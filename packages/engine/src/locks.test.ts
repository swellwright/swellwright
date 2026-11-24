import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidResourceError,
  RESOURCE_KINDS,
  dnsZoneResource,
  lockKey,
  nodeResource,
  orderLocks,
  panelResource,
  parseLockKey,
  planAcquisition,
  resource,
  serverResource,
  waitingReason,
  type HeldLock,
  type ResourceRef,
} from './locks.js';

const keys = (refs: readonly ResourceRef[]): string[] => refs.map(lockKey);

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ]),
      );

describe('a resource', () => {
  it('is written as `panel`, `server:<id>`, `node:<name>` or `dns-zone:<zone>`', () => {
    assert.equal(lockKey(panelResource()), 'panel');
    assert.equal(lockKey(serverResource('3f2a')), 'server:3f2a');
    assert.equal(lockKey(nodeResource('NL-01')), 'node:NL-01');
    assert.equal(lockKey(dnsZoneResource('example.test')), 'dns-zone:example.test');
  });

  it('is read back from the text it was written as', () => {
    for (const ref of [
      panelResource(),
      serverResource('a'),
      nodeResource('DE-1_x'),
      dnsZoneResource('a.b.test'),
    ]) {
      assert.deepEqual(parseLockKey(lockKey(ref)), ref);
    }
  });

  it('takes no id for the panel and needs one for the rest', () => {
    assert.throws(() => resource('panel', 'x'), InvalidResourceError);
    for (const kind of RESOURCE_KINDS.filter((k) => k !== 'panel')) {
      assert.throws(() => resource(kind), InvalidResourceError);
      assert.throws(() => resource(kind, ''), InvalidResourceError);
    }
  });

  it('refuses an id that could be a path, a flag, a second lock or too long', () => {
    for (const id of ['../x', 'a/b', 'a b', '-x', '.x', 'a:b', 'a\nb', 'x'.repeat(129), 'ü']) {
      assert.throws(() => serverResource(id), InvalidResourceError, JSON.stringify(id));
    }
    assert.doesNotThrow(() => serverResource('x'.repeat(128)));
  });

  it('refuses a kind that does not exist and a text that is not a lock', () => {
    assert.throws(() => resource('volume' as never, 'x'), InvalidResourceError);
    assert.throws(() => parseLockKey('volume:x'), InvalidResourceError);
    assert.throws(() => parseLockKey('server'), InvalidResourceError);
    assert.throws(() => parseLockKey('panel:x'), InvalidResourceError);
    assert.throws(() => parseLockKey(''), InvalidResourceError);
  });

  it('cannot be changed once made', () => {
    assert.ok(Object.isFrozen(panelResource()));
    assert.ok(Object.isFrozen(nodeResource('a')));
  });
});

describe('the order of locks', () => {
  it('goes by kind and then by id, and names a resource once', () => {
    const ordered = orderLocks([
      nodeResource('b'),
      serverResource('9'),
      nodeResource('a'),
      dnsZoneResource('z.test'),
      panelResource(),
      serverResource('9'),
      nodeResource('B'),
    ]);
    // Upper case sorts before lower case: the order is the one of the code units, the same everywhere.
    assert.deepEqual(keys(ordered), [
      'panel',
      'dns-zone:z.test',
      'server:9',
      'node:B',
      'node:a',
      'node:b',
    ]);
  });

  it('is the same whatever order the step named them in', () => {
    const wanted = [
      panelResource(),
      dnsZoneResource('a.test'),
      serverResource('2'),
      serverResource('10'),
      nodeResource('x'),
    ];
    const reference = keys(orderLocks(wanted));
    for (const permutation of permutations(wanted)) {
      assert.deepEqual(keys(orderLocks(permutation)), reference);
    }
  });

  it('does not change what it was given', () => {
    const wanted = [nodeResource('b'), nodeResource('a')];
    orderLocks(wanted);
    assert.deepEqual(keys(wanted), ['node:b', 'node:a']);
  });
});

describe('taking the locks of a run', () => {
  const NOW = 1_000;
  const held = (key: string, holder: string, expiresAt: number, fence = 1): HeldLock => ({
    key,
    holder,
    fence,
    expiresAt,
  });

  it('takes what nobody holds', () => {
    const result = planAcquisition({
      run: 'r1',
      wanted: [nodeResource('b'), serverResource('1')],
      held: [held('node:other', 'r2', NOW + 5)],
      now: NOW,
    });
    assert.deepEqual(result, { ok: true, take: ['server:1', 'node:b'], renew: [], supersede: [] });
  });

  it('renews what the same run holds already: a new worker of the run, or a stage that goes on', () => {
    const result = planAcquisition({
      run: 'r1',
      wanted: [serverResource('1')],
      held: [held('server:1', 'r1', NOW + 5)],
      now: NOW,
    });
    assert.deepEqual(result, { ok: true, take: [], renew: ['server:1'], supersede: [] });
    // Even when its own lease is out: it is the same run.
    assert.deepEqual(
      planAcquisition({
        run: 'r1',
        wanted: [serverResource('1')],
        held: [held('server:1', 'r1', NOW - 5)],
        now: NOW,
      }),
      { ok: true, take: [], renew: ['server:1'], supersede: [] },
    );
  });

  it('takes over what another run let expire, and counts the very moment of expiry as expired', () => {
    for (const expiresAt of [NOW - 1, NOW]) {
      const result = planAcquisition({
        run: 'r1',
        wanted: [serverResource('1')],
        held: [held('server:1', 'r2', expiresAt)],
        now: NOW,
      });
      assert.deepEqual(result, { ok: true, take: [], renew: [], supersede: ['server:1'] });
    }
  });

  it('is blocked by a lock that another run holds and has not let expire', () => {
    const result = planAcquisition({
      run: 'r1',
      wanted: [serverResource('1')],
      held: [held('server:1', 'r2', NOW + 1)],
      now: NOW,
    });
    assert.deepEqual(result, {
      ok: false,
      blockedKey: 'server:1',
      heldBy: 'r2',
      expiresAt: NOW + 1,
    });
    assert.equal(waitingReason(result), 'lock server:1 held by r2');
  });

  it('takes all or nothing, and names the first blocked lock in the order of the locks', () => {
    const result = planAcquisition({
      run: 'r1',
      wanted: [nodeResource('a'), serverResource('1'), panelResource()],
      held: [held('node:a', 'r3', NOW + 9), held('server:1', 'r2', NOW + 9)],
      now: NOW,
    });
    assert.equal(result.ok, false);
    // `panel` is free, `server:1` comes before `node:a`: that is the one the run waits for.
    assert.deepEqual(result, {
      ok: false,
      blockedKey: 'server:1',
      heldBy: 'r2',
      expiresAt: NOW + 9,
    });
  });

  it('asks for nothing and gets nothing when the run needs no lock', () => {
    assert.deepEqual(planAcquisition({ run: 'r1', wanted: [], held: [], now: NOW }), {
      ok: true,
      take: [],
      renew: [],
      supersede: [],
    });
  });

  it('cannot let two runs wait for each other, because both go in the same order', () => {
    // Run one names (a, b) and run two names (b, a). Whoever comes first gets both; the other waits for the first lock.
    const wanted1 = [nodeResource('a'), nodeResource('b')];
    const wanted2 = [nodeResource('b'), nodeResource('a')];
    const first = planAcquisition({ run: 'r1', wanted: wanted1, held: [], now: NOW });
    assert.equal(first.ok, true);
    const afterFirst = [held('node:a', 'r1', NOW + 9), held('node:b', 'r1', NOW + 9)];
    const second = planAcquisition({ run: 'r2', wanted: wanted2, held: afterFirst, now: NOW });
    assert.deepEqual(second, { ok: false, blockedKey: 'node:a', heldBy: 'r1', expiresAt: NOW + 9 });
    // Had run two been first, run one would be blocked on the very same lock.
    const reverse = planAcquisition({
      run: 'r1',
      wanted: wanted1,
      held: [held('node:a', 'r2', NOW + 9), held('node:b', 'r2', NOW + 9)],
      now: NOW,
    });
    assert.deepEqual(reverse, {
      ok: false,
      blockedKey: 'node:a',
      heldBy: 'r2',
      expiresAt: NOW + 9,
    });
  });
});
