// The rules every `RunStore` must keep, as tests (ADR 0048). The store in memory and the one over PostgreSQL are both run
// through this one suite, so the rules cannot be one thing in the model and another in the database.
//
// Usage: `runStoreContract('memory', () => Promise.resolve({ store: new MemoryRunStore() }))` inside a test file.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTransitionError } from '../machine.js';
import { planHash } from '../plan.js';
import {
  FenceLostError,
  InvalidDataError,
  LockLostError,
  StateConflictError,
  type Claim,
  type RunStore,
} from '../store.js';
import { node, plan, runId, server } from './fixtures.js';

export interface StoreUnderTest {
  readonly store: RunStore;
  readonly close?: () => Promise<void>;
}

const T0 = 1_000_000;
const LEASE = 30_000;

/** Runs `body` on a store that no other test has touched, and closes it. */
async function withStore(
  make: () => Promise<StoreUnderTest>,
  body: (store: RunStore) => Promise<void>,
): Promise<void> {
  const { store, close } = await make();
  try {
    await body(store);
  } finally {
    await close?.();
  }
}

async function queued(
  store: RunStore,
  n: number,
  steps = 2,
  extra: Parameters<typeof plan>[0] = [],
) {
  const run = await store.createRun({
    id: runId(n),
    plan: plan(extra.length > 0 ? extra : Array.from({ length: steps }, () => ({}))),
    risk: 'low',
    requestedBy: 'person-1',
    now: T0 + n,
  });
  await store.applyEvent(run.id, 'queue', { now: T0 + n });
  return run.id;
}

async function claimed(store: RunStore, n: number, now = T0 + 100, workerId = 'w1') {
  const got = await store.claimNext({ workerId, now, leaseMs: LEASE });
  assert.ok(got, `run ${String(n)} was not claimed`);
  return got;
}

const refused = (error: unknown): boolean => error instanceof FenceLostError;

/** A queued run, claimed, with its first step begun: the claim of a worker that is in the middle of a step. */
async function begun(store: RunStore): Promise<Claim> {
  await queued(store, 1);
  const got = await claimed(store, 1);
  await store.beginStep(got.claim, 0, { now: T0 + 120 });
  return got.claim;
}

export function runStoreContract(
  name: string,
  make: () => Promise<StoreUnderTest>,
  /** `skip` says why the suite cannot run here (no database configured), as the options of `describe` do. */
  options: { readonly skip?: string | boolean } = {},
): void {
  describe(`the run store contract: ${name}`, { skip: options.skip ?? false }, () => {
    describe('a new run', () => {
      it('is `planned`, with a `pending` step for every step of the plan and an event', async () => {
        await withStore(make, async (store) => {
          const p = plan([{ input: { a: 1 } }, {}]);
          const run = await store.createRun({
            id: runId(1),
            plan: p,
            risk: 'high',
            requestedBy: 'u',
            now: T0,
          });
          assert.equal(run.state, 'planned');
          assert.equal(run.fence, 0);
          assert.equal(run.planHash, planHash(p));
          assert.equal(run.risk, 'high');
          assert.equal(run.workerId, null);
          assert.equal(run.leaseExpiresAt, null);
          const steps = await store.getSteps(run.id);
          assert.deepEqual(
            steps.map((s) => [s.index, s.key, s.state, s.attempt, s.remoteId]),
            [
              [0, 'test.step-0', 'pending', 0, `${run.id}-0`],
              [1, 'test.step-1', 'pending', 0, `${run.id}-1`],
            ],
          );
          assert.deepEqual(steps[0]?.input, { a: 1 });
          const events = await store.listEvents(run.id, 0, 10);
          assert.deepEqual(
            events.map((e) => [e.seq, e.type]),
            [[1, 'run.created']],
          );
          assert.deepEqual(await store.getRun(run.id), run);
        });
      });

      it('cannot be made twice, and an unknown run is `null`', async () => {
        await withStore(make, async (store) => {
          await store.createRun({
            id: runId(1),
            plan: plan([{}]),
            risk: 'low',
            requestedBy: null,
            now: T0,
          });
          await assert.rejects(
            store.createRun({
              id: runId(1),
              plan: plan([{}]),
              risk: 'low',
              requestedBy: null,
              now: T0,
            }),
            StateConflictError,
          );
          assert.equal(await store.getRun(runId(99)), null);
        });
      });
    });

    describe('the events of people', () => {
      it('move the run as the table says, with the person in the event', async () => {
        await withStore(make, async (store) => {
          const id = runId(1);
          await store.createRun({ id, plan: plan([{}]), risk: 'low', requestedBy: null, now: T0 });
          const asked = await store.applyEvent(id, 'request_approval', {
            now: T0 + 1,
            actor: 'u1',
          });
          assert.equal(asked.state, 'awaiting_approval');
          const approved = await store.applyEvent(id, 'approve', { now: T0 + 2, actor: 'u2' });
          assert.equal(approved.state, 'queued');
          const events = await store.listEvents(id, 0, 10);
          assert.deepEqual(
            events.map((e) => e.type),
            ['run.created', 'run.request_approval', 'run.approve'],
          );
          assert.deepEqual(events[2]?.data, {
            from: 'awaiting_approval',
            to: 'queued',
            actor: 'u2',
          });
        });
      });

      it('are refused when the state does not take them, and when the person saw another state', async () => {
        await withStore(make, async (store) => {
          const id = runId(1);
          await store.createRun({ id, plan: plan([{}]), risk: 'low', requestedBy: null, now: T0 });
          await assert.rejects(
            store.applyEvent(id, 'approve', { now: T0 }),
            InvalidTransitionError,
          );
          await assert.rejects(
            store.applyEvent(id, 'queue', { now: T0, expectedState: 'awaiting_approval' }),
            StateConflictError,
          );
          await assert.rejects(
            store.applyEvent(id, 'claim' as never, { now: T0 }),
            StateConflictError,
          );
          // Nothing of it was written.
          assert.equal((await store.getRun(id))?.state, 'planned');
          assert.equal((await store.listEvents(id, 0, 10)).length, 1);
        });
      });

      it('are refused while a worker holds the run', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          await claimed(store, 1);
          await assert.rejects(
            store.applyEvent(id, 'pause', { now: T0 + 200 }),
            StateConflictError,
          );
        });
      });

      it('end a run in `cancelled` at once when no worker holds it', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const cancelled = await store.requestCancel(id, T0 + 500);
          assert.equal(cancelled.state, 'cancelled');
          assert.equal(cancelled.finishedAt, T0 + 500);
        });
      });
    });

    describe('claiming', () => {
      it('takes nothing when no run is `queued`', async () => {
        await withStore(make, async (store) => {
          await store.createRun({
            id: runId(1),
            plan: plan([{}]),
            risk: 'low',
            requestedBy: null,
            now: T0,
          });
          assert.equal(
            await store.claimNext({ workerId: 'w1', now: T0 + 1, leaseMs: LEASE }),
            null,
          );
        });
      });

      it('takes the oldest queued run, with a lease and the first fence', async () => {
        await withStore(make, async (store) => {
          await queued(store, 2);
          await queued(store, 1);
          const got = await claimed(store, 1, T0 + 100);
          assert.equal(got.claim.runId, runId(1));
          assert.equal(got.claim.fence, 1);
          assert.equal(got.run.state, 'running');
          assert.equal(got.run.workerId, 'w1');
          assert.equal(got.run.leaseExpiresAt, T0 + 100 + LEASE);
          assert.equal(got.run.startedAt, T0 + 100);
          assert.equal(got.steps.length, 2);
          const events = await store.listEvents(runId(1), 0, 10);
          assert.equal(events.at(-1)?.type, 'run.claim');
          assert.deepEqual(events.at(-1)?.data, {
            from: 'queued',
            to: 'running',
            workerId: 'w1',
            fence: 1,
            takeover: false,
          });
        });
      });

      it('does not take a run whose lease is alive, and takes it over when it ran out, with a higher fence', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          await claimed(store, 1, T0 + 100);
          assert.equal(
            await store.claimNext({ workerId: 'w2', now: T0 + 100 + LEASE - 1, leaseMs: LEASE }),
            null,
          );
          const over = await store.claimNext({
            workerId: 'w2',
            now: T0 + 100 + LEASE,
            leaseMs: LEASE,
          });
          assert.ok(over);
          assert.equal(over.claim.fence, 2);
          assert.equal(over.run.workerId, 'w2');
          assert.equal(over.run.state, 'running');
          const events = await store.listEvents(runId(1), 0, 10);
          assert.deepEqual(events.at(-1)?.data, {
            from: 'running',
            to: 'running',
            workerId: 'w2',
            fence: 2,
            takeover: true,
          });
        });
      });

      it('leaves a run that asked for a rollback alone: nothing executes undo yet, and the loop would run the steps forward', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          await store.applyEvent(id, 'cancel', { now: T0 + 50 });
          const asked = await store.applyEvent(id, 'request_rollback', { now: T0 + 60 });
          assert.equal(asked.state, 'rollback_requested');
          assert.equal(
            await store.claimNext({ workerId: 'w1', now: T0 + 100, leaseMs: LEASE }),
            null,
          );
          assert.equal((await store.getRun(id))?.state, 'rollback_requested');
          assert.deepEqual(
            (await store.getSteps(id)).map((step) => step.state),
            ['pending', 'pending'],
          );
        });
      });

      it('leaves a run alone that waits with a reason the worker cannot serve, and takes the next one', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          await queued(store, 2);
          const first = await claimed(store, 1, T0 + 100);
          await store.finishRun(first.claim, 'wait', {
            now: T0 + 200,
            waiting: 'vault_sealed',
            retryAfter: T0 + 300,
          });
          // Run 1 is the older and its time has come, but this worker cannot do anything about a sealed vault.
          const other = await store.claimNext({
            workerId: 'sealed',
            now: T0 + 400,
            leaseMs: LEASE,
            skipWaiting: ['vault_sealed'],
          });
          assert.equal(other?.claim.runId, runId(2));
          assert.equal(
            await store.claimNext({
              workerId: 'sealed',
              now: T0 + 400,
              leaseMs: LEASE,
              skipWaiting: ['vault_sealed'],
            }),
            null,
          );
          assert.equal((await store.getRun(runId(1)))?.waiting, 'vault_sealed');
          // A worker that can serve it takes it, and a reason that is not in the list is no reason to leave a run.
          const served = await store.claimNext({
            workerId: 'open',
            now: T0 + 400,
            leaseMs: LEASE,
            skipWaiting: ['something_else'],
          });
          assert.equal(served?.claim.runId, runId(1));
        });
      });

      it('takes a run that has a request of the people pending even for a worker that cannot serve its reason: a cancel needs no vault', async () => {
        for (const ask of ['requestCancel', 'requestPause'] as const) {
          await withStore(make, async (store) => {
            const id = await queued(store, 1);
            const first = await claimed(store, 1, T0 + 100);
            await store[ask](id, T0 + 110);
            await store.finishRun(first.claim, 'wait', {
              now: T0 + 120,
              waiting: 'vault_sealed',
              retryAfter: T0 + 200,
            });
            const got = await store.claimNext({
              workerId: 'sealed',
              now: T0 + 300,
              leaseMs: LEASE,
              skipWaiting: ['vault_sealed'],
            });
            assert.equal(got?.claim.runId, id, ask);
            assert.equal(
              ask === 'requestCancel' ? got.run.cancelRequestedAt : got.run.pauseRequestedAt,
              T0 + 110,
            );
          });
        }
      });

      it('leaves a run that waited alone until its time, and then takes it', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const first = await claimed(store, 1, T0 + 100);
          await store.finishRun(first.claim, 'wait', {
            now: T0 + 200,
            waiting: 'vault_sealed',
            retryAfter: T0 + 5_000,
          });
          const waiting = await store.getRun(runId(1));
          assert.equal(waiting?.state, 'queued');
          assert.equal(waiting.waiting, 'vault_sealed');
          assert.equal(waiting.workerId, null);
          assert.equal(
            await store.claimNext({ workerId: 'w1', now: T0 + 4_999, leaseMs: LEASE }),
            null,
          );
          const again = await store.claimNext({ workerId: 'w1', now: T0 + 5_000, leaseMs: LEASE });
          assert.ok(again);
          assert.equal(again.claim.fence, 2);
          assert.equal(again.run.waiting, null);
        });
      });
    });

    describe('the fence', () => {
      it('refuses every write of a worker whose run another worker took', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const old = await claimed(store, 1, T0 + 100, 'w1');
          const fresh = await store.claimNext({
            workerId: 'w2',
            now: T0 + 100 + LEASE,
            leaseMs: LEASE,
          });
          assert.ok(fresh);
          const at = T0 + 100 + LEASE + 1;
          const writes: [string, () => Promise<unknown>][] = [
            ['renewLease', () => store.renewLease(old.claim, { now: at, leaseMs: LEASE })],
            ['acquireLocks', () => store.acquireLocks(old.claim, { now: at, ttlMs: LEASE })],
            ['beginStep', () => store.beginStep(old.claim, 0, { now: at })],
            [
              'checkpointStep',
              () => store.checkpointStep(old.claim, 0, { now: at, output: null, undo: [] }),
            ],
            ['failStep', () => store.failStep(old.claim, 0, { now: at, code: 'x', message: 'y' })],
            ['deferStep', () => store.deferStep(old.claim, 0, { now: at, reason: 'r' })],
            ['finishRun', () => store.finishRun(old.claim, 'succeed', { now: at })],
            ['appendEvent', () => store.appendEvent(old.claim, 'locks.acquired', {}, at)],
          ];
          for (const [what, write] of writes) {
            await assert.rejects(write(), refused, what);
          }
          // The new worker is not affected, and nothing of the refused writes is in the rows.
          const run = await store.renewLease(fresh.claim, { now: at, leaseMs: LEASE });
          assert.equal(run.workerId, 'w2');
          assert.equal(
            (await store.getSteps(runId(1))).every((s) => s.state === 'pending'),
            true,
          );
          assert.equal(
            (await store.listEvents(runId(1), 0, 50)).filter((e) => e.type === 'locks.acquired')
              .length,
            0,
          );
        });
      });

      it('refuses an old claim even of the same worker id: a restarted process is not the stalled one', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const old = await claimed(store, 1, T0 + 100, 'host-1');
          const fresh = await store.claimNext({
            workerId: 'host-1',
            now: T0 + 100 + LEASE,
            leaseMs: LEASE,
          });
          assert.ok(fresh);
          assert.equal(fresh.claim.fence, 2);
          await assert.rejects(
            store.renewLease(old.claim, { now: T0 + 100 + LEASE + 1, leaseMs: LEASE }),
            refused,
          );
          await assert.rejects(
            store.beginStep(old.claim, 0, { now: T0 + 100 + LEASE + 1 }),
            refused,
          );
          assert.equal(
            (await store.beginStep(fresh.claim, 0, { now: T0 + 100 + LEASE + 1 })).state,
            'running',
          );
        });
      });

      it('refuses a worker that is not the one the fence was given to', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          const impostor: Claim = { ...got.claim, workerId: 'w9' };
          await assert.rejects(
            store.renewLease(impostor, { now: T0 + 200, leaseMs: LEASE }),
            refused,
          );
        });
      });

      it('refuses a worker after it let go of the run, and for a run that does not exist', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await store.acquireLocks(got.claim, { now: T0 + 200, ttlMs: LEASE });
          await store.finishRun(got.claim, 'pause', { now: T0 + 300 });
          await assert.rejects(
            store.renewLease(got.claim, { now: T0 + 400, leaseMs: LEASE }),
            refused,
          );
          await assert.rejects(
            store.renewLease(
              { runId: runId(77), workerId: 'w1', fence: 1 },
              { now: T0, leaseMs: LEASE },
            ),
          );
        });
      });

      it('lets a renewal extend the lease, so the run is not taken over while the worker is alive', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1, T0 + 100);
          const renewed = await store.renewLease(got.claim, {
            now: T0 + 100 + LEASE - 1,
            leaseMs: LEASE,
          });
          assert.equal(renewed.leaseExpiresAt, T0 + 100 + 2 * LEASE - 1);
          assert.equal(
            await store.claimNext({ workerId: 'w2', now: T0 + 100 + LEASE + 10, leaseMs: LEASE }),
            null,
          );
        });
      });
    });

    describe('locks', () => {
      const wanting = [{ locks: [server('s-1'), node('n-1')] }, {}];

      it('are taken all together, for the whole plan, and released when the run lets go', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1, 2, wanting);
          const got = await claimed(store, 1);
          const result = await store.acquireLocks(got.claim, { now: T0 + 200, ttlMs: LEASE });
          assert.deepEqual(result, { ok: true, keys: ['server:s-1', 'node:n-1'] });
          assert.deepEqual(
            (await store.listLocks()).map((l) => [l.key, l.holder, l.fence, l.expiresAt]),
            [
              ['node:n-1', runId(1), 1, T0 + 200 + LEASE],
              ['server:s-1', runId(1), 1, T0 + 200 + LEASE],
            ],
          );
          await store.finishRun(got.claim, 'wait', {
            now: T0 + 300,
            waiting: 'x',
            retryAfter: T0 + 9_000,
          });
          assert.deepEqual(await store.listLocks(), []);
        });
      });

      it('make a second run wait with the reason, and it takes none of them', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1, 2, [{ locks: [node('n-1')] }]);
          await queued(store, 2, 2, [{ locks: [server('s-1'), node('n-1')] }]);
          const first = await claimed(store, 1);
          assert.deepEqual(await store.acquireLocks(first.claim, { now: T0 + 200, ttlMs: LEASE }), {
            ok: true,
            keys: ['node:n-1'],
          });
          const second = await claimed(store, 2, T0 + 210, 'w2');
          const blocked = await store.acquireLocks(second.claim, { now: T0 + 220, ttlMs: LEASE });
          assert.deepEqual(blocked, {
            ok: false,
            blockedKey: 'node:n-1',
            heldBy: runId(1),
            reason: `lock node:n-1 held by ${runId(1)}`,
          });
          // `server:s-1` is free and comes first in the order, yet it was not taken.
          assert.deepEqual(
            (await store.listLocks()).map((l) => l.key),
            ['node:n-1'],
          );
        });
      });

      it('go to another run when they expired, and the first run can then write nothing about its steps', async () => {
        await withStore(make, async (store) => {
          // The run that stalls is the younger one, so that the older run is the first to be claimed when both can be.
          await queued(store, 2, 2, [{ locks: [node('n-1')] }]);
          const first = await claimed(store, 2, T0 + 100, 'w1');
          await store.acquireLocks(first.claim, { now: T0 + 100, ttlMs: LEASE });
          await queued(store, 1, 2, [{ locks: [node('n-1')] }]);
          // The first worker stalls; its lock and its lease run out; the other run takes the lock.
          const second = await claimed(store, 1, T0 + 100 + LEASE, 'w2');
          const taken = await store.acquireLocks(second.claim, {
            now: T0 + 100 + LEASE,
            ttlMs: LEASE,
          });
          assert.deepEqual(taken, { ok: true, keys: ['node:n-1'] });
          // The first worker wakes up. Its fence is still the one on its row, but it no longer owns what the step changes.
          await assert.rejects(
            store.beginStep(first.claim, 0, { now: T0 + 100 + LEASE + 1 }),
            (error: unknown) => error instanceof LockLostError && error.key === 'node:n-1',
          );
          assert.equal((await store.getSteps(runId(2)))[0]?.state, 'pending');
        });
      });

      it('are checked at the renewal and at every write about a step: a worker whose lock went to another run learns it at once', async () => {
        await withStore(make, async (store) => {
          await queued(store, 2, 2, [{ locks: [node('n-1')] }]);
          const first = await claimed(store, 2, T0 + 100, 'w1');
          await store.acquireLocks(first.claim, { now: T0 + 100, ttlMs: LEASE });
          await store.beginStep(first.claim, 0, { now: T0 + 105 });
          await queued(store, 1, 2, [{ locks: [node('n-1')] }]);
          const second = await claimed(store, 1, T0 + 100 + LEASE, 'w2');
          assert.deepEqual(
            await store.acquireLocks(second.claim, { now: T0 + 100 + LEASE, ttlMs: LEASE }),
            { ok: true, keys: ['node:n-1'] },
          );
          const lost = (error: unknown): boolean =>
            error instanceof LockLostError && error.key === 'node:n-1';
          const now = T0 + 100 + LEASE + 1;
          await assert.rejects(store.renewLease(first.claim, { now, leaseMs: LEASE }), lost);
          await assert.rejects(
            store.failStep(first.claim, 0, { now, code: 'step_error', message: 'm' }),
            lost,
          );
          await assert.rejects(store.deferStep(first.claim, 0, { now, reason: 'r' }), lost);
          await assert.rejects(
            store.finishRun(first.claim, 'fail', {
              now,
              failedStep: { index: 0, code: 'step_error', message: 'm' },
            }),
            lost,
          );
          // None of it was written: the step is still running and the lease was not extended.
          assert.equal((await store.getSteps(runId(2)))[0]?.state, 'running');
          assert.equal((await store.getRun(runId(2)))?.leaseExpiresAt, T0 + 100 + LEASE);
        });
      });

      it("are kept by a renewal, and are the same worker's after a takeover of the same run", async () => {
        await withStore(make, async (store) => {
          await queued(store, 1, 2, [{ locks: [node('n-1')] }]);
          const first = await claimed(store, 1, T0 + 100, 'w1');
          await store.acquireLocks(first.claim, { now: T0 + 100, ttlMs: LEASE });
          await store.renewLease(first.claim, { now: T0 + 20_000, leaseMs: LEASE });
          assert.equal((await store.listLocks())[0]?.expiresAt, T0 + 20_000 + LEASE);
          const second = await store.claimNext({
            workerId: 'w2',
            now: T0 + 20_000 + LEASE,
            leaseMs: LEASE,
          });
          assert.ok(second);
          const again = await store.acquireLocks(second.claim, {
            now: T0 + 20_000 + LEASE,
            ttlMs: LEASE,
          });
          assert.deepEqual(again, { ok: true, keys: ['node:n-1'] });
          assert.equal((await store.listLocks())[0]?.fence, 2);
          await assert.rejects(
            store.beginStep(first.claim, 0, { now: T0 + 20_000 + LEASE }),
            refused,
          );
          assert.equal(
            (await store.beginStep(second.claim, 0, { now: T0 + 20_000 + LEASE })).state,
            'running',
          );
        });
      });
    });

    describe('a step', () => {
      it('goes from the intent to the checkpoint, with the output and the undo records written together', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await store.acquireLocks(got.claim, { now: T0 + 110, ttlMs: LEASE });
          const begun = await store.beginStep(got.claim, 0, { now: T0 + 120 });
          assert.equal(begun.state, 'running');
          assert.equal(begun.attempt, 1);
          assert.equal(begun.startedAt, T0 + 120);
          const done = await store.checkpointStep(got.claim, 0, {
            now: T0 + 130,
            output: { written: 2 },
            undo: [
              { kind: 'file.remove', data: { path: '/a' } },
              { kind: 'file.restore', data: { path: '/b' } },
            ],
          });
          assert.equal(done.state, 'succeeded');
          assert.deepEqual(done.output, { written: 2 });
          assert.equal(done.finishedAt, T0 + 130);
          assert.deepEqual(
            (await store.getUndoRecords(runId(1))).map((r) => [
              r.stepIndex,
              r.seq,
              r.kind,
              r.state,
              r.data,
            ]),
            [
              [0, 0, 'file.remove', 'pending', { path: '/a' }],
              [0, 1, 'file.restore', 'pending', { path: '/b' }],
            ],
          );
          const events = await store.listEvents(runId(1), 0, 50);
          assert.deepEqual(
            events.map((e) => e.type),
            ['run.created', 'run.queue', 'run.claim', 'step.start', 'step.succeed'],
          );
          assert.deepEqual(
            events.map((e) => e.seq),
            events.map((_, i) => i + 1),
          );
        });
      });

      it('is started again by `restart` and counts the attempts', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await store.beginStep(got.claim, 0, { now: T0 + 120 });
          const again = await store.beginStep(got.claim, 0, { now: T0 + 130 });
          assert.equal(again.attempt, 2);
          assert.equal(again.startedAt, T0 + 120);
          assert.equal((await store.listEvents(runId(1), 0, 50)).at(-1)?.type, 'step.restart');
        });
      });

      it('cannot be checkpointed before it was started, or started once it succeeded', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await assert.rejects(
            store.checkpointStep(got.claim, 0, { now: T0 + 120, output: null, undo: [] }),
            InvalidTransitionError,
          );
          await store.beginStep(got.claim, 0, { now: T0 + 120 });
          await store.checkpointStep(got.claim, 0, { now: T0 + 130, output: null, undo: [] });
          await assert.rejects(
            store.beginStep(got.claim, 0, { now: T0 + 140 }),
            InvalidTransitionError,
          );
          await assert.rejects(store.beginStep(got.claim, 9, { now: T0 + 140 }));
        });
      });

      it('fails with a code and a message that is cut short, and can go back to waiting', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await store.beginStep(got.claim, 0, { now: T0 + 120 });
          const deferred = await store.deferStep(got.claim, 0, {
            now: T0 + 125,
            reason: 'vault_sealed',
          });
          assert.equal(deferred.state, 'pending');
          assert.equal(deferred.attempt, 1);
          await store.beginStep(got.claim, 0, { now: T0 + 130 });
          const failed = await store.failStep(got.claim, 0, {
            now: T0 + 140,
            code: 'host_unreachable',
            message: 'x'.repeat(5_000),
          });
          assert.equal(failed.state, 'failed');
          assert.equal(failed.errorCode, 'host_unreachable');
          assert.equal(failed.errorMessage?.length, 500);
          assert.equal(failed.attempt, 2);
        });
      });
    });

    describe('what a store keeps, the same in every store', () => {
      it('refuses a code or a kind that does not fit its column, and a text that holds a NUL, and writes nothing of it', async () => {
        await withStore(make, async (store) => {
          const claim = await begun(store);
          const refusedData = (error: unknown): boolean => error instanceof InvalidDataError;
          await assert.rejects(
            store.failStep(claim, 0, { now: T0 + 130, code: 'c'.repeat(81), message: 'm' }),
            refusedData,
          );
          await assert.rejects(
            store.failStep(claim, 0, { now: T0 + 130, code: 'bad\u0000code', message: 'm' }),
            refusedData,
          );
          await assert.rejects(
            store.checkpointStep(claim, 0, {
              now: T0 + 130,
              output: null,
              undo: [{ kind: 'k'.repeat(81), data: null }],
            }),
            refusedData,
          );
          await assert.rejects(
            store.checkpointStep(claim, 0, { now: T0 + 130, output: { a: 'x\u0000y' }, undo: [] }),
            refusedData,
          );
          await assert.rejects(
            store.checkpointStep(claim, 0, {
              now: T0 + 130,
              output: null,
              undo: [{ kind: 'file.remove', data: { 'k\u0000': 1 } }],
            }),
            refusedData,
          );
          await assert.rejects(
            store.checkpointStep(claim, 0, { now: T0 + 130, output: { a: '\ud800' }, undo: [] }),
            refusedData,
          );
          // The step is as it was, no undo record exists, and the run can still be written about.
          assert.equal((await store.getSteps(runId(1)))[0]?.state, 'running');
          assert.deepEqual(await store.getUndoRecords(runId(1)), []);
          assert.deepEqual(
            (await store.listEvents(runId(1), 0, 50)).map((e) => e.type),
            ['run.created', 'run.queue', 'run.claim', 'step.start'],
          );
          const done = await store.checkpointStep(claim, 0, {
            now: T0 + 140,
            output: { fine: true },
            undo: [{ kind: 'k'.repeat(80), data: { a: 'é€😀' } }],
          });
          assert.equal(done.state, 'succeeded');
        });
      });

      it('cleans and cuts a message and a reason, which are diagnostics: a NUL is removed, a lone surrogate replaced', async () => {
        await withStore(make, async (store) => {
          const claim = await begun(store);
          const deferred = await store.deferStep(claim, 0, {
            now: T0 + 125,
            reason: `r\u0000${'x'.repeat(400)}`,
          });
          assert.equal(deferred.state, 'pending');
          const reason = (await store.listEvents(runId(1), 0, 50)).find(
            (e) => e.type === 'step.defer',
          )?.data;
          assert.deepEqual(reason, { index: 0, reason: `r${'x'.repeat(299)}` });
          await store.beginStep(claim, 0, { now: T0 + 130 });
          const failed = await store.failStep(claim, 0, {
            now: T0 + 140,
            code: 'step_error',
            message: `a\u0000b\ud800c${'z'.repeat(900)}`,
          });
          assert.equal(failed.errorMessage?.length, 500);
          assert.ok(failed.errorMessage.startsWith('ab\ufffdc'));
          assert.ok(!failed.errorMessage.includes('\u0000'));
          const waiting = await store.finishRun(claim, 'wait', {
            now: T0 + 150,
            waiting: `w${'y'.repeat(900)}`,
            retryAfter: T0 + 9_000,
          });
          assert.equal(waiting.waiting?.length, 300);
        });
      });
    });

    describe('letting go of a run', () => {
      it('writes the failure of a step and the end of the run together, and a failure that is refused leaves the run as it was', async () => {
        await withStore(make, async (store) => {
          const claim = await begun(store);
          await assert.rejects(
            store.finishRun(claim, 'fail', {
              now: T0 + 130,
              failedStep: { index: 0, code: 'c'.repeat(81), message: 'm' },
            }),
            InvalidDataError,
          );
          assert.equal((await store.getRun(runId(1)))?.state, 'running');
          assert.equal((await store.getSteps(runId(1)))[0]?.state, 'running');
          const ended = await store.finishRun(claim, 'fail', {
            now: T0 + 140,
            data: { index: 0, code: 'host_unreachable' },
            failedStep: { index: 0, code: 'host_unreachable', message: 'no route' },
          });
          assert.equal(ended.state, 'failed');
          assert.equal(ended.workerId, null);
          const step = (await store.getSteps(runId(1)))[0];
          assert.equal(step?.state, 'failed');
          assert.equal(step.errorCode, 'host_unreachable');
          assert.equal(step.errorMessage, 'no route');
          assert.deepEqual(
            (await store.listEvents(runId(1), 0, 50)).slice(-2).map((e) => e.type),
            ['step.fail', 'run.fail'],
          );
        });
      });

      it('carries out a cancel that was asked for when the worker asks for a person, instead of parking a run that nothing claims', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const got = await claimed(store, 1);
          await store.requestCancel(id, T0 + 110);
          const after = await store.finishRun(got.claim, 'await_input', {
            now: T0 + 120,
            waiting: 'step 0 needs a person',
          });
          assert.equal(after.state, 'cancelled');
          assert.equal(after.cancelRequestedAt, null);
          assert.equal(after.waiting, null);
          assert.equal(after.workerId, null);
          assert.equal(after.finishedAt, T0 + 120);
          const last = (await store.listEvents(id, 0, 50)).at(-1);
          assert.equal(last?.type, 'run.cancel');
          assert.deepEqual(last.data, {
            from: 'running',
            to: 'cancelled',
            data: { instead: 'await_input', reason: 'step 0 needs a person' },
            waiting: null,
          });
        });
      });

      it('cancels a run that a worker pauses while a cancel is pending: a paused run is claimed by nobody', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const got = await claimed(store, 1);
          await store.requestPause(id, T0 + 110);
          await store.requestCancel(id, T0 + 111);
          const after = await store.finishRun(got.claim, 'pause', { now: T0 + 120 });
          assert.equal(after.state, 'cancelled');
          assert.equal(after.cancelRequestedAt, null);
          assert.equal(after.pauseRequestedAt, null);
          const last = (await store.listEvents(id, 0, 50)).at(-1);
          assert.equal(last?.type, 'run.cancel');
          assert.deepEqual(last.data, {
            from: 'running',
            to: 'cancelled',
            data: { instead: 'pause', reason: null },
            waiting: null,
          });
        });
      });

      it('parks a run for a person when only a pause is pending, and the pause is gone with it', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const got = await claimed(store, 1);
          await store.requestPause(id, T0 + 110);
          const after = await store.finishRun(got.claim, 'await_input', {
            now: T0 + 120,
            waiting: 'step 0 needs a person',
          });
          assert.equal(after.state, 'awaiting_input');
          assert.equal(after.waiting, 'step 0 needs a person');
          assert.equal(after.pauseRequestedAt, null);
        });
      });

      it('leaves no request of the people for a run that ended or stopped for a person; a wait keeps them', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const first = await claimed(store, 1, T0 + 100);
          await store.requestCancel(id, T0 + 110);
          await store.requestPause(id, T0 + 111);
          const waiting = await store.finishRun(first.claim, 'wait', {
            now: T0 + 120,
            waiting: 'lock',
            retryAfter: T0 + 200,
          });
          assert.equal(waiting.cancelRequestedAt, T0 + 110);
          assert.equal(waiting.pauseRequestedAt, T0 + 111);
          // The run that was claimed again with both pending ends by the cancel: it came first.
          const second = await claimed(store, 1, T0 + 200);
          assert.equal(second.run.cancelRequestedAt, T0 + 110);
          const ended = await store.finishRun(second.claim, 'pause', { now: T0 + 210 });
          assert.equal(ended.state, 'cancelled');
          assert.equal(ended.cancelRequestedAt, null);
          assert.equal(ended.pauseRequestedAt, null);
        });
      });

      it('leaves no request of the people for a run that failed, so that its retry is not a cancel', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const first = await claimed(store, 1, T0 + 100);
          await store.requestPause(id, T0 + 110);
          const paused = await store.finishRun(first.claim, 'pause', { now: T0 + 120 });
          assert.equal(paused.state, 'paused');
          assert.equal(paused.pauseRequestedAt, null);
          await store.applyEvent(id, 'resume', { now: T0 + 130 });
          const second = await claimed(store, 1, T0 + 140);
          await store.requestCancel(id, T0 + 150);
          await store.requestPause(id, T0 + 151);
          const failed = await store.finishRun(second.claim, 'fail', { now: T0 + 160 });
          assert.equal(failed.cancelRequestedAt, null);
          assert.equal(failed.pauseRequestedAt, null);
          // A retry of the failed run is not a cancel that nobody asked for now.
          const again = await store.applyEvent(id, 'retry', { now: T0 + 170 });
          assert.equal(again.state, 'queued');
          assert.equal(again.cancelRequestedAt, null);
        });
      });

      it('ends it, with no worker, no lease and the time it ended', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1, 1);
          const got = await claimed(store, 1);
          await store.beginStep(got.claim, 0, { now: T0 + 120 });
          await store.checkpointStep(got.claim, 0, { now: T0 + 130, output: null, undo: [] });
          const run = await store.finishRun(got.claim, 'succeed', { now: T0 + 140 });
          assert.equal(run.state, 'succeeded');
          assert.equal(run.workerId, null);
          assert.equal(run.leaseExpiresAt, null);
          assert.equal(run.finishedAt, T0 + 140);
          assert.equal(run.fence, 1);
        });
      });

      it('refuses an event that is not for a worker, and one that the state does not take', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await assert.rejects(
            store.finishRun(got.claim, 'approve' as never, { now: T0 + 200 }),
            StateConflictError,
          );
          await assert.rejects(
            store.finishRun(got.claim, 'rollback_done' as never, { now: T0 + 200 }),
            StateConflictError,
          );
          assert.equal((await store.getRun(runId(1)))?.state, 'running');
        });
      });

      it('puts a run that waits for a person in `awaiting_input` with the reason, without its locks', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1, 2, [{ locks: [node('n-1')] }]);
          const got = await claimed(store, 1);
          await store.acquireLocks(got.claim, { now: T0 + 110, ttlMs: LEASE });
          const run = await store.finishRun(got.claim, 'await_input', {
            now: T0 + 120,
            waiting: 'step 0 was interrupted',
          });
          assert.equal(run.state, 'awaiting_input');
          assert.equal(run.waiting, 'step 0 was interrupted');
          assert.deepEqual(await store.listLocks(), []);
        });
      });
    });

    describe('the requests of people to a run that a worker holds', () => {
      it('are flags that the worker reads when it renews the lease', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const got = await claimed(store, 1);
          assert.equal((await store.requestCancel(id, T0 + 150)).cancelRequestedAt, T0 + 150);
          assert.equal((await store.requestPause(id, T0 + 160)).pauseRequestedAt, T0 + 160);
          // Asking again changes nothing and adds no event.
          const events = (await store.listEvents(id, 0, 50)).length;
          await store.requestCancel(id, T0 + 170);
          assert.equal((await store.listEvents(id, 0, 50)).length, events);
          const renewed = await store.renewLease(got.claim, { now: T0 + 180, leaseMs: LEASE });
          assert.equal(renewed.cancelRequestedAt, T0 + 150);
          assert.equal(renewed.pauseRequestedAt, T0 + 160);
          const done = await store.finishRun(got.claim, 'cancel', { now: T0 + 190 });
          assert.equal(done.state, 'cancelled');
          assert.equal(done.cancelRequestedAt, null);
        });
      });

      it('pause a queued run at once', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const paused = await store.requestPause(id, T0 + 50);
          assert.equal(paused.state, 'paused');
          const queuedAgain = await store.applyEvent(id, 'resume', { now: T0 + 60 });
          assert.equal(queuedAgain.state, 'queued');
        });
      });
    });

    describe('a pause that meets a cancel that was accepted', () => {
      it('is a cancel: a run that waits with a cancel kept for it is cancelled by the pause of a person, not paused', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const first = await claimed(store, 1, T0 + 100);
          await store.requestCancel(id, T0 + 110);
          await store.finishRun(first.claim, 'wait', {
            now: T0 + 120,
            waiting: 'lock',
            retryAfter: T0 + 9_000,
          });
          const after = await store.requestPause(id, T0 + 130);
          assert.equal(after.state, 'cancelled');
          assert.equal(after.cancelRequestedAt, null);
          assert.equal(after.finishedAt, T0 + 130);
          const last = (await store.listEvents(id, 0, 50)).at(-1);
          assert.equal(last?.type, 'run.cancel');
          assert.deepEqual(last.data, {
            from: 'queued',
            to: 'cancelled',
            actor: null,
            instead: 'pause',
          });
        });
      });

      it('is a pause when nothing is pending, and the event says pause', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const after = await store.requestPause(id, T0 + 130);
          assert.equal(after.state, 'paused');
          const last = (await store.listEvents(id, 0, 50)).at(-1);
          assert.equal(last?.type, 'run.pause');
          assert.deepEqual(last.data, { from: 'queued', to: 'paused', actor: null });
        });
      });
    });

    describe('what people choose for a run that stopped', () => {
      async function interrupted(store: RunStore) {
        await queued(store, 1);
        const got = await claimed(store, 1);
        await store.beginStep(got.claim, 0, { now: T0 + 120 });
        await store.finishRun(got.claim, 'await_input', {
          now: T0 + 130,
          waiting: 'step 0 was interrupted',
        });
        return runId(1);
      }

      it('retry puts the failed steps back to `pending` and queues the run', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          const got = await claimed(store, 1);
          await store.beginStep(got.claim, 0, { now: T0 + 120 });
          await store.failStep(got.claim, 0, { now: T0 + 130, code: 'boom', message: 'it broke' });
          await store.finishRun(got.claim, 'fail', { now: T0 + 140 });
          const run = await store.applyEvent(runId(1), 'retry', { now: T0 + 150 });
          assert.equal(run.state, 'queued');
          const step = (await store.getSteps(runId(1)))[0];
          assert.equal(step?.state, 'pending');
          assert.equal(step.errorCode, null);
          assert.equal(step.attempt, 1);
        });
      });

      it('retry of an interrupted step records the choice, and mark_done writes the step as done', async () => {
        await withStore(make, async (store) => {
          const id = await interrupted(store);
          const retried = await store.applyEvent(id, 'retry', { now: T0 + 200 });
          assert.equal(retried.state, 'queued');
          assert.equal((await store.getSteps(id))[0]?.retryApproved, true);
        });
        await withStore(make, async (store) => {
          const id = await interrupted(store);
          const done = await store.applyEvent(id, 'mark_done', { now: T0 + 200 });
          assert.equal(done.state, 'queued');
          const step = (await store.getSteps(id))[0];
          assert.equal(step?.state, 'succeeded');
          assert.equal(step.output, null);
          assert.deepEqual(await store.getUndoRecords(id), []);
        });
      });
    });

    describe('the events of a run', () => {
      it('are numbered from 1 without gaps, and read after a number', async () => {
        await withStore(make, async (store) => {
          const id = await queued(store, 1);
          const got = await claimed(store, 1);
          await store.appendEvent(got.claim, 'locks.acquired', { keys: [] }, T0 + 150);
          const all = await store.listEvents(id, 0, 100);
          assert.deepEqual(
            all.map((e) => e.seq),
            [1, 2, 3, 4],
          );
          assert.deepEqual(
            (await store.listEvents(id, 2, 100)).map((e) => e.seq),
            [3, 4],
          );
          assert.deepEqual(
            (await store.listEvents(id, 0, 2)).map((e) => e.seq),
            [1, 2],
          );
          assert.deepEqual(await store.listEvents(id, 4, 100), []);
        });
      });

      it('are those of one run only', async () => {
        await withStore(make, async (store) => {
          await queued(store, 1);
          await queued(store, 2);
          assert.equal(
            (await store.listEvents(runId(1), 0, 100)).every((e) => e.runId === runId(1)),
            true,
          );
        });
      });
    });
  });
}
