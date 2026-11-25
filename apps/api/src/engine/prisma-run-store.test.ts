import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createIsolatedDatabase } from '@swellwright/db/testing';
import { InvalidTransitionError } from '@swellwright/engine';
import {
  plan,
  node,
  runId,
  runStoreContract,
  runWorkerScenarios,
  type StoreUnderTest,
} from '@swellwright/engine/testing';

import { databaseUrl } from '../test-support.js';
import { PrismaRunStore } from './prisma-run-store.js';

const skip = databaseUrl === undefined ? 'SW_TEST_DATABASE_URL is not set' : false;

/** A schema of its own for every test, with every shipped migration applied. */
async function make(): Promise<StoreUnderTest> {
  const isolated = await createIsolatedDatabase(databaseUrl ?? '');
  return { store: new PrismaRunStore(isolated.database.client), close: () => isolated.drop() };
}

// The same rules as the store in memory, and the same scenarios of the loop (a worker killed at each point, a stalled worker,
// contested locks, cancel and pause), on a real PostgreSQL.
runStoreContract('PostgreSQL', make, { skip });
runWorkerScenarios('PostgreSQL', make, { skip });

// What only a server that runs transactions side by side can show: the claims and the locks of several loops do not
// overlap. A stand that serialises everything (`SW_TEST_DATABASE_POOL=1`) cannot, so these are left to the CI service.
const concurrent = skip === false && process.env['SW_TEST_DATABASE_POOL'] !== '1';

describe(
  'several loops on one PostgreSQL',
  { skip: concurrent ? false : skip || 'the stand runs one connection' },
  () => {
    const T0 = 1_000_000;
    const LEASE = 30_000;

    it('claim every queued run once, however many of them ask at the same time', async () => {
      const { store, close } = await make();
      try {
        const ids: string[] = [];
        for (let n = 1; n <= 12; n += 1) {
          const run = await store.createRun({
            id: runId(n),
            plan: plan([{}]),
            risk: 'low',
            requestedBy: null,
            now: T0 + n,
          });
          await store.applyEvent(run.id, 'queue', { now: T0 + n });
          ids.push(run.id);
        }
        const claimed: string[] = [];
        for (let round = 0; round < 6; round += 1) {
          const got = await Promise.all(
            ['a', 'b', 'c', 'd'].map((workerId) =>
              store.claimNext({ workerId, now: T0 + 100, leaseMs: LEASE }),
            ),
          );
          for (const one of got) {
            if (one !== null) {
              claimed.push(one.claim.runId);
            }
          }
        }
        // No run was claimed twice, and every one was claimed.
        assert.equal(new Set(claimed).size, claimed.length);
        assert.deepEqual([...claimed].sort(), [...ids].sort());
        for (const id of ids) {
          assert.equal((await store.getRun(id))?.fence, 1);
        }
      } finally {
        await close?.();
      }
    });

    it('give a lock that two runs ask for at the same moment to one of them', async () => {
      const { store, close } = await make();
      try {
        for (const n of [1, 2]) {
          const run = await store.createRun({
            id: runId(n),
            plan: plan([{ locks: [node('n-1')] }]),
            risk: 'low',
            requestedBy: null,
            now: T0 + n,
          });
          await store.applyEvent(run.id, 'queue', { now: T0 + n });
        }
        const first = await store.claimNext({ workerId: 'a', now: T0 + 100, leaseMs: LEASE });
        const second = await store.claimNext({ workerId: 'b', now: T0 + 100, leaseMs: LEASE });
        assert.ok(first && second);
        const results = await Promise.all([
          store.acquireLocks(first.claim, { now: T0 + 200, ttlMs: LEASE }),
          store.acquireLocks(second.claim, { now: T0 + 200, ttlMs: LEASE }),
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        const holders = (await store.listLocks()).map((lock) => lock.holder);
        assert.equal(holders.length, 1);
        assert.equal(holders[0], results[0].ok ? first.claim.runId : second.claim.runId);
      } finally {
        await close?.();
      }
    });

    it('let one of several people who answer the same run at once win, and keep the events in order', async () => {
      const { store, close } = await make();
      try {
        const id = runId(1);
        await store.createRun({ id, plan: plan([{}]), risk: 'low', requestedBy: null, now: T0 });
        await store.applyEvent(id, 'queue', { now: T0 });
        const outcomes = await Promise.allSettled(
          Array.from({ length: 6 }, (_, n) =>
            store.applyEvent(id, 'cancel', { now: T0 + 10 + n, actor: `person-${String(n)}` }),
          ),
        );
        assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            assert.ok(outcome.reason instanceof InvalidTransitionError);
          }
        }
        const events = await store.listEvents(id, 0, 50);
        assert.deepEqual(
          events.map((event) => event.seq),
          [1, 2, 3],
        );
        assert.deepEqual(
          events.map((event) => event.type),
          ['run.created', 'run.queue', 'run.cancel'],
        );
      } finally {
        await close?.();
      }
    });
  },
);
