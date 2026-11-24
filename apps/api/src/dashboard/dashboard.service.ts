import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ATTENTION_SOURCE_PERMISSIONS,
  ATTENTION_SOURCES,
  type AttentionFeed,
  type AttentionSource,
  type AttentionSourceState,
  type FleetHealth,
  type FleetHealthQuery,
  type FleetHealthRow,
} from '@swellwright/contracts';
import type { Database } from '@swellwright/db';

import { type AuthContext, requireDatabase } from '../auth/context.js';
import { can } from '../auth/guards.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { CheckRunsService } from '../baseline/check-runs.service.js';
import { ChecksMemory } from '../checks/memory.js';
import { type AppConfig } from '../config.js';
import { RateLimitedException } from '../http.js';
import { PanelService } from '../panel/panel.service.js';
import { PanelSnapshotsService } from '../panel/snapshots/snapshots.service.js';
import { ServersService } from '../servers/servers.service.js';
import { UpdatesService } from '../system/updates.service.js';
import { CLOCK, CONFIG, DATABASE } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';
import { type AttentionFacts, type AttentionThresholds, buildAttention } from './attention.js';
import {
  fleetHealthRow,
  type FleetAccessInput,
  type FleetServerInput,
  pageFleet,
} from './fleet-health.js';

/** The reasons for which a plugin that was enabled is switched off by itself (see `plugins.service.ts`). */
const SWITCH_OFF_REASONS: ReadonlySet<string> = new Set(['changed', 'missing', 'unavailable']);
/** At most this many disabled plugins are looked at: more than a page of them is a different problem. */
const MAX_PLUGINS = 200;

const asDate = (value: string | null): Date | null => (value === null ? null : new Date(value));

/**
 * The dashboard (ADR 0047): the attention feed and the health of the fleet. Everything it says comes from this
 * server's own records (database rows) and memory (the last convention run and reconciliation, the update check); it
 * never calls the panel, a server, or GitHub. A source that fails is reported and the others are still returned, and the
 * answer of the feed is reused for a few seconds because it depends only on which sources the caller may read.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger('Dashboard');
  private readonly limiter: WindowLimiter;
  private readonly cache = new Map<
    string,
    { readonly at: number; readonly feed: Promise<AttentionFeed> }
  >();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(CLOCK) private readonly clock: () => number,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(PanelService) private readonly panel: PanelService,
    @Inject(ChecksMemory) private readonly memory: ChecksMemory,
    @Inject(PanelSnapshotsService) private readonly snapshots: PanelSnapshotsService,
    @Inject(CheckRunsService) private readonly runs: CheckRunsService,
    @Inject(ServersService) private readonly servers: ServersService,
    @Inject(UpdatesService) private readonly updates: UpdatesService,
  ) {
    this.limiter = new WindowLimiter(config.dashboard.rateLimitPerMinute, 60_000);
  }

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  private limit(auth: AuthContext): void {
    if (!this.limiter.hit(auth.user.id)) {
      throw new RateLimitedException(60, 'Too many dashboard reads. Try again in a minute.');
    }
  }

  private get thresholds(): AttentionThresholds {
    const { dashboard } = this.config;
    return {
      expiryWarningDays: dashboard.expiryWarningDays,
      baselineStaleDays: dashboard.baselineStaleDays,
      factsStaleDays: dashboard.factsStaleDays,
      snapshotStaleDays: dashboard.snapshotStaleDays,
      auditVerifyDays: dashboard.auditVerifyDays,
      runsWindowHours: dashboard.runsWindowHours,
    };
  }

  // ---- the attention feed ----------------------------------------------------------------------------------------------

  async attention(auth: AuthContext): Promise<AttentionFeed> {
    this.limit(auth);
    const permitted = ATTENTION_SOURCES.filter((source) => {
      const permission = ATTENTION_SOURCE_PERMISSIONS[source];
      return permission === null || can(auth, permission);
    });
    // The feed depends on which sources are read and on nothing else about the caller.
    const key = permitted.join(',');
    const now = this.clock();
    const ttl = this.config.dashboard.cacheMs;
    const kept = this.cache.get(key);
    if (kept !== undefined && ttl > 0 && now - kept.at < ttl) {
      return kept.feed;
    }
    const feed = this.build(new Set(permitted), now);
    this.cache.set(key, { at: now, feed });
    return feed;
  }

  private async build(
    permitted: ReadonlySet<AttentionSource>,
    now: number,
  ): Promise<AttentionFeed> {
    const states: AttentionSourceState[] = [];
    const read = async <T>(source: AttentionSource, load: () => Promise<T>): Promise<T | null> => {
      if (!permitted.has(source)) {
        states.push({ source, state: 'not_permitted' });
        return null;
      }
      try {
        const facts = await load();
        states.push({ source, state: 'ok' });
        return facts;
      } catch (error) {
        // A source that cannot be read leaves the others alone; what went wrong stays in the log, not in the answer.
        this.logger.warn(
          `the dashboard could not read "${source}": ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        states.push({ source, state: 'failed' });
        return null;
      }
    };
    // The connection row is read once, for the four sources that start from it.
    const needsPanel = ['panel', 'conventions', 'reconciliation', 'snapshots'].some((source) =>
      permitted.has(source as AttentionSource),
    );
    const connection = needsPanel ? this.panel.row() : Promise.resolve(null);
    connection.catch(() => undefined);

    const [
      vault,
      panel,
      conventions,
      reconciliation,
      snapshots,
      baseline,
      servers,
      runs,
      audit,
      plugins,
      updates,
    ] = await Promise.all([
      read('vault', () => this.vaultFacts()),
      read('panel', async (): Promise<NonNullable<AttentionFacts['panel']>> => {
        const row = await connection;
        return row === null
          ? { state: 'unconfigured', lastCheckedAt: null, version: null, tokenExpiresAt: null }
          : {
              state: row.state,
              lastCheckedAt: row.lastCheckedAt,
              version: row.panelVersion,
              tokenExpiresAt: row.tokenExpiresAt,
            };
      }),
      read('conventions', async () => {
        const row = await connection;
        const last = this.memory.last(row?.id ?? null);
        return {
          panelConnected: row !== null,
          last:
            last === null
              ? null
              : {
                  ranAt: new Date(last.ranAt),
                  errors: last.summary.error,
                  warnings: last.summary.warning,
                },
        };
      }),
      read('reconciliation', async () => {
        const row = await connection;
        const last = this.memory.lastReconciliation(row?.id ?? null);
        return {
          panelConnected: row !== null,
          last:
            last === null
              ? null
              : {
                  ranAt: new Date(last.ranAt),
                  drift: last.drift,
                  missing: last.missing,
                  extra: last.extra,
                  unknown: last.unknown,
                  inventoryCompared: last.inventoryCompared,
                  inventoryServers: last.inventoryServers,
                  unmanaged: last.unmanaged,
                },
        };
      }),
      read('snapshots', async () => {
        const row = await connection;
        const intervalMs = this.config.panel.snapshotIntervalMs;
        if (row === null) {
          return { panelConnected: false, intervalMs, latest: null };
        }
        const { snapshots: found } = await this.snapshots.list({ limit: 1 });
        const latest = found[0];
        return {
          panelConnected: true,
          intervalMs: this.database === undefined ? 0 : intervalMs,
          latest:
            latest === undefined
              ? null
              : {
                  createdAt: new Date(latest.createdAt),
                  checkedAt: asDate(latest.checkedAt),
                  changesSince: latest.changesSince,
                },
        };
      }),
      read('baseline', () => this.baselineFacts()),
      read('servers', async () => {
        const { servers: list } = await this.servers.list({});
        return {
          servers: list.map((server) => ({
            name: server.name,
            state: server.state,
            hostKeyCount: server.hostKeyCount,
            accessCount: server.accessCount,
            factsAt: server.facts === null ? null : new Date(server.facts.collectedAt),
          })),
        };
      }),
      read('runs', () => this.runFacts(now)),
      read('audit', () => this.auditFacts()),
      read('plugins', () => this.pluginFacts()),
      read('updates', () => {
        const known = this.updates.peek();
        return Promise.resolve({
          current: this.config.version,
          latest: known.latestVersion,
          checkedAt: asDate(known.checkedAt),
        });
      }),
    ]);

    const items = buildAttention(
      {
        vault,
        panel,
        conventions,
        reconciliation,
        snapshots,
        baseline,
        servers,
        runs,
        audit,
        plugins,
        updates,
      },
      now,
      this.thresholds,
    );
    const order = new Map<AttentionSource, number>(
      ATTENTION_SOURCES.map((source, index) => [source, index]),
    );
    return {
      generatedAt: new Date(now).toISOString(),
      items,
      counts: {
        critical: items.filter((item) => item.severity === 'critical').length,
        warning: items.filter((item) => item.severity === 'warning').length,
        info: items.filter((item) => item.severity === 'info').length,
      },
      sources: states.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0)),
    };
  }

  private async vaultFacts(): Promise<NonNullable<AttentionFacts['vault']>> {
    const [status, rows] = await Promise.all([
      this.vault.status(),
      this.db.secret.findMany({
        where: { expiresAt: { not: null } },
        select: { name: true, expiresAt: true },
      }),
    ]);
    return {
      state: status.state,
      expiring: rows.flatMap((row) =>
        row.expiresAt === null ? [] : [{ name: row.name, expiresAt: row.expiresAt }],
      ),
    };
  }

  private async baselineFacts(): Promise<NonNullable<AttentionFacts['baseline']>> {
    const fleet = await this.runs.fleet();
    return {
      servers: fleet.items.map((item) => {
        const run = item.lastRun;
        const finished = run === null ? null : (run.finishedAt ?? run.queuedAt);
        return {
          name: item.server.name,
          assigned: item.baseline !== null,
          running: item.running,
          last:
            run === null ||
            finished === null ||
            (run.state !== 'completed' && run.state !== 'error')
              ? null
              : {
                  state: run.state,
                  at: new Date(finished),
                  fail: run.counts.fail,
                  warn: run.counts.warn,
                  error: run.counts.error,
                  errorCode: run.errorCode,
                },
        };
      }),
    };
  }

  private async runFacts(now: number): Promise<NonNullable<AttentionFacts['runs']>> {
    const since = new Date(now - this.config.dashboard.runsWindowHours * 3_600_000);
    const where = {
      state: { in: ['failed', 'partial'] as ('failed' | 'partial')[] },
      finishedAt: { gte: since },
    };
    const [failed, latest] = await Promise.all([
      this.db.commandRun.count({ where }),
      this.db.commandRun.findFirst({
        where,
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
    ]);
    return { failed, latestAt: latest?.finishedAt ?? null };
  }

  private async auditFacts(): Promise<NonNullable<AttentionFacts['audit']>> {
    const [verified, oldest] = await Promise.all([
      this.db.auditEvent.findFirst({
        where: { action: 'audit.chain.verified' },
        orderBy: { seq: 'desc' },
        select: { occurredAt: true, outcome: true },
      }),
      this.db.auditEvent.findFirst({ orderBy: { seq: 'asc' }, select: { occurredAt: true } }),
    ]);
    return {
      lastVerification:
        verified === null ? null : { at: verified.occurredAt, ok: verified.outcome === 'success' },
      oldestEventAt: oldest?.occurredAt ?? null,
    };
  }

  private async pluginFacts(): Promise<NonNullable<AttentionFacts['plugins']>> {
    const off = await this.db.pluginApproval.findMany({
      where: { enabled: false },
      select: { pluginId: true },
      take: MAX_PLUGINS,
    });
    if (off.length === 0) {
      return { switchedOff: [] };
    }
    // Why a plugin is off is in the audit log: the newest `plugin.disabled` of each says who or what switched it off.
    const events = await this.db.auditEvent.findMany({
      where: {
        action: 'plugin.disabled',
        objectType: 'plugin',
        objectId: { in: off.map((plugin) => plugin.pluginId) },
      },
      orderBy: { seq: 'desc' },
      select: { objectId: true, details: true, occurredAt: true },
    });
    const newest = new Map<string, { reason: string; at: Date }>();
    for (const event of events) {
      if (event.objectId === null || newest.has(event.objectId)) {
        continue;
      }
      let reason = '';
      try {
        const details = JSON.parse(event.details) as { reason?: unknown };
        reason = typeof details.reason === 'string' ? details.reason : '';
      } catch {
        // an unreadable record says nothing about why
      }
      newest.set(event.objectId, { reason, at: event.occurredAt });
    }
    return {
      switchedOff: [...newest.entries()]
        .filter(([, found]) => SWITCH_OFF_REASONS.has(found.reason))
        .map(([id, found]) => ({ id, reason: found.reason, at: found.at })),
    };
  }

  // ---- the health of the fleet -----------------------------------------------------------------------------------------

  async fleet(auth: AuthContext, query: FleetHealthQuery): Promise<FleetHealth> {
    this.limit(auth);
    const now = this.clock();
    const { dashboard } = this.config;
    const canSeePanel = can(auth, 'panel:read');
    const [inventory, access, baseline, connection] = await Promise.all([
      this.servers.list({}),
      this.db.serverAccess.findMany({
        select: {
          serverId: true,
          lastVerifiedAt: true,
          lastVerifyOk: true,
          secret: { select: { expiresAt: true } },
          sudoSecret: { select: { expiresAt: true } },
        },
      }),
      this.runs.fleet(),
      canSeePanel ? this.panel.row() : Promise.resolve(null),
    ]);
    const entriesOf = new Map<string, FleetAccessInput[]>();
    for (const entry of access) {
      const list = entriesOf.get(entry.serverId) ?? [];
      list.push({
        secretExpiresAt: entry.secret.expiresAt,
        sudoSecretExpiresAt: entry.sudoSecret?.expiresAt ?? null,
        lastVerifiedAt: entry.lastVerifiedAt,
        lastVerifyOk: entry.lastVerifyOk,
      });
      entriesOf.set(entry.serverId, list);
    }
    const baselineOf = new Map(baseline.items.map((item) => [item.server.id, item]));
    const reconciled = canSeePanel ? this.memory.lastReconciliation(connection?.id ?? null) : null;
    const reconciledAt = reconciled === null ? null : new Date(reconciled.ranAt);

    const inputs: FleetServerInput[] = inventory.servers.map((server) => {
      const item = baselineOf.get(server.id);
      const run = item?.lastRun ?? null;
      const finished = run === null ? null : (run.finishedAt ?? run.queuedAt);
      return {
        id: server.id,
        name: server.name,
        state: server.state,
        country: server.country,
        tags: server.tags,
        hostKeyCount: server.hostKeyCount,
        access: entriesOf.get(server.id) ?? [],
        facts:
          server.facts === null
            ? null
            : {
                collectedAt: new Date(server.facts.collectedAt),
                os: server.facts.os,
                kernel: server.facts.kernel,
              },
        baseline:
          item?.baseline == null
            ? null
            : { name: item.baseline.name, version: item.baseline.version },
        last:
          run === null || finished === null || (run.state !== 'completed' && run.state !== 'error')
            ? null
            : {
                state: run.state,
                at: new Date(finished),
                counts: run.counts,
                errorCode: run.errorCode,
                trend: run.trend,
              },
        running: item?.running ?? false,
        node: reconciled?.nodes.get(server.id) ?? null,
      };
    });
    const rows: FleetHealthRow[] = inputs.map((input) =>
      fleetHealthRow(input, now, dashboard, reconciledAt),
    );
    const page = pageFleet(rows, query);
    const count = (health: FleetHealthRow['health']): number =>
      rows.filter((row) => row.health === health).length;
    return {
      generatedAt: new Date(now).toISOString(),
      rows: page.rows,
      total: page.total,
      totals: {
        servers: rows.length,
        critical: count('critical'),
        warning: count('warning'),
        ok: count('ok'),
        unknown: count('unknown'),
      },
      panel: { matched: reconciledAt !== null, asOf: reconciledAt?.toISOString() ?? null },
      settings: {
        baselineStaleDays: dashboard.baselineStaleDays,
        factsStaleDays: dashboard.factsStaleDays,
      },
    };
  }
}
