import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type BaselineDocument,
  BaselineDocumentSchema,
  type BaselineList,
  type BaselineSummary,
  type BaselineVersionInfo,
  type BaselineView,
  type CreateBaselineRequest,
  type SetBaselineAssignmentsRequest,
  type UpdateBaselineRequest,
  type ValidateBaselineResult,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { CodedHttpException } from '../http.js';
import { type Actor } from '../servers/servers.service.js';
import { DATABASE } from '../tokens.js';
import { loadBuiltinBaselines } from './builtin.js';
import { parseBaselineSource, validateBaselineSource } from './document.js';

type ProfileRow = Prisma.BaselineProfileGetPayload<object>;
type VersionRow = Prisma.BaselineVersionGetPayload<object>;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** Line endings made LF and trailing white space cut, so a text that only differs there is not a new version. */
export const normalizeSource = (text: string): string =>
  `${text.replaceAll('\r\n', '\n').trimEnd()}\n`;

/** Which baseline applies to a server, and why. */
export interface EffectiveBaseline {
  readonly profileId: string;
  readonly by: 'server' | 'tag';
}

interface Assignment {
  readonly profileId: string;
  readonly serverId: string | null;
  readonly tag: string | null;
}

/**
 * The baseline of every server (ADR 0045): the one assigned to the server itself, otherwise the one of a tag it carries
 * (the first by baseline name, then by tag, when several tags have one), otherwise none. A pure function of the servers,
 * the assignments and the names of the baselines.
 */
export function effectiveBaselines(
  servers: readonly { readonly id: string; readonly tags: readonly string[] }[],
  assignments: readonly Assignment[],
  profileNames: ReadonlyMap<string, string>,
): Map<string, EffectiveBaseline> {
  const byServer = new Map<string, string>();
  const byTag = new Map<string, string>();
  for (const assignment of assignments) {
    if (assignment.serverId !== null) {
      byServer.set(assignment.serverId, assignment.profileId);
    } else if (assignment.tag !== null) {
      byTag.set(assignment.tag, assignment.profileId);
    }
  }
  const effective = new Map<string, EffectiveBaseline>();
  for (const server of servers) {
    const explicit = byServer.get(server.id);
    if (explicit !== undefined) {
      effective.set(server.id, { profileId: explicit, by: 'server' });
      continue;
    }
    const candidates = server.tags
      .filter((tag) => byTag.has(tag))
      .map((tag) => ({ tag, profileId: byTag.get(tag) ?? '' }))
      .sort(
        (a, b) =>
          (profileNames.get(a.profileId) ?? '').localeCompare(
            profileNames.get(b.profileId) ?? '',
          ) || a.tag.localeCompare(b.tag),
      );
    const first = candidates[0];
    if (first) {
      effective.set(server.id, { profileId: first.profileId, by: 'tag' });
    }
  }
  return effective;
}

/**
 * Baselines, their versions and what they are assigned to (ADR 0045). A version is immutable: a change makes the next
 * one, so that every run can be read against the document it ran with. The built-in baselines are files of this build and
 * are made and kept current by name at start; the rest are the instance's own. Every write is audited in the same
 * transaction, and the routes need `servers:write` and a fresh authenticator code.
 */
@Injectable()
export class BaselinesService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Baselines');

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** A database that is not ready yet must not stop the process; the next start tries again. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.database) {
      return;
    }
    try {
      await this.seedBuiltins();
    } catch (error) {
      this.logger.warn(
        `could not seed the built-in baselines: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Makes every built-in baseline exist with the document of this build. Idempotent: one that is current is left
   * alone, one whose document changed gets a new version (the old one stays), one that is missing is created. A
   * baseline of the instance that already uses a built-in name is never touched.
   */
  async seedBuiltins(): Promise<{ created: number; updated: number; skipped: string[] }> {
    const result = { created: 0, updated: 0, skipped: [] as string[] };
    for (const builtin of loadBuiltinBaselines()) {
      const existing = await this.db.baselineProfile.findUnique({
        where: { name: builtin.name },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (!existing) {
        try {
          await this.db.$transaction(async (tx) => {
            const profile = await tx.baselineProfile.create({
              data: {
                name: builtin.name,
                description: builtin.description.slice(0, 300),
                builtIn: true,
                currentVersion: 1,
              },
            });
            await tx.baselineVersion.create({
              data: {
                profileId: profile.id,
                version: 1,
                document: builtin.parsed.document,
                source: builtin.source,
                documentSha256: builtin.parsed.sha256,
                checkCount: builtin.parsed.document.checks.length,
                comment: 'Shipped with Swellwright.',
              },
            });
            await this.audit.record(
              {
                action: 'baseline.version.created',
                outcome: 'success',
                object: { type: 'baseline', id: profile.id },
                details: {
                  baseline: builtin.name,
                  version: 1,
                  checks: builtin.parsed.document.checks.length,
                  sha256: builtin.parsed.sha256,
                  built_in: true,
                },
                meta: { ip: undefined, requestId: undefined },
              },
              tx,
            );
          });
          result.created += 1;
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
        }
        continue;
      }
      if (!existing.builtIn) {
        this.logger.warn(
          `a baseline of this instance is called "${builtin.name}", which a built-in baseline needs: the built-in one is not added`,
        );
        result.skipped.push(builtin.name);
        continue;
      }
      const latest = existing.versions[0];
      if (latest?.documentSha256 === builtin.parsed.sha256) {
        continue;
      }
      const next = existing.currentVersion + 1;
      await this.db.$transaction(async (tx) => {
        await tx.baselineVersion.create({
          data: {
            profileId: existing.id,
            version: next,
            document: builtin.parsed.document,
            source: builtin.source,
            documentSha256: builtin.parsed.sha256,
            checkCount: builtin.parsed.document.checks.length,
            comment: 'Updated with Swellwright.',
          },
        });
        await tx.baselineProfile.update({
          where: { id: existing.id },
          data: { currentVersion: next, description: builtin.description.slice(0, 300) },
        });
        await this.audit.record(
          {
            action: 'baseline.version.created',
            outcome: 'success',
            object: { type: 'baseline', id: existing.id },
            details: {
              baseline: builtin.name,
              version: next,
              checks: builtin.parsed.document.checks.length,
              sha256: builtin.parsed.sha256,
              built_in: true,
            },
            meta: { ip: undefined, requestId: undefined },
          },
          tx,
        );
      });
      result.updated += 1;
    }
    return result;
  }

  // ---- reading -------------------------------------------------------------------------------------------------

  /** Which baseline applies to each server now. */
  async effective(): Promise<Map<string, EffectiveBaseline>> {
    const [servers, assignments, profiles] = await Promise.all([
      this.db.server.findMany({ select: { id: true, tags: true } }),
      this.db.baselineAssignment.findMany({
        select: { profileId: true, serverId: true, tag: true },
      }),
      this.db.baselineProfile.findMany({ select: { id: true, name: true } }),
    ]);
    return effectiveBaselines(
      servers,
      assignments,
      new Map(profiles.map((profile) => [profile.id, profile.name])),
    );
  }

  private async summaries(rows: readonly ProfileRow[]): Promise<BaselineSummary[]> {
    const [assignments, effective, versions] = await Promise.all([
      this.db.baselineAssignment.findMany({
        include: { server: { select: { id: true, name: true } } },
      }),
      this.effective(),
      this.db.baselineVersion.findMany({
        where: { profileId: { in: rows.map((row) => row.id) } },
        select: { profileId: true, version: true, checkCount: true },
      }),
    ]);
    const counts = new Map<string, number>();
    for (const [, entry] of effective) {
      counts.set(entry.profileId, (counts.get(entry.profileId) ?? 0) + 1);
    }
    return rows.map((row) => {
      const mine = assignments.filter((assignment) => assignment.profileId === row.id);
      const current = versions.find(
        (version) => version.profileId === row.id && version.version === row.currentVersion,
      );
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        builtIn: row.builtIn,
        currentVersion: row.currentVersion,
        checkCount: current?.checkCount ?? 0,
        updatedAt: row.updatedAt.toISOString(),
        assignments: {
          servers: mine
            .filter((assignment) => assignment.server !== null)
            .map((assignment) => ({
              id: assignment.server?.id ?? '',
              name: assignment.server?.name ?? '',
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          tags: mine
            .map((assignment) => assignment.tag)
            .filter((tag): tag is string => tag !== null)
            .sort(),
        },
        serverCount: counts.get(row.id) ?? 0,
      };
    });
  }

  async list(): Promise<BaselineList> {
    const rows = await this.db.baselineProfile.findMany({ orderBy: { name: 'asc' } });
    return { baselines: await this.summaries(rows) };
  }

  private versionInfo(row: VersionRow): BaselineVersionInfo {
    return {
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdById ? { id: row.createdById, name: row.createdByName ?? '' } : null,
      comment: row.comment,
      sha256: row.documentSha256,
      checkCount: row.checkCount,
    };
  }

  /** The document of a stored version; a record that no longer fits the schema is a defect, not an empty baseline. */
  documentOf(row: Pick<VersionRow, 'document' | 'profileId' | 'version'>): BaselineDocument {
    const parsed = BaselineDocumentSchema.safeParse(row.document);
    if (!parsed.success) {
      throw new Error(
        `The stored document of baseline ${row.profileId} version ${String(row.version)} does not fit the schema.`,
      );
    }
    return parsed.data;
  }

  async get(id: string, version?: number): Promise<BaselineView> {
    const profile = await this.db.baselineProfile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException('There is no such baseline.');
    }
    const versions = await this.db.baselineVersion.findMany({
      where: { profileId: id },
      orderBy: { version: 'desc' },
    });
    const shown = versions.find((row) => row.version === (version ?? profile.currentVersion));
    if (!shown) {
      throw new NotFoundException('There is no such version of this baseline.');
    }
    const [summary] = await this.summaries([profile]);
    if (!summary) {
      throw new Error('A baseline summary must exist for a baseline that was just read.');
    }
    return {
      ...summary,
      version: shown.version,
      document: this.documentOf(shown),
      source: shown.source,
      versions: versions.map((row) => this.versionInfo(row)),
    };
  }

  /** The version a run should use: the profile and the document of its current (or a named) version. */
  async loadForRun(
    id: string,
  ): Promise<{ profile: ProfileRow; version: VersionRow; document: BaselineDocument } | null> {
    const profile = await this.db.baselineProfile.findUnique({ where: { id } });
    if (!profile) {
      return null;
    }
    const version = await this.db.baselineVersion.findUnique({
      where: { profileId_version: { profileId: id, version: profile.currentVersion } },
    });
    if (!version) {
      return null;
    }
    return { profile, version, document: this.documentOf(version) };
  }

  validate(source: string): ValidateBaselineResult {
    return validateBaselineSource(source);
  }

  // ---- writing -------------------------------------------------------------------------------------------------

  private parseOrThrow(source: string): { document: BaselineDocument; sha256: string } {
    const result = parseBaselineSource(source);
    if (!result.ok) {
      throw new CodedHttpException(
        400,
        'validation_failed',
        `The baseline is not valid: ${result.issues[0]?.message ?? 'see details'}`,
        { issues: result.issues },
      );
    }
    return result.parsed;
  }

  async create(
    actor: Actor,
    request: CreateBaselineRequest,
    meta: RequestMeta,
  ): Promise<BaselineView> {
    const parsed = this.parseOrThrow(request.source);
    const source = normalizeSource(request.source);
    try {
      const id = await this.db.$transaction(async (tx) => {
        const profile = await tx.baselineProfile.create({
          data: {
            name: request.name,
            description: request.description ?? parsed.document.description?.slice(0, 300) ?? null,
            builtIn: false,
            currentVersion: 1,
            createdById: actor.id,
          },
        });
        await tx.baselineVersion.create({
          data: {
            profileId: profile.id,
            version: 1,
            document: parsed.document,
            source,
            documentSha256: parsed.sha256,
            checkCount: parsed.document.checks.length,
            comment: request.comment ?? null,
            createdById: actor.id,
            createdByName: actor.name,
          },
        });
        await this.audit.record(
          {
            action: 'baseline.version.created',
            outcome: 'success',
            actor,
            object: { type: 'baseline', id: profile.id },
            details: {
              baseline: request.name,
              version: 1,
              checks: parsed.document.checks.length,
              sha256: parsed.sha256,
              built_in: false,
            },
            meta,
          },
          tx,
        );
        return profile.id;
      });
      return await this.get(id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`A baseline named "${request.name}" exists already.`);
      }
      throw error;
    }
  }

  async update(
    actor: Actor,
    id: string,
    request: UpdateBaselineRequest,
    meta: RequestMeta,
  ): Promise<BaselineView> {
    const parsed = request.source === undefined ? undefined : this.parseOrThrow(request.source);
    await this.db.$transaction(async (tx) => {
      // One writer per baseline at a time: the version number must not be taken twice.
      await tx.$executeRaw`SELECT 1 FROM baseline_profiles WHERE id = ${id}::uuid FOR UPDATE`;
      const profile = await tx.baselineProfile.findUnique({ where: { id } });
      if (!profile) {
        throw new NotFoundException('There is no such baseline.');
      }
      if (profile.builtIn) {
        throw new CodedHttpException(
          409,
          'conflict',
          'A built-in baseline cannot be changed. Make a copy and change the copy.',
          { reason: 'built_in' },
        );
      }
      if (
        request.expectedVersion !== undefined &&
        request.expectedVersion !== profile.currentVersion
      ) {
        throw new CodedHttpException(
          409,
          'conflict',
          `The baseline is at version ${String(profile.currentVersion)} now, not ${String(request.expectedVersion)}. Reload it and apply your change again.`,
          { reason: 'version', currentVersion: profile.currentVersion },
        );
      }
      const data: Prisma.BaselineProfileUpdateInput = {};
      if (request.description !== undefined) {
        data.description = request.description;
      }
      if (parsed && request.source !== undefined) {
        const current = await tx.baselineVersion.findUniqueOrThrow({
          where: { profileId_version: { profileId: id, version: profile.currentVersion } },
        });
        const source = normalizeSource(request.source);
        if (normalizeSource(current.source) !== source) {
          const next = profile.currentVersion + 1;
          await tx.baselineVersion.create({
            data: {
              profileId: id,
              version: next,
              document: parsed.document,
              source,
              documentSha256: parsed.sha256,
              checkCount: parsed.document.checks.length,
              comment: request.comment ?? null,
              createdById: actor.id,
              createdByName: actor.name,
            },
          });
          data.currentVersion = next;
          await this.audit.record(
            {
              action: 'baseline.version.created',
              outcome: 'success',
              actor,
              object: { type: 'baseline', id },
              details: {
                baseline: profile.name,
                version: next,
                previous_version: profile.currentVersion,
                checks: parsed.document.checks.length,
                sha256: parsed.sha256,
                document_changed: parsed.sha256 !== current.documentSha256,
                built_in: false,
              },
              meta,
            },
            tx,
          );
        }
      }
      if (Object.keys(data).length > 0) {
        await tx.baselineProfile.update({ where: { id }, data });
      }
    });
    return this.get(id);
  }

  async remove(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const profile = await tx.baselineProfile.findUnique({ where: { id } });
      if (!profile) {
        throw new NotFoundException('There is no such baseline.');
      }
      if (profile.builtIn) {
        throw new CodedHttpException(409, 'conflict', 'A built-in baseline cannot be deleted.', {
          reason: 'built_in',
        });
      }
      const assignments = await tx.baselineAssignment.count({ where: { profileId: id } });
      await tx.baselineProfile.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'baseline.deleted',
          outcome: 'success',
          actor,
          object: { type: 'baseline', id },
          details: { baseline: profile.name, versions: profile.currentVersion, assignments },
          meta,
        },
        tx,
      );
    });
  }

  async setAssignments(
    actor: Actor,
    id: string,
    request: SetBaselineAssignmentsRequest,
    meta: RequestMeta,
  ): Promise<BaselineSummary> {
    const serverIds = [...new Set(request.serverIds)];
    const tags = [...new Set(request.tags)];
    await this.db.$transaction(async (tx) => {
      const profile = await tx.baselineProfile.findUnique({ where: { id } });
      if (!profile) {
        throw new NotFoundException('There is no such baseline.');
      }
      if (serverIds.length > 0) {
        const found = await tx.server.findMany({
          where: { id: { in: serverIds } },
          select: { id: true },
        });
        if (found.length !== serverIds.length) {
          const known = new Set(found.map((server) => server.id));
          throw new BadRequestException(
            `There is no server ${serverIds.find((candidate) => !known.has(candidate)) ?? ''}.`,
          );
        }
      }
      // What another baseline had of these is moved here; what this one had of others is let go.
      const moved = await tx.baselineAssignment.count({
        where: {
          profileId: { not: id },
          OR: [
            ...(serverIds.length > 0 ? [{ serverId: { in: serverIds } }] : []),
            ...(tags.length > 0 ? [{ tag: { in: tags } }] : []),
          ],
        },
      });
      await tx.baselineAssignment.deleteMany({
        where: {
          OR: [
            { profileId: id },
            ...(serverIds.length > 0 ? [{ serverId: { in: serverIds } }] : []),
            ...(tags.length > 0 ? [{ tag: { in: tags } }] : []),
          ],
        },
      });
      await tx.baselineAssignment.createMany({
        data: [
          ...serverIds.map((serverId) => ({ profileId: id, serverId, createdById: actor.id })),
          ...tags.map((tag) => ({ profileId: id, tag, createdById: actor.id })),
        ],
      });
      await this.audit.record(
        {
          action: 'baseline.assigned',
          outcome: 'success',
          actor,
          object: { type: 'baseline', id },
          details: {
            baseline: profile.name,
            servers: serverIds.length,
            tags: tags.length,
            moved,
          },
          meta,
        },
        tx,
      );
    });
    const profile = await this.db.baselineProfile.findUniqueOrThrow({ where: { id } });
    const [summary] = await this.summaries([profile]);
    if (!summary) {
      throw new Error('A baseline summary must exist for a baseline that was just read.');
    }
    return summary;
  }
}
