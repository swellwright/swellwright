import {
  FLEET_HEALTH_PAGE_DEFAULT,
  type FleetFlag,
  type FleetHealthQuery,
  type FleetHealthRow,
  type FleetHealthState,
  type PanelNodeState,
} from '@swellwright/contracts';

import { isExpired } from '../vault/expiry.js';

/**
 * The health of one server as a pure function (ADR 0047): what was stored about it goes in, a row with flags and a
 * rolled-up health comes out, and a second function filters, sorts and pages the rows. Nothing here reads a database,
 * the clock or the network.
 */

const DAY_MS = 86_400_000;

export interface FleetThresholds {
  /** 0 switches the check off. */
  readonly baselineStaleDays: number;
  readonly factsStaleDays: number;
}

export interface FleetAccessInput {
  readonly secretExpiresAt: Date | null;
  readonly sudoSecretExpiresAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly lastVerifyOk: boolean | null;
}

export interface FleetServerInput {
  readonly id: string;
  readonly name: string;
  readonly state: FleetHealthRow['server']['state'];
  readonly country: string | null;
  readonly tags: readonly string[];
  readonly hostKeyCount: number;
  readonly access: readonly FleetAccessInput[];
  readonly facts: {
    readonly collectedAt: Date;
    readonly os: string | null;
    readonly kernel: string | null;
  } | null;
  /** The baseline that applies to the server, if any. */
  readonly baseline: { readonly name: string; readonly version: number } | null;
  /** The newest finished run, completed or not. */
  readonly last: {
    readonly state: 'completed' | 'error';
    readonly at: Date;
    readonly counts: { pass: number; warn: number; fail: number; error: number; skipped: number };
    readonly errorCode: string | null;
    readonly trend: 'better' | 'worse' | 'same' | null;
  } | null;
  readonly running: boolean;
  /** The node the last reconciliation matched, if it ran with the inventory and the caller may read the panel. */
  readonly node: { readonly name: string; readonly state: PanelNodeState } | null;
}

type Level = 'critical' | 'warning' | 'info';

/** How serious each flag is. */
const FLAG_LEVEL: Record<FleetFlag, Level> = {
  host_key_mismatch: 'critical',
  baseline_failing: 'critical',
  access_expired: 'warning',
  access_failed: 'warning',
  no_host_key: 'warning',
  no_access: 'warning',
  baseline_unreachable: 'warning',
  baseline_stale: 'warning',
  baseline_warning: 'warning',
  node_offline: 'warning',
  facts_stale: 'info',
  facts_missing: 'info',
  baseline_never_checked: 'info',
  check_running: 'info',
};

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** A server that is only a draft or is retired is not expected to be set up: its gaps are not flags. */
const expectsSetup = (state: FleetServerInput['state']): boolean =>
  state === 'active' || state === 'provisioning' || state === 'draining';

export function fleetHealthRow(
  server: FleetServerInput,
  now: number,
  thresholds: FleetThresholds,
  reconciledAt: Date | null,
): FleetHealthRow {
  const flags = new Set<FleetFlag>();
  const setup = expectsSetup(server.state);
  const retired = server.state === 'retired';

  // The host key and the access entries.
  const expired = server.access.filter(
    (entry) => isExpired(entry.secretExpiresAt, now) || isExpired(entry.sudoSecretExpiresAt, now),
  ).length;
  const usable = server.access.length - expired;
  if (setup && server.hostKeyCount === 0) {
    flags.add('no_host_key');
  }
  if (setup && server.access.length === 0) {
    flags.add('no_access');
  }
  if (!retired && expired > 0) {
    flags.add('access_expired');
  }
  const tried = server.access.filter((entry) => entry.lastVerifiedAt !== null);
  const newestTry = tried.reduce<FleetAccessInput | null>(
    (best, entry) =>
      best === null ||
      (entry.lastVerifiedAt?.getTime() ?? 0) > (best.lastVerifiedAt?.getTime() ?? 0)
        ? entry
        : best,
    null,
  );
  // Every entry that was tried failed: the server cannot be logged in to as far as anyone knows.
  if (!retired && tried.length > 0 && tried.every((entry) => entry.lastVerifyOk === false)) {
    flags.add('access_failed');
  }

  // Facts.
  const factsLimit = thresholds.factsStaleDays * DAY_MS;
  const factsStale =
    server.facts !== null &&
    factsLimit > 0 &&
    now - server.facts.collectedAt.getTime() > factsLimit;
  const ready = setup && server.hostKeyCount > 0 && server.access.length > 0;
  if (ready && server.facts === null) {
    flags.add('facts_missing');
  }
  if (ready && factsStale) {
    flags.add('facts_stale');
  }

  // The baseline.
  const { last } = server;
  let status: FleetHealthRow['baseline']['status'];
  if (server.baseline === null) {
    status = 'unassigned';
  } else if (last === null) {
    status = 'never';
  } else if (last.state === 'error') {
    status = 'unreachable';
  } else if (last.counts.fail > 0) {
    status = 'fail';
  } else if (last.counts.warn > 0 || last.counts.error > 0) {
    status = 'warn';
  } else {
    status = 'pass';
  }
  if (!retired) {
    if (status === 'fail') {
      flags.add('baseline_failing');
    } else if (status === 'warn') {
      flags.add('baseline_warning');
    } else if (status === 'unreachable') {
      flags.add(
        last?.errorCode === 'host_key_mismatch' ? 'host_key_mismatch' : 'baseline_unreachable',
      );
    } else if (status === 'never' && setup && !server.running) {
      flags.add('baseline_never_checked');
    }
    const baselineLimit = thresholds.baselineStaleDays * DAY_MS;
    if (
      status !== 'never' &&
      status !== 'unassigned' &&
      status !== 'unreachable' &&
      last !== null &&
      baselineLimit > 0 &&
      !server.running &&
      now - last.at.getTime() > baselineLimit
    ) {
      flags.add('baseline_stale');
    }
  }
  if (server.running) {
    flags.add('check_running');
  }
  if (!retired && server.node?.state === 'offline') {
    flags.add('node_offline');
  }

  // The worst flag is the health; with none, a server nobody has looked at yet is unknown.
  let health: FleetHealthState;
  const levels = [...flags].map((flag) => FLAG_LEVEL[flag]);
  if (levels.includes('critical') || (flags.has('access_expired') && usable === 0)) {
    health = 'critical';
  } else if (levels.includes('warning')) {
    health = 'warning';
  } else if (retired || (server.facts === null && last === null)) {
    health = 'unknown';
  } else {
    health = 'ok';
  }

  return {
    server: {
      id: server.id,
      name: server.name,
      state: server.state,
      country: server.country,
      tags: [...server.tags],
    },
    health,
    flags: [...flags],
    facts:
      server.facts === null
        ? null
        : {
            collectedAt: server.facts.collectedAt.toISOString(),
            stale: factsStale,
            os: server.facts.os,
            kernel: server.facts.kernel,
          },
    baseline: {
      status,
      name: server.baseline?.name ?? null,
      version: server.baseline?.version ?? null,
      lastRunAt: iso(last?.at ?? null),
      counts: last !== null && last.state === 'completed' ? { ...last.counts } : null,
      errorCode: last?.state === 'error' ? last.errorCode : null,
      trend: last?.state === 'completed' ? last.trend : null,
      running: server.running,
    },
    hostKey: { pinned: server.hostKeyCount > 0, count: server.hostKeyCount },
    access: {
      entries: server.access.length,
      usable,
      expired,
      lastVerifiedAt: iso(newestTry?.lastVerifiedAt ?? null),
      lastVerifyOk: newestTry?.lastVerifyOk ?? null,
    },
    panelNode:
      server.node === null || reconciledAt === null
        ? null
        : { name: server.node.name, state: server.node.state, asOf: reconciledAt.toISOString() },
  };
}

const HEALTH_RANK: Record<FleetHealthState, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  ok: 3,
};

const byText = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export interface FleetPage {
  readonly rows: FleetHealthRow[];
  readonly total: number;
}

/** Filters, sorts and pages the rows of the fleet. The filters combine. */
export function pageFleet(rows: readonly FleetHealthRow[], query: FleetHealthQuery): FleetPage {
  const text = query.q?.toLowerCase();
  const matching = rows.filter(
    (row) =>
      (query.state === undefined || row.server.state === query.state) &&
      (query.tag === undefined || row.server.tags.includes(query.tag)) &&
      (query.health === undefined || row.health === query.health) &&
      (query.flag === undefined || row.flags.includes(query.flag)) &&
      (text === undefined ||
        row.server.name.toLowerCase().includes(text) ||
        row.server.tags.some((tag) => tag.toLowerCase().includes(text))),
  );
  const sort = query.sort ?? 'health';
  const direction = query.order === 'desc' ? -1 : 1;
  const sorted = [...matching].sort((a, b) => {
    let order = 0;
    if (sort === 'health') {
      order = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
    } else if (sort === 'lastCheck') {
      // The longest without a finished check first; never checked is the longest of all.
      const x = a.baseline.lastRunAt === null ? -Infinity : Date.parse(a.baseline.lastRunAt);
      const y = b.baseline.lastRunAt === null ? -Infinity : Date.parse(b.baseline.lastRunAt);
      order = x === y ? 0 : x < y ? -1 : 1;
    }
    const decided = order !== 0 ? order : byText(a.server.name, b.server.name);
    // A reversed order reverses the whole comparison, ties by name included.
    return decided === 0 ? (a.server.id < b.server.id ? -1 : 1) : direction * decided;
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? FLEET_HEALTH_PAGE_DEFAULT;
  return { rows: sorted.slice(offset, offset + limit), total: sorted.length };
}
