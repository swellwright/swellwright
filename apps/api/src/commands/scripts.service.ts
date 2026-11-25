import { createHash } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type CreateScriptRequest,
  type ParameterIssue,
  parameterWriteIssues,
  type ScriptList,
  ScriptParametersSchema,
  type ScriptSummary,
  type ScriptView,
  type UpdateScriptRequest,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';
import { ZodError } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
// Sets the deadline under which the patterns of script parameters run in this process.
import '../common/regex-deadline.js';
import { type Actor } from '../servers/servers.service.js';
import { DATABASE } from '../tokens.js';
import { loadBuiltinScripts } from './builtin-scripts.js';

type ScriptRow = Prisma.ScriptGetPayload<object>;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Line endings are made LF when a script is saved: it runs on Linux, and a pasted CRLF would break `sh`. */
export const normalizeBody = (text: string): string => text.replaceAll('\r\n', '\n');

/** Parameter definitions the rules for writing refuse, as the 400 a schema issue gives (path `parameters.<name>`). */
function invalidDefinitions(issues: readonly ParameterIssue[]): ZodError {
  return new ZodError(
    issues.map((issue) => ({
      code: 'custom' as const,
      path: issue.name === null ? ['parameters'] : ['parameters', issue.name],
      message: issue.message,
    })),
  );
}

/**
 * The parameters as stored, read with the schema (which keeps the rules a stored definition has always met, so a
 * pattern refused only by the newer bound on matching is still listed); a record that does not fit even that is shown
 * as having none.
 */
function parametersOf(
  row: Pick<ScriptRow, 'name' | 'parameters'>,
  logger: Logger,
): ScriptSummary['parameters'] {
  const parsed = ScriptParametersSchema.safeParse(row.parameters);
  if (!parsed.success) {
    logger.warn(`the stored parameters of the script "${row.name}" do not fit the schema`);
    return [];
  }
  return parsed.data;
}

/**
 * The script library (ADR 0038): the built-in scripts, seeded by name when the server starts, and the scripts of the
 * instance. Writing a script is writing code that will run on servers, so every write is audited in the same
 * transaction, and the routes need `servers:exec` and a fresh authenticator code.
 */
@Injectable()
export class ScriptsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Scripts');

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** The built-in scripts are made and kept current at start. A database that is not ready yet must not stop the process. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.database) {
      return;
    }
    try {
      await this.seedBuiltins();
    } catch (error) {
      this.logger.warn(
        `could not seed the built-in scripts: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Makes every built-in script exist with the text and the version of this build. Idempotent: a script that is
   * current is left alone, one whose text changed gets the new text (the history keeps what ran), one that is missing
   * is created. A script of the instance that already uses a built-in name is never overwritten: it is reported and
   * left as it is (the built-in one is then not in the library until the name is free).
   */
  async seedBuiltins(): Promise<{ created: number; updated: number; skipped: string[] }> {
    const result = { created: 0, updated: 0, skipped: [] as string[] };
    for (const builtin of loadBuiltinScripts()) {
      const existing = await this.db.script.findUnique({ where: { name: builtin.name } });
      const data = {
        description: builtin.description,
        body: builtin.body,
        dangerLevel: 'read' as const,
        sudo: builtin.sudo,
        parameters: builtin.parameters as unknown as Prisma.InputJsonValue,
        builtin: true,
        version: builtin.version,
        bodySha256: builtin.bodySha256,
      };
      if (!existing) {
        try {
          await this.db.script.create({ data: { name: builtin.name, ...data } });
          result.created += 1;
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          // Another process made it a moment ago: nothing to do.
        }
        continue;
      }
      if (!existing.builtin) {
        this.logger.warn(
          `a script of this instance is called "${builtin.name}", which a built-in script needs: the built-in one is not added`,
        );
        result.skipped.push(builtin.name);
        continue;
      }
      if (
        existing.bodySha256 !== builtin.bodySha256 ||
        existing.version !== builtin.version ||
        existing.description !== builtin.description ||
        existing.sudo !== builtin.sudo ||
        JSON.stringify(existing.parameters) !== JSON.stringify(builtin.parameters)
      ) {
        await this.db.script.update({ where: { id: existing.id }, data });
        result.updated += 1;
      }
    }
    return result;
  }

  private summary(row: ScriptRow): ScriptSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      dangerLevel: row.dangerLevel,
      sudo: row.sudo,
      parameters: parametersOf(row, this.logger),
      builtin: row.builtin,
      version: row.version,
      bodySha256: row.bodySha256,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private view(row: ScriptRow): ScriptView {
    return { ...this.summary(row), body: row.body };
  }

  async list(): Promise<ScriptList> {
    const rows = await this.db.script.findMany({
      orderBy: [{ builtin: 'desc' }, { name: 'asc' }],
    });
    return { scripts: rows.map((row) => this.summary(row)) };
  }

  /** The row itself, for the code that makes a run from a script. */
  async find(id: string): Promise<ScriptRow> {
    const row = await this.db.script.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('There is no such script.');
    }
    return row;
  }

  async get(id: string): Promise<ScriptView> {
    return this.view(await this.find(id));
  }

  async create(actor: Actor, request: CreateScriptRequest, meta: RequestMeta): Promise<ScriptView> {
    const refused = parameterWriteIssues(request.parameters);
    if (refused.length > 0) {
      throw invalidDefinitions(refused);
    }
    const body = normalizeBody(request.body);
    const bodySha256 = sha256Hex(body);
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.script.create({
          data: {
            name: request.name,
            description: request.description,
            body,
            dangerLevel: request.dangerLevel,
            sudo: request.sudo,
            parameters: request.parameters,
            builtin: false,
            version: 1,
            bodySha256,
            createdById: actor.id,
          },
        });
        await this.audit.record(
          {
            action: 'script.created',
            outcome: 'success',
            actor,
            object: { type: 'script', id: created.id },
            details: {
              name: created.name,
              danger_level: created.dangerLevel,
              sudo: created.sudo,
              parameters: request.parameters.length,
              body_sha256: bodySha256,
            },
            meta,
          },
          tx,
        );
        return created;
      });
      return this.view(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`A script called "${request.name}" exists already.`);
      }
      throw error;
    }
  }

  async update(
    actor: Actor,
    id: string,
    request: UpdateScriptRequest,
    meta: RequestMeta,
  ): Promise<ScriptView> {
    const current = await this.find(id);
    if (current.builtin) {
      throw new ConflictException(
        'A built-in script cannot be changed. Copy it under another name and change the copy.',
      );
    }
    const changed: string[] = [];
    const data: Prisma.ScriptUpdateInput = {};
    if (request.name !== undefined && request.name !== current.name) {
      data.name = request.name;
      changed.push('name');
    }
    if (request.description !== undefined && request.description !== current.description) {
      data.description = request.description;
      changed.push('description');
    }
    if (request.dangerLevel !== undefined && request.dangerLevel !== current.dangerLevel) {
      data.dangerLevel = request.dangerLevel;
      changed.push('danger_level');
    }
    if (request.sudo !== undefined && request.sudo !== current.sudo) {
      data.sudo = request.sudo;
      changed.push('sudo');
    }
    if (request.parameters !== undefined) {
      // A pattern that is stored already may stay (an old script must keep its definitions); a new one meets the rule.
      const refused = parameterWriteIssues(request.parameters, parametersOf(current, this.logger));
      if (refused.length > 0) {
        throw invalidDefinitions(refused);
      }
    }
    if (
      request.parameters !== undefined &&
      JSON.stringify(request.parameters) !== JSON.stringify(current.parameters)
    ) {
      data.parameters = request.parameters;
      changed.push('parameters');
    }
    let bodySha256 = current.bodySha256;
    if (request.body !== undefined) {
      const body = normalizeBody(request.body);
      if (body !== current.body) {
        bodySha256 = sha256Hex(body);
        data.body = body;
        data.bodySha256 = bodySha256;
        data.version = current.version + 1;
        changed.push('body');
      }
    }
    if (changed.length === 0) {
      return this.view(current);
    }
    try {
      const row = await this.db.$transaction(async (tx) => {
        // Only if nobody changed it since it was read: two edits at once must not both think they went first.
        const done = await tx.script.updateMany({
          where: { id, updatedAt: current.updatedAt, builtin: false },
          data,
        });
        if (done.count === 0) {
          throw new ConflictException('The script was changed by somebody else. Open it again.');
        }
        const updated = await tx.script.findUniqueOrThrow({ where: { id } });
        await this.audit.record(
          {
            action: 'script.updated',
            outcome: 'success',
            actor,
            object: { type: 'script', id },
            details: {
              name: updated.name,
              changed: changed.join(','),
              version: updated.version,
              body_sha256: bodySha256,
            },
            meta,
          },
          tx,
        );
        return updated;
      });
      return this.view(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`A script called "${request.name ?? ''}" exists already.`);
      }
      throw error;
    }
  }

  async remove(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    const current = await this.find(id);
    if (current.builtin) {
      throw new ConflictException('A built-in script cannot be deleted.');
    }
    await this.db.$transaction(async (tx) => {
      const done = await tx.script.deleteMany({ where: { id, builtin: false } });
      if (done.count === 0) {
        throw new NotFoundException('There is no such script.');
      }
      await this.audit.record(
        {
          action: 'script.deleted',
          outcome: 'success',
          actor,
          object: { type: 'script', id },
          details: {
            name: current.name,
            version: current.version,
            body_sha256: current.bodySha256,
          },
          meta,
        },
        tx,
      );
    });
  }
}
