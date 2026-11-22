import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ConventionPackValidation,
  ConventionPackVersionList,
  ConventionPackView,
  SaveConventionPackRequest,
  ValidateConventionPackRequest,
} from '@swellwright/contracts';
import {
  builtInDocument,
  builtInPack,
  checkPack,
  checkPackValue,
  loadPack,
  packHash,
  renderPackYaml,
  type ResolvedPack,
} from '@swellwright/conventions';
import { type Database, Prisma } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { CodedHttpException } from '../http.js';
import { DATABASE } from '../tokens.js';
import type { Actor } from '../vault/vault.service.js';
import { ChecksMemory } from './memory.js';

/** Which panel the packs are for: one while Swellwright talks to one panel (the column and the reason are in the schema). */
export const PANEL_KEY = 'default';

/** An arbitrary constant: one transaction at a time saves or resets the pack. */
const PACK_LOCK_KEY = 7_761_250;

/**
 * The convention pack (ADR 0044): the one that is active, its history, validation, and the changes. A change is a new
 * version in the same transaction as its audit record; nothing is ever overwritten, so the history is complete, and
 * "reset" only says that no saved version is active, which makes the built-in pack apply again. The document is data
 * from a person: it is validated completely before it is stored and again when it is loaded, and a stored pack that a
 * later release no longer accepts is not run (the built-in pack runs and the log says why).
 */
@Injectable()
export class ConventionPackService {
  private readonly logger = new Logger('ConventionPack');
  private builtIn: ConventionPackView | undefined;

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChecksMemory) private readonly memory: ChecksMemory,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** The pack the checks run with. */
  async active(): Promise<ResolvedPack> {
    const row = await this.db.conventionPack.findFirst({
      where: { panelKey: PANEL_KEY, active: true },
    });
    if (!row) {
      return builtInPack();
    }
    const pack = loadPack(row.document, row.version);
    if (pack === null) {
      this.logger.warn(
        `The saved convention pack (version ${String(row.version)}) is not accepted by this release: the built-in pack runs.`,
      );
      return builtInPack();
    }
    return pack;
  }

  private builtInView(active: boolean): ConventionPackView {
    this.builtIn ??= {
      pack: builtInPack().ref,
      description: builtInDocument().description ?? null,
      comment: null,
      createdAt: null,
      createdBy: null,
      active: true,
      document: builtInDocument(),
      yaml: renderPackYaml(builtInDocument()),
    };
    return { ...this.builtIn, active };
  }

  private async nameOf(userId: string | null): Promise<string | null> {
    if (userId === null) {
      return null;
    }
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    return user?.username ?? null;
  }

  private async viewOf(row: Prisma.ConventionPackGetPayload<object>): Promise<ConventionPackView> {
    const checked = checkPackValue(row.document);
    if (checked.document === null) {
      throw new CodedHttpException(
        409,
        'conflict',
        `The saved convention pack (version ${String(row.version)}) is not accepted by this release. Its text is kept; fix it in the editor and save it again.`,
        {
          version: row.version,
          yaml: row.source.slice(0, 20_000),
          issues: checked.result.issues.slice(0, 20),
        },
      );
    }
    return {
      pack: { source: 'custom', version: row.version, name: row.name, hash: row.hash },
      description: checked.document.description ?? null,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      createdBy: await this.nameOf(row.createdById),
      active: row.active,
      document: checked.document,
      yaml: row.source,
    };
  }

  /** The active pack, or the built-in one when none is saved; with `version`, a pack from the history. */
  async view(version?: number): Promise<ConventionPackView> {
    if (version !== undefined) {
      const row = await this.db.conventionPack.findUnique({
        where: { panelKey_version: { panelKey: PANEL_KEY, version } },
      });
      if (!row) {
        throw new NotFoundException('There is no such version of the convention pack.');
      }
      return this.viewOf(row);
    }
    const row = await this.db.conventionPack.findFirst({
      where: { panelKey: PANEL_KEY, active: true },
    });
    return row ? this.viewOf(row) : this.builtInView(true);
  }

  async versions(): Promise<ConventionPackVersionList> {
    const rows = await this.db.conventionPack.findMany({
      where: { panelKey: PANEL_KEY },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        name: true,
        hash: true,
        active: true,
        comment: true,
        createdAt: true,
        createdById: true,
      },
    });
    const ids = [
      ...new Set(rows.flatMap((row) => (row.createdById === null ? [] : [row.createdById]))),
    ];
    const users =
      ids.length === 0
        ? []
        : await this.db.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, username: true },
          });
    const names = new Map(users.map((user) => [user.id, user.username]));
    return {
      versions: rows.map((row) => ({
        version: row.version,
        name: row.name,
        hash: row.hash,
        active: row.active,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdById === null ? null : (names.get(row.createdById) ?? null),
      })),
    };
  }

  /** The same checks as saving, without saving. */
  validate(request: ValidateConventionPackRequest): ConventionPackValidation {
    return checkPack(
      request.yaml === undefined ? { document: request.document } : { yaml: request.yaml },
    ).result;
  }

  async save(
    actor: Actor,
    request: SaveConventionPackRequest,
    meta: RequestMeta,
  ): Promise<ConventionPackView> {
    const checked = checkPack(
      request.yaml === undefined ? { document: request.document } : { yaml: request.yaml },
    );
    if (checked.document === null) {
      throw new CodedHttpException(400, 'validation_failed', 'The convention pack is not valid.', {
        issues: checked.result.issues.filter((issue) => issue.severity === 'error'),
      });
    }
    const { document } = checked;
    const hash = packHash(document);
    const source = request.yaml ?? renderPackYaml(document);
    const row = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PACK_LOCK_KEY})`;
      const active = await tx.conventionPack.findFirst({
        where: { panelKey: PANEL_KEY, active: true },
      });
      if (request.expectedVersion !== undefined) {
        const have = active?.version ?? null;
        if (have !== request.expectedVersion) {
          throw new CodedHttpException(
            409,
            'conflict',
            `The convention pack changed meanwhile: the active version is ${have === null ? 'none (the built-in pack)' : String(have)}. Reload it and apply your change again.`,
            { activeVersion: have },
          );
        }
      }
      if (active?.hash === hash && active.source === source) {
        return active;
      }
      const last = await tx.conventionPack.aggregate({
        where: { panelKey: PANEL_KEY },
        _max: { version: true },
      });
      const version = (last._max.version ?? 0) + 1;
      if (active) {
        await tx.conventionPack.update({ where: { id: active.id }, data: { active: false } });
      }
      const created = await tx.conventionPack.create({
        data: {
          panelKey: PANEL_KEY,
          version,
          name: document.name,
          document: document as unknown as Prisma.InputJsonValue,
          source,
          hash,
          active: true,
          comment: request.comment === undefined || request.comment === '' ? null : request.comment,
          createdById: actor.id,
        },
      });
      await this.audit.record(
        {
          action: 'panel.convention_pack.saved',
          outcome: 'success',
          actor,
          object: { type: 'convention_pack', id: created.id },
          details: {
            version,
            previous_version: active?.version ?? null,
            name: document.name.slice(0, 100),
            hash,
            rules: Object.keys(document.rules ?? {}).length,
            via: request.yaml === undefined ? 'document' : 'yaml',
          },
          meta,
        },
        tx,
      );
      return created;
    });
    this.memory.forgetLast();
    return this.viewOf(row);
  }

  /** The built-in pack applies again; the saved versions stay in the history. */
  async reset(actor: Actor, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PACK_LOCK_KEY})`;
      const active = await tx.conventionPack.findFirst({
        where: { panelKey: PANEL_KEY, active: true },
      });
      if (!active) {
        throw new NotFoundException(
          'No saved convention pack is active: the built-in pack applies.',
        );
      }
      await tx.conventionPack.update({ where: { id: active.id }, data: { active: false } });
      await this.audit.record(
        {
          action: 'panel.convention_pack.reset',
          outcome: 'success',
          actor,
          object: { type: 'convention_pack', id: active.id },
          details: { version: active.version, name: active.name.slice(0, 100) },
          meta,
        },
        tx,
      );
    });
    this.memory.forgetLast();
  }
}
