import { createHash } from 'node:crypto';

import {
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionKind,
  type AttentionLink,
  type AttentionSeverity,
  type AttentionSource,
  type PanelConnectionState,
} from '@swellwright/contracts';
import { daysUntil } from '@swellwright/remnawave';

import { expiryView } from '../vault/expiry.js';

/**
 * The attention feed as a pure function (ADR 0047): facts that were read from this server's own records go in, a ranked
 * list of items comes out. Nothing here reads a database, the clock or the network, so a table of fixtures can say
 * what every source makes of every state, with the clock moved at will. A source whose facts are `null` was not read
 * (the caller may not, or reading failed) and makes no item.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How many names an item lists; the rest is a count. */
const NAMES_SHOWN = 3;

export interface AttentionThresholds {
  /** Vault secrets and the panel token count as expiring this many days ahead. */
  readonly expiryWarningDays: number;
  /** 0 switches the check off. */
  readonly baselineStaleDays: number;
  readonly factsStaleDays: number;
  readonly snapshotStaleDays: number;
  readonly auditVerifyDays: number;
  readonly runsWindowHours: number;
}

export interface VaultFacts {
  readonly state: 'uninitialized' | 'sealed' | 'unsealed';
  /** The secrets that have an expiry (the others cannot expire). */
  readonly expiring: readonly { readonly name: string; readonly expiresAt: Date }[];
}

export interface PanelFacts {
  readonly state: PanelConnectionState;
  readonly lastCheckedAt: Date | null;
  readonly version: string | null;
  readonly tokenExpiresAt: Date | null;
}

export interface ConventionFacts {
  readonly panelConnected: boolean;
  readonly last: {
    readonly ranAt: Date;
    readonly errors: number;
    readonly warnings: number;
  } | null;
}

export interface ReconciliationFacts {
  readonly panelConnected: boolean;
  readonly last: {
    readonly ranAt: Date;
    readonly drift: number;
    readonly missing: number;
    readonly extra: number;
    readonly unknown: number;
    readonly inventoryCompared: boolean;
  } | null;
}

export interface SnapshotFacts {
  readonly panelConnected: boolean;
  /** The interval of the background job in milliseconds; 0 when it is off. */
  readonly intervalMs: number;
  readonly latest: {
    readonly createdAt: Date;
    readonly checkedAt: Date | null;
    readonly changesSince: number | null;
  } | null;
}

export interface BaselineServerFacts {
  readonly name: string;
  /** A baseline applies to the server. */
  readonly assigned: boolean;
  readonly running: boolean;
  /** The newest run that finished, or null when none has. */
  readonly last: {
    readonly state: 'completed' | 'error';
    readonly at: Date;
    readonly fail: number;
    readonly warn: number;
    readonly error: number;
    readonly errorCode: string | null;
  } | null;
}

export interface BaselineFacts {
  readonly servers: readonly BaselineServerFacts[];
}

export interface InventoryServerFacts {
  readonly name: string;
  readonly state: 'draft' | 'provisioning' | 'active' | 'draining' | 'retired';
  readonly hostKeyCount: number;
  readonly accessCount: number;
  readonly factsAt: Date | null;
}

export interface ServerFacts {
  readonly servers: readonly InventoryServerFacts[];
}

export interface RunFacts {
  readonly failed: number;
  readonly latestAt: Date | null;
}

export interface AuditFacts {
  /** The newest verification of the chain, from the audit log itself. */
  readonly lastVerification: { readonly at: Date; readonly ok: boolean } | null;
  /** The oldest event: a chain that is young needs no reminder. */
  readonly oldestEventAt: Date | null;
}

export interface PluginFacts {
  /** Plugins that were enabled and were switched off because their files are gone, unusable or changed. */
  readonly switchedOff: readonly {
    readonly id: string;
    readonly reason: string;
    readonly at: Date;
  }[];
}

export interface UpdateFacts {
  readonly current: string;
  readonly latest: string | null;
  readonly checkedAt: Date | null;
}

export interface AttentionFacts {
  readonly vault: VaultFacts | null;
  readonly panel: PanelFacts | null;
  readonly conventions: ConventionFacts | null;
  readonly reconciliation: ReconciliationFacts | null;
  readonly snapshots: SnapshotFacts | null;
  readonly baseline: BaselineFacts | null;
  readonly servers: ServerFacts | null;
  readonly runs: RunFacts | null;
  readonly audit: AuditFacts | null;
  readonly plugins: PluginFacts | null;
  readonly updates: UpdateFacts | null;
}

type Params = Record<string, string | number | boolean | null>;

interface KindInfo {
  readonly source: AttentionSource;
  readonly severity: AttentionSeverity;
  readonly link: AttentionLink | null;
  readonly title: (params: Params) => string;
  readonly detail: (params: Params) => string;
}

const plural = (count: unknown, one: string, many: string): string => (count === 1 ? one : many);

/** The kinds, with the English texts an API client reads (the console has its own, in both languages). */
const KINDS: Record<AttentionKind, KindInfo> = {
  'vault.secrets_expired': {
    source: 'vault',
    severity: 'critical',
    link: '/dashboard/security/vault',
    title: (p) =>
      `${String(p['count'])} vault ${plural(p['count'], 'secret has', 'secrets have')} expired`,
    detail: (p) =>
      `An expired secret is refused by everything that would use it: ${listed(p)}. Renew or replace it.`,
  },
  'vault.secrets_expiring': {
    source: 'vault',
    severity: 'warning',
    link: '/dashboard/security/vault',
    title: (p) =>
      `${String(p['count'])} vault ${plural(p['count'], 'secret expires', 'secrets expire')} soon`,
    detail: (p) =>
      `The first one expires in ${String(p['soonestDays'])} ${plural(p['soonestDays'], 'day', 'days')}: ${listed(p)}.`,
  },
  'vault.sealed': {
    source: 'vault',
    severity: 'warning',
    link: '/dashboard/security/vault',
    title: () => 'The vault is sealed',
    detail: () =>
      'Nothing that needs a secret can run (server logins, runs, the panel connection) until someone unseals it.',
  },
  'vault.uninitialized': {
    source: 'vault',
    severity: 'info',
    link: '/dashboard/security/vault',
    title: () => 'The vault is not set up',
    detail: () => 'Set it up to keep the secrets of your servers and your panel.',
  },
  'panel.unauthorized': {
    source: 'panel',
    severity: 'critical',
    link: '/dashboard/panel/connection',
    title: () => 'The panel refuses the token',
    detail: () => 'The token is expired, revoked or wrong. Connect with a new one.',
  },
  'panel.token_expired': {
    source: 'panel',
    severity: 'critical',
    link: '/dashboard/panel/connection',
    title: () => 'The token of the panel has expired',
    detail: () => 'Create a new token in the panel and connect with it.',
  },
  'panel.unreachable': {
    source: 'panel',
    severity: 'warning',
    link: '/dashboard/panel/connection',
    title: () => 'The panel does not answer',
    detail: () =>
      'The last check could not reach it (network, certificate, timeout or a server error).',
  },
  'panel.unsupported': {
    source: 'panel',
    severity: 'warning',
    link: '/dashboard/panel/connection',
    title: () => 'The version of the panel is not supported',
    detail: (p) =>
      `The panel reports ${String(p['version'] ?? 'an unknown version')}, outside what this release reads.`,
  },
  'panel.degraded': {
    source: 'panel',
    severity: 'warning',
    link: '/dashboard/panel/connection',
    title: () => 'The panel connection is limited',
    detail: () => 'It works, but the token cannot read everything or a read failed.',
  },
  'panel.token_expiring': {
    source: 'panel',
    severity: 'warning',
    link: '/dashboard/panel/connection',
    title: (p) =>
      `The panel token expires in ${String(p['daysLeft'])} ${plural(p['daysLeft'], 'day', 'days')}`,
    detail: () => 'Create a new token in the panel and connect with it before then.',
  },
  'panel.not_connected': {
    source: 'panel',
    severity: 'info',
    link: '/dashboard/panel/connection',
    title: () => 'No panel is connected',
    detail: () => 'Connect a Remnawave panel to see its nodes, hosts and profiles here.',
  },
  'conventions.errors': {
    source: 'conventions',
    severity: 'warning',
    link: '/dashboard/panel/checks',
    title: (p) =>
      `${String(p['errors'])} ${plural(p['errors'], 'convention error', 'convention errors')} in the panel`,
    detail: (p) =>
      `The last run found ${String(p['errors'])} errors and ${String(p['warnings'])} warnings.`,
  },
  'conventions.warnings': {
    source: 'conventions',
    severity: 'info',
    link: '/dashboard/panel/checks',
    title: (p) =>
      `${String(p['warnings'])} ${plural(p['warnings'], 'convention warning', 'convention warnings')} in the panel`,
    detail: () => 'The last run found no errors.',
  },
  'conventions.not_run': {
    source: 'conventions',
    severity: 'info',
    link: '/dashboard/panel/checks',
    title: () => 'The conventions have not been checked yet',
    detail: () => 'Run the checks to see whether the panel follows your rules.',
  },
  'reconciliation.drift': {
    source: 'reconciliation',
    severity: 'warning',
    link: '/dashboard/panel/checks',
    title: (p) =>
      `${String(p['total'])} ${plural(p['total'], 'difference', 'differences')} between the panel and the inventory`,
    detail: (p) =>
      `The last reconciliation found ${String(p['drift'])} drifting, ${String(p['missing'])} missing and ${String(p['extra'])} extra.`,
  },
  'reconciliation.undecided': {
    source: 'reconciliation',
    severity: 'info',
    link: '/dashboard/panel/checks',
    title: (p) =>
      `${String(p['unknown'])} ${plural(p['unknown'], 'comparison', 'comparisons')} could not be decided`,
    detail: () => 'A name did not resolve in time or nothing serves an inbound.',
  },
  'snapshots.stale': {
    source: 'snapshots',
    severity: 'warning',
    link: '/dashboard/panel/snapshots',
    title: () => 'The last snapshot of the panel is old',
    detail: (p) => `Nothing was taken or compared for ${String(p['ageHours'])} hours.`,
  },
  'snapshots.none': {
    source: 'snapshots',
    severity: 'info',
    link: '/dashboard/panel/snapshots',
    title: () => 'No snapshot of the panel yet',
    detail: () => 'Take one to be able to see what changes.',
  },
  'snapshots.changed': {
    source: 'snapshots',
    severity: 'info',
    link: '/dashboard/panel/snapshots',
    title: (p) =>
      `${String(p['changes'])} ${plural(p['changes'], 'change', 'changes')} in the panel since the last snapshot`,
    detail: () => 'Compare the panel with the snapshot to see what changed.',
  },
  'baseline.host_key_mismatch': {
    source: 'baseline',
    severity: 'critical',
    link: '/dashboard/fleet/baseline',
    title: (p) =>
      `The host key of ${String(p['count'])} ${plural(p['count'], 'server', 'servers')} changed`,
    detail: (p) =>
      `The check refused to log in: ${listed(p)}. Find out why before you pin the new key.`,
  },
  'baseline.failing': {
    source: 'baseline',
    severity: 'warning',
    link: '/dashboard/fleet/baseline',
    title: (p) =>
      `${String(p['servers'])} ${plural(p['servers'], 'server fails', 'servers fail')} its baseline`,
    detail: (p) => `${String(p['checks'])} checks failed: ${listed(p)}.`,
  },
  'baseline.unreachable': {
    source: 'baseline',
    severity: 'warning',
    link: '/dashboard/fleet/baseline',
    title: (p) =>
      `${String(p['count'])} ${plural(p['count'], 'server', 'servers')} could not be checked`,
    detail: (p) => `The last check could not observe ${listed(p)}.`,
  },
  'baseline.stale': {
    source: 'baseline',
    severity: 'warning',
    link: '/dashboard/fleet/baseline',
    title: (p) =>
      `${String(p['count'])} ${plural(p['count'], 'server', 'servers')} not checked for ${String(p['days'])} days`,
    detail: (p) => `The newest check is older than ${String(p['days'])} days: ${listed(p)}.`,
  },
  'baseline.warnings': {
    source: 'baseline',
    severity: 'info',
    link: '/dashboard/fleet/baseline',
    title: (p) =>
      `${String(p['servers'])} ${plural(p['servers'], 'server has', 'servers have')} baseline warnings`,
    detail: (p) => `${String(p['checks'])} checks warn: ${listed(p)}.`,
  },
  'baseline.never_checked': {
    source: 'baseline',
    severity: 'info',
    link: '/dashboard/fleet/baseline',
    title: (p) =>
      `${String(p['count'])} ${plural(p['count'], 'server has', 'servers have')} never been checked`,
    detail: (p) => `A baseline applies but no check has finished: ${listed(p)}.`,
  },
  'servers.not_ready': {
    source: 'servers',
    severity: 'warning',
    link: '/dashboard/fleet/servers',
    title: (p) =>
      `${String(p['count'])} ${plural(p['count'], 'server is', 'servers are')} not ready to be managed`,
    detail: (p) =>
      `${String(p['noKey'])} without a pinned host key, ${String(p['noAccess'])} without an access entry: ${listed(p)}.`,
  },
  'servers.facts_stale': {
    source: 'servers',
    severity: 'info',
    link: '/dashboard/fleet/servers',
    title: (p) =>
      `The facts of ${String(p['count'])} ${plural(p['count'], 'server are', 'servers are')} old or missing`,
    detail: (p) =>
      `${String(p['stale'])} older than ${String(p['days'])} days, ${String(p['missing'])} never collected: ${listed(p)}.`,
  },
  'runs.failed': {
    source: 'runs',
    severity: 'warning',
    link: '/dashboard/operations/runs',
    title: (p) =>
      `${String(p['count'])} ${plural(p['count'], 'run', 'runs')} of commands failed in the last ${String(p['hours'])} hours`,
    detail: () => 'Open the history of runs to see which servers failed and why.',
  },
  'audit.chain_failed': {
    source: 'audit',
    severity: 'critical',
    link: '/dashboard/security/audit',
    title: () => 'The last check of the audit chain failed',
    detail: () =>
      'The chain does not verify: a record is missing or was changed. Treat it as an incident and check it again.',
  },
  'audit.verify_overdue': {
    source: 'audit',
    severity: 'info',
    link: '/dashboard/security/audit',
    title: () => 'The audit chain has not been verified for a while',
    detail: (p) =>
      p['neverVerified'] === true
        ? 'It has never been verified.'
        : `The last verification was ${String(p['days'])} days ago.`,
  },
  'plugins.switched_off': {
    source: 'plugins',
    severity: 'warning',
    link: '/dashboard/settings/plugins',
    title: (p) =>
      `${String(p['count'])} ${plural(p['count'], 'plugin was', 'plugins were')} switched off`,
    detail: (p) =>
      `Their files are gone, unusable or changed since they were approved: ${listed(p)}. Review and enable them again.`,
  },
  'updates.available': {
    source: 'updates',
    severity: 'info',
    link: null,
    title: (p) => `Version ${String(p['latest'])} is available`,
    detail: (p) => `This server runs ${String(p['current'])}.`,
  },
};

// ---- Helpers ---------------------------------------------------------------------------------------------------------

/** A short fingerprint of the facts behind an item: it changes when they do. */
function fingerprintOf(kind: string, severity: string, params: Params): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, severity, params]))
    .digest('hex')
    .slice(0, 8);
}

function make(
  kind: AttentionKind,
  params: Params,
  since: Date | null,
  severity?: AttentionSeverity,
): AttentionItem {
  const info = KINDS[kind];
  const level = severity ?? info.severity;
  return {
    id: kind,
    fingerprint: fingerprintOf(kind, level, params),
    severity: level,
    kind,
    source: info.source,
    title: info.title(params),
    detail: info.detail(params),
    params,
    since: since === null ? null : since.toISOString(),
    link: info.link,
  };
}

/** The first few names in order, comma separated, and how many more there are: `names` and `more` of an item. */
function namesOf(names: readonly string[]): { names: string; more: number } {
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    names: sorted.slice(0, NAMES_SHOWN).join(', '),
    more: Math.max(0, sorted.length - NAMES_SHOWN),
  };
}

/** The names of an item as English text (the console composes its own, in the language of the user). */
function listed(params: Params): string {
  const more = typeof params['more'] === 'number' ? params['more'] : 0;
  return more > 0 ? `${String(params['names'])} and ${String(more)} more` : String(params['names']);
}

const oldest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.min(...dates.map((date) => date.getTime())));
const newest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime())));

/** Whole numbers 0 to 4 are all that a version has to be told apart by here: `1.2.3-rc.1` is `1.2.3` with a tag. */
function versionParts(version: string): { numbers: number[]; pre: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+.*)?$/u.exec(version.trim());
  if (!match) {
    return null;
  }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined,
  };
}

/** Whether `latest` is a newer release than `current`. An unreadable version is never newer. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (a === null || b === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const x = a.numbers[index] ?? 0;
    const y = b.numbers[index] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  // The same numbers: a release is newer than a pre-release of it.
  return b.pre && !a.pre;
}

// ---- The sources -----------------------------------------------------------------------------------------------------

function vaultItems(
  facts: VaultFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (facts.state === 'uninitialized') {
    items.push(make('vault.uninitialized', {}, null));
  } else if (facts.state === 'sealed') {
    items.push(make('vault.sealed', {}, null));
  }
  const expired: { name: string; expiresAt: Date }[] = [];
  const soon: { name: string; expiresAt: Date; days: number }[] = [];
  for (const secret of facts.expiring) {
    const view = expiryView(secret.expiresAt, now);
    if (view.expired) {
      expired.push(secret);
    } else if (view.expiresInDays !== null && view.expiresInDays <= thresholds.expiryWarningDays) {
      soon.push({ ...secret, days: view.expiresInDays });
    }
  }
  if (expired.length > 0) {
    items.push(
      make(
        'vault.secrets_expired',
        { count: expired.length, ...namesOf(expired.map((secret) => secret.name)) },
        oldest(expired.map((secret) => secret.expiresAt)),
      ),
    );
  }
  if (soon.length > 0) {
    items.push(
      make(
        'vault.secrets_expiring',
        {
          count: soon.length,
          soonestDays: Math.min(...soon.map((secret) => secret.days)),
          ...namesOf(soon.map((secret) => secret.name)),
        },
        null,
      ),
    );
  }
  return items;
}

function panelItems(
  facts: PanelFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const seen = facts.lastCheckedAt;
  switch (facts.state) {
    case 'unconfigured':
      items.push(make('panel.not_connected', {}, null));
      return items;
    case 'unauthorized':
      items.push(make('panel.unauthorized', {}, seen));
      break;
    case 'unreachable':
      items.push(make('panel.unreachable', {}, seen));
      break;
    case 'unsupported':
      items.push(make('panel.unsupported', { version: facts.version }, seen));
      break;
    case 'degraded':
      items.push(make('panel.degraded', {}, seen));
      break;
    case 'connected':
      break;
  }
  if (facts.tokenExpiresAt !== null) {
    const daysLeft = daysUntil(facts.tokenExpiresAt, new Date(now));
    if (daysLeft < 0) {
      items.push(make('panel.token_expired', {}, facts.tokenExpiresAt));
    } else if (daysLeft <= thresholds.expiryWarningDays) {
      items.push(make('panel.token_expiring', { daysLeft }, null));
    }
  }
  return items;
}

function conventionItems(facts: ConventionFacts): AttentionItem[] {
  if (!facts.panelConnected) {
    return [];
  }
  if (facts.last === null) {
    return [make('conventions.not_run', {}, null)];
  }
  const { errors, warnings, ranAt } = facts.last;
  if (errors > 0) {
    return [make('conventions.errors', { errors, warnings }, ranAt)];
  }
  return warnings > 0 ? [make('conventions.warnings', { warnings }, ranAt)] : [];
}

function reconciliationItems(facts: ReconciliationFacts): AttentionItem[] {
  if (!facts.panelConnected || facts.last === null) {
    return [];
  }
  const { drift, missing, extra, unknown, ranAt, inventoryCompared } = facts.last;
  const items: AttentionItem[] = [];
  const total = drift + missing + extra;
  if (total > 0) {
    items.push(
      make('reconciliation.drift', { total, drift, missing, extra, inventoryCompared }, ranAt),
    );
  }
  if (unknown > 0) {
    items.push(make('reconciliation.undecided', { unknown }, ranAt));
  }
  return items;
}

function snapshotItems(
  facts: SnapshotFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  if (!facts.panelConnected) {
    return [];
  }
  const { latest } = facts;
  if (latest === null) {
    return [make('snapshots.none', {}, null)];
  }
  const items: AttentionItem[] = [];
  const last = Math.max(latest.createdAt.getTime(), latest.checkedAt?.getTime() ?? 0);
  // The job compares the panel with the snapshot every interval, so a run that was missed or two is a stale job.
  const limit = facts.intervalMs > 0 ? facts.intervalMs * 2 : thresholds.snapshotStaleDays * DAY_MS;
  if (limit > 0 && now - last > limit) {
    items.push(
      make('snapshots.stale', { ageHours: Math.floor((now - last) / HOUR_MS) }, new Date(last)),
    );
  }
  if (latest.changesSince !== null && latest.changesSince > 0) {
    items.push(make('snapshots.changed', { changes: latest.changesSince }, latest.checkedAt));
  }
  return items;
}

function baselineItems(
  facts: BaselineFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const mismatch = facts.servers.filter(
    (server) => server.last?.state === 'error' && server.last.errorCode === 'host_key_mismatch',
  );
  const unreachable = facts.servers.filter(
    (server) => server.last?.state === 'error' && server.last.errorCode !== 'host_key_mismatch',
  );
  const completed = facts.servers.filter((server) => server.last?.state === 'completed');
  const failing = completed.filter((server) => (server.last?.fail ?? 0) > 0);
  const warning = completed.filter(
    (server) =>
      (server.last?.fail ?? 0) === 0 &&
      ((server.last?.warn ?? 0) > 0 || (server.last?.error ?? 0) > 0),
  );
  const never = facts.servers.filter(
    (server) => server.assigned && server.last === null && !server.running,
  );
  const staleLimit = thresholds.baselineStaleDays * DAY_MS;
  const stale =
    staleLimit > 0
      ? completed.filter(
          (server) =>
            server.assigned &&
            !server.running &&
            server.last !== null &&
            now - server.last.at.getTime() > staleLimit,
        )
      : [];
  const at = (list: readonly BaselineServerFacts[]): Date | null =>
    newest(list.flatMap((server) => (server.last === null ? [] : [server.last.at])));
  if (mismatch.length > 0) {
    items.push(
      make(
        'baseline.host_key_mismatch',
        { count: mismatch.length, ...namesOf(mismatch.map((server) => server.name)) },
        at(mismatch),
      ),
    );
  }
  if (failing.length > 0) {
    items.push(
      make(
        'baseline.failing',
        {
          servers: failing.length,
          checks: failing.reduce((sum, server) => sum + (server.last?.fail ?? 0), 0),
          ...namesOf(failing.map((server) => server.name)),
        },
        at(failing),
      ),
    );
  }
  if (unreachable.length > 0) {
    items.push(
      make(
        'baseline.unreachable',
        { count: unreachable.length, ...namesOf(unreachable.map((server) => server.name)) },
        at(unreachable),
      ),
    );
  }
  if (stale.length > 0) {
    items.push(
      make(
        'baseline.stale',
        {
          count: stale.length,
          days: thresholds.baselineStaleDays,
          ...namesOf(stale.map((server) => server.name)),
        },
        oldest(stale.flatMap((server) => (server.last === null ? [] : [server.last.at]))),
      ),
    );
  }
  if (warning.length > 0) {
    items.push(
      make(
        'baseline.warnings',
        {
          servers: warning.length,
          checks: warning.reduce(
            (sum, server) => sum + (server.last?.warn ?? 0) + (server.last?.error ?? 0),
            0,
          ),
          ...namesOf(warning.map((server) => server.name)),
        },
        at(warning),
      ),
    );
  }
  if (never.length > 0) {
    items.push(
      make(
        'baseline.never_checked',
        { count: never.length, ...namesOf(never.map((server) => server.name)) },
        null,
      ),
    );
  }
  return items;
}

/** A server that is only a draft or is retired is not expected to be set up. */
const isOperational = (server: InventoryServerFacts): boolean =>
  server.state === 'active' || server.state === 'provisioning' || server.state === 'draining';

function serverItems(
  facts: ServerFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const live = facts.servers.filter((server) => server.state !== 'retired');
  const notReady = live.filter((server) => server.hostKeyCount === 0 || server.accessCount === 0);
  if (notReady.length > 0) {
    const operational = notReady.filter(isOperational);
    const subjects = operational.length > 0 ? operational : notReady;
    items.push(
      make(
        'servers.not_ready',
        {
          count: subjects.length,
          noKey: subjects.filter((server) => server.hostKeyCount === 0).length,
          noAccess: subjects.filter((server) => server.accessCount === 0).length,
          ...namesOf(subjects.map((server) => server.name)),
        },
        null,
        operational.length > 0 ? 'warning' : 'info',
      ),
    );
  }
  const limit = thresholds.factsStaleDays * DAY_MS;
  if (limit > 0) {
    // Only servers that can be reached: one that is not ready is already in the item above.
    const ready = live.filter(
      (server) => isOperational(server) && server.hostKeyCount > 0 && server.accessCount > 0,
    );
    const missing = ready.filter((server) => server.factsAt === null);
    const stale = ready.filter(
      (server) => server.factsAt !== null && now - server.factsAt.getTime() > limit,
    );
    if (missing.length + stale.length > 0) {
      items.push(
        make(
          'servers.facts_stale',
          {
            count: missing.length + stale.length,
            stale: stale.length,
            missing: missing.length,
            days: thresholds.factsStaleDays,
            ...namesOf([...missing, ...stale].map((server) => server.name)),
          },
          null,
        ),
      );
    }
  }
  return items;
}

function runItems(facts: RunFacts, thresholds: AttentionThresholds): AttentionItem[] {
  return facts.failed > 0
    ? [
        make(
          'runs.failed',
          { count: facts.failed, hours: thresholds.runsWindowHours },
          facts.latestAt,
        ),
      ]
    : [];
}

function auditItems(
  facts: AuditFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  const { lastVerification } = facts;
  if (lastVerification !== null && !lastVerification.ok) {
    return [make('audit.chain_failed', {}, lastVerification.at)];
  }
  const limit = thresholds.auditVerifyDays * DAY_MS;
  if (limit <= 0) {
    return [];
  }
  if (lastVerification === null) {
    // A chain younger than the interval has had no time to be forgotten.
    return facts.oldestEventAt !== null && now - facts.oldestEventAt.getTime() > limit
      ? [make('audit.verify_overdue', { neverVerified: true, days: null }, null)]
      : [];
  }
  const age = now - lastVerification.at.getTime();
  return age > limit
    ? [
        make(
          'audit.verify_overdue',
          { neverVerified: false, days: Math.floor(age / DAY_MS) },
          lastVerification.at,
        ),
      ]
    : [];
}

function pluginItems(facts: PluginFacts): AttentionItem[] {
  if (facts.switchedOff.length === 0) {
    return [];
  }
  return [
    make(
      'plugins.switched_off',
      {
        count: facts.switchedOff.length,
        ...namesOf(facts.switchedOff.map((plugin) => plugin.id)),
      },
      newest(facts.switchedOff.map((plugin) => plugin.at)),
    ),
  ];
}

function updateItems(facts: UpdateFacts): AttentionItem[] {
  return facts.latest !== null && isNewerVersion(facts.latest, facts.current)
    ? [make('updates.available', { latest: facts.latest, current: facts.current }, facts.checkedAt)]
    : [];
}

// ---- The feed --------------------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };
const KIND_RANK = new Map<AttentionKind, number>(
  ATTENTION_KINDS.map((kind, index) => [kind, index]),
);

/**
 * Most severe first, then by the order of the kinds (what stops things before what only nags), then the oldest first
 * (a condition that has lasted longer comes before a newer one; one without a date comes last).
 */
export function rankItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const byKind = (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0);
    if (byKind !== 0) {
      return byKind;
    }
    const x = a.since === null ? Infinity : Date.parse(a.since);
    const y = b.since === null ? Infinity : Date.parse(b.since);
    return x === y ? 0 : x < y ? -1 : 1;
  });
}

/** Everything the facts say needs attention, ranked. `now` is milliseconds since the epoch. */
export function buildAttention(
  facts: AttentionFacts,
  now: number,
  thresholds: AttentionThresholds,
): AttentionItem[] {
  const items: AttentionItem[] = [
    ...(facts.vault === null ? [] : vaultItems(facts.vault, now, thresholds)),
    ...(facts.panel === null ? [] : panelItems(facts.panel, now, thresholds)),
    ...(facts.conventions === null ? [] : conventionItems(facts.conventions)),
    ...(facts.reconciliation === null ? [] : reconciliationItems(facts.reconciliation)),
    ...(facts.snapshots === null ? [] : snapshotItems(facts.snapshots, now, thresholds)),
    ...(facts.baseline === null ? [] : baselineItems(facts.baseline, now, thresholds)),
    ...(facts.servers === null ? [] : serverItems(facts.servers, now, thresholds)),
    ...(facts.runs === null ? [] : runItems(facts.runs, thresholds)),
    ...(facts.audit === null ? [] : auditItems(facts.audit, now, thresholds)),
    ...(facts.plugins === null ? [] : pluginItems(facts.plugins)),
    ...(facts.updates === null ? [] : updateItems(facts.updates)),
  ];
  return rankItems(items);
}
