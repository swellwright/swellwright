import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LEASE_TTL_FACTOR,
  fenceAccepts,
  isClaimable,
  isLeaseExpired,
  leaseExpiresAt,
  leaseTtlMs,
  nextFence,
} from './lease.js';
import { RUN_STATES, needsWorker, type RunState } from './run-state.js';

describe('the lease of a run', () => {
  it('lasts three renewal intervals, so two lost renewals do not cost a live worker its run', () => {
    assert.equal(LEASE_TTL_FACTOR, 3);
    assert.equal(leaseTtlMs(5_000), 15_000);
    assert.equal(leaseExpiresAt(1_000_000, 5_000), 1_015_000);
  });

  it('needs a positive whole number of milliseconds for the interval', () => {
    for (const interval of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => leaseTtlMs(interval), RangeError, String(interval));
    }
  });

  it('is expired when it was never taken, and from the moment it runs out', () => {
    assert.equal(isLeaseExpired(null, 10), true);
    assert.equal(isLeaseExpired(9, 10), true);
    assert.equal(isLeaseExpired(10, 10), true);
    assert.equal(isLeaseExpired(11, 10), false);
  });
});

describe('the fence of a run', () => {
  it('grows by one for every claim', () => {
    assert.equal(nextFence(0), 1);
    assert.equal(nextFence(41), 42);
  });

  it('accepts a write only from the worker whose fence is the one on the row', () => {
    assert.equal(fenceAccepts(7, 7), true);
    // A worker that stalled and wakes up after another one took the run has an older fence.
    assert.equal(fenceAccepts(8, 7), false);
    // And one that is ahead of the row is as wrong as one that is behind.
    assert.equal(fenceAccepts(7, 8), false);
  });
});

describe('what a worker can claim', () => {
  const NOW = 100;
  const claimable = (state: RunState, lease: number | null): boolean =>
    isClaimable(state, lease, NOW);

  it('claims a queued run, whatever the lease says', () => {
    assert.equal(claimable('queued', null), true);
    assert.equal(claimable('queued', NOW + 50), true);
  });

  it('claims a running run only when its lease is out', () => {
    assert.equal(claimable('running', NOW + 1), false, 'a live lease');
    assert.equal(claimable('running', NOW), true, 'the moment the lease runs out');
    assert.equal(claimable('running', NOW - 1), true, 'an expired lease');
    assert.equal(claimable('running', null), true, 'no lease at all');
  });

  it('leaves a rollback alone: the loop has no executor of undo and would run the steps forward', () => {
    for (const state of ['rollback_requested', 'rolling_back'] as const) {
      assert.ok(needsWorker(state), `${state} is a state that wants a worker`);
      for (const lease of [null, NOW - 1, NOW, NOW + 50]) {
        assert.equal(claimable(state, lease), false, `${state}, lease ${String(lease)}`);
      }
    }
  });

  it('claims nothing else, with any lease', () => {
    const others = RUN_STATES.filter(
      (state) => !['queued', 'rollback_requested', 'running', 'rolling_back'].includes(state),
    );
    assert.equal(others.length, 9);
    for (const state of others) {
      assert.equal(claimable(state, null), false, state);
      assert.equal(claimable(state, NOW - 1), false, state);
    }
  });
});
