import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTENTION_KINDS,
  ATTENTION_SOURCE_PERMISSIONS,
  ATTENTION_SOURCES,
  AttentionItemSchema,
  type AttentionItem,
  type AttentionKind,
} from '@swellwright/contracts';

import {
  type AttentionFacts,
  type AttentionThresholds,
  type BaselineServerFacts,
  buildAttention,
  isNewerVersion,
  rankItems,
} from './attention.js';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number): Date => new Date(NOW - ms);
const ahead = (ms: number): Date => new Date(NOW + ms);

const THRESHOLDS: AttentionThresholds = {
  expiryWarningDays: 14,
  baselineStaleDays: 7,
  factsStaleDays: 14,
  snapshotStaleDays: 7,
  auditVerifyDays: 30,
  runsWindowHours: 24,
};

/** Facts for a system where nothing was read. Each test fills in the source it is about. */
const NONE: AttentionFacts = {
  vault: null,
  panel: null,
  conventions: null,
  reconciliation: null,
  snapshots: null,
  baseline: null,
  servers: null,
  runs: null,
  audit: null,
  plugins: null,
  updates: null,
};

/** Every kind any test of this file has made, so that the last test can say which kind has no fixture. */
const produced = new Set<AttentionKind>();

const build = (facts: Partial<AttentionFacts>, thresholds = THRESHOLDS): AttentionItem[] => {
  const items = buildAttention({ ...NONE, ...facts }, NOW, thresholds);
  for (const item of items) {
    produced.add(item.kind);
  }
  return items;
};

const kinds = (items: readonly AttentionItem[]): AttentionKind[] => items.map((item) => item.kind);

const only = (items: readonly AttentionItem[], kind: AttentionKind): AttentionItem => {
  const found = items.find((item) => item.kind === kind);
  assert.ok(found, `${kind} is not in ${JSON.stringify(kinds(items))}`);
  return found;
};

const server = (name: string, patch: Partial<BaselineServerFacts> = {}): BaselineServerFacts => ({
  name,
  assigned: true,
  running: false,
  last: null,
  ...patch,
});

describe('the attention feed: a system with nothing wrong', () => {
  it('says nothing when no source was read', () => {
    assert.deepEqual(build({}), []);
  });

  it('says nothing for a healthy system', () => {
    const items = build({
      vault: { state: 'unsealed', expiring: [{ name: 'later', expiresAt: ahead(400 * DAY) }] },
      panel: {
        state: 'connected',
        lastCheckedAt: ago(HOUR),
        version: '3.4.11',
        tokenExpiresAt: ahead(200 * DAY),
      },
      conventions: {
        panelConnected: true,
        last: { ranAt: ago(HOUR), errors: 0, warnings: 0 },
      },
      reconciliation: {
        panelConnected: true,
        last: {
          ranAt: ago(HOUR),
          drift: 0,
          missing: 0,
          extra: 0,
          unknown: 0,
          inventoryCompared: true,
          inventoryServers: 3,
          unmanaged: 0,
        },
      },
      snapshots: {
        panelConnected: true,
        intervalMs: 24 * HOUR,
        latest: { createdAt: ago(5 * HOUR), checkedAt: ago(HOUR), changesSince: 0 },
      },
      baseline: {
        servers: [
          server('a', {
            last: { state: 'completed', at: ago(DAY), fail: 0, warn: 0, error: 0, errorCode: null },
          }),
        ],
      },
      servers: {
        servers: [
          { name: 'a', state: 'active', hostKeyCount: 1, accessCount: 1, factsAt: ago(DAY) },
        ],
      },
      runs: { failed: 0, latestAt: null },
      audit: { lastVerification: { at: ago(DAY), ok: true }, oldestEventAt: ago(100 * DAY) },
      plugins: { switchedOff: [] },
      updates: { current: '1.0.0', latest: '1.0.0', checkedAt: ago(HOUR) },
    });
    assert.deepEqual(items, []);
  });
});

describe('the attention feed: the vault', () => {
  it('reports a vault that is not set up and one that is sealed', () => {
    assert.deepEqual(kinds(build({ vault: { state: 'uninitialized', expiring: [] } })), [
      'vault.uninitialized',
    ]);
    const sealed = build({ vault: { state: 'sealed', expiring: [] } });
    assert.deepEqual(kinds(sealed), ['vault.sealed']);
    assert.equal(sealed[0]?.severity, 'warning');
    assert.equal(sealed[0].link, '/dashboard/security/vault');
  });

  it('counts a secret as expired at the moment of its expiry and not a moment before', () => {
    const at = build({
      vault: { state: 'unsealed', expiring: [{ name: 'edge', expiresAt: new Date(NOW) }] },
    });
    assert.deepEqual(kinds(at), ['vault.secrets_expired']);
    assert.equal(at[0]?.severity, 'critical');
    const before = build({
      vault: { state: 'unsealed', expiring: [{ name: 'edge', expiresAt: new Date(NOW + 1) }] },
    });
    assert.deepEqual(kinds(before), ['vault.secrets_expiring']);
  });

  it('warns 14 days ahead, to the millisecond, and not 14 days and a millisecond ahead', () => {
    const inside = build({
      vault: { state: 'unsealed', expiring: [{ name: 's', expiresAt: ahead(14 * DAY) }] },
    });
    assert.equal(only(inside, 'vault.secrets_expiring').params['soonestDays'], 14);
    const outside = build({
      vault: { state: 'unsealed', expiring: [{ name: 's', expiresAt: ahead(14 * DAY + 1) }] },
    });
    assert.deepEqual(outside, []);
  });

  it('follows the threshold it is given', () => {
    const secret = { name: 's', expiresAt: ahead(20 * DAY) };
    assert.deepEqual(build({ vault: { state: 'unsealed', expiring: [secret] } }), []);
    const wider = build(
      { vault: { state: 'unsealed', expiring: [secret] } },
      { ...THRESHOLDS, expiryWarningDays: 30 },
    );
    assert.deepEqual(kinds(wider), ['vault.secrets_expiring']);
  });

  it('lists a few names and counts the rest, and dates the oldest expiry', () => {
    const items = build({
      vault: {
        state: 'sealed',
        expiring: [
          { name: 'e', expiresAt: ago(DAY) },
          { name: 'd', expiresAt: ago(3 * DAY) },
          { name: 'c', expiresAt: ago(2 * DAY) },
          { name: 'b', expiresAt: ago(4 * DAY) },
          { name: 'a', expiresAt: ago(5 * DAY) },
        ],
      },
    });
    const expired = only(items, 'vault.secrets_expired');
    assert.equal(expired.params['count'], 5);
    assert.equal(expired.params['names'], 'a, b, c');
    assert.equal(expired.params['more'], 2);
    assert.equal(expired.since, ago(5 * DAY).toISOString());
    // A sealed vault still reports expiries: they are stored in the clear.
    assert.ok(kinds(items).includes('vault.sealed'));
  });
});

describe('the attention feed: the panel connection', () => {
  const connection = (
    state: NonNullable<AttentionFacts['panel']>['state'],
    tokenExpiresAt: Date | null = null,
  ): AttentionFacts['panel'] => ({
    state,
    lastCheckedAt: ago(HOUR),
    version: '9.9.9',
    tokenExpiresAt,
  });

  it('maps every state of the connection', () => {
    const cases: [NonNullable<AttentionFacts['panel']>['state'], AttentionKind[], string | null][] =
      [
        ['unconfigured', ['panel.not_connected'], 'info'],
        ['unauthorized', ['panel.unauthorized'], 'critical'],
        ['unreachable', ['panel.unreachable'], 'warning'],
        ['unsupported', ['panel.unsupported'], 'warning'],
        ['degraded', ['panel.degraded'], 'warning'],
        ['connected', [], null],
      ];
    for (const [state, expected, severity] of cases) {
      const items = build({ panel: connection(state) });
      assert.deepEqual(kinds(items), expected, state);
      if (severity !== null) {
        assert.equal(items[0]?.severity, severity, state);
      }
    }
  });

  it('names the unsupported version it was told', () => {
    assert.equal(
      only(build({ panel: connection('unsupported') }), 'panel.unsupported').params['version'],
      '9.9.9',
    );
  });

  it('judges the token like the Overview card does: by whole days, floor', () => {
    // 14 days and 23 hours ahead is still "14 days left": it warns.
    const warns = build({ panel: connection('connected', ahead(14 * DAY + 23 * HOUR)) });
    assert.equal(only(warns, 'panel.token_expiring').params['daysLeft'], 14);
    const quiet = build({ panel: connection('connected', ahead(15 * DAY)) });
    assert.deepEqual(quiet, []);
    const expired = build({ panel: connection('connected', ago(1)) });
    assert.deepEqual(kinds(expired), ['panel.token_expired']);
    assert.equal(expired[0]?.severity, 'critical');
  });

  it('reports the token even when the connection is also in trouble', () => {
    const items = build({ panel: connection('unreachable', ahead(2 * DAY)) });
    assert.deepEqual(kinds(items), ['panel.unreachable', 'panel.token_expiring']);
  });

  it('says nothing about the token of a panel that is not connected', () => {
    assert.deepEqual(kinds(build({ panel: connection('unconfigured', ago(DAY)) })), [
      'panel.not_connected',
    ]);
  });
});

describe('the attention feed: conventions and reconciliation', () => {
  it('says "not run yet" only when a panel is connected', () => {
    assert.deepEqual(kinds(build({ conventions: { panelConnected: true, last: null } })), [
      'conventions.not_run',
    ]);
    assert.deepEqual(build({ conventions: { panelConnected: false, last: null } }), []);
  });

  it('ranks errors above warnings and carries both counts', () => {
    const errors = build({
      conventions: { panelConnected: true, last: { ranAt: ago(HOUR), errors: 2, warnings: 5 } },
    });
    assert.equal(errors[0]?.kind, 'conventions.errors');
    assert.equal(errors[0].severity, 'warning');
    assert.deepEqual(errors[0].params, { errors: 2, warnings: 5 });
    const warnings = build({
      conventions: { panelConnected: true, last: { ranAt: ago(HOUR), errors: 0, warnings: 5 } },
    });
    assert.equal(warnings[0]?.kind, 'conventions.warnings');
    assert.equal(warnings[0].severity, 'info');
  });

  it('adds up the three kinds of difference and keeps the undecided apart', () => {
    const items = build({
      reconciliation: {
        panelConnected: true,
        last: {
          ranAt: ago(HOUR),
          drift: 1,
          missing: 2,
          extra: 3,
          unknown: 4,
          inventoryCompared: false,
          inventoryServers: 0,
          unmanaged: 0,
        },
      },
    });
    assert.deepEqual(only(items, 'reconciliation.drift').params, {
      total: 6,
      drift: 1,
      missing: 2,
      extra: 3,
      inventoryCompared: false,
    });
    assert.equal(only(items, 'reconciliation.undecided').severity, 'info');
    assert.deepEqual(
      build({ reconciliation: { panelConnected: true, last: null } }),
      [],
      'a reconciliation that never ran says nothing',
    );
  });

  describe('with an inventory that has no servers', () => {
    const found = (counts: {
      drift: number;
      missing: number;
      extra: number;
      inventoryCompared?: boolean;
      inventoryServers?: number;
      unmanaged: number;
    }) =>
      only(
        build({
          reconciliation: {
            panelConnected: true,
            last: {
              ranAt: ago(HOUR),
              unknown: 0,
              inventoryCompared: true,
              inventoryServers: 0,
              ...counts,
            },
          },
        }),
        'reconciliation.drift',
      );

    it('is a hint, not a warning, while the only difference is that every node has no server yet', () => {
      const item = found({ drift: 0, missing: 13, extra: 0, unmanaged: 13 });
      assert.equal(item.severity, 'info');
      assert.equal(item.params['total'], 13, 'the numbers are the same');
    });

    it('stays a warning when anything else differs, even one thing', () => {
      assert.equal(found({ drift: 1, missing: 13, extra: 0, unmanaged: 13 }).severity, 'warning');
      assert.equal(
        found({ drift: 0, missing: 14, extra: 0, unmanaged: 13 }).severity,
        'warning',
        'a missing row that is not a node without a server',
      );
      assert.equal(found({ drift: 0, missing: 13, extra: 1, unmanaged: 13 }).severity, 'warning');
    });

    it('is a warning when the inventory has servers, or was not compared at all', () => {
      assert.equal(
        found({ drift: 0, missing: 12, extra: 0, unmanaged: 12, inventoryServers: 1 }).severity,
        'warning',
        'a fleet that was started but not finished is still a difference',
      );
      assert.equal(
        found({
          drift: 0,
          missing: 2,
          extra: 0,
          unmanaged: 0,
          inventoryCompared: false,
        }).severity,
        'warning',
        'without the inventory the counts are those of the panel itself',
      );
    });
  });
});

describe('the attention feed: snapshots', () => {
  const latest = (createdAgo: number, checkedAgo: number | null, changes: number | null) => ({
    createdAt: ago(createdAgo),
    checkedAt: checkedAgo === null ? null : ago(checkedAgo),
    changesSince: changes,
  });

  it('asks for a first snapshot', () => {
    const items = build({ snapshots: { panelConnected: true, intervalMs: DAY, latest: null } });
    assert.deepEqual(kinds(items), ['snapshots.none']);
    assert.deepEqual(
      build({ snapshots: { panelConnected: false, intervalMs: DAY, latest: null } }),
      [],
    );
  });

  it('calls the job stale after two intervals without a look, counting the newest of taken and compared', () => {
    const interval = 24 * HOUR;
    assert.deepEqual(
      build({
        snapshots: {
          panelConnected: true,
          intervalMs: interval,
          latest: latest(10 * DAY, 2 * interval, 0),
        },
      }),
      [],
      'exactly two intervals is not yet stale',
    );
    const stale = build({
      snapshots: {
        panelConnected: true,
        intervalMs: interval,
        latest: latest(10 * DAY, 2 * interval + 1, 0),
      },
    });
    assert.deepEqual(kinds(stale), ['snapshots.stale']);
    assert.equal(stale[0]?.severity, 'warning');
    // A fresh snapshot makes a long unchecked time irrelevant.
    assert.deepEqual(
      build({
        snapshots: {
          panelConnected: true,
          intervalMs: interval,
          latest: latest(HOUR, 10 * DAY, 0),
        },
      }),
      [],
    );
  });

  it('uses the days of the knob when the job is off, and nothing when the knob is 0', () => {
    const old = { panelConnected: true, intervalMs: 0, latest: latest(8 * DAY, null, null) };
    assert.deepEqual(kinds(build({ snapshots: old })), ['snapshots.stale']);
    assert.deepEqual(build({ snapshots: old }, { ...THRESHOLDS, snapshotStaleDays: 0 }), []);
    assert.deepEqual(
      build({ snapshots: { ...old, latest: latest(7 * DAY, null, null) } }),
      [],
      'exactly seven days is not yet stale',
    );
  });

  it('reports the changes since the last snapshot as information', () => {
    const items = build({
      snapshots: {
        panelConnected: true,
        intervalMs: DAY,
        latest: latest(2 * HOUR, HOUR, 3),
      },
    });
    assert.deepEqual(kinds(items), ['snapshots.changed']);
    assert.equal(items[0]?.params['changes'], 3);
    assert.equal(items[0].since, ago(HOUR).toISOString());
  });
});

describe('the attention feed: the baseline checks', () => {
  const checked = (
    name: string,
    counts: { fail?: number; warn?: number; error?: number },
    at = ago(HOUR),
  ): BaselineServerFacts =>
    server(name, {
      last: {
        state: 'completed',
        at,
        fail: counts.fail ?? 0,
        warn: counts.warn ?? 0,
        error: counts.error ?? 0,
        errorCode: null,
      },
    });
  const unreachable = (name: string, errorCode: string): BaselineServerFacts =>
    server(name, {
      last: { state: 'error', at: ago(HOUR), fail: 0, warn: 0, error: 0, errorCode },
    });

  it('sorts the servers into failing, warning, unreachable, stale and never checked', () => {
    const items = build({
      baseline: {
        servers: [
          checked('f1', { fail: 2 }),
          checked('f2', { fail: 1, warn: 9 }),
          checked('w1', { warn: 1 }),
          checked('w2', { error: 2 }),
          checked('ok', {}),
          checked('old', {}, ago(8 * DAY)),
          unreachable('u1', 'ssh_connect_failed'),
          unreachable('m1', 'host_key_mismatch'),
          server('never'),
          server('unassigned', { assigned: false }),
          server('busy', { running: true }),
        ],
      },
    });
    assert.deepEqual(kinds(items), [
      'baseline.host_key_mismatch',
      'baseline.failing',
      'baseline.unreachable',
      'baseline.stale',
      'baseline.warnings',
      'baseline.never_checked',
    ]);
    assert.deepEqual(only(items, 'baseline.failing').params, {
      servers: 2,
      checks: 3,
      names: 'f1, f2',
      more: 0,
    });
    assert.equal(only(items, 'baseline.host_key_mismatch').severity, 'critical');
    assert.equal(only(items, 'baseline.warnings').params['checks'], 3);
    assert.equal(only(items, 'baseline.never_checked').params['names'], 'never');
    assert.equal(only(items, 'baseline.stale').params['names'], 'old');
  });

  it('puts the host key mismatch apart from the other reasons a server cannot be checked', () => {
    const items = build({
      baseline: {
        servers: [unreachable('m', 'host_key_mismatch'), unreachable('x', 'secret_expired')],
      },
    });
    assert.equal(only(items, 'baseline.host_key_mismatch').params['names'], 'm');
    assert.equal(only(items, 'baseline.unreachable').params['names'], 'x');
  });

  it('calls a check stale after N days to the millisecond, and never when N is 0', () => {
    const exactly = build({ baseline: { servers: [checked('a', {}, ago(7 * DAY))] } });
    assert.deepEqual(exactly, []);
    const over = build({ baseline: { servers: [checked('a', {}, ago(7 * DAY + 1))] } });
    assert.deepEqual(kinds(over), ['baseline.stale']);
    assert.deepEqual(
      build(
        { baseline: { servers: [checked('a', {}, ago(400 * DAY))] } },
        { ...THRESHOLDS, baselineStaleDays: 0 },
      ),
      [],
    );
  });

  it('does not call a server that is being checked now stale or never checked', () => {
    const items = build({
      baseline: {
        servers: [
          server('now', { running: true }),
          { ...checked('now2', {}, ago(30 * DAY)), running: true },
        ],
      },
    });
    assert.deepEqual(items, []);
  });
});

describe('the attention feed: servers', () => {
  const entry = (
    name: string,
    patch: Partial<NonNullable<AttentionFacts['servers']>['servers'][number]> = {},
  ) => ({
    name,
    state: 'active' as const,
    hostKeyCount: 1,
    accessCount: 1,
    factsAt: ago(DAY),
    ...patch,
  });

  it('flags a server without a pinned key or without an access entry, as a warning when it is in use', () => {
    const items = build({
      servers: {
        servers: [
          entry('nokey', { hostKeyCount: 0 }),
          entry('noaccess', { accessCount: 0, state: 'provisioning' }),
          entry('both', { hostKeyCount: 0, accessCount: 0, state: 'draining' }),
          entry('draft', { hostKeyCount: 0, accessCount: 0, state: 'draft' }),
          entry('gone', { hostKeyCount: 0, accessCount: 0, state: 'retired' }),
          entry('fine'),
        ],
      },
    });
    const notReady = only(items, 'servers.not_ready');
    assert.equal(notReady.severity, 'warning');
    assert.deepEqual(notReady.params, {
      count: 3,
      noKey: 2,
      noAccess: 2,
      names: 'both, noaccess, nokey',
      more: 0,
    });
  });

  it('is only information when nothing but drafts is incomplete', () => {
    const items = build({
      servers: {
        servers: [
          entry('draft', { hostKeyCount: 0, state: 'draft' }),
          entry('retired', { accessCount: 0, state: 'retired' }),
        ],
      },
    });
    assert.equal(only(items, 'servers.not_ready').severity, 'info');
    assert.equal(only(items, 'servers.not_ready').params['names'], 'draft');
  });

  it('counts facts that are old or missing, only on servers that can be reached', () => {
    const items = build({
      servers: {
        servers: [
          entry('old', { factsAt: ago(14 * DAY + 1) }),
          entry('edge', { factsAt: ago(14 * DAY) }),
          entry('never', { factsAt: null }),
          entry('unready', { factsAt: null, hostKeyCount: 0 }),
          entry('draft', { factsAt: null, state: 'draft' }),
        ],
      },
    });
    assert.deepEqual(only(items, 'servers.facts_stale').params, {
      count: 2,
      stale: 1,
      missing: 1,
      days: 14,
      names: 'never, old',
      more: 0,
    });
    assert.deepEqual(
      kinds(
        build(
          { servers: { servers: [entry('old', { factsAt: ago(400 * DAY) })] } },
          { ...THRESHOLDS, factsStaleDays: 0 },
        ),
      ),
      [],
    );
  });
});

describe('the attention feed: runs, audit, plugins and updates', () => {
  it('reports failed runs with the window it looked at', () => {
    const items = build({ runs: { failed: 2, latestAt: ago(HOUR) } });
    assert.deepEqual(items[0]?.params, { count: 2, hours: 24 });
    assert.equal(items[0].since, ago(HOUR).toISOString());
    assert.equal(items[0].link, '/dashboard/operations/runs');
  });

  it('treats a failed verification of the chain as critical, until a later one succeeds', () => {
    const failed = build({
      audit: { lastVerification: { at: ago(DAY), ok: false }, oldestEventAt: ago(1000 * DAY) },
    });
    assert.deepEqual(kinds(failed), ['audit.chain_failed']);
    assert.equal(failed[0]?.severity, 'critical');
    // A failure is not softened by being old.
    assert.deepEqual(
      kinds(
        build({
          audit: { lastVerification: { at: ago(900 * DAY), ok: false }, oldestEventAt: null },
        }),
      ),
      ['audit.chain_failed'],
    );
  });

  it('reminds to verify the chain after N days, to the millisecond, and not for a young chain', () => {
    const verified = (age: number) => ({
      lastVerification: { at: ago(age), ok: true },
      oldestEventAt: ago(1000 * DAY),
    });
    assert.deepEqual(build({ audit: verified(30 * DAY) }), []);
    const overdue = build({ audit: verified(30 * DAY + 1) });
    assert.deepEqual(kinds(overdue), ['audit.verify_overdue']);
    assert.equal(overdue[0]?.params['days'], 30);
    const never = build({ audit: { lastVerification: null, oldestEventAt: ago(31 * DAY) } });
    assert.equal(only(never, 'audit.verify_overdue').params['neverVerified'], true);
    assert.deepEqual(
      build({ audit: { lastVerification: null, oldestEventAt: ago(30 * DAY) } }),
      [],
    );
    assert.deepEqual(build({ audit: { lastVerification: null, oldestEventAt: null } }), []);
    assert.deepEqual(
      build({ audit: verified(900 * DAY) }, { ...THRESHOLDS, auditVerifyDays: 0 }),
      [],
    );
  });

  it('lists plugins that were switched off', () => {
    const items = build({
      plugins: {
        switchedOff: [
          { id: 'b-plugin', reason: 'changed', at: ago(2 * DAY) },
          { id: 'a-plugin', reason: 'missing', at: ago(DAY) },
        ],
      },
    });
    assert.deepEqual(items[0]?.params, { count: 2, names: 'a-plugin, b-plugin', more: 0 });
    assert.equal(items[0].since, ago(DAY).toISOString());
    assert.deepEqual(build({ plugins: { switchedOff: [] } }), []);
  });

  it('compares versions the way a person does', () => {
    const cases: [string, string, boolean][] = [
      ['1.2.4', '1.2.3', true],
      ['1.10.0', '1.9.9', true],
      ['2.0.0', '1.99.99', true],
      ['1.2.3', '1.2.3', false],
      ['1.2.2', '1.2.3', false],
      ['1.0.0', '1.0.0-rc.1', true],
      ['1.0.0-rc.1', '1.0.0', false],
      ['v1.1.0', '1.0.0', true],
      ['0.1.0', '0.0.0-test', true],
      ['not-a-version', '1.0.0', false],
      ['1.0.0', 'dev', false],
    ];
    for (const [latest, current, newer] of cases) {
      assert.equal(isNewerVersion(latest, current), newer, `${latest} over ${current}`);
    }
    const items = build({ updates: { current: '1.0.0', latest: '1.1.0', checkedAt: ago(HOUR) } });
    assert.deepEqual(items[0]?.params, { latest: '1.1.0', current: '1.0.0' });
    assert.equal(items[0].link, null);
    assert.deepEqual(build({ updates: { current: '1.0.0', latest: null, checkedAt: null } }), []);
  });
});

describe('the attention feed: ranking, ids and what an item may carry', () => {
  const everythingWrong = (): AttentionItem[] =>
    build({
      vault: {
        state: 'sealed',
        expiring: [
          { name: 'gone', expiresAt: ago(DAY) },
          { name: 'soon', expiresAt: ahead(DAY) },
        ],
      },
      panel: {
        state: 'unauthorized',
        lastCheckedAt: ago(HOUR),
        version: '3.4.11',
        tokenExpiresAt: ago(DAY),
      },
      conventions: { panelConnected: true, last: { ranAt: ago(HOUR), errors: 1, warnings: 1 } },
      reconciliation: {
        panelConnected: true,
        last: {
          ranAt: ago(HOUR),
          drift: 1,
          missing: 1,
          extra: 1,
          unknown: 1,
          inventoryCompared: true,
          inventoryServers: 3,
          unmanaged: 1,
        },
      },
      snapshots: {
        panelConnected: true,
        intervalMs: DAY,
        latest: { createdAt: ago(30 * DAY), checkedAt: ago(20 * DAY), changesSince: 4 },
      },
      baseline: {
        servers: [
          server('f', {
            last: {
              state: 'completed',
              at: ago(HOUR),
              fail: 1,
              warn: 0,
              error: 0,
              errorCode: null,
            },
          }),
          server('m', {
            last: {
              state: 'error',
              at: ago(HOUR),
              fail: 0,
              warn: 0,
              error: 0,
              errorCode: 'host_key_mismatch',
            },
          }),
          server('n'),
        ],
      },
      servers: {
        servers: [{ name: 's', state: 'active', hostKeyCount: 0, accessCount: 0, factsAt: null }],
      },
      runs: { failed: 3, latestAt: ago(HOUR) },
      audit: { lastVerification: { at: ago(DAY), ok: false }, oldestEventAt: ago(100 * DAY) },
      plugins: { switchedOff: [{ id: 'p', reason: 'changed', at: ago(HOUR) }] },
      updates: { current: '1.0.0', latest: '2.0.0', checkedAt: ago(HOUR) },
    });

  it('ranks critical before warning before info, and by the order of the kinds inside a severity', () => {
    const items = everythingWrong();
    const severities = items.map((item) => item.severity);
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    assert.deepEqual(
      severities,
      [...severities].sort((a, b) => rank[a] - rank[b]),
    );
    const order = (a: AttentionKind) => ATTENTION_KINDS.indexOf(a);
    for (const severity of ['critical', 'warning', 'info'] as const) {
      const ofLevel = items.filter((item) => item.severity === severity).map((item) => item.kind);
      assert.deepEqual(
        ofLevel,
        [...ofLevel].sort((a, b) => order(a) - order(b)),
        severity,
      );
    }
    assert.equal(items[0]?.severity, 'critical');
    assert.equal(items.at(-1)?.severity, 'info');
  });

  it('is deterministic: the same facts give the same items, ids and fingerprints', () => {
    assert.deepEqual(everythingWrong(), everythingWrong());
  });

  it('gives an item the id of its kind and a fingerprint that changes with the facts', () => {
    const a = build({ runs: { failed: 2, latestAt: ago(HOUR) } });
    const b = build({ runs: { failed: 3, latestAt: ago(HOUR) } });
    assert.equal(a[0]?.id, 'runs.failed');
    assert.equal(b[0]?.id, 'runs.failed');
    assert.notEqual(a[0].fingerprint, b[0].fingerprint);
    assert.equal(
      a[0].fingerprint,
      build({ runs: { failed: 2, latestAt: ago(2 * HOUR) } })[0]?.fingerprint,
      'a later date alone is not a different condition',
    );
  });

  it('puts the oldest first inside a kind and the dated ones before the undated ones', () => {
    const make = (since: string | null): AttentionItem => ({
      id: 'x',
      fingerprint: 'x',
      severity: 'warning',
      kind: 'runs.failed',
      source: 'runs',
      title: 't',
      detail: 'd',
      params: {},
      since,
      link: null,
    });
    const ranked = rankItems([
      make(null),
      make('2026-06-02T00:00:00.000Z'),
      make('2026-06-01T00:00:00.000Z'),
    ]);
    assert.deepEqual(
      ranked.map((item) => item.since),
      ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', null],
    );
  });

  it('makes only items that are valid by the contract, from a source that says so, with the link of its kind', () => {
    const items = everythingWrong();
    assert.equal(new Set(kinds(items)).size, items.length, 'one item per kind');
    for (const item of items) {
      AttentionItemSchema.parse(item);
      assert.ok(ATTENTION_SOURCES.includes(item.source));
      assert.ok(item.title.length > 0 && item.detail.length > 0);
    }
  });

  it('carries no secret, address or person: only numbers, flags and short names', () => {
    const text = JSON.stringify(everythingWrong());
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u.test(text), 'an IP address');
    assert.ok(!/https?:\/\//u.test(text), 'a URL');
    assert.ok(!text.includes('@'), 'an e-mail address');
    assert.ok(
      !/token=|password|passphrase/iu.test(text.replace(/panel token/giu, '')),
      'a credential word',
    );
    for (const item of everythingWrong()) {
      for (const value of Object.values(item.params)) {
        assert.ok(
          value === null || ['string', 'number', 'boolean'].includes(typeof value),
          'a param is a scalar',
        );
        if (typeof value === 'string') {
          assert.ok(value.length <= 120, 'a short name');
        }
      }
    }
  });

  it('keeps the permission of every source in the table the service uses', () => {
    assert.deepEqual(
      Object.keys(ATTENTION_SOURCE_PERMISSIONS).sort(),
      [...ATTENTION_SOURCES].sort(),
    );
  });
});

describe('the attention feed: the catalogue is covered', () => {
  it('has made every kind of the contract in the tests above', () => {
    // A kind that is added to the contract needs a rule in the builder and a fixture here: this fails until it has both.
    const missing = ATTENTION_KINDS.filter((kind) => !produced.has(kind));
    assert.deepEqual(missing, []);
  });
});
