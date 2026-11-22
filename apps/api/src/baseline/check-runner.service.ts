import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { BaselineDocument, ObservedValue } from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';
import {
  cancelStep,
  removeStep,
  SshAbortError,
  type SshConnection,
  SshStepError,
  startDetachedStep,
  type StepStatus,
  type SudoOptions,
  waitForStep,
} from '@swellwright/ssh';

import { AuditService } from '../audit/audit.service.js';
import { requireDatabase } from '../auth/context.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, VaultSealedException } from '../http.js';
import { ServersService } from '../servers/servers.service.js';
import { type SshSession, SshService } from '../servers/ssh.service.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { BaselinesService } from './baselines.service.js';
import { countOf, evaluateCheck } from './evaluate.js';
import { diffResults, trendOf } from './diff.js';
import { parseObservations } from './parse.js';
import { buildPlan, type Plan } from './plan.js';
import { loadObserveScript, type ObserveScript } from './script.js';

/** The script prints a few kilobytes; a megabyte means something is wrong, and the rest is cut. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** The quick probes (who am I, may I sudo) never wait longer than this. */
const PROBE_TIMEOUT_MS = 20_000;

/** A failure of a run that has a code of its own; the run records the code and the message. */
class ObserveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Observed {
  readonly stdout: Buffer;
  readonly truncated: boolean;
  readonly exitCode: number | null;
  readonly collectedAs: 'root' | 'sudo' | 'user';
  /** Where in time the server read its clock, as far as this server can tell. */
  readonly clockMs: number;
}

/** The codes that mean "this access entry does not log in; the next one may". */
const NEXT_ENTRY = new Set<string>(['ssh_auth_failed', 'ssh_key_invalid', 'secret_expired']);

type RunRow = Prisma.CheckRunGetPayload<object>;

/**
 * Runs baseline checks (ADR 0045). A run is a row that was queued by `CheckRunsService`; this class takes queued runs
 * `SW_CHECKS_PARALLELISM` at a time, connects to the server with its stored access entries (the pinned host key first),
 * runs the observation script as one detached step in one SSH session, reads its output strictly, compares it with the
 * baseline version the run was queued with and stores the results with the run's counts and its drift against the
 * previous run, all in one transaction with the audit record. A server that cannot be observed ends the run as `error`
 * with the code of the failure; nothing here crashes the process or another run.
 *
 * Nothing is written to the server except the step directory of the SSH layer (the script and its output), which is
 * removed when the run is over.
 */
@Injectable()
export class CheckRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('CheckRunner');
  private readonly queue: string[] = [];
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly script: ObserveScript;
  private stopping = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ServersService) private readonly servers: ServersService,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(BaselinesService) private readonly baselines: BaselinesService,
  ) {
    // Read now, so that a build without the script fails at start and not at the first run.
    this.script = loadObserveScript();
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  get scriptSha256(): string {
    return this.script.sha256;
  }

  /**
   * A run that was queued or going on when the process stopped is over: nothing remembers it, and the vault is sealed
   * after a restart. It is closed as an error that says so, and a person (or the schedule) starts another.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.database) {
      return;
    }
    try {
      await this.db.checkRun.updateMany({
        where: { state: { in: ['queued', 'running'] } },
        data: {
          state: 'error',
          finishedAt: new Date(),
          errorCode: 'interrupted',
          errorMessage: 'The server of Swellwright stopped before this check finished.',
        },
      });
    } catch (error) {
      this.logger.warn(
        `could not close the runs that were going on: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.queue.length = 0;
    this.abort.abort();
    await Promise.allSettled([...this.active.values()]);
  }

  /** Puts runs in the queue; the first ones start at once. */
  enqueue(runIds: readonly string[]): void {
    if (this.stopping) {
      return;
    }
    this.queue.push(...runIds);
    this.pump();
  }

  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.queue.length > 0 || this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
      if (this.queue.length > 0 && this.active.size === 0) {
        this.pump();
      }
    }
  }

  private pump(): void {
    while (!this.stopping && this.active.size < this.config.baseline.parallelism) {
      const next = this.queue.shift();
      if (next === undefined) {
        return;
      }
      const running = this.execute(next)
        .catch((error: unknown) => {
          this.logger.error(
            `run ${next} failed in the runner: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        })
        .finally(() => {
          this.active.delete(next);
          this.pump();
        });
      this.active.set(next, running);
    }
  }

  // ---- one run -------------------------------------------------------------------------------------------------

  private async execute(runId: string): Promise<void> {
    const started = await this.db.checkRun.updateMany({
      where: { id: runId, state: 'queued' },
      data: { state: 'running', startedAt: new Date() },
    });
    if (started.count !== 1) {
      return;
    }
    const run = await this.db.checkRun.findUnique({ where: { id: runId } });
    if (!run) {
      return;
    }
    try {
      await this.observeAndStore(run);
    } catch (error) {
      await this.failRun(run, error);
    }
  }

  private async observeAndStore(run: RunRow): Promise<void> {
    const document = await this.documentOf(run);
    const plan = buildPlan(document);
    const info = await this.servers.connectionInfo(run.serverId);
    if (info.fingerprints.length === 0) {
      throw new ObserveError(
        'host_key_not_pinned',
        'No host key is pinned for this server. Scan its host key and confirm the fingerprint first.',
      );
    }
    if (info.access.length === 0) {
      throw new ObserveError(
        'no_access_entry',
        'This server has no way to log in. Add an access entry first.',
      );
    }
    let refusal: unknown;
    for (const entry of info.access) {
      try {
        const observed = await this.ssh.withAccess(
          { address: info.address, port: info.port, hostKeyTypes: info.hostKeyTypes },
          info.fingerprints,
          entry,
          (session) => this.observe(session, run, plan),
        );
        await this.store(run, document, plan, observed);
        return;
      } catch (error) {
        if (
          error instanceof CodedHttpException &&
          NEXT_ENTRY.has(error.apiCode) &&
          info.access.length > 1
        ) {
          // This entry does not log in (or its secret expired); the next one may.
          refusal = error;
          continue;
        }
        throw error;
      }
    }
    throw refusal;
  }

  private async documentOf(run: RunRow): Promise<BaselineDocument> {
    const version =
      run.profileId === null
        ? null
        : await this.db.baselineVersion.findUnique({
            where: {
              profileId_version: { profileId: run.profileId, version: run.baselineVersion },
            },
          });
    if (!version) {
      throw new ObserveError(
        'baseline_deleted',
        'The baseline of this run was deleted before the run started.',
      );
    }
    return this.baselines.documentOf(version);
  }

  /** Does the login have a working sudo: the stored password on standard input when there is one, otherwise `sudo -n`. */
  private async sudoWorks(
    connection: SshConnection,
    sudoPassword: string | undefined,
  ): Promise<boolean> {
    const result = await connection.exec('true', {
      sudo: sudoPassword === undefined ? {} : { password: sudoPassword },
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, this.config.baseline.timeoutMs),
    });
    return result.code === 0;
  }

  /** Runs the script as one detached step on the connection and reads what it printed. */
  private async observe(session: SshSession, run: RunRow, plan: Plan): Promise<Observed> {
    const { connection, sudoPassword } = session;
    const uid = await connection.exec('id -u', {
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, this.config.baseline.timeoutMs),
    });
    const isRoot = uid.code === 0 && uid.stdout.trim() === '0';
    const viaSudo = !isRoot && (await this.sudoWorks(connection, sudoPassword));
    const collectedAs = isRoot ? 'root' : viaSudo ? 'sudo' : 'user';
    const sudo: SudoOptions | undefined = viaSudo
      ? sudoPassword === undefined
        ? {}
        : { password: sudoPassword }
      : undefined;
    const stepId = `swb-${run.id}`;
    const before = Date.now();
    await startDetachedStep(connection, {
      id: stepId,
      script: this.script.text,
      stdin: plan.text,
      ...(sudo === undefined ? {} : { sudo }),
    });
    const clockMs = (before + Date.now()) / 2;

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const limit = new AbortController();
    const timer = setTimeout(() => {
      limit.abort();
    }, this.config.baseline.timeoutMs);
    let status: StepStatus;
    try {
      status = await waitForStep(connection, stepId, {
        pollMs: this.config.baseline.pollMs,
        signal: AbortSignal.any([limit.signal, this.abort.signal]),
        onOutput: (chunk) => {
          if (chunk.stream !== 'stdout') {
            return;
          }
          const room = MAX_OUTPUT_BYTES - size;
          if (chunk.data.length > room) {
            truncated = true;
          }
          if (room > 0) {
            const part = chunk.data.subarray(0, room);
            chunks.push(part);
            size += part.length;
          }
        },
      });
    } catch (error) {
      if (error instanceof SshAbortError) {
        await this.stop(connection, stepId, sudo);
        throw this.abort.signal.aborted
          ? new ObserveError(
              'interrupted',
              'The server of Swellwright stopped before this check finished.',
            )
          : new ObserveError(
              'check_timeout',
              `The check did not finish within ${String(this.config.baseline.timeoutMs / 1000)} seconds and was stopped.`,
            );
      }
      if (error instanceof SshStepError) {
        throw new ObserveError('observe_failed', error.message);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    try {
      await removeStep(connection, stepId, sudo === undefined ? {} : { sudo });
    } catch (error) {
      // What is left is a few kilobytes in the step directory of the login; the results are what matters.
      this.logger.warn(
        `could not remove the step of run ${run.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    if (status.state === 'lost') {
      throw new ObserveError(
        'observe_lost',
        'The script of the check ended without an exit status (the server may have been rebooted, or the process killed).',
      );
    }
    return {
      stdout: Buffer.concat(chunks),
      truncated,
      exitCode: status.exitCode,
      collectedAs,
      clockMs,
    };
  }

  private async stop(
    connection: SshConnection,
    stepId: string,
    sudo: SudoOptions | undefined,
  ): Promise<void> {
    try {
      await cancelStep(connection, stepId, {
        ...(sudo === undefined ? {} : { sudo }),
        graceMs: 2000,
      });
      await removeStep(connection, stepId, {
        ...(sudo === undefined ? {} : { sudo }),
        force: true,
      });
    } catch {
      // The connection may be the very thing that is broken; the script has a deadline of its own tools.
    }
  }

  // ---- results ---------------------------------------------------------------------------------------------------

  private async store(
    run: RunRow,
    document: BaselineDocument,
    plan: Plan,
    observed: Observed,
  ): Promise<void> {
    const parsed = parseObservations(observed.stdout, plan.observations, {
      truncated: observed.truncated,
      controllerEpochMs: observed.clockMs,
    });
    if (!parsed.recognised) {
      throw new ObserveError(
        'observe_unreadable',
        `The server answered, but not with the output of the observation script (exit status ${String(observed.exitCode)}). A restricted shell, a forced command or a login banner can cause this.`,
      );
    }
    const rows = document.checks.map((check, position) => {
      const observation = parsed.observations.get(plan.observationOf[position] ?? 0);
      const outcome = evaluateCheck(check, observation);
      const expectation = Object.entries(check.expect)[0] ?? ['equals', null];
      return {
        position,
        checkId: check.id,
        title: check.title,
        category: check.category,
        severity: check.severity,
        status: outcome.status,
        observationKind: check.observe.kind,
        observationField: check.observe.field,
        observationParams:
          plan.observations.find((candidate) => candidate.index === plan.observationOf[position])
            ?.params ?? {},
        observationStatus: observation?.status ?? 'error',
        observed: outcome.observed ?? Prisma.DbNull,
        comparator: expectation[0],
        expected: expectation[1] as Prisma.InputJsonValue,
        message: outcome.message?.slice(0, 600) ?? null,
        remediationHint: check.remediationHint ?? null,
        // For the drift and the counts below.
        observedValue: outcome.observed satisfies ObservedValue,
      };
    });
    const counts = countOf(rows.map((row) => row.status));

    // The previous completed run of this server, for the drift and the trend.
    const previous = await this.db.checkRun.findFirst({
      where: {
        serverId: run.serverId,
        state: 'completed',
        id: { not: run.id },
        queuedAt: { lt: run.queuedAt },
      },
      orderBy: { queuedAt: 'desc' },
      include: { results: { orderBy: { position: 'asc' } } },
    });
    let changedSincePrevious: number | null = null;
    let trend: 'better' | 'worse' | 'same' | null = null;
    if (previous) {
      const drift = diffResults(
        previous.results.map((result) => ({
          checkId: result.checkId,
          title: result.title,
          category: result.category as BaselineDocument['checks'][number]['category'],
          severity: result.severity as BaselineDocument['checks'][number]['severity'],
          status: result.status,
          observed: result.observed as ObservedValue,
          message: result.message,
        })),
        rows.map((row) => ({
          checkId: row.checkId,
          title: row.title,
          category: row.category,
          severity: row.severity,
          status: row.status,
          observed: row.observedValue,
          message: row.message,
        })),
      );
      changedSincePrevious =
        drift.counts.regressed +
        drift.counts.improved +
        drift.counts.changed +
        drift.counts.added +
        drift.counts.removed;
      trend = trendOf(counts, {
        fail: previous.failCount,
        error: previous.errorCount,
        warn: previous.warnCount,
      });
    }

    const finishedAt = new Date();
    await this.db.$transaction(async (tx) => {
      const closed = await tx.checkRun.updateMany({
        where: { id: run.id, state: 'running' },
        data: {
          state: 'completed',
          finishedAt,
          passCount: counts.pass,
          warnCount: counts.warn,
          failCount: counts.fail,
          errorCount: counts.error,
          skippedCount: counts.skipped,
          changedSincePrevious,
          trend,
          collectedAs: observed.collectedAs,
          scriptSha256: this.script.sha256,
        },
      });
      if (closed.count !== 1) {
        return;
      }
      await tx.checkResult.createMany({
        data: rows.map((row) => ({
          runId: run.id,
          position: row.position,
          checkId: row.checkId,
          title: row.title,
          category: row.category,
          severity: row.severity,
          status: row.status,
          observationKind: row.observationKind,
          observationField: row.observationField,
          observationParams: row.observationParams,
          observationStatus: row.observationStatus,
          observed: row.observed,
          comparator: row.comparator,
          expected: row.expected,
          message: row.message,
          remediationHint: row.remediationHint,
        })),
      });
      await this.audit.record(
        {
          action: 'baseline.run.finished',
          outcome: 'success',
          object: { type: 'server', id: run.serverId },
          details: {
            baseline: run.baselineName,
            version: run.baselineVersion,
            trigger: run.trigger,
            state: 'completed',
            pass: counts.pass,
            warn: counts.warn,
            fail: counts.fail,
            error: counts.error,
            skipped: counts.skipped,
            collected_as: observed.collectedAs,
            duration_ms: finishedAt.getTime() - (run.startedAt?.getTime() ?? finishedAt.getTime()),
            warnings: parsed.warnings.length,
          },
          meta: { ip: undefined, requestId: undefined },
        },
        tx,
      );
    });
    await this.prune(run.serverId);
  }

  /** The run could not observe the server: close it as an error with the code, never as a result. */
  private async failRun(run: RunRow, error: unknown): Promise<void> {
    const { code, message } = describeFailure(error);
    if (code === 'internal_error') {
      this.logger.error(
        `run ${run.id} failed: ${error instanceof Error ? (error.stack ?? error.message) : 'unknown error'}`,
      );
    }
    const finishedAt = new Date();
    try {
      await this.db.$transaction(async (tx) => {
        const closed = await tx.checkRun.updateMany({
          where: { id: run.id, state: { in: ['queued', 'running'] } },
          data: {
            state: 'error',
            finishedAt,
            errorCode: code.slice(0, 40),
            errorMessage: message.slice(0, 500),
          },
        });
        if (closed.count !== 1) {
          return;
        }
        await this.audit.record(
          {
            action: 'baseline.run.finished',
            outcome: 'failure',
            object: { type: 'server', id: run.serverId },
            details: {
              baseline: run.baselineName,
              version: run.baselineVersion,
              trigger: run.trigger,
              state: 'error',
              error_code: code.slice(0, 40),
              duration_ms:
                finishedAt.getTime() - (run.startedAt?.getTime() ?? finishedAt.getTime()),
            },
            meta: { ip: undefined, requestId: undefined },
          },
          tx,
        );
      });
      await this.prune(run.serverId);
    } catch (storeError) {
      this.logger.error(
        `could not record the failure of run ${run.id}: ${storeError instanceof Error ? storeError.message : 'unknown error'}`,
      );
    }
  }

  /** Keeps the newest `SW_CHECKS_KEEP_RUNS` runs of the server and deletes the rest (never one that is still going on). */
  async prune(serverId: string): Promise<void> {
    const old = await this.db.checkRun.findMany({
      where: { serverId },
      orderBy: { queuedAt: 'desc' },
      skip: this.config.baseline.keepRuns,
      select: { id: true, state: true },
    });
    const ids = old
      .filter((row) => row.state !== 'queued' && row.state !== 'running')
      .map((row) => row.id);
    if (ids.length > 0) {
      await this.db.checkRun.deleteMany({ where: { id: { in: ids } } });
    }
  }
}

/** The code and the sentence a failure is recorded with. A defect of Swellwright says so and leaks nothing. */
function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ObserveError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof VaultSealedException) {
    return {
      code: 'vault_sealed',
      message: 'The vault is sealed. Unseal it and run the check again.',
    };
  }
  if (error instanceof CodedHttpException) {
    return { code: error.apiCode, message: error.message };
  }
  return {
    code: 'internal_error',
    message: 'The check failed because of an error in Swellwright. It is in the log of the server.',
  };
}
