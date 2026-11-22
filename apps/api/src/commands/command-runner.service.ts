import {
  type BeforeApplicationShutdown,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type CommandRunState,
  type CommandTargetState,
  FINISHED_RUN_STATES,
  OUTPUT_TAIL_BYTES,
  PARAMETER_NAME_PATTERN,
  parameterEnvName,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';
import {
  cancelStep,
  getStepStatus,
  readStepOutput,
  removeStep,
  type StepStatus,
  SshStepError,
  startDetachedStep,
  type SudoOptions,
} from '@swellwright/ssh';

import { AuditService } from '../audit/audit.service.js';
import { requireDatabase } from '../auth/context.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException } from '../http.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService, type SshSession } from '../servers/ssh.service.js';
import { CONFIG, DATABASE } from '../tokens.js';

type TargetRow = Prisma.CommandRunTargetGetPayload<{ include: { run: true } }>;
type Stream = 'stdout' | 'stderr';

/** A read of the server's file that goes at most this far at a time. */
const READ_BYTES = 256 * 1024;
/** A server that does not start a script gets this many tries; a script that already runs is waited for much longer. */
const START_ATTEMPTS = 2;
/** Failures nobody expected (a defect, not a server) end a target after this many in a row. */
const UNKNOWN_FAILURES = 5;
/** A step that exists but has not recorded a process this long after it was made is given up. */
const UNKNOWN_STEP_MS = 60_000;

/** The kinds of failure that end a target at once: nothing will change by trying again. */
const FATAL_CODES = new Set([
  'host_key_mismatch',
  'host_key_not_pinned',
  'address_not_allowed',
  'no_access_entry',
  'ssh_auth_failed',
  'ssh_key_invalid',
  // The secret of every access entry expired before the script was started: renewing it is a person's job (ADR 0042).
  'secret_expired',
]);
/** The kinds that pass: the server may come back, the connection may be made again. */
const TRANSIENT_CODES = new Set(['ssh_connect_failed', 'ssh_timeout', 'ssh_failed']);

/** The row changed under the runner's hands (a finish, a restart overlapping): read it again. */
class StaleTargetError extends Error {}

type Verdict =
  | { readonly kind: 'fatal'; readonly code: string; readonly message: string }
  | { readonly kind: 'transient'; readonly code: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unknown' };

/** What the work of one poll found out. */
type WorkResult =
  | { readonly kind: 'running'; readonly progressed: boolean }
  | { readonly kind: 'exited'; readonly exitCode: number; readonly truncated: boolean }
  | {
      readonly kind: 'lost';
      readonly truncated: boolean;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'gone' }
  | { readonly kind: 'start_failed'; readonly message: string };

interface TargetContext {
  startFailures: number;
  unknownFailures: number;
  /** Polls in a row that brought nothing new: the interval grows with them, up to four times the base. */
  idle: number;
}

/** What the vault says when it cannot give a secret: a sealed vault passes, the rest does not. */
function isVaultProblem(error: unknown): error is Error {
  return (
    error instanceof NotFoundException ||
    error instanceof ConflictException ||
    error instanceof InternalServerErrorException
  );
}

function classify(error: unknown): Verdict {
  if (error instanceof StaleTargetError) {
    return { kind: 'stale' };
  }
  if (error instanceof CodedHttpException) {
    if (FATAL_CODES.has(error.apiCode)) {
      return { kind: 'fatal', code: error.apiCode, message: error.message };
    }
    if (TRANSIENT_CODES.has(error.apiCode)) {
      return { kind: 'transient', code: error.apiCode };
    }
    return { kind: 'unknown' };
  }
  if (error instanceof HttpException) {
    if (error.getStatus() === 423) {
      return { kind: 'transient', code: 'vault_sealed' };
    }
    if (isVaultProblem(error)) {
      return {
        kind: 'fatal',
        code: 'secret_unavailable',
        message: 'The secret this access entry names cannot be used any more.',
      };
    }
  }
  return { kind: 'unknown' };
}

/** The environment a script gets from the values of its parameters: only names that could be parameters. */
export function environmentOf(parameters: Prisma.JsonValue): Record<string, string> {
  const env: Record<string, string> = {};
  if (parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)) {
    for (const [name, value] of Object.entries(parameters)) {
      if (!PARAMETER_NAME_PATTERN.test(name) || value === null || typeof value === 'object') {
        continue;
      }
      env[parameterEnvName(name)] =
        typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    }
  }
  return env;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', done);
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Does the work of a run (ADR 0038): for every server of it, starts the script as a detached step, follows it by
 * polling (status, then new output by byte offset), stores the output, enforces the timeout, stops it when a person
 * asks, and closes the run when every server is done. It is a deliberately small precursor of the engine of phase 4:
 * no approvals, no policies, no resumable plan, only what the step layer already makes durable.
 *
 * Everything it knows is in the database: each poll starts from the target's row, so a restart of the API picks up where
 * the last poll stopped (the steps run on the servers meanwhile), and a poll that fails is simply the next one. The
 * output is read from the offset that is stored, so a connection that drops costs nothing and repeats nothing.
 */
@Injectable()
export class CommandRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('CommandRunner');
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private stopping = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ServersService) private readonly servers: ServersService,
    @Inject(SshService) private readonly ssh: SshService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** Runs that were going when the process stopped are taken up again. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.database) {
      return;
    }
    try {
      const runs = await this.db.commandRun.findMany({
        where: { state: { in: ['pending', 'running'] } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const run of runs) {
        this.kick(run.id);
      }
      if (runs.length > 0) {
        this.logger.log(
          `taking up ${String(runs.length)} run(s) that were going when the server stopped`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `could not look for runs to take up: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Stops following: what runs on the servers keeps running (that is the point of a detached step) and the next start
   * takes it up. Waits for the polls in flight, so that nothing touches the database once it is closed.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    // A poll may sit in a connection to a server that does not answer: end the connections so that it returns.
    this.ssh.closeConnections();
    await Promise.allSettled([...this.active.values()]);
  }

  /** Whether the shutdown has begun (a method, so that a check after an await is not narrowed away). */
  private isStopping(): boolean {
    return this.stopping;
  }

  /** Resolves when no run is being worked on (tests wait for this). */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
  }

  /** Starts working on a run in the background, unless it is being worked on already. */
  kick(runId: string): void {
    if (this.stopping || this.active.has(runId)) {
      return;
    }
    const work = this.processRun(runId)
      .catch((error: unknown) => {
        this.logger.error(
          `run ${runId}: ${error instanceof Error ? (error.stack ?? error.message) : 'unknown error'}`,
        );
      })
      .finally(() => {
        this.active.delete(runId);
      });
    this.active.set(runId, work);
  }

  private async processRun(runId: string): Promise<void> {
    const targets = await this.db.commandRunTarget.findMany({
      where: { runId, state: { in: ['pending', 'running'] } },
      select: { id: true, state: true, ordinal: true },
    });
    // Servers that run already are followed first: nothing is waited for there.
    const queue = [...targets].sort(
      (a, b) =>
        Number(b.state === 'running') - Number(a.state === 'running') || a.ordinal - b.ordinal,
    );
    const workers = Array.from(
      { length: Math.min(this.config.commands.concurrency, queue.length) },
      async () => {
        for (;;) {
          const next = queue.shift();
          if (!next || this.stopping) {
            return;
          }
          try {
            await this.runTarget(runId, next.id);
          } catch (error) {
            if (!this.isStopping()) {
              this.logger.error(
                `run ${runId}, target ${next.id}: ${error instanceof Error ? (error.stack ?? error.message) : 'unknown error'}`,
              );
              await this.endOnDefect(next.id);
            }
          }
        }
      },
    );
    await Promise.all(workers);
    if (!this.stopping) {
      await this.finalizeRun(runId);
    }
  }

  /** A defect in the runner must not leave a server running for ever in the list. */
  private async endOnDefect(targetId: string): Promise<void> {
    try {
      await this.db.commandRunTarget.updateMany({
        where: { id: targetId, state: { in: ['pending', 'running'] } },
        data: {
          state: 'failed',
          errorCode: 'internal_error',
          errorMessage: 'Swellwright failed while following this server. See its log.',
          finishedAt: new Date(),
          waiting: null,
        },
      });
    } catch {
      // The database is the problem; the next start takes the target up again.
    }
  }

  private async runTarget(runId: string, targetId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.db.commandRunTarget.updateMany({
      where: { id: targetId, state: 'pending' },
      data: { state: 'running', startedAt: now, lastContactAt: now },
    });
    if (claimed.count === 1) {
      // The first server that starts starts the run.
      await this.db.commandRun.updateMany({
        where: { id: runId, state: 'pending' },
        data: { state: 'running', startedAt: now },
      });
    }
    const context: TargetContext = { startFailures: 0, unknownFailures: 0, idle: 0 };
    const base = this.config.commands.pollMs;
    while (!this.stopping) {
      const result = await this.poll(targetId, context);
      if (result === 'done') {
        return;
      }
      context.idle = result === 'progress' ? 0 : Math.min(context.idle + 1, 2);
      await sleep(base * 2 ** context.idle, this.abort.signal);
    }
  }

  /** One look at a server: start (once), status, new output, and the end when there is one. */
  private async poll(
    targetId: string,
    context: TargetContext,
  ): Promise<'done' | 'progress' | 'quiet'> {
    const row = await this.db.commandRunTarget.findUnique({
      where: { id: targetId },
      include: { run: true },
    });
    if (row?.state !== 'running') {
      return 'done';
    }
    if (row.serverId === null) {
      return this.endDeleted(row);
    }
    let info;
    try {
      info = await this.servers.connectionInfo(row.serverId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        return this.endDeleted(row);
      }
      throw error;
    }
    if (
      (info.fingerprints.length === 0 || info.access.length === 0) &&
      !(await this.serverExists(row.serverId))
    ) {
      // The server went while its keys and access entries were read: it is what happened, not a missing key.
      return this.endDeleted(row);
    }
    if (info.fingerprints.length === 0) {
      return this.end(row, 'failed', {
        errorCode: 'host_key_not_pinned',
        errorMessage: row.launched
          ? 'The pinned host key was revoked while the script ran. The script may still be running.'
          : 'No host key is pinned for this server any more.',
      });
    }
    if (info.access.length === 0) {
      return this.end(row, 'failed', {
        errorCode: 'no_access_entry',
        errorMessage: 'The server has no access entry any more.',
      });
    }

    let result: WorkResult;
    try {
      result = await this.contact(row, info, context);
    } catch (error) {
      if (this.stopping) {
        return 'done';
      }
      return this.afterFailure(row, error, context);
    }
    context.startFailures = 0;
    context.unknownFailures = 0;

    switch (result.kind) {
      case 'running':
        return result.progressed ? 'progress' : 'quiet';
      case 'exited':
        return this.endExited(row, result.exitCode, result.truncated, info);
      case 'lost':
        return this.end(
          row,
          'lost',
          { errorCode: result.code, errorMessage: result.message },
          info,
          result.truncated,
        );
      case 'gone':
        if (row.run.cancelRequestedAt !== null) {
          return this.end(row, 'cancelled', {
            errorCode: 'cancelled',
            errorMessage: 'Stopped by a person; nothing was left on the server.',
          });
        }
        return this.end(row, 'lost', {
          errorCode: 'step_lost',
          errorMessage:
            'The record of this run is gone from the server (it was removed, or the server was rebuilt), so the result is unknown.',
        });
      case 'start_failed':
        return this.end(row, 'failed', {
          errorCode: 'start_failed',
          errorMessage: result.message,
        });
    }
  }

  /** The server of a target is gone: the target ends, and says whether the script may still be running there. */
  private endDeleted(row: TargetRow): Promise<'done' | 'quiet'> {
    return this.end(row, 'failed', {
      errorCode: 'server_deleted',
      errorMessage: row.launched
        ? 'The server was deleted while the script ran on it. The script may still be running.'
        : 'The server was deleted before the script started.',
    });
  }

  private async serverExists(serverId: string): Promise<boolean> {
    const found = await this.db.server.findUnique({
      where: { id: serverId },
      select: { id: true },
    });
    return found !== null;
  }

  /** What a failed poll means: end the target, or wait and try again. */
  private async afterFailure(
    row: TargetRow,
    error: unknown,
    context: TargetContext,
  ): Promise<'done' | 'quiet'> {
    const verdict = classify(error);
    if (verdict.kind === 'stale') {
      return 'quiet';
    }
    // A server that was deleted in the middle of a poll fails in whatever way the poll happened to be: say what happened.
    if (row.serverId !== null && !(await this.serverExists(row.serverId))) {
      return this.endDeleted(row);
    }
    if (verdict.kind === 'fatal') {
      return this.end(row, 'failed', { errorCode: verdict.code, errorMessage: verdict.message });
    }
    if (verdict.kind === 'unknown') {
      context.unknownFailures += 1;
      this.logger.error(
        `target ${row.id}: ${error instanceof Error ? (error.stack ?? error.message) : 'unknown error'}`,
      );
      if (context.unknownFailures >= UNKNOWN_FAILURES) {
        return this.end(row, 'failed', {
          errorCode: 'internal_error',
          errorMessage:
            'Swellwright failed in a way it did not expect while following this server.',
        });
      }
      return 'quiet';
    }
    // The server cannot be reached for now (or the vault is sealed): the script, if it runs, is not affected.
    if (!row.launched) {
      context.startFailures += 1;
      if (context.startFailures >= START_ATTEMPTS) {
        return this.end(row, 'failed', {
          errorCode: verdict.code,
          errorMessage: error instanceof Error ? error.message : 'The server could not be reached.',
        });
      }
    } else {
      const since = (row.lastContactAt ?? row.startedAt ?? new Date()).getTime();
      if (Date.now() - since > this.config.commands.lostAfterMs) {
        return this.end(row, 'lost', {
          errorCode: 'unreachable',
          errorMessage: `The server did not answer for ${String(Math.round(this.config.commands.lostAfterMs / 60_000))} minutes, so the result is unknown. The script may have finished or may still be running.`,
        });
      }
    }
    await this.db.commandRunTarget.updateMany({
      where: { id: row.id, state: 'running' },
      data: { waiting: verdict.code },
    });
    return 'quiet';
  }

  /**
   * Opens a connection with the access entry that worked before (or tries the entries by priority the first time:
   * a wrong password is tried once per entry, never again) and does the work of one poll on it.
   */
  private async contact(
    row: TargetRow,
    info: Awaited<ReturnType<ServersService['connectionInfo']>>,
    context: TargetContext,
  ): Promise<WorkResult> {
    const remembered = info.access.filter((entry) => entry.id === row.accessId);
    const entries = remembered.length > 0 ? remembered : info.access;
    let refused: unknown;
    for (const entry of entries) {
      try {
        const result = await this.ssh.withAccess(
          { address: info.address, port: info.port, hostKeyTypes: info.hostKeyTypes },
          info.fingerprints,
          entry,
          (session) => this.work(session, row, context),
          // A script that has started is followed to its end whatever happens to the credential meanwhile: an expiry
          // is checked when a use begins, not in the middle of one (ADR 0042).
          { allowExpired: row.launched || row.run.cancelRequestedAt !== null },
        );
        if (row.accessId !== entry.id) {
          await this.db.commandRunTarget.updateMany({
            where: { id: row.id, state: 'running' },
            data: { accessId: entry.id },
          });
          row.accessId = entry.id;
        }
        return result;
      } catch (error) {
        if (
          error instanceof CodedHttpException &&
          (error.apiCode === 'ssh_auth_failed' ||
            error.apiCode === 'ssh_key_invalid' ||
            error.apiCode === 'secret_expired') &&
          entries.length > 1
        ) {
          refused = error;
          continue;
        }
        throw error;
      }
    }
    throw refused;
  }

  private async work(
    session: SshSession,
    row: TargetRow,
    context: TargetContext,
  ): Promise<WorkResult> {
    const { connection, sudoPassword } = session;
    const run = row.run;
    const sudo: SudoOptions | undefined = run.sudo
      ? sudoPassword === undefined
        ? {}
        : { password: sudoPassword }
      : undefined;
    const cancelling = run.cancelRequestedAt !== null;

    if (!row.launched && !cancelling) {
      try {
        await startDetachedStep(connection, {
          id: row.stepId,
          script: run.body,
          env: environmentOf(run.parameters),
          ...(sudo === undefined ? {} : { sudo }),
        });
      } catch (error) {
        if (error instanceof SshStepError) {
          return { kind: 'start_failed', message: error.message };
        }
        throw error;
      }
      await this.db.commandRunTarget.updateMany({
        where: { id: row.id, state: 'running' },
        data: { launched: true },
      });
      row.launched = true;
    }

    let status: StepStatus;
    try {
      status = await getStepStatus(connection, row.stepId);
    } catch (error) {
      if (error instanceof SshStepError && error.code === 'ssh_step_not_found') {
        return { kind: 'gone' };
      }
      throw error;
    }

    // Stop it when a person asked, or when it ran too long.
    const deadline = (row.startedAt ?? new Date()).getTime() + run.timeoutSeconds * 1000;
    if (status.state === 'running' && (cancelling || Date.now() > deadline)) {
      if (!cancelling && row.errorCode !== 'timeout') {
        const message = `The script did not finish within ${String(run.timeoutSeconds)} seconds and was stopped.`;
        await this.db.commandRunTarget.updateMany({
          where: { id: row.id, state: 'running' },
          data: { errorCode: 'timeout', errorMessage: message },
        });
        row.errorCode = 'timeout';
        row.errorMessage = message;
      }
      await cancelStep(connection, row.stepId, { ...(sudo === undefined ? {} : { sudo }) });
      status = await getStepStatus(connection, row.stepId);
    }

    // The status was read first: when it says the step is over, everything it wrote is in the files.
    const drained = await this.drain(connection, row, status);

    if (status.state === 'exited') {
      return { kind: 'exited', exitCode: status.exitCode ?? -1, truncated: drained.truncated };
    }
    if (status.state === 'lost') {
      return {
        kind: 'lost',
        truncated: drained.truncated,
        code: 'step_lost',
        message:
          "The script's process is gone and left no exit status (the server may have been rebooted or the process killed).",
      };
    }
    if (
      status.state === 'unknown' &&
      Date.now() - (row.startedAt ?? new Date()).getTime() > UNKNOWN_STEP_MS
    ) {
      return {
        kind: 'lost',
        truncated: drained.truncated,
        code: 'step_lost',
        message: 'The script never started a process on the server.',
      };
    }
    context.startFailures = 0;
    return { kind: 'running', progressed: drained.progressed };
  }

  /**
   * Reads what the script wrote since the last poll, up to the limit, stores it and records that the server answered.
   * The offset that is stored is where the next read starts, and a chunk whose offset was stored already is refused by
   * its key, so a connection that drops costs nothing and repeats nothing.
   */
  private async drain(
    connection: SshSession['connection'],
    row: TargetRow,
    status: StepStatus,
  ): Promise<{ progressed: boolean; truncated: boolean }> {
    const limit = this.config.commands.outputLimitBytes;
    let progressed = false;
    const counters: Record<
      Stream,
      { stored: number; tail: Uint8Array; size: number; truncated: boolean }
    > = {
      stdout: {
        stored: row.stdoutStored,
        tail: row.stdoutTail,
        size: status.stdoutBytes,
        truncated: row.stdoutTruncated,
      },
      stderr: {
        stored: row.stderrStored,
        tail: row.stderrTail,
        size: status.stderrBytes,
        truncated: row.stderrTruncated,
      },
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = counters[stream];
      while (state.stored < state.size && state.stored < limit) {
        const slice = await readStepOutput(connection, row.stepId, {
          stream,
          fromOffset: state.stored,
          maxBytes: Math.min(READ_BYTES, limit - state.stored),
        });
        if (slice.data.length === 0) {
          break;
        }
        const tail = Buffer.concat([state.tail, slice.data]).subarray(-OUTPUT_TAIL_BYTES);
        await this.append(row.id, stream, state.stored, slice.data, tail, state.size);
        state.stored += slice.data.length;
        state.tail = tail;
        progressed = true;
      }
      state.truncated = state.size > state.stored && state.stored >= limit;
    }
    // The server answered: remember it, and what the files hold now.
    await this.db.commandRunTarget.updateMany({
      where: { id: row.id, state: 'running' },
      data: {
        lastContactAt: new Date(),
        waiting: null,
        stdoutSize: counters.stdout.size,
        stdoutTruncated: counters.stdout.truncated,
        stderrSize: counters.stderr.size,
        stderrTruncated: counters.stderr.truncated,
      },
    });
    return {
      progressed,
      truncated: counters.stdout.truncated || counters.stderr.truncated,
    };
  }

  /** Stores one piece of output and moves the offset, or refuses when the row is not where the caller thinks. */
  private async append(
    targetId: string,
    stream: Stream,
    startOffset: number,
    data: Buffer,
    tail: Uint8Array,
    size: number,
  ): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const moved =
          stream === 'stdout'
            ? await tx.commandRunTarget.updateMany({
                where: { id: targetId, state: 'running', stdoutStored: startOffset },
                data: {
                  stdoutStored: startOffset + data.length,
                  stdoutTail: new Uint8Array(tail),
                  stdoutSize: size,
                },
              })
            : await tx.commandRunTarget.updateMany({
                where: { id: targetId, state: 'running', stderrStored: startOffset },
                data: {
                  stderrStored: startOffset + data.length,
                  stderrTail: new Uint8Array(tail),
                  stderrSize: size,
                },
              });
        if (moved.count === 0) {
          throw new StaleTargetError();
        }
        await tx.commandOutputChunk.create({
          data: { targetId, stream, startOffset, data: new Uint8Array(data) },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new StaleTargetError();
      }
      throw error;
    }
  }

  private async endExited(
    row: TargetRow,
    exitCode: number,
    truncated: boolean,
    info: Awaited<ReturnType<ServersService['connectionInfo']>>,
  ): Promise<'done'> {
    const cancelling = row.run.cancelRequestedAt !== null;
    if (exitCode === 0) {
      return this.end(row, 'succeeded', { exitCode }, info, truncated);
    }
    if (row.errorCode === 'timeout') {
      return this.end(
        row,
        'failed',
        { exitCode, errorCode: 'timeout', errorMessage: row.errorMessage },
        info,
        truncated,
      );
    }
    if (cancelling && (exitCode === 143 || exitCode === 137)) {
      return this.end(
        row,
        'cancelled',
        { exitCode, errorCode: 'cancelled', errorMessage: 'Stopped by a person.' },
        info,
        truncated,
      );
    }
    return this.end(row, 'failed', { exitCode }, info, truncated);
  }

  /**
   * Ends a target: one atomic step from `running`, and when the script ended by itself and its output is all kept, the
   * record of it is removed from the server. (A truncated output stays there: it is the only complete copy.)
   */
  private async end(
    row: TargetRow,
    state: Extract<CommandTargetState, 'succeeded' | 'failed' | 'lost' | 'cancelled'>,
    detail: { exitCode?: number; errorCode?: string; errorMessage?: string | null },
    info?: Awaited<ReturnType<ServersService['connectionInfo']>>,
    truncated = false,
  ): Promise<'done'> {
    const ended = await this.db.commandRunTarget.updateMany({
      where: { id: row.id, state: 'running' },
      data: {
        state,
        finishedAt: new Date(),
        waiting: null,
        ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
        ...(detail.errorCode === undefined ? {} : { errorCode: detail.errorCode }),
        ...(detail.errorMessage === undefined
          ? {}
          : { errorMessage: detail.errorMessage?.slice(0, 500) ?? null }),
      },
    });
    const mayRemove =
      ended.count === 1 &&
      info !== undefined &&
      !truncated &&
      (state === 'succeeded' || state === 'failed' || state === 'cancelled') &&
      row.launched &&
      row.accessId !== null;
    if (mayRemove) {
      await this.removeRecord(row, info);
    }
    return 'done';
  }

  /** Best effort: the output is stored, so a record that stays on the server is only untidy. */
  private async removeRecord(
    row: TargetRow,
    info: Awaited<ReturnType<ServersService['connectionInfo']>>,
  ): Promise<void> {
    const entry = info.access.find((candidate) => candidate.id === row.accessId);
    if (!entry || this.stopping) {
      return;
    }
    try {
      await this.ssh.withAccess(
        { address: info.address, port: info.port, hostKeyTypes: info.hostKeyTypes },
        info.fingerprints,
        entry,
        async ({ connection, sudoPassword }) => {
          await removeStep(connection, row.stepId, {
            ...(row.run.sudo
              ? { sudo: sudoPassword === undefined ? {} : { password: sudoPassword } }
              : {}),
          });
        },
        // Tidying up after a script that started: allowed even if the credential has expired since.
        { allowExpired: true },
      );
    } catch (error) {
      this.logger.warn(
        `could not remove the record of target ${row.id} from its server: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Closes a run when every server of it is over: one atomic step from `pending` or `running`, with its audit record in
   * the same transaction. Whoever calls it second finds the run closed and does nothing.
   */
  async finalizeRun(runId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const run = await tx.commandRun.findUnique({ where: { id: runId } });
      if (!run || FINISHED_RUN_STATES.includes(run.state)) {
        return;
      }
      const grouped = await tx.commandRunTarget.groupBy({
        by: ['state'],
        where: { runId },
        _count: { _all: true },
      });
      const count = (state: CommandTargetState): number =>
        grouped.find((entry) => entry.state === state)?._count._all ?? 0;
      const total = grouped.reduce((sum, entry) => sum + entry._count._all, 0);
      if (count('pending') + count('running') > 0) {
        return;
      }
      const state: CommandRunState =
        run.cancelRequestedAt !== null
          ? 'cancelled'
          : count('succeeded') === total
            ? 'succeeded'
            : count('succeeded') === 0
              ? 'failed'
              : 'partial';
      const finishedAt = new Date();
      const closed = await tx.commandRun.updateMany({
        where: { id: runId, state: { in: ['pending', 'running'] } },
        data: { state, finishedAt },
      });
      if (closed.count === 0) {
        return;
      }
      await this.audit.record(
        {
          action: 'command.run.finished',
          outcome: state === 'succeeded' ? 'success' : 'failure',
          actor: null,
          object: { type: 'command_run', id: runId },
          details: {
            state,
            servers: total,
            succeeded: count('succeeded'),
            failed: count('failed'),
            lost: count('lost'),
            cancelled: count('cancelled'),
            skipped: count('skipped'),
            duration_ms: finishedAt.getTime() - (run.startedAt ?? run.createdAt).getTime(),
            started_by: run.createdByName,
          },
          meta: { ip: undefined, requestId: undefined },
        },
        tx,
      );
    });
  }
}
