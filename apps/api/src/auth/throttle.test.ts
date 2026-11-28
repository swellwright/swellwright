import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressBucket } from './cidr.js';
import { HasherBusyError, PasswordHasher } from './password.js';
import { WindowLimiter } from './rate-limit.js';
import {
  afterMfaFailure,
  afterPasswordFailure,
  afterSourceFailure,
  type MfaState,
  passwordWaitMs,
  type PasswordState,
  PASSWORD_WINDOW_MS,
} from './throttle.js';

const CHEAP = { memory: 256, passes: 1, parallelism: 1 } as const;
const t0 = new Date('2026-11-26T10:00:00.000Z');
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const EMPTY: PasswordState = { failures: 0, windowEndsAt: null, retryAt: null };

describe('password limits', () => {
  it('waits 1, 2, 4, then 8 seconds from the twentieth wrong password, within a fixed window', () => {
    let state = EMPTY;
    for (let i = 0; i < 19; i += 1) {
      state = afterPasswordFailure(state, t0);
      assert.equal(state.retryAt, null);
    }
    assert.deepEqual(state.windowEndsAt, at(PASSWORD_WINDOW_MS));
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const now = at(60_000 * (i + 1));
      state = afterPasswordFailure(state, now);
      waits.push((state.retryAt?.getTime() ?? 0) - now.getTime());
    }
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    assert.equal(state.failures, 23, 'the count stops');
    assert.deepEqual(state.windowEndsAt, at(PASSWORD_WINDOW_MS), 'the window does not move');
  });

  it('never waits past the end of the window, and starts over after it', () => {
    const state: PasswordState = { failures: 22, windowEndsAt: at(3_000), retryAt: null };
    const next = afterPasswordFailure(state, at(0));
    assert.deepEqual(next.retryAt, at(3_000));
    const later = afterPasswordFailure(next, at(3_000));
    assert.equal(later.failures, 1);
    assert.equal(later.retryAt, null);
  });

  it('makes a source wait for its window after five, and leaves another source alone', () => {
    let source = afterSourceFailure(null, t0);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(passwordWaitMs(EMPTY, source, at(1000)), 0);
      source = afterSourceFailure(source, at(1000));
    }
    assert.equal(source.failures, 5);
    assert.equal(passwordWaitMs(EMPTY, source, at(1000)), PASSWORD_WINDOW_MS - 1000);
    assert.equal(passwordWaitMs(EMPTY, null, at(1000)), 0);
    assert.equal(passwordWaitMs(EMPTY, source, at(PASSWORD_WINDOW_MS)), 0, 'the window ended');
  });

  it('locks the second factor at the threshold and starts its count over', () => {
    let state: MfaState = { failures: 0, windowEndsAt: null, lockedUntil: null };
    const results = [1, 2, 3].map(() => {
      const r = afterMfaFailure(state, t0, 3, 900_000);
      state = r.state;
      return r.locked;
    });
    assert.deepEqual(results, [false, false, true]);
    assert.deepEqual(state.lockedUntil, at(900_000));
    assert.equal(state.failures, 0);
  });
});

describe('address buckets', () => {
  it('keeps an IPv4 address, in any spelling, and puts an IPv6 address in its /64', () => {
    assert.equal(addressBucket('198.51.100.7'), '198.51.100.7');
    assert.equal(addressBucket('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(addressBucket('::ffff:c633:6407'), '198.51.100.7');
    assert.equal(addressBucket('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(addressBucket('2001:DB8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(addressBucket('2001:db8:1:3::1'), '2001:db8:1:3::/64');
    assert.equal(addressBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(addressBucket(undefined), 'unknown');
    assert.equal(addressBucket('not an address'), 'unknown');
  });
});

describe('bounded limiter', () => {
  it('admits a ninth IPv6 /64 by evicting the oldest of eight source windows', () => {
    const limiter = new WindowLimiter(1, 1000, () => 0, 8, 'evict-oldest');
    const bucket = (i: number) => addressBucket(`2001:db8:${i.toString(16)}:1::1`);
    for (let i = 0; i < 8; i += 1) {
      assert.ok(limiter.hit(bucket(i)));
    }
    assert.ok(limiter.hit(bucket(8)));
    assert.equal(limiter.size, 8);
    assert.equal(limiter.hit(bucket(1)), false, 'the remaining source window is still enforced');
    assert.ok(limiter.hit(bucket(0)), 'the oldest window was evicted');
  });
  it('refuses unseen keys when full, keeps the budget of tracked ones, and frees slots as windows end', () => {
    let now = 0;
    const limiter = new WindowLimiter(2, 1000, () => now, 3);
    assert.ok(limiter.hit('a'));
    now = 100;
    assert.ok(limiter.hit('b'));
    now = 200;
    assert.ok(limiter.hit('c'));
    assert.equal(limiter.tryHit('d'), undefined, 'untracked key at capacity');
    assert.equal(limiter.hit('d'), false, 'the map is full');
    assert.equal(limiter.retryAfterSeconds('d'), 1, 'until the oldest window ends');
    assert.ok(limiter.hit('a'), 'a tracked key keeps its budget');
    assert.equal(limiter.hit('a'), false);
    assert.equal(limiter.tryHit('a'), false, 'a tracked key already used its budget');
    now = 1000;
    assert.ok(limiter.hit('d'), 'the first window ended and made room');
    assert.equal(limiter.size, 3);
    now = 5000;
    assert.ok(limiter.hit('e'));
    assert.equal(limiter.size, 1, 'expired windows are gone');
  });

  it('caps the count of a key that keeps hitting', () => {
    const limiter = new WindowLimiter(1, 1000, () => 0);
    for (let i = 0; i < 10_000; i += 1) {
      limiter.hit('a');
    }
    assert.ok(limiter.blocked('a'));
    assert.equal(limiter.retryAfterSeconds('a'), 1);
  });
});

describe('the password hasher queue', () => {
  it('refuses a caller over the queue at once, and one that waited too long', async () => {
    const hasher = new PasswordHasher(
      { memory: 65536, passes: 3, parallelism: 1 },
      { concurrent: 1, queue: 4, waitMs: 50 },
    );
    const busy = hasher.hash('a long running one');
    const waiting = hasher.verifyDummy('queued');
    await assert.rejects(hasher.verifyDummy('over the queue'), HasherBusyError);
    await assert.rejects(waiting, HasherBusyError, 'the wait ran out');
    await busy;
    assert.deepEqual(hasher.load, { active: 0, waiting: 0 }, 'every slot came back');
  });

  it('gives the slot back after an error, and works normally after an overload', async () => {
    const hasher = new PasswordHasher(CHEAP, { concurrent: 1, queue: 0, waitMs: 1000 });
    const first = hasher.verifyDummy('one');
    await assert.rejects(hasher.verifyDummy('two'), HasherBusyError);
    await first;
    await hasher.verifyDummy('three');
    const hash = await hasher.hash('a real password here');
    assert.ok(await hasher.verify(hash, 'a real password here'));
    assert.deepEqual(hasher.load, { active: 0, waiting: 0 });
    const busy = new HasherBusyError();
    assert.equal(busy.retryAfterSeconds, 2);
    assert.equal(busy.getStatus(), 429);
  });
});
