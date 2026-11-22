import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CommandOutput,
  type CommandOutputPage,
  type CommandOutputQuery,
  type CommandRunCounts,
  type CommandRunList,
  type CommandRunListQuery,
  type CommandRunState,
  type CommandRunSummary,
  type CommandRunView,
  type CommandTargetView,
  checkParameterValues,
  commandLabel,
  type CreateCommandRunRequest,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  FINISHED_RUN_STATES,
  MAX_RUN_SECRETS,
  OUTPUT_PAGE_DEFAULT,
  type ParameterValues,
  parameterSecretName,
  type Permission,
  type RunSecretView,
  ScriptParametersSchema,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';
import { ZodError } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException } from '../http.js';
import { type Actor } from '../servers/servers.service.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';
import { CommandRunner } from './command-runner.service.js';
import { displayText, pageOf, startOnBoundary } from './output.js';
import { normalizeBody, ScriptsService, sha256Hex } from './scripts.service.js';

type DangerLevel = CommandRunSummary['dangerLevel'];

type RunRow = Prisma.CommandRunGetPayload<object>;
type SecretRow = Prisma.CommandRunSecretGetPayload<object>;
type TargetRow = Prisma.CommandRunTargetGetPayload<object>;

const EMPTY_COUNTS: CommandRunCounts = {
  total: 0,
  pending: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  lost: 0,
  cancelled: 0,
  skipped: 0,
};

const NO_BYTES = (): Uint8Array<ArrayBuffer> => new Uint8Array(0);

const isFinishedRun = (state: CommandRunState): boolean => FINISHED_RUN_STATES.includes(state);

const outputView = (
  tail: Uint8Array,
  stored: number,
  size: number,
  truncated: boolean,
): CommandOutput => {
  const window = tail.length < stored ? startOnBoundary(tail) : tail;
  return {
    storedBytes: stored,
    totalBytes: Math.max(size, stored),
    truncated,
    tail: displayText(window),
    tailOffset: stored - window.length,
  };
};

export function targetView(row: TargetRow): CommandTargetView {
  return {
    id: row.id,
    serverId: row.serverId,
    serverName: row.serverName,
    state: row.state,
    exitCode: row.exitCode,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    waiting: row.state === 'running' ? row.waiting : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    stdout: outputView(row.stdoutTail, row.stdoutStored, row.stdoutSize, row.stdoutTruncated),
    stderr: outputView(row.stderrTail, row.stderrStored, row.stderrSize, row.stderrTruncated),
  };
}

function summaryOf(row: RunRow, counts: CommandRunCounts): CommandRunSummary {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    label: row.label,
    scriptId: row.scriptId,
    dangerLevel: row.dangerLevel,
    sudo: row.sudo,
    timeoutSeconds: row.timeoutSeconds,
    createdBy: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    counts,
  };
}

const secretView = (row: SecretRow): RunSecretView => ({
  name: row.name,
  secretId: row.secretId,
  secretName: row.secretName,
});

function viewOf(
  row: RunRow,
  targets: readonly TargetRow[],
  secrets: readonly SecretRow[],
): CommandRunView {
  const counts: CommandRunCounts = { ...EMPTY_COUNTS, total: targets.length };
  for (const target of targets) {
    counts[target.state] += 1;
  }
  return {
    ...summaryOf(row, counts),
    body: row.body,
    bodySha256: row.bodySha256,
    scriptName: row.scriptName,
    scriptVersion: row.scriptVersion,
    parameters: (row.parameters ?? {}) as ParameterValues,
    confirmedLevel: row.confirmedLevel,
    secrets: [...secrets].sort((a, b) => a.name.localeCompare(b.name)).map(secretView),
    targets: targets.map((target) => targetView(target)),
  };
}

/** A parameter value that does not fit its definition, as the 400 the contract promises. */
function invalidParameters(issues: readonly { name: string | null; message: string }[]): ZodError {
  return new ZodError(
    issues.map((issue) => ({
      code: 'custom' as const,
      path: issue.name === null ? ['parameters'] : ['parameters', issue.name],
      message: issue.message,
    })),
  );
}

/** A secret chosen for a run that does not fit, as the 400 the contract promises. */
function invalidSecrets(
  issues: readonly { path: (string | number)[]; message: string }[],
): ZodError {
  return new ZodError(issues.map((issue) => ({ code: 'custom' as const, ...issue })));
}

/**
 * Runs on several servers (ADR 0038): queues a run with a target per server, answers its state and output, stops it.
 * The work itself is done by `CommandRunner`, which this service wakes after the transaction that made the run.
 */
@Injectable()
export class CommandRunsService {
  private readonly limiter: WindowLimiter;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ScriptsService) private readonly scripts: ScriptsService,
    @Inject(CommandRunner) private readonly runner: CommandRunner,
    @Inject(VaultService) private readonly vault: VaultService,
  ) {
    this.limiter = new WindowLimiter(config.commands.rateLimitPerMinute, 60_000);
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /**
   * `permissions` are what the caller's role holds: handing a secret to a run needs `vault:reveal` besides
   * `servers:exec` (a script can print what it reads, so it is a reveal in effect, ADR 0042).
   */
  async create(
    actor: Actor,
    request: CreateCommandRunRequest,
    meta: RequestMeta,
    permissions: readonly Permission[],
  ): Promise<CommandRunView> {
    if (!this.limiter.hit(actor.id)) {
      throw new RateLimitedException(60, 'Too many runs. Try again in a minute.');
    }

    // What runs, and at which level.
    let body: string;
    let scriptId: string | null = null;
    let scriptName: string | null = null;
    let scriptVersion: number | null = null;
    let label: string;
    let sudo: boolean;
    let level: DangerLevel;
    let values: ParameterValues = {};
    // The secrets of the run: the ones asked for by name, and those of the `secret` parameters of the script.
    const handed: { name: string; secretId: string; parameter: string | undefined }[] = (
      request.secrets ?? []
    ).map((entry) => ({ name: entry.name, secretId: entry.secretId, parameter: undefined }));
    let secretParameters: Readonly<Record<string, readonly string[]>> = {};
    if (request.mode === 'script') {
      const script = await this.scripts.find(request.scriptId);
      const definitions = ScriptParametersSchema.safeParse(script.parameters);
      if (!definitions.success) {
        throw new ConflictException(
          'The parameters of this script are not readable. Open the script and save it again.',
        );
      }
      const checked = checkParameterValues(definitions.data, request.parameters ?? {});
      if (!checked.ok) {
        throw invalidParameters(checked.issues);
      }
      values = checked.values;
      secretParameters = Object.fromEntries(
        definitions.data.flatMap((definition) =>
          definition.type === 'secret' ? [[definition.name, definition.secretTypes]] : [],
        ),
      );
      for (const [parameter, secretId] of Object.entries(checked.secrets)) {
        const name = parameterSecretName(parameter);
        if (handed.some((entry) => entry.name === name)) {
          throw invalidSecrets([
            {
              path: ['parameters', parameter],
              message: `A secret named ${name} was given in \`secrets\` as well.`,
            },
          ]);
        }
        handed.push({ name, secretId, parameter });
      }
      body = script.body;
      scriptId = script.id;
      scriptName = script.name;
      scriptVersion = script.version;
      label = script.name;
      sudo = script.sudo;
      level = script.dangerLevel;
    } else {
      body = normalizeBody(request.command);
      label = commandLabel(body);
      sudo = request.sudo ?? false;
      level = request.dangerLevel ?? 'change';
    }
    const secrets = await this.checkSecrets(actor, handed, secretParameters, permissions, meta);
    if (level !== 'read' && request.confirmedLevel !== level) {
      throw new CodedHttpException(
        409,
        'confirmation_required',
        `This run is at the level "${level}". Confirm it, naming the level, to start it.`,
        { level },
      );
    }

    // The servers: all must exist; one that cannot be used is a skipped target, not a failed request.
    const servers = await this.db.server.findMany({
      where: { id: { in: request.serverIds } },
      select: { id: true, name: true, _count: { select: { hostKeys: true, access: true } } },
    });
    const byId = new Map(servers.map((server) => [server.id, server]));
    const missing = request.serverIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `${String(missing.length)} of the servers do not exist (any more): ${missing.join(', ')}.`,
      );
    }

    const now = new Date();
    const runId = randomUUID();
    const targets = request.serverIds.map((serverId, ordinal) => {
      const server = byId.get(serverId);
      if (!server) {
        throw new Error('The servers were checked above.');
      }
      const id = randomUUID();
      const unusable =
        server._count.hostKeys === 0
          ? ({
              code: 'host_key_not_pinned',
              message: 'No host key is pinned for this server: scan it and confirm the key first.',
            } as const)
          : server._count.access === 0
            ? ({
                code: 'no_access_entry',
                message: 'This server has no way to log in: add an access entry first.',
              } as const)
            : null;
      return {
        id,
        runId,
        ordinal,
        serverId,
        serverName: server.name,
        state: unusable ? ('skipped' as const) : ('pending' as const),
        stepId: `sw-${id}`,
        errorCode: unusable?.code ?? null,
        errorMessage: unusable?.message ?? null,
        finishedAt: unusable ? now : null,
        stdoutTail: NO_BYTES(),
        stderrTail: NO_BYTES(),
      };
    });
    const bodySha256 = sha256Hex(body);
    const skipped = targets.filter((target) => target.state === 'skipped').length;

    await this.db.$transaction(async (tx) => {
      if (secrets.length > 0) {
        // Under the lock that replacing and deleting a secret take too: the run is queued with the values it checked.
        await this.vault.recheckForRun(tx, secrets);
      }
      await tx.commandRun.create({
        data: {
          id: runId,
          mode: request.mode,
          scriptId,
          scriptName,
          scriptVersion,
          label,
          body,
          bodySha256,
          sudo,
          dangerLevel: level,
          confirmedLevel: level === 'read' ? null : level,
          parameters: values,
          timeoutSeconds: request.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS,
          createdById: actor.id,
          createdByName: actor.name,
          createdAt: now,
        },
      });
      await tx.commandRunTarget.createMany({ data: targets });
      if (secrets.length > 0) {
        await tx.commandRunSecret.createMany({
          data: secrets.map((secret) => ({
            runId,
            name: secret.name,
            secretId: secret.secretId,
            secretName: secret.secretName,
            secretVersion: secret.version,
          })),
        });
        // One record for every secret that was handed over, in the same transaction as the run: no run, no record, and
        // no run without its record. It names the secret and the servers, never a value.
        const serverIds = request.serverIds
          .filter((id) =>
            targets.some((target) => target.serverId === id && target.state !== 'skipped'),
          )
          .slice(0, 5)
          .join(',');
        for (const secret of secrets) {
          await this.audit.record(
            {
              action: 'secret.used_in_run',
              outcome: 'success',
              actor,
              object: { type: 'secret', id: secret.secretId },
              details: {
                run: runId,
                name: secret.name,
                secret_name: secret.secretName.slice(0, 100),
                version: secret.version,
                servers: targets.length - skipped,
                server_ids: serverIds,
              },
              meta,
            },
            tx,
          );
        }
      }
      await this.audit.record(
        {
          action: 'command.run.started',
          outcome: 'success',
          actor,
          object: { type: 'command_run', id: runId },
          details: {
            mode: request.mode,
            level,
            servers: targets.length,
            skipped,
            sudo,
            confirmed: level !== 'read',
            timeout_seconds: request.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS,
            body_sha256: bodySha256,
            secrets: secrets.length,
            ...(scriptName === null ? {} : { script: scriptName, script_version: scriptVersion }),
          },
          meta,
        },
        tx,
      );
    });

    this.runner.kick(runId);
    return this.get(runId);
  }

  /**
   * Decides whether the secrets a run asks for may be handed to it, before anything is queued (ADR 0042): the role must
   * hold `vault:reveal`, the vault must be open (423), every secret must exist, be of a kind a run (and the parameter,
   * if it came from one) may have, and not have expired (409 `secret_expired`). Answers what the run is queued with.
   */
  private async checkSecrets(
    actor: Actor,
    handed: readonly { name: string; secretId: string; parameter: string | undefined }[],
    secretParameters: Readonly<Record<string, readonly string[]>>,
    permissions: readonly Permission[],
    meta: RequestMeta,
  ): Promise<{ name: string; secretId: string; secretName: string; version: number }[]> {
    if (handed.length === 0) {
      return [];
    }
    if (!permissions.includes('vault:reveal')) {
      await this.audit.note({
        action: 'authz.denied',
        outcome: 'denied',
        actor,
        object: { type: 'route', id: 'createCommandRun' },
        details: { permission: 'vault:reveal', via: 'session' },
        meta,
      });
      throw new ForbiddenException(
        'Handing a secret to a run needs the permission to reveal secrets: a script can print what it reads.',
      );
    }
    if (handed.length > MAX_RUN_SECRETS) {
      throw invalidSecrets([
        { path: ['secrets'], message: `At most ${String(MAX_RUN_SECRETS)} secrets.` },
      ]);
    }
    const found = await this.vault.inspectForRun(handed, { kind: 'command_run', id: actor.id });
    for (const [index, entry] of found.entries()) {
      const wanted = handed[index];
      const allowed =
        wanted?.parameter === undefined ? undefined : secretParameters[wanted.parameter];
      if (
        wanted?.parameter !== undefined &&
        allowed !== undefined &&
        !allowed.includes(entry.type)
      ) {
        throw invalidSecrets([
          {
            path: ['parameters', wanted.parameter],
            message: `This parameter takes a secret of the kind ${allowed.join(', ')}, not ${entry.type}.`,
          },
        ]);
      }
    }
    return found;
  }

  private async countsFor(runIds: readonly string[]): Promise<Map<string, CommandRunCounts>> {
    const grouped = await this.db.commandRunTarget.groupBy({
      by: ['runId', 'state'],
      where: { runId: { in: [...runIds] } },
      _count: { _all: true },
    });
    const counts = new Map<string, CommandRunCounts>();
    for (const row of grouped) {
      const entry = counts.get(row.runId) ?? { ...EMPTY_COUNTS };
      entry[row.state] += row._count._all;
      entry.total += row._count._all;
      counts.set(row.runId, entry);
    }
    return counts;
  }

  async list(query: CommandRunListQuery): Promise<CommandRunList> {
    const where: Prisma.CommandRunWhereInput = {
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.serverId === undefined ? {} : { targets: { some: { serverId: query.serverId } } }),
    };
    const [rows, total] = await Promise.all([
      this.db.commandRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
      }),
      this.db.commandRun.count({ where }),
    ]);
    const counts = await this.countsFor(rows.map((row) => row.id));
    return {
      runs: rows.map((row) => summaryOf(row, counts.get(row.id) ?? { ...EMPTY_COUNTS })),
      total,
    };
  }

  async get(id: string): Promise<CommandRunView> {
    const row = await this.db.commandRun.findUnique({
      where: { id },
      include: { targets: { orderBy: { ordinal: 'asc' } }, secrets: true },
    });
    if (!row) {
      throw new NotFoundException('There is no such run.');
    }
    return viewOf(row, row.targets, row.secrets);
  }

  /** The bytes `[start, start + length)` of what is kept of one stream, from the chunks it was stored in. */
  private async readRange(
    targetId: string,
    stream: 'stdout' | 'stderr',
    start: number,
    length: number,
  ): Promise<Buffer> {
    const first = await this.db.commandOutputChunk.findFirst({
      where: { targetId, stream, startOffset: { lte: start } },
      orderBy: { startOffset: 'desc' },
    });
    if (!first) {
      return Buffer.alloc(0);
    }
    const rest = await this.db.commandOutputChunk.findMany({
      where: { targetId, stream, startOffset: { gt: first.startOffset, lt: start + length } },
      orderBy: { startOffset: 'asc' },
    });
    const joined = Buffer.concat([first, ...rest].map((chunk) => Buffer.from(chunk.data)));
    return joined.subarray(start - first.startOffset, start - first.startOffset + length);
  }

  async output(
    runId: string,
    targetId: string,
    query: CommandOutputQuery,
  ): Promise<CommandOutputPage> {
    const target = await this.db.commandRunTarget.findFirst({
      where: { id: targetId, runId },
      include: { run: { select: { state: true } } },
    });
    if (!target) {
      throw new NotFoundException('There is no such server in this run.');
    }
    const stored = query.stream === 'stdout' ? target.stdoutStored : target.stderrStored;
    const size = query.stream === 'stdout' ? target.stdoutSize : target.stderrSize;
    const truncated = query.stream === 'stdout' ? target.stdoutTruncated : target.stderrTruncated;
    const offset = Math.min(query.offset ?? 0, stored);
    const limit = query.limit ?? OUTPUT_PAGE_DEFAULT;
    // Three bytes more than asked, so that a character that straddles the end can be seen whole.
    const window = await this.readRange(targetId, query.stream, offset, limit + 3);
    const growing = !isFinishedRun(target.run.state) && target.state === 'running';
    const page = pageOf(window, limit, offset + window.length < stored || growing);
    return {
      stream: query.stream,
      offset,
      nextOffset: offset + page.length,
      text: displayText(page),
      storedBytes: stored,
      totalBytes: Math.max(size, stored),
      truncated,
      eof: offset + page.length >= stored,
    };
  }

  /**
   * Asks for a run to stop. The flag and the targets that have not started are one atomic step; the targets that run
   * are stopped by the runner, which sees the flag within a poll. Asking twice is harmless; a run that has ended is 409.
   */
  async cancel(actor: Actor, id: string, meta: RequestMeta): Promise<CommandRunView> {
    await this.db.$transaction(async (tx) => {
      const now = new Date();
      const flagged = await tx.commandRun.updateMany({
        where: { id, cancelRequestedAt: null, state: { in: ['pending', 'running'] } },
        data: { cancelRequestedAt: now },
      });
      if (flagged.count === 0) {
        const run = await tx.commandRun.findUnique({ where: { id } });
        if (!run) {
          throw new NotFoundException('There is no such run.');
        }
        if (isFinishedRun(run.state)) {
          throw new ConflictException('This run has ended already.');
        }
        // Somebody asked a moment ago and the servers are being stopped: the same run, nothing more to do.
        return;
      }
      const running = await tx.commandRunTarget.count({ where: { runId: id, state: 'running' } });
      const cancelled = await tx.commandRunTarget.updateMany({
        where: { runId: id, state: 'pending' },
        data: {
          state: 'cancelled',
          finishedAt: now,
          errorCode: 'cancelled',
          errorMessage: 'The run was stopped before it reached this server.',
        },
      });
      await this.audit.record(
        {
          action: 'command.run.cancelled',
          outcome: 'success',
          actor,
          object: { type: 'command_run', id },
          details: { running, cancelled_before_start: cancelled.count },
          meta,
        },
        tx,
      );
    });
    // The runner may have nothing left to do (every target was waiting): let it close the run.
    this.runner.kick(id);
    return this.get(id);
  }
}
