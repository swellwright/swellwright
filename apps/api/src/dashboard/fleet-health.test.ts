import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FLEET_FLAGS,
  FleetHealthRowSchema,
  type FleetFlag,
  type FleetHealthRow,
} from '@swellwright/contracts';

import {
  type FleetAccessInput,
  type FleetServerInput,
  type FleetThresholds,
  fleetHealthRow,
  pageFleet,
} from './fleet-health.js';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (ms: number): Date => new Date(NOW - ms);

const THRESHOLDS: FleetThresholds = { baselineStaleDays: 7, factsStaleDays: 14 };
const COUNTS = { pass: 10, warn: 0, fail: 0, error: 0, skipped: 0 };

const entry = (patch: Partial<FleetAccessInput> = {}): FleetAccessInput => ({
  secretExpiresAt: null,
  sudoSecretExpiresAt: null,
  lastVerifiedAt: ago(DAY),
  lastVerifyOk: true,
  ...patch,
});

/** A server in good order: pinned, one working access entry, fresh facts, a passing check. */
const good = (patch: Partial<FleetServerInput> = {}): FleetServerInput => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'alpha',
  state: 'active',
  country: 'DE',
  tags: ['node'],
  hostKeyCount: 1,
  access: [entry()],
  facts: { collectedAt: ago(DAY), os: 'Ubuntu 24.04', kernel: '6.8.0' },
  baseline: { name: 'node', version: 3 },
  last: { state: 'completed', at: ago(DAY), counts: COUNTS, errorCode: null, trend: 'same' },
  running: false,
  node: null,
  ...patch,
});

const row = (patch: Partial<FleetServerInput> = {}, thresholds = THRESHOLDS): FleetHealthRow =>
  fleetHealthRow(good(patch), NOW, thresholds, null);

const flagsOf = (patch: Partial<FleetServerInput>, thresholds = THRESHOLDS): FleetFlag[] =>
  row(patch, thresholds).flags.sort();

describe('the health of one server', () => {
  it('is ok with no flag for a server in good order, and valid by the contract', () => {
    const result = row();
    assert.equal(result.health, 'ok');
    assert.deepEqual(result.flags, []);
    assert.equal(result.baseline.status, 'pass');
    assert.deepEqual(result.access, {
      entries: 1,
      usable: 1,
      expired: 0,
      lastVerifiedAt: ago(DAY).toISOString(),
      lastVerifyOk: true,
    });
    assert.deepEqual(result.hostKey, { pinned: true, count: 1 });
    FleetHealthRowSchema.parse(result);
  });

  it('is unknown when nothing was ever looked at', () => {
    const result = row({ facts: null, last: null, baseline: null, access: [], hostKeyCount: 0 });
    assert.equal(result.health, 'warning', 'an active server without a key or access is a warning');
    const draft = row({
      state: 'draft',
      facts: null,
      last: null,
      baseline: null,
      access: [],
      hostKeyCount: 0,
    });
    assert.equal(draft.health, 'unknown');
    assert.deepEqual(draft.flags, [], 'a draft is not expected to be set up');
    assert.equal(draft.baseline.status, 'unassigned');
  });

  it('puts a retired server out of the way: no flag from what is missing, unknown health', () => {
    const result = row({
      state: 'retired',
      hostKeyCount: 0,
      access: [],
      facts: null,
      last: null,
      baseline: null,
    });
    assert.equal(result.health, 'unknown');
    assert.deepEqual(result.flags, []);
  });

  it('flags a missing host key and a missing access entry', () => {
    assert.deepEqual(flagsOf({ hostKeyCount: 0 }), ['no_host_key']);
    assert.deepEqual(flagsOf({ access: [] }), ['no_access']);
    assert.equal(row({ hostKeyCount: 0 }).health, 'warning');
  });

  it('judges an expired secret by the moment of its expiry, on the login or on sudo', () => {
    assert.deepEqual(
      flagsOf({ access: [entry(), entry({ secretExpiresAt: new Date(NOW) })] }),
      ['access_expired'],
      'the moment itself is expired',
    );
    assert.deepEqual(
      flagsOf({ access: [entry({ secretExpiresAt: new Date(NOW + 1) })] }),
      [],
      'a millisecond left is still good',
    );
    const sudo = row({ access: [entry({ sudoSecretExpiresAt: ago(1) })] });
    assert.deepEqual(sudo.flags, ['access_expired']);
    assert.equal(sudo.access.expired, 1);
    assert.equal(sudo.access.usable, 0);
  });

  it('is critical when every access entry has expired, and a warning when one still works', () => {
    const all = row({
      access: [entry({ secretExpiresAt: ago(DAY) }), entry({ secretExpiresAt: ago(2 * DAY) })],
    });
    assert.equal(all.health, 'critical');
    const some = row({ access: [entry({ secretExpiresAt: ago(DAY) }), entry()] });
    assert.equal(some.health, 'warning');
    assert.equal(some.access.usable, 1);
  });

  it('flags a server whose every tried access entry failed, and not one with a working entry', () => {
    assert.deepEqual(flagsOf({ access: [entry({ lastVerifyOk: false })] }), ['access_failed']);
    assert.deepEqual(
      flagsOf({ access: [entry({ lastVerifyOk: false }), entry({ lastVerifyOk: true })] }),
      [],
    );
    assert.deepEqual(
      flagsOf({ access: [entry({ lastVerifiedAt: null, lastVerifyOk: null })] }),
      [],
    );
    const newest = row({
      access: [
        entry({ lastVerifiedAt: ago(3 * DAY), lastVerifyOk: true }),
        entry({ lastVerifiedAt: ago(DAY), lastVerifyOk: false }),
      ],
    });
    assert.equal(newest.access.lastVerifiedAt, ago(DAY).toISOString());
    assert.equal(newest.access.lastVerifyOk, false);
  });

  it('judges facts by days to the millisecond, only on a server that can be reached', () => {
    assert.deepEqual(
      flagsOf({ facts: { collectedAt: ago(14 * DAY), os: null, kernel: null } }),
      [],
    );
    const stale = row({ facts: { collectedAt: ago(14 * DAY + 1), os: null, kernel: null } });
    assert.deepEqual(stale.flags, ['facts_stale']);
    assert.equal(stale.facts?.stale, true);
    assert.equal(stale.health, 'ok', 'old facts alone are information, not a warning');
    assert.deepEqual(flagsOf({ facts: null }), ['facts_missing']);
    assert.deepEqual(flagsOf({ facts: null, hostKeyCount: 0 }), ['no_host_key']);
    assert.deepEqual(
      flagsOf(
        { facts: { collectedAt: ago(500 * DAY), os: null, kernel: null } },
        { ...THRESHOLDS, factsStaleDays: 0 },
      ),
      [],
    );
  });

  it('turns the newest baseline check into a status and flags', () => {
    const at = ago(DAY);
    const cases: [Partial<FleetServerInput>, string, FleetFlag[], string][] = [
      [{}, 'pass', [], 'ok'],
      [
        {
          last: {
            state: 'completed',
            at,
            counts: { ...COUNTS, warn: 2 },
            errorCode: null,
            trend: null,
          },
        },
        'warn',
        ['baseline_warning'],
        'warning',
      ],
      [
        {
          last: {
            state: 'completed',
            at,
            counts: { ...COUNTS, error: 1 },
            errorCode: null,
            trend: null,
          },
        },
        'warn',
        ['baseline_warning'],
        'warning',
      ],
      [
        {
          last: {
            state: 'completed',
            at,
            counts: { ...COUNTS, fail: 1, warn: 5 },
            errorCode: null,
            trend: 'worse',
          },
        },
        'fail',
        ['baseline_failing'],
        'critical',
      ],
      [
        {
          last: {
            state: 'error',
            at,
            counts: COUNTS,
            errorCode: 'ssh_connect_failed',
            trend: null,
          },
        },
        'unreachable',
        ['baseline_unreachable'],
        'warning',
      ],
      [
        {
          last: { state: 'error', at, counts: COUNTS, errorCode: 'host_key_mismatch', trend: null },
        },
        'unreachable',
        ['host_key_mismatch'],
        'critical',
      ],
      [{ last: null }, 'never', ['baseline_never_checked'], 'ok'],
      [{ baseline: null, last: null }, 'unassigned', [], 'ok'],
    ];
    for (const [patch, status, flags, health] of cases) {
      const result = row(patch);
      assert.equal(result.baseline.status, status, JSON.stringify(patch));
      assert.deepEqual([...result.flags].sort(), flags, JSON.stringify(patch));
      assert.equal(result.health, health, JSON.stringify(patch));
    }
  });

  it('reports the counts of a check that observed the server and the code of one that did not', () => {
    const seen = row({
      last: {
        state: 'completed',
        at: ago(DAY),
        counts: { ...COUNTS, fail: 2 },
        errorCode: null,
        trend: 'worse',
      },
    });
    assert.deepEqual(seen.baseline.counts, { ...COUNTS, fail: 2 });
    assert.equal(seen.baseline.errorCode, null);
    assert.equal(seen.baseline.trend, 'worse');
    const lost = row({
      last: {
        state: 'error',
        at: ago(DAY),
        counts: COUNTS,
        errorCode: 'secret_expired',
        trend: null,
      },
    });
    assert.equal(lost.baseline.counts, null);
    assert.equal(lost.baseline.errorCode, 'secret_expired');
  });

  it('calls a check stale after N days to the millisecond, but not one that is going on or has not finished', () => {
    const at = (age: number): Partial<FleetServerInput> => ({
      last: { state: 'completed', at: ago(age), counts: COUNTS, errorCode: null, trend: null },
    });
    assert.deepEqual(flagsOf(at(7 * DAY)), []);
    assert.deepEqual(flagsOf(at(7 * DAY + 1)), ['baseline_stale']);
    assert.deepEqual(flagsOf({ ...at(30 * DAY), running: true }), ['check_running']);
    assert.deepEqual(flagsOf(at(30 * DAY), { ...THRESHOLDS, baselineStaleDays: 0 }), []);
    assert.equal(row(at(30 * DAY)).health, 'warning');
  });

  it('does not say never checked of a server whose first check is running or which is only a draft', () => {
    assert.deepEqual(flagsOf({ last: null, running: true }), ['check_running']);
    assert.deepEqual(flagsOf({ last: null, state: 'draft' }), []);
  });

  it('joins the node the last reconciliation matched, and flags one that is offline', () => {
    const matched = fleetHealthRow(
      good({ node: { name: 'node-1', state: 'online' } }),
      NOW,
      THRESHOLDS,
      ago(DAY),
    );
    assert.deepEqual(matched.panelNode, {
      name: 'node-1',
      state: 'online',
      asOf: ago(DAY).toISOString(),
    });
    assert.deepEqual(matched.flags, []);
    const offline = fleetHealthRow(
      good({ node: { name: 'node-1', state: 'offline' } }),
      NOW,
      THRESHOLDS,
      ago(DAY),
    );
    assert.deepEqual(offline.flags, ['node_offline']);
    assert.equal(offline.health, 'warning');
    const connecting = fleetHealthRow(
      good({ node: { name: 'node-1', state: 'connecting' } }),
      NOW,
      THRESHOLDS,
      ago(DAY),
    );
    assert.deepEqual(connecting.flags, []);
    const unknown = fleetHealthRow(
      good({ node: { name: 'node-1', state: 'online' } }),
      NOW,
      THRESHOLDS,
      null,
    );
    assert.equal(unknown.panelNode, null, 'without a date the match is not shown');
  });

  it('uses every flag of the contract somewhere', () => {
    const made = new Set<FleetFlag>();
    const feed = (patch: Partial<FleetServerInput>): void => {
      for (const flag of row(patch).flags) {
        made.add(flag);
      }
    };
    feed({ hostKeyCount: 0, access: [], facts: null });
    feed({ facts: null });
    feed({ access: [entry({ secretExpiresAt: ago(DAY), lastVerifyOk: false })] });
    feed({ facts: { collectedAt: ago(30 * DAY), os: null, kernel: null } });
    feed({
      last: {
        state: 'completed',
        at: ago(30 * DAY),
        counts: { ...COUNTS, fail: 1 },
        errorCode: null,
        trend: null,
      },
    });
    feed({
      last: {
        state: 'completed',
        at: ago(30 * DAY),
        counts: { ...COUNTS, warn: 1 },
        errorCode: null,
        trend: null,
      },
    });
    feed({
      last: { state: 'completed', at: ago(30 * DAY), counts: COUNTS, errorCode: null, trend: null },
    });
    feed({
      last: {
        state: 'error',
        at: ago(DAY),
        counts: COUNTS,
        errorCode: 'host_key_mismatch',
        trend: null,
      },
    });
    feed({
      last: { state: 'error', at: ago(DAY), counts: COUNTS, errorCode: 'ssh_timeout', trend: null },
    });
    feed({ last: null });
    feed({ running: true });
    feed({ node: { name: 'n', state: 'offline' } });
    assert.deepEqual(
      FLEET_FLAGS.filter((flag) => !made.has(flag)),
      [],
    );
  });
});

describe('paging the health of the fleet', () => {
  const make = (
    name: string,
    health: 'critical' | 'warning' | 'ok' | 'unknown',
    patch: Partial<FleetHealthRow> = {},
  ): FleetHealthRow => ({
    ...row({ name, id: `00000000-0000-4000-8000-${String(name.charCodeAt(0)).padStart(12, '0')}` }),
    health,
    ...patch,
  });
  const fleet = [
    make('delta', 'ok'),
    make('Bravo', 'critical', { flags: ['baseline_failing'] }),
    make('charlie', 'warning', { flags: ['no_host_key'] }),
    make('alpha', 'ok'),
    make('echo', 'unknown'),
  ];
  const names = (query: Parameters<typeof pageFleet>[1]): string[] =>
    pageFleet(fleet, query).rows.map((found) => found.server.name);

  it('lists the worst first by default, then by name ignoring case', () => {
    assert.deepEqual(names({}), ['Bravo', 'charlie', 'echo', 'alpha', 'delta']);
  });

  it('sorts by name, in either direction', () => {
    assert.deepEqual(names({ sort: 'name' }), ['alpha', 'Bravo', 'charlie', 'delta', 'echo']);
    assert.deepEqual(names({ sort: 'name', order: 'desc' }), [
      'echo',
      'delta',
      'charlie',
      'Bravo',
      'alpha',
    ]);
  });

  it('sorts by the last check, the longest without one first and never checked on top', () => {
    const dated = [
      make('new', 'ok', { baseline: { ...row().baseline, lastRunAt: ago(DAY).toISOString() } }),
      make('old', 'ok', { baseline: { ...row().baseline, lastRunAt: ago(9 * DAY).toISOString() } }),
      make('never', 'ok', { baseline: { ...row().baseline, lastRunAt: null } }),
    ];
    assert.deepEqual(
      pageFleet(dated, { sort: 'lastCheck' }).rows.map((found) => found.server.name),
      ['never', 'old', 'new'],
    );
    assert.deepEqual(
      pageFleet(dated, { sort: 'lastCheck', order: 'desc' }).rows.map((found) => found.server.name),
      ['new', 'old', 'never'],
    );
  });

  it('filters by health, flag, state, tag and text, and the filters combine', () => {
    assert.deepEqual(names({ health: 'ok' }), ['alpha', 'delta']);
    assert.deepEqual(names({ flag: 'no_host_key' }), ['charlie']);
    assert.deepEqual(names({ q: 'LIE' }), ['charlie']);
    assert.deepEqual(
      names({ q: 'node', health: 'critical' }),
      ['Bravo'],
      'the tag is searched too',
    );
    assert.deepEqual(names({ tag: 'missing' }), []);
    assert.deepEqual(names({ state: 'draft' }), []);
    assert.deepEqual(names({ health: 'ok', flag: 'no_host_key' }), []);
  });

  it('pages, and reports how many match whatever the page', () => {
    const second = pageFleet(fleet, { limit: 2, offset: 2 });
    assert.deepEqual(
      second.rows.map((found) => found.server.name),
      ['echo', 'alpha'],
    );
    assert.equal(second.total, 5);
    const filtered = pageFleet(fleet, { health: 'ok', limit: 1 });
    assert.equal(filtered.total, 2);
    assert.equal(filtered.rows.length, 1);
    assert.deepEqual(pageFleet(fleet, { offset: 50 }).rows, []);
    assert.equal(pageFleet(fleet, {}).rows.length, 5);
  });
});
