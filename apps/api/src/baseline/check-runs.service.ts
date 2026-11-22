import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BaselineCategory,
  BaselineFleet,
  BaselineFleetItem,
  CheckResultView,
  CheckRunDiff,
  CheckRunList,
  CheckRunListQuery,
  CheckRunSummary,
  CheckRunView,
  BaselineSeverity,
  ObservedValue,
  StartBaselineRunsRequest,
  StartBaselineRunsResult,
  StartServerBaselineRunRequest,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { type AppConfig } from '../config.js';
import { CodedHttpException, RateLimitedException, VaultSealedException } from '../http.js';
import { type Actor } from '../servers/servers.service.js';
import { CHECKS_CLOCK, CONFIG, DATABASE } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';
import { BaselinesService } from './baselines.service.js';
import { CheckRunner } from './check-runner.service.js';
import { type ComparableResult, diffResults } from './diff.js';

type RunRow = Prisma.CheckRunGetPayload<object>;
type ResultRow = Prisma.CheckResultGetPayload<object>;

const ScalarRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** The run as a summary: what a list and the fleet need, without the results. */
export function summaryOf(row: RunRow): CheckRunSummary {
  return {
    id: row.id,
    serverId: row.serverId,
    serverName: row.serverName,
    baseline: {
      id: row.profileId,
      name: row.baselineName,
      version: row.baselineVersion,
      sha256: row.baselineSha256,
    },
    trigger: row.trigger,
    state: row.state,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs:
      row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    counts: {
      pass: row.passCount,
      warn: row.warnCount,
      fail: row.failCount,
      error: row.errorCount,
      skipped: row.skippedCount,
    },
    trend:
      row.trend === 'better' || row.trend === 'worse' || row.trend === 'same' ? row.trend : null,
    changedSincePrevious: row.changedSincePrevious,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedBy: row.startedById ? { id: row.startedById, name: row.startedByName ?? '' } : null,
    collectedAs:
      row.collectedAs === 'root' || row.collectedAs === 'sudo' || row.collectedAs === 'user'
        ? row.collectedAs
        : null,
  };
}

function resultView(row: ResultRow): CheckResultView {
  const params = ScalarRecord.safeParse(row.observationParams);
  return {
    checkId: row.checkId,
    title: row.title,
    category: row.category as BaselineCategory,
    severity: row.severity as BaselineSeverity,
    status: row.status,
    observation: {
      kind: row.observationKind,
      field: row.observationField,
      params: params.success ? params.data : {},
      status: row.observationStatus as CheckResultView['observation']['status'],
    },
    observed: row.observed as ObservedValue,
    expectation: {
      comparator: row.comparator as CheckResultView['expectation']['comparator'],
      value: row.expected,
    },
    message: row.message,
    remediationHint: row.remediationHint,
  };
}

const comparable = (row: ResultRow): ComparableResult => ({
  checkId: row.checkId,
  title: row.title,
  category: row.category as BaselineCategory,
  severity: row.severity as BaselineSeverity,
  status: row.status,
  observed: row.observed as ObservedValue,
  message: row.message,
});

/** An arbitrary constant namespace for the per-server advisory lock that makes "one run per server" true. */
const lockKey = (serverId: string): string => `swb-run:${serverId}`;

interface QueueRequest {
  readonly serverIds: readonly string[];
  readonly baselineId: string | undefined;
  readonly trigger: 'manual' | 'scheduled';
  readonly actor: Actor | null;
  readonly meta: Pick<RequestMeta, 'ip' | 'requestId'>;
}

/**
 * Starts, reads and compares baseline checks (ADR 0045). Starting one only queues a row and answers at once; the
 * `CheckRunner` does the work. One run per server at a time is kept under an advisory lock, so two requests that arrive
 * together cannot both queue the same server.
 */
@Injectable()
export class CheckRunsService {
  private readonly limiter: WindowLimiter;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BaselinesService) private readonly baselines: BaselinesService,
    @Inject(CheckRunner) private readonly runner: CheckRunner,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(CHECKS_CLOCK) private readonly now: () => number,
  ) {
    this.limiter = new WindowLimiter(config.baseline.rateLimitPerMinute, 60_000);
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  // ---- starting -----------------------------------------------------------------------------------------------

  async startForServer(
    actor: Actor,
    serverId: string,
    request: StartServerBaselineRunRequest,
    meta: RequestMeta,
  ): Promise<CheckRunSummary> {
    const result = await this.queue({
      serverIds: [serverId],
      baselineId: request.baselineId,
      trigger: 'manual',
      actor,
      meta,
    });
    const run = result.runs[0];
    if (!run) {
      const reason = result.skipped[0]?.reason ?? 'no_baseline';
      throw new CodedHttpException(
        409,
        'conflict',
        reason === 'already_running'
          ? 'A check of this server is already queued or going on.'
          : 'No baseline is assigned to this server. Assign one, or choose one for this run.',
        { reason },
      );
    }
    return run;
  }

  async startMany(
    actor: Actor,
    request: StartBaselineRunsRequest,
    meta: RequestMeta,
  ): Promise<StartBaselineRunsResult> {
    // `all` is every server that has a baseline (or every server, when one baseline is named for the run).
    const serverIds =
      request.serverIds ??
      (request.baselineId === undefined
        ? [...(await this.baselines.effective()).keys()]
        : (await this.db.server.findMany({ select: { id: true } })).map((server) => server.id));
    if (serverIds.length === 0) {
      return { runs: [], skipped: [] };
    }
    return this.queue({
      serverIds,
      baselineId: request.baselineId,
      trigger: 'manual',
      actor,
      meta,
    });
  }

  /** When the newest run of each server was queued, in epoch milliseconds (any state, any trigger). */
  async lastQueued(serverIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.db.checkRun.groupBy({
      by: ['serverId'],
      where: { serverId: { in: [...serverIds] } },
      _max: { queuedAt: true },
    });
    const last = new Map<string, number>();
    for (const row of rows) {
      if (row._max.queuedAt) {
        last.set(row.serverId, row._max.queuedAt.getTime());
      }
    }
    return last;
  }

  /** The runs of the schedule: no person, no rate limit, and the caller has chosen the servers. */
  startScheduled(serverIds: readonly string[]): Promise<StartBaselineRunsResult> {
    return this.queue({
      serverIds,
      baselineId: undefined,
      trigger: 'scheduled',
      actor: null,
      meta: { ip: undefined, requestId: undefined },
    });
  }

  private async queue(request: QueueRequest): Promise<StartBaselineRunsResult> {
    if (request.actor && !this.limiter.hit(request.actor.id)) {
      throw new RateLimitedException(60, 'Too many checks started. Try again in a minute.');
    }
    // A sealed vault means no login can happen: say so now, and queue nothing.
    if ((await this.vault.status()).state !== 'unsealed') {
      throw new VaultSealedException();
    }
    const ids = [...new Set(request.serverIds)].sort();
    const servers = await this.db.server.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, tags: true },
    });
    if (servers.length !== ids.length) {
      const known = new Set(servers.map((server) => server.id));
      throw new NotFoundException(
        `There is no server ${ids.find((candidate) => !known.has(candidate)) ?? ''}.`,
      );
    }
    const override =
      request.baselineId === undefined
        ? undefined
        : await this.baselines.loadForRun(request.baselineId);
    if (request.baselineId !== undefined && !override) {
      throw new NotFoundException('There is no such baseline.');
    }
    const effective = override ? undefined : await this.baselines.effective();
    const loaded = new Map<string, Awaited<ReturnType<BaselinesService['loadForRun']>>>();
    const baselineFor = async (
      serverId: string,
    ): Promise<Awaited<ReturnType<BaselinesService['loadForRun']>>> => {
      if (override) {
        return override;
      }
      const profileId = effective?.get(serverId)?.profileId;
      if (profileId === undefined) {
        return null;
      }
      if (!loaded.has(profileId)) {
        loaded.set(profileId, await this.baselines.loadForRun(profileId));
      }
      return loaded.get(profileId) ?? null;
    };

    // Everything the transaction needs is read before it starts: it holds a connection, and reading through the pool
    // from inside it would wait for a second one.
    const baselines = new Map<string, Awaited<ReturnType<typeof baselineFor>>>();
    for (const server of servers) {
      baselines.set(server.id, await baselineFor(server.id));
    }
    const skipped: StartBaselineRunsResult['skipped'] = [];
    const created: RunRow[] = [];
    await this.db.$transaction(async (tx) => {
      for (const server of servers) {
        const baseline = baselines.get(server.id);
        if (!baseline) {
          skipped.push({ serverId: server.id, serverName: server.name, reason: 'no_baseline' });
          continue;
        }
        // One run per server at a time: the lock is held to the end of the transaction, so the check and the insert are one.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(server.id)}))`;
        const going = await tx.checkRun.findFirst({
          where: { serverId: server.id, state: { in: ['queued', 'running'] } },
          select: { id: true },
        });
        if (going) {
          skipped.push({ serverId: server.id, serverName: server.name, reason: 'already_running' });
          continue;
        }
        created.push(
          await tx.checkRun.create({
            data: {
              serverId: server.id,
              serverName: server.name,
              profileId: baseline.profile.id,
              baselineName: baseline.profile.name,
              baselineVersion: baseline.version.version,
              baselineSha256: baseline.version.documentSha256,
              trigger: request.trigger,
              state: 'queued',
              queuedAt: new Date(this.now()),
              startedById: request.actor?.id ?? null,
              startedByName: request.actor?.name ?? null,
            },
          }),
        );
      }
      if (created.length > 0) {
        const first = created[0];
        await this.audit.record(
          {
            action: 'baseline.run',
            outcome: 'success',
            ...(request.actor ? { actor: request.actor } : {}),
            object: created.length === 1 && first ? { type: 'server', id: first.serverId } : null,
            details: {
              trigger: request.trigger,
              servers: created.length,
              skipped: skipped.length,
              baseline:
                override?.profile.name ??
                (new Set(created.map((run) => run.baselineName)).size === 1
                  ? (first?.baselineName ?? null)
                  : 'assigned'),
              version: created.length === 1 && first ? first.baselineVersion : null,
              first_servers: created
                .slice(0, 4)
                .map((run) => run.serverId)
                .join(','),
            },
            meta: request.meta,
          },
          tx,
        );
      }
    });
    this.runner.enqueue(created.map((run) => run.id));
    return { runs: created.map((run) => summaryOf(run)), skipped };
  }

  // ---- reading ------------------------------------------------------------------------------------------------

  async listForServer(serverId: string, query: CheckRunListQuery): Promise<CheckRunList> {
    if (!(await this.db.server.findUnique({ where: { id: serverId }, select: { id: true } }))) {
      throw new NotFoundException('There is no such server.');
    }
    const [rows, total] = await Promise.all([
      this.db.checkRun.findMany({
        where: { serverId },
        orderBy: { queuedAt: 'desc' },
        take: query.limit ?? 30,
        skip: query.offset ?? 0,
      }),
      this.db.checkRun.count({ where: { serverId } }),
    ]);
    return { runs: rows.map((row) => summaryOf(row)), total };
  }

  async get(id: string): Promise<CheckRunView> {
    const row = await this.db.checkRun.findUnique({
      where: { id },
      include: { results: { orderBy: { position: 'asc' } } },
    });
    if (!row) {
      throw new NotFoundException('There is no such run.');
    }
    return {
      ...summaryOf(row),
      scriptSha256: row.scriptSha256,
      results: row.results.map((result) => resultView(result)),
    };
  }

  async diff(id: string, against: string | undefined): Promise<CheckRunDiff> {
    const to = await this.db.checkRun.findUnique({
      where: { id },
      include: { results: { orderBy: { position: 'asc' } } },
    });
    if (!to) {
      throw new NotFoundException('There is no such run.');
    }
    if (to.state !== 'completed') {
      throw new CodedHttpException(
        409,
        'conflict',
        'This run has no results to compare: it is still going on, or it could not observe the server.',
        { reason: 'not_completed' },
      );
    }
    let from: (RunRow & { results: ResultRow[] }) | null;
    if (against === undefined || against === 'previous') {
      from = await this.db.checkRun.findFirst({
        where: {
          serverId: to.serverId,
          state: 'completed',
          id: { not: to.id },
          queuedAt: { lt: to.queuedAt },
        },
        orderBy: { queuedAt: 'desc' },
        include: { results: { orderBy: { position: 'asc' } } },
      });
    } else {
      from = await this.db.checkRun.findUnique({
        where: { id: against },
        include: { results: { orderBy: { position: 'asc' } } },
      });
      if (!from) {
        throw new NotFoundException('There is no such run to compare with.');
      }
      if (from.serverId !== to.serverId || from.state !== 'completed' || from.id === to.id) {
        throw new CodedHttpException(
          409,
          'conflict',
          'A run can only be compared with another completed run of the same server.',
          { reason: 'not_comparable' },
        );
      }
    }
    if (!from) {
      return {
        from: null,
        to: summaryOf(to),
        identical: false,
        counts: { regressed: 0, improved: 0, changed: 0, added: 0, removed: 0, unchanged: 0 },
        changes: [],
        notes: ['no_previous_run'],
      };
    }
    const drift = diffResults(from.results.map(comparable), to.results.map(comparable));
    const notes: CheckRunDiff['notes'] = [];
    if (from.profileId !== to.profileId || from.baselineName !== to.baselineName) {
      notes.push('baseline_differs');
    } else if (from.baselineVersion !== to.baselineVersion) {
      notes.push('baseline_version_differs');
    }
    return {
      from: summaryOf(from),
      to: summaryOf(to),
      identical: drift.identical,
      counts: drift.counts,
      changes: [...drift.changes],
      notes,
    };
  }

  /** Every server with the baseline that applies to it and its newest finished run. */
  async fleet(): Promise<BaselineFleet> {
    const [servers, effective, profiles, finished, going] = await Promise.all([
      this.db.server.findMany({
        select: { id: true, name: true, state: true, country: true, tags: true },
        orderBy: { name: 'asc' },
      }),
      this.baselines.effective(),
      this.db.baselineProfile.findMany({
        select: { id: true, name: true, currentVersion: true },
      }),
      this.db.checkRun.findMany({
        where: { state: { in: ['completed', 'error'] } },
        orderBy: [{ serverId: 'asc' }, { queuedAt: 'desc' }],
        distinct: ['serverId'],
      }),
      this.db.checkRun.findMany({
        where: { state: { in: ['queued', 'running'] } },
        select: { serverId: true },
      }),
    ]);
    const profileOf = new Map(profiles.map((profile) => [profile.id, profile]));
    const lastOf = new Map(finished.map((run) => [run.serverId, run]));
    const running = new Set(going.map((run) => run.serverId));
    const items: BaselineFleetItem[] = servers.map((server) => {
      const assigned = effective.get(server.id);
      const profile = assigned ? profileOf.get(assigned.profileId) : undefined;
      const last = lastOf.get(server.id);
      const lastRun = last ? summaryOf(last) : null;
      return {
        server: {
          id: server.id,
          name: server.name,
          state: server.state,
          country: server.country,
          tags: server.tags,
        },
        baseline: profile
          ? { id: profile.id, name: profile.name, version: profile.currentVersion }
          : null,
        assignedBy: assigned?.by ?? 'none',
        lastRun,
        trend: lastRun?.state === 'completed' ? lastRun.trend : null,
        running: running.has(server.id),
      };
    });
    const completed = items.flatMap((item) =>
      item.lastRun?.state === 'completed' ? [item.lastRun] : [],
    );
    const lastFinished = finished
      .map((run) => run.finishedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        servers: items.length,
        assigned: items.filter((item) => item.baseline !== null).length,
        checked: completed.length,
        failing: completed.filter((run) => run.counts.fail > 0).length,
        warning: completed.filter(
          (run) => run.counts.fail === 0 && (run.counts.warn > 0 || run.counts.error > 0),
        ).length,
        unreachable: items.filter((item) => item.lastRun?.state === 'error').length,
        lastRunAt: lastFinished?.toISOString() ?? null,
        failingChecks: completed.reduce((sum, run) => sum + run.counts.fail, 0),
        warningChecks: completed.reduce((sum, run) => sum + run.counts.warn, 0),
      },
      items,
    };
  }

  /**
   * The servers the schedule may check: they have a baseline, a pinned host key and an access entry whose secrets have not
   * expired. A server the schedule could not log in to is left alone (nothing is recorded for it), and a server whose
   * last check is still going on is left alone as well.
   */
  async scheduledCandidates(): Promise<string[]> {
    const [servers, effective] = await Promise.all([
      this.db.server.findMany({
        select: {
          id: true,
          hostKeys: { select: { id: true }, take: 1 },
          access: {
            select: {
              secret: { select: { expiresAt: true } },
              sudoSecret: { select: { expiresAt: true } },
            },
          },
        },
      }),
      this.baselines.effective(),
    ]);
    const now = this.now();
    const live = (secret: { expiresAt: Date | null } | null): boolean =>
      (secret?.expiresAt?.getTime() ?? Infinity) > now;
    return servers
      .filter(
        (server) =>
          effective.has(server.id) &&
          server.hostKeys.length > 0 &&
          server.access.some((entry) => live(entry.secret) && live(entry.sudoSecret)),
      )
      .map((server) => server.id);
  }
}
