// The loop on a store, as tests (ADR 0048, "How it is tested"): golden scenarios, a worker killed at each point, a stalled worker
// that the fence must stop, contested locks, cancel and pause, steps that cannot be repeated. The suite takes a store and
// runs the same scenarios on the store in memory and on the one over PostgreSQL.
//
// Usage: `runWorkerScenarios('memory', () => Promise.resolve({ store: new MemoryRunStore() }))` inside a test file.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { JsonValue } from '../plan.js';
import { StepRegistry } from '../registry.js';
import {
  StepDeferredError,
  StepFailure,
  defineStep,
  type Schema,
  type Step,
  type StepContext,
} from '../step.js';
import { LockLostError, type RunStore } from '../store.js';
import { CRASH_POINTS, ShutdownError, Worker, WorkerCrash, type CrashPoint } from '../worker.js';
import { FakeClock, node, plan, runId, server, type PlanStep } from './fixtures.js';
import type { StoreUnderTest } from './store-contract.js';

const RENEW = 10_000;
const LEASE = 3 * RENEW;
const BACKOFF = 5_000;

const json: Schema<JsonValue> = { parse: (input) => input as JsonValue };

/** What the steps do to the "world": how often `apply` ran, and which effects exist (an effect is done once per step). */
interface World {
  readonly calls: Map<string, number>;
  readonly effects: Set<string>;
  readonly order: string[];
  sealed: boolean;
}

const newWorld = (): World => ({ calls: new Map(), effects: new Set(), order: [], sealed: false });
const callsOf = (world: World, id: string, index: number): number =>
  world.calls.get(`${id}-${String(index)}`) ?? 0;

type TestStep = Step<JsonValue, JsonValue, null>;

function step(world: World, key: string, over: Partial<TestStep> = {}) {
  return defineStep<JsonValue, JsonValue, null>({
    key,
    title: () => key,
    estimateSeconds: () => 1,
    locks: () => [],
    plan: () => Promise.resolve([]),
    input: json,
    output: json,
    apply: (ctx: StepContext<null>) => {
      world.calls.set(ctx.remoteId, (world.calls.get(ctx.remoteId) ?? 0) + 1);
      world.effects.add(ctx.remoteId);
      world.order.push(`${key}#${String(ctx.attempt)}`);
      return Promise.resolve({ by: key, attempt: ctx.attempt });
    },
    ...over,
  });
}

function registryOf(
  world: World,
  count: number,
  over: (index: number) => Partial<TestStep> = () => ({}),
): StepRegistry<null> {
  const registry = new StepRegistry<null>();
  for (let index = 0; index < count; index += 1) {
    registry.register(step(world, `test.step-${String(index)}`, over(index)));
  }
  return registry;
}

/** A hook that makes the worker die, once, at the named point (of the step at `index`, or of the run when it is `null`). */
const dieAt =
  (point: CrashPoint, index: number | null = null) =>
  (reached: CrashPoint, info: { stepIndex: number | null }): void => {
    if (reached === point && info.stepIndex === index) {
      throw new WorkerCrash(point);
    }
  };

/** Waits for something that another task does, in real time and for no longer than `ms`. */
async function until(condition: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    assert.ok(Date.now() < end, 'the condition was not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A promise that the test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The store as a worker sees it, with one method held at its call until `release` is called: the moment at which a `stop` that
 * arrives finds that call still pending. `entered` settles when the worker has made the call.
 */
function held(
  store: RunStore,
  method: 'getSteps' | 'beginStep' | 'checkpointStep',
): { readonly store: RunStore; readonly entered: Promise<void>; readonly release: () => void } {
  const entered = gate();
  const release = gate();
  const proxy = new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (property !== method) {
        return bound;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        entered.open();
        await release.promise;
        return bound(...args);
      };
    },
  });
  return { store: proxy, entered: entered.promise, release: release.open };
}

export function runWorkerScenarios(
  name: string,
  make: () => Promise<StoreUnderTest>,
  /** `skip` says why the suite cannot run here (no database configured), as the options of `describe` do. */
  options: { readonly skip?: string | boolean } = {},
): void {
  describe(`the loop on a store: ${name}`, { skip: options.skip ?? false }, () => {
    const closers: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const close of closers.splice(0)) {
        await close();
      }
    });

    async function setup(
      steps: readonly PlanStep[] = [{}, {}, {}],
      over: (index: number) => Partial<TestStep> = () => ({}),
    ) {
      const clock = new FakeClock();
      const { store, close } = await make();
      if (close !== undefined) {
        closers.push(close);
      }
      const world = newWorld();
      const registry = registryOf(world, steps.length, over);
      const worker = (
        id: string,
        extra: Partial<ConstructorParameters<typeof Worker<null>>[0]> = {},
      ): Worker<null> =>
        new Worker<null>({
          store,
          registry,
          ports: null,
          workerId: id,
          now: clock.now,
          renewIntervalMs: RENEW,
          waitBackoffMs: BACKOFF,
          heartbeat: false,
          ...extra,
        });
      const submit = async (n: number, planSteps: readonly PlanStep[] = steps): Promise<string> => {
        const run = await store.createRun({
          id: runId(n),
          plan: plan(planSteps),
          risk: 'low',
          requestedBy: 'person-1',
          now: clock.now(),
        });
        await store.applyEvent(run.id, 'queue', { now: clock.now() });
        return run.id;
      };
      return { clock, store, world, registry, worker, submit };
    }

    const types = async (store: RunStore, id: string): Promise<string[]> =>
      (await store.listEvents(id, 0, 500)).map((event) => event.type);

    describe('a run from start to end (golden)', () => {
      it('claims, locks, does the steps in order with a checkpoint each, and ends', async () => {
        const t = await setup();
        const id = await t.submit(1, [
          { locks: [server('s-1')], input: { n: 0 } },
          { locks: [server('s-1'), node('n-1')], input: { n: 1 } },
          { input: { n: 2 } },
        ]);
        const undo = (index: number) => ({
          undo: (ctx: StepContext<null>) =>
            Promise.resolve([
              { kind: `undo.step-${String(ctx.stepIndex)}.a`, data: { index } },
              { kind: `undo.step-${String(ctx.stepIndex)}.b`, data: null },
            ]),
        });
        const registry = registryOf(t.world, 3, (index) => (index < 2 ? undo(index) : {}));
        const worker = new Worker<null>({
          store: t.store,
          registry,
          ports: null,
          workerId: 'w1',
          now: t.clock.now,
          renewIntervalMs: RENEW,
          heartbeat: false,
        });

        t.clock.advance(100);
        assert.deepEqual(await worker.runOnce(), { kind: 'succeeded', runId: id });

        assert.deepEqual(await types(t.store, id), [
          'run.created',
          'run.queue',
          'run.claim',
          'locks.acquired',
          'step.start',
          'step.succeed',
          'step.start',
          'step.succeed',
          'step.start',
          'step.succeed',
          'run.succeed',
        ]);
        assert.deepEqual(t.world.order, ['test.step-0#1', 'test.step-1#1', 'test.step-2#1']);
        const steps = await t.store.getSteps(id);
        assert.deepEqual(
          steps.map((s) => [s.state, s.attempt, s.output]),
          [
            ['succeeded', 1, { by: 'test.step-0', attempt: 1 }],
            ['succeeded', 1, { by: 'test.step-1', attempt: 1 }],
            ['succeeded', 1, { by: 'test.step-2', attempt: 1 }],
          ],
        );
        assert.deepEqual(
          (await t.store.getUndoRecords(id)).map((r) => [r.stepIndex, r.seq, r.kind, r.state]),
          [
            [0, 0, 'undo.step-0.a', 'pending'],
            [0, 1, 'undo.step-0.b', 'pending'],
            [1, 0, 'undo.step-1.a', 'pending'],
            [1, 1, 'undo.step-1.b', 'pending'],
          ],
        );
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'succeeded');
        assert.equal(run.fence, 1);
        assert.equal(run.workerId, null);
        assert.deepEqual(await t.store.listLocks(), []);
        assert.deepEqual(
          (await t.store.listEvents(id, 0, 50))
            .filter((e) => e.type === 'locks.acquired')
            .map((e) => e.data),
          [{ keys: ['server:s-1', 'node:n-1'] }],
        );
        // Nothing left for anyone.
        assert.equal(await worker.runOnce(), null);
      });

      it('is the same on the second run of the same input: a fixed input gives fixed events', async () => {
        const run = async () => {
          const t = await setup();
          const id = await t.submit(1);
          t.clock.advance(100);
          await t.worker('w1').runOnce();
          return (await t.store.listEvents(id, 0, 50)).map((e) => [e.seq, e.at, e.type, e.data]);
        };
        assert.deepEqual(await run(), await run());
      });
    });

    describe('a worker that dies at any point', () => {
      const points = CRASH_POINTS;
      // How many times the step at the crash is applied in all, for a step that can be repeated.
      const applyCalls: Record<CrashPoint, number> = {
        after_claim: 1,
        after_locks: 1,
        before_intent: 1,
        after_intent: 1,
        after_apply: 2,
        after_checkpoint: 1,
      };

      for (const point of points) {
        for (const index of point === 'after_claim' || point === 'after_locks'
          ? [null]
          : [0, 1, 2]) {
          it(`leaves rows from which another worker finishes the run: ${point}, step ${String(index)}`, async () => {
            const t = await setup();
            const id = await t.submit(1, [{ locks: [server('s-1')] }, {}, {}]);
            t.clock.advance(100);
            await assert.rejects(
              t.worker('a', { crash: dieAt(point, index) }).runOnce(),
              WorkerCrash,
            );

            // The dead worker still holds the run until its lease runs out: nobody can take it earlier.
            assert.equal(await t.worker('b').runOnce(), null);
            t.clock.advance(LEASE);
            assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });

            const run = await t.store.getRun(id);
            assert.equal(run?.state, 'succeeded');
            assert.equal(run.fence, 2);
            assert.deepEqual(await t.store.listLocks(), []);
            // Every effect exists once; a step that was applied twice is one that can be, and its effect is still one.
            assert.deepEqual(
              [...t.world.effects].sort(),
              [0, 1, 2].map((i) => `${id}-${String(i)}`),
            );
            for (const i of [0, 1, 2]) {
              const expected = index === i ? applyCalls[point] : 1;
              assert.equal(
                callsOf(t.world, id, i),
                expected,
                `step ${String(i)} applied ${String(callsOf(t.world, id, i))} times`,
              );
            }
            const steps = await t.store.getSteps(id);
            assert.deepEqual(
              steps.map((s) => s.state),
              ['succeeded', 'succeeded', 'succeeded'],
            );
            // No undo record twice, and the journal has no gaps.
            const events = await t.store.listEvents(id, 0, 500);
            assert.deepEqual(
              events.map((e) => e.seq),
              events.map((_, n) => n + 1),
            );
          });
        }
      }

      it('is taken over in the middle of `apply`: the step is started again with the next attempt', async () => {
        const t = await setup();
        const id = await t.submit(1);
        const dying = (ctx: StepContext<null>): Promise<JsonValue> => {
          t.world.calls.set(ctx.remoteId, (t.world.calls.get(ctx.remoteId) ?? 0) + 1);
          return Promise.reject(new WorkerCrash('in apply'));
        };
        const registry = registryOf(t.world, 3, (index) => (index === 1 ? { apply: dying } : {}));
        const worker = new Worker<null>({
          store: t.store,
          registry,
          ports: null,
          workerId: 'a',
          now: t.clock.now,
          renewIntervalMs: RENEW,
          heartbeat: false,
        });
        await assert.rejects(worker.runOnce(), WorkerCrash);
        // The step is `running`, not `failed`: a crash is not a failure of the step.
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'running', 'pending'],
        );
        t.clock.advance(LEASE);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal((await t.store.getSteps(id))[1]?.attempt, 2);
        // Once by the worker that died in the middle of it, once by the one that finished the step.
        assert.equal(callsOf(t.world, id, 1), 2);
      });
    });

    describe('a step that cannot be repeated', () => {
      const once = (index: number): Partial<TestStep> => (index === 1 ? { idempotent: false } : {});

      it('is never repeated by itself: the run waits for a person', async () => {
        const t = await setup(undefined, once);
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        const outcome = await t.worker('b').runOnce();
        assert.equal(outcome?.kind, 'awaiting_input');
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'awaiting_input');
        assert.match(
          run.waiting ?? '',
          /step 1 \(test\.step-1\) was interrupted and cannot be repeated by itself/u,
        );
        assert.deepEqual(await t.store.listLocks(), []);
        // Nothing is claimed while it waits, however long.
        t.clock.advance(10 * LEASE);
        assert.equal(await t.worker('c').runOnce(), null);
      });

      it('goes on after a person says it was done, without being applied again', async () => {
        const t = await setup(undefined, once);
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        await t.worker('b').runOnce();
        await t.store.applyEvent(id, 'mark_done', { now: t.clock.now(), actor: 'person-1' });
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(callsOf(t.world, id, 1), 1);
        const step = (await t.store.getSteps(id))[1];
        assert.equal(step?.state, 'succeeded');
        assert.equal(step.output, null);
      });

      it('is repeated when a person chooses to retry it, and only then', async () => {
        const t = await setup(undefined, once);
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        await t.worker('b').runOnce();
        await t.store.applyEvent(id, 'retry', { now: t.clock.now(), actor: 'person-1' });
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(callsOf(t.world, id, 1), 2);
      });

      it('can be left to a rollback, which is only requested here', async () => {
        const t = await setup(undefined, once);
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        await t.worker('b').runOnce();
        const run = await t.store.applyEvent(id, 'request_rollback', { now: t.clock.now() });
        assert.equal(run.state, 'rollback_requested');
      });
    });

    describe('a step that can look at the world (reconcile)', () => {
      const reconciling =
        (
          found: () => Promise<
            { status: 'done'; output: JsonValue } | { status: 'not_done' } | { status: 'partial' }
          >,
          idempotent: boolean,
        ) =>
        (index: number): Partial<TestStep> =>
          index === 1 ? { idempotent, reconcile: found } : {};

      it('records the success without applying the step again when the effect is there', async () => {
        let asked = 0;
        const t = await setup(
          undefined,
          reconciling(() => {
            asked += 1;
            return Promise.resolve({ status: 'done', output: { found: true } } as const);
          }, false),
        );
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(asked, 1);
        assert.equal(callsOf(t.world, id, 1), 1);
        assert.deepEqual((await t.store.getSteps(id))[1]?.output, { found: true });
      });

      it('applies the step when nothing was done, even one that cannot be repeated', async () => {
        const t = await setup(
          undefined,
          reconciling(() => Promise.resolve({ status: 'not_done' } as const), false),
        );
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_intent', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(callsOf(t.world, id, 1), 1);
      });

      it('keeps the interrupted step as it is when the reconcile has to wait (a sealed vault), and reconciles again before anything is repeated', async () => {
        let asked = 0;
        const t = await setup(
          undefined,
          reconciling(() => {
            asked += 1;
            return asked === 1
              ? Promise.reject(new StepDeferredError('vault_sealed'))
              : Promise.resolve({ status: 'done', output: { found: true } } as const);
          }, false),
        );
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        const b = t.worker('b');
        assert.deepEqual(await b.runOnce(), { kind: 'waiting', runId: id, reason: 'vault_sealed' });
        // The effect may be there: the step is still `running`, so that the next one to take the run reconciles it again.
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'running', 'pending'],
        );

        t.clock.advance(8 * BACKOFF + 1);
        assert.deepEqual(await b.runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(asked, 2);
        assert.equal(callsOf(t.world, id, 1), 1);
        assert.deepEqual((await t.store.getSteps(id))[1]?.output, { found: true });
      });

      it('verifies what the reconcile found before it records the step, and a `null` output is an output like any other', async () => {
        let verified = 0;
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                idempotent: false,
                // The effect is there and the output is `null`: a valid output that must not be taken for "nothing found".
                reconcile: () => Promise.resolve({ status: 'done', output: null } as const),
                verify: () => {
                  verified += 1;
                  return verified <= 2
                    ? Promise.reject(new StepDeferredError('vault_sealed'))
                    : Promise.resolve();
                },
              }
            : {},
        );
        const id = await t.submit(1);
        t.clock.advance(1);
        const a = t.worker('a');
        const waited = { kind: 'waiting', runId: id, reason: 'vault_sealed' };
        // The first claim applies the step, and its verification has to wait.
        assert.deepEqual(await a.runOnce(), waited);
        // The second finds the effect, and the verification has to wait again: the step is not recorded, nothing is repeated.
        t.clock.advance(8 * BACKOFF + 1);
        assert.deepEqual(await a.runOnce(), waited);
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'running', 'pending'],
        );
        // The third verifies, and the run goes on.
        t.clock.advance(8 * BACKOFF + 1);
        assert.deepEqual(await a.runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(verified, 3);
        assert.equal(callsOf(t.world, id, 1), 1);
      });

      it('makes a run that waits after its effect wait longer each time, as one that waits before it does', async () => {
        const t = await setup(
          undefined,
          reconciling(() => Promise.reject(new StepDeferredError('vault_sealed')), false),
        );
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        const waits: number[] = [];
        const b = t.worker('b');
        for (let round = 0; round < 5; round += 1) {
          assert.equal((await b.runOnce())?.kind, 'waiting');
          const until = (await t.store.getRun(id))?.retryAfter ?? 0;
          waits.push((until - t.clock.now()) / BACKOFF);
          t.clock.advance(until - t.clock.now());
        }
        // Twice as long each time, up to eight times the backoff.
        assert.deepEqual(waits, [2, 4, 8, 8, 8]);
        assert.equal(callsOf(t.world, id, 1), 1);
      });

      it('does not send a step back to `pending` when it defers after `apply` (in `verify`): the effect is there, so nothing is repeated', async () => {
        let verified = 0;
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                idempotent: false,
                verify: () => {
                  verified += 1;
                  return verified === 1
                    ? Promise.reject(new StepDeferredError('vault_sealed'))
                    : Promise.resolve();
                },
              }
            : {},
        );
        const id = await t.submit(1);
        t.clock.advance(1);
        const a = t.worker('a');
        assert.deepEqual(await a.runOnce(), { kind: 'waiting', runId: id, reason: 'vault_sealed' });
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'running', 'pending'],
        );

        // A step that cannot be repeated and is `running` is a person's decision, as after a crash; it is not applied again.
        t.clock.advance(BACKOFF + 1);
        assert.equal((await a.runOnce())?.kind, 'awaiting_input');
        assert.equal(callsOf(t.world, id, 1), 1);
      });

      it('asks a person after a part of the step when the step cannot be repeated, and repeats it when it can', async () => {
        const partial = () => Promise.resolve({ status: 'partial' } as const);
        const hard = await setup(undefined, reconciling(partial, false));
        const hardId = await hard.submit(1);
        await assert.rejects(
          hard.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        hard.clock.advance(LEASE);
        assert.equal((await hard.worker('b').runOnce())?.kind, 'awaiting_input');
        assert.match((await hard.store.getRun(hardId))?.waiting ?? '', /only partly done/u);

        const easy = await setup(undefined, reconciling(partial, true));
        const easyId = await easy.submit(1);
        await assert.rejects(
          easy.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        easy.clock.advance(LEASE);
        assert.deepEqual(await easy.worker('b').runOnce(), { kind: 'succeeded', runId: easyId });
        assert.equal(callsOf(easy.world, easyId, 1), 2);
      });

      it('fails the run when the look at the world fails, and says why', async () => {
        const t = await setup(
          undefined,
          reconciling(
            () => Promise.reject(new StepFailure('panel_unreachable', 'The panel did not answer.')),
            false,
          ),
        );
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        assert.equal((await t.worker('b').runOnce())?.kind, 'failed');
        const step = (await t.store.getSteps(id))[1];
        assert.equal(step?.state, 'failed');
        assert.equal(step.errorCode, 'panel_unreachable');
      });
    });

    describe('two workers and the fence', () => {
      it('stops a worker that was stalled and wakes up after another one took the run: it writes nothing', async () => {
        const stalled = gate();
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                apply: async (ctx: StepContext<null>) => {
                  t.world.calls.set(ctx.remoteId, (t.world.calls.get(ctx.remoteId) ?? 0) + 1);
                  if (ctx.fence === 1) {
                    await stalled.promise;
                    return { by: 'the stalled worker' };
                  }
                  return { by: 'the second worker' };
                },
              }
            : {},
        );
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}, {}]);
        const first = t.worker('a').runOnce();
        // Wait until the step is inside `apply`, not only recorded as running: the worker renews its lease once more between the
        // two, and a clock moved before that renewal would give the lease a new life.
        await until(() => Promise.resolve(callsOf(t.world, id, 1) === 1));

        // The lease runs out while the first worker is stalled inside `apply`; the second one takes the run and finishes it.
        t.clock.advance(LEASE);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        const before = await t.store.listEvents(id, 0, 500);

        // The first one wakes up: its checkpoint is refused, it says it lost the run, and it touches nothing more.
        stalled.open();
        const outcome = await first;
        assert.equal(outcome?.kind, 'lost');
        assert.deepEqual(await t.store.listEvents(id, 0, 500), before);
        const step = (await t.store.getSteps(id))[1];
        assert.deepEqual(step?.output, { by: 'the second worker' });
        assert.equal(step.attempt, 2);
        // What the fence cannot do is un-run the step on the server: it ran twice, which is why steps must be repeatable.
        assert.equal(callsOf(t.world, id, 1), 2);
        assert.deepEqual(await t.store.listLocks(), []);
      });

      it('keeps a run that a worker holds: renewals on a timer, so a long step is not taken over', async () => {
        const hold = gate();
        const t = await setup([{}], () => ({
          apply: async () => {
            await hold.promise;
            return { done: true };
          },
        }));
        const id = await t.submit(1);
        const first = t.worker('a', { heartbeat: true, renewIntervalMs: 10 }).runOnce();
        await until(async () => (await t.store.getSteps(id))[0]?.state === 'running');
        // Far more fake time than a lease passes, in small steps, while the step is still going on.
        for (let n = 0; n < 6; n += 1) {
          t.clock.advance(20);
          const expected = t.clock.now() + 30;
          await until(async () => ((await t.store.getRun(id))?.leaseExpiresAt ?? 0) >= expected);
        }
        assert.equal(await t.worker('b', { renewIntervalMs: 10 }).runOnce(), null);
        hold.open();
        assert.deepEqual(await first, { kind: 'succeeded', runId: id });
      });
    });

    describe('locks between runs', () => {
      it('make a second run wait with the reason, leave it alone until its time and let the runs behind it go first', async () => {
        const hold = gate();
        const t = await setup([{ locks: [node('n-1')] }], (index) =>
          index === 0
            ? {
                apply: async (ctx: StepContext<null>) => {
                  if (ctx.runId === runId(1)) {
                    await hold.promise;
                  }
                  return { done: true };
                },
              }
            : {},
        );
        const first = await t.submit(1, [{ locks: [node('n-1')] }]);
        const second = await t.submit(2, [{ locks: [node('n-1')] }]);
        const third = await t.submit(3, [{}]);

        const running = t.worker('a').runOnce();
        await until(async () => (await t.store.getSteps(first))[0]?.state === 'running');

        const blocked = await t.worker('b').runOnce();
        assert.deepEqual(blocked, {
          kind: 'waiting',
          runId: second,
          reason: `lock node:n-1 held by ${first}`,
        });
        const waiting = await t.store.getRun(second);
        assert.equal(waiting?.state, 'queued');
        assert.equal(waiting.waiting, `lock node:n-1 held by ${first}`);
        assert.deepEqual(
          (await t.store.getSteps(second)).map((s) => s.state),
          ['pending'],
        );

        // The run that waits is the oldest queued one, and still the run behind it gets its turn.
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: third });
        assert.equal(await t.worker('b').runOnce(), null);

        hold.open();
        assert.deepEqual(await running, { kind: 'succeeded', runId: first });
        // Its time has not come yet; when it does, the run goes.
        assert.equal(await t.worker('b').runOnce(), null);
        t.clock.advance(BACKOFF);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: second });
        assert.deepEqual(await t.store.listLocks(), []);
      });
    });

    describe('a step that cannot go on now, and a step that fails', () => {
      it('waits when the vault is sealed, and goes on when it is not, with nothing lost', async () => {
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                apply: (ctx: StepContext<null>) => {
                  if (t.world.sealed) {
                    return Promise.reject(new StepDeferredError('vault_sealed'));
                  }
                  t.world.effects.add(ctx.remoteId);
                  return Promise.resolve({ opened: true });
                },
              }
            : {},
        );
        t.world.sealed = true;
        const id = await t.submit(1);
        assert.deepEqual(await t.worker('a').runOnce(), {
          kind: 'waiting',
          runId: id,
          reason: 'vault_sealed',
        });
        const waiting = await t.store.getRun(id);
        assert.equal(waiting?.state, 'queued');
        assert.equal(waiting.waiting, 'vault_sealed');
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'pending', 'pending'],
        );
        assert.equal(await t.worker('a').runOnce(), null);

        t.world.sealed = false;
        t.clock.advance(BACKOFF);
        assert.deepEqual(await t.worker('a').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal((await t.store.getSteps(id))[1]?.attempt, 2);
        assert.equal(callsOf(t.world, id, 0), 1);
      });

      it('waits twice as long after each deferral, up to eight times the backoff', async () => {
        const t = await setup([{}, {}], (index) =>
          index === 0 ? { apply: () => Promise.reject(new StepDeferredError('vault_sealed')) } : {},
        );
        const id = await t.submit(1);
        const waits: number[] = [];
        for (let round = 0; round < 6; round += 1) {
          t.clock.advance(1);
          assert.equal((await t.worker('a').runOnce())?.kind, 'waiting');
          const run = await t.store.getRun(id);
          waits.push((run?.retryAfter ?? 0) - t.clock.now());
          t.clock.advance(waits[round] ?? 0);
        }
        assert.deepEqual(
          waits,
          [1, 2, 4, 8, 8, 8].map((n) => n * BACKOFF),
        );
        // Every start counted as an attempt, the deferred ones too: the number says how many times the step was asked.
        assert.equal((await t.store.getSteps(id))[0]?.attempt, 6);
      });

      it('fails the run with the code of the step, releases the locks, and goes on after a retry', async () => {
        let broken = true;
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                apply: () =>
                  broken
                    ? Promise.reject(
                        new StepFailure('host_unreachable', 'The host did not answer.'),
                      )
                    : Promise.resolve({ fixed: true }),
              }
            : {},
        );
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}, {}]);
        assert.deepEqual(await t.worker('a').runOnce(), { kind: 'failed', runId: id });
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'failed');
        assert.equal(run.workerId, null);
        assert.deepEqual(await t.store.listLocks(), []);
        const steps = await t.store.getSteps(id);
        assert.deepEqual(
          steps.map((s) => s.state),
          ['succeeded', 'failed', 'pending'],
        );
        assert.equal(steps[1]?.errorCode, 'host_unreachable');
        assert.equal(steps[1].errorMessage, 'The host did not answer.');
        assert.equal(await t.worker('a').runOnce(), null);

        broken = false;
        await t.store.applyEvent(id, 'retry', { now: t.clock.now(), actor: 'person-1' });
        assert.deepEqual(await t.worker('a').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal((await t.store.getSteps(id))[1]?.attempt, 2);
        assert.equal(callsOf(t.world, id, 0), 1, 'the step that was done is not done again');
      });

      it('gives an error that is not a StepFailure the code of the phase it happened in', async () => {
        const cases: [string, Partial<TestStep>][] = [
          ['step_error', { apply: () => Promise.reject(new Error('boom')) }],
          [
            'output_invalid',
            {
              output: {
                parse: () => {
                  throw new TypeError('wrong shape');
                },
              },
            },
          ],
          ['verify_failed', { verify: () => Promise.reject(new Error('not as expected')) }],
          ['undo_failed', { undo: () => Promise.reject(new Error('cannot say how to undo')) }],
        ];
        for (const [code, over] of cases) {
          const t = await setup([{}], () => over);
          const id = await t.submit(1);
          assert.equal((await t.worker('a').runOnce())?.kind, 'failed', code);
          assert.equal((await t.store.getSteps(id))[0]?.errorCode, code);
        }
      });

      it('refuses an output that is not JSON and a step that is not registered', async () => {
        const t = await setup([{}], () => ({
          apply: () => Promise.resolve(Number.NaN as unknown as JsonValue),
        }));
        const id = await t.submit(1);
        assert.equal((await t.worker('a').runOnce())?.kind, 'failed');
        assert.equal((await t.store.getSteps(id))[0]?.errorCode, 'output_invalid');

        const u = await setup([{}]);
        const run = await u.store.createRun({
          id: runId(5),
          plan: plan([{ key: 'nobody.knows' }]),
          risk: 'low',
          requestedBy: null,
          now: u.clock.now(),
        });
        await u.store.applyEvent(run.id, 'queue', { now: u.clock.now() });
        assert.equal((await u.worker('a').runOnce())?.kind, 'failed');
        assert.equal((await u.store.getRun(run.id))?.state, 'failed');
        const failed = (await u.store.listEvents(run.id, 0, 50)).at(-1);
        assert.deepEqual(failed?.data, {
          from: 'running',
          to: 'failed',
          data: { code: 'step_unknown', message: 'No step "nobody.knows" is registered.' },
          waiting: null,
        });
      });
    });

    describe('what people ask of a run that is going', () => {
      it('a pause waits for the step in hand, ends the run in `paused`, and a resume goes on from the next step', async () => {
        const hold = gate();
        const t = await setup(undefined, (index) =>
          index === 0
            ? {
                apply: async (ctx: StepContext<null>) => {
                  t.world.effects.add(ctx.remoteId);
                  await hold.promise;
                  return { first: true };
                },
              }
            : {},
        );
        const id = await t.submit(1);
        const running = t.worker('a').runOnce();
        // The step is inside `apply` (it records its effect first thing): a pause that comes before that would stop the run before
        // the effect, which is another scenario.
        await until(() => Promise.resolve(t.world.effects.has(`${id}-0`)));
        await t.store.requestPause(id, t.clock.now());
        hold.open();
        assert.deepEqual(await running, { kind: 'paused', runId: id });
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'pending', 'pending'],
        );
        const paused = await t.store.getRun(id);
        assert.equal(paused?.state, 'paused');
        assert.equal(paused.pauseRequestedAt, null);
        assert.equal(await t.worker('a').runOnce(), null);

        await t.store.applyEvent(id, 'resume', { now: t.clock.now(), actor: 'person-1' });
        assert.deepEqual(await t.worker('a').runOnce(), { kind: 'succeeded', runId: id });
        // The first step was applied once (it did not go through the counting `apply`), the rest after the resume.
        assert.deepEqual(
          [0, 1, 2].map((i) => t.world.effects.has(`${id}-${String(i)}`)),
          [true, true, true],
        );
        assert.deepEqual(
          [1, 2].map((i) => callsOf(t.world, id, i)),
          [1, 1],
        );
      });

      it('a cancel reaches the step through its signal, and the run ends in `cancelled`', async () => {
        const started = gate();
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                apply: async (ctx: StepContext<null>) => {
                  started.open();
                  await new Promise<never>((_, reject) => {
                    ctx.signal.addEventListener(
                      'abort',
                      () => {
                        reject(new Error('aborted'));
                      },
                      { once: true },
                    );
                  });
                  return null;
                },
              }
            : {},
        );
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}, {}]);
        const running = t.worker('a', { heartbeat: true, renewIntervalMs: 10 }).runOnce();
        await started.promise;
        await t.store.requestCancel(id, t.clock.now());
        assert.deepEqual(await running, { kind: 'cancelled', runId: id });
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'cancelled');
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'failed', 'pending'],
        );
        assert.deepEqual(await t.store.listLocks(), []);
        // What was done can be rolled back, as the table says.
        assert.equal(
          (await t.store.applyEvent(id, 'request_rollback', { now: t.clock.now() })).state,
          'rollback_requested',
        );
      });

      it('a cancel is honoured between steps when no step is running', async () => {
        const t = await setup();
        const id = await t.submit(1);
        t.clock.advance(1);
        const worker = t.worker('a', {
          crash: async (point, info) => {
            if (point === 'after_checkpoint' && info.stepIndex === 0) {
              await t.store.requestCancel(id, t.clock.now());
            }
          },
        });
        assert.deepEqual(await worker.runOnce(), { kind: 'cancelled', runId: id });
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'pending', 'pending'],
        );
      });
    });

    describe('a worker that is told to stop', () => {
      it('aborts the step in hand with a ShutdownError, writes nothing, and leaves the run to its lease', async () => {
        const started = gate();
        const reasons: unknown[] = [];
        const attempts: number[] = [];
        const t = await setup([{}, {}], (index) =>
          index === 0
            ? {
                apply: async (ctx: StepContext<null>) => {
                  attempts.push(ctx.attempt);
                  if (ctx.attempt === 1) {
                    started.open();
                    await new Promise<never>((_, reject) => {
                      ctx.signal.addEventListener(
                        'abort',
                        () => {
                          reasons.push(ctx.signal.reason);
                          reject(new Error('the step gave up'));
                        },
                        { once: true },
                      );
                    });
                  }
                  return { attempt: ctx.attempt };
                },
              }
            : {},
        );
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}]);
        t.clock.advance(1);
        const a = t.worker('a');
        const running = a.runOnce();
        await started.promise;
        await a.stop();

        assert.deepEqual(await running, { kind: 'stopped', runId: id });
        assert.ok(reasons[0] instanceof ShutdownError);
        // Nothing was written: the step is `running`, the run holds its lease and its locks, no failure is on record.
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['running', 'pending'],
        );
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'running');
        assert.equal(run.workerId, 'a');
        assert.equal((await t.store.listLocks()).length, 1);
        const seen = await types(t.store, id);
        assert.ok(!seen.includes('step.fail') && !seen.includes('run.fail'));

        // The lease runs out, another worker takes the run over, and the step is started again (idempotent) with attempt 2.
        t.clock.advance(LEASE + 1);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.deepEqual(attempts, [1, 2]);
      });

      it('hands the run back at the boundary of a step that finished anyway: queued, locks released, no waiting for the lease', async () => {
        const started = gate();
        const finish = gate();
        const t = await setup([{}, {}, {}], (index) =>
          index === 0
            ? {
                apply: async () => {
                  started.open();
                  await finish.promise;
                  return { done: 0 };
                },
              }
            : {},
        );
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}, {}]);
        t.clock.advance(1);
        const a = t.worker('a');
        const running = a.runOnce();
        await started.promise;
        const stopping = a.stop();
        finish.open();
        await stopping;

        assert.deepEqual(await running, { kind: 'stopped', runId: id });
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'queued');
        assert.equal(run.waiting, 'worker_stopped');
        assert.equal(run.workerId, null);
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['succeeded', 'pending', 'pending'],
        );
        assert.deepEqual(await t.store.listLocks(), []);

        // Another worker goes on at once, and the step that was done is not done again.
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.deepEqual(
          [0, 1, 2].map((i) => callsOf(t.world, id, i)),
          [0, 1, 1],
        );
      });

      it('gives up on a step that ignores the signal when the timeout is over: the halted worker calls no verify or undo and writes nothing more', async () => {
        const started = gate();
        const never = gate();
        const errors: unknown[] = [];
        const touched: string[] = [];
        const t = await setup([{}, {}], (index) =>
          index === 0
            ? {
                apply: async () => {
                  started.open();
                  await never.promise;
                  return { late: true };
                },
                verify: () => {
                  touched.push('verify');
                  return Promise.resolve();
                },
                undo: () => {
                  touched.push('undo');
                  return Promise.resolve([]);
                },
              }
            : {},
        );
        const id = await t.submit(1);
        t.clock.advance(1);
        const a = t.worker('a', { onError: (error) => errors.push(error) });
        const running = a.runOnce();
        await started.promise;
        await a.stop({ timeoutMs: 20 });

        // `stop` came back while the step is still in hand. When the step returns, the worker is halted: its ports are not
        // touched again (`verify` and `undo` may use what the application closes), and nothing is written.
        never.open();
        assert.deepEqual(await running, { kind: 'stopped', runId: id });
        assert.deepEqual(touched, []);
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['running', 'pending'],
        );
        assert.ok(!(await types(t.store, id)).includes('step.succeed'));
        assert.deepEqual(errors, []);
        assert.throws(() => {
          a.start();
        }, /halted/u);
      });

      it('waits, after the timeout, for a store call that was already on its way, and then refuses every new one', async () => {
        const t = await setup([{}, {}]);
        const id = await t.submit(1);
        t.clock.advance(1);
        const writing = held(t.store, 'checkpointStep');
        const errors: unknown[] = [];
        const a = t.worker('a', { store: writing.store, onError: (error) => errors.push(error) });
        const running = a.runOnce();
        const refused = assert.rejects(running, /halted/u);
        await writing.entered;

        // The step is done and its checkpoint is being written. The timeout runs out first (the worker is halted), and the
        // write lands while `stop` is still waiting for it: it is not left to land after the caller closed the database.
        const stopping = a.stop({ timeoutMs: 80 });
        setTimeout(writing.release, 120);
        await stopping;
        assert.equal((await t.store.getSteps(id))[0]?.state, 'succeeded');
        await refused;
        assert.deepEqual(errors, []);
      });

      it('does not wait for ever for a store call that does not come back: the second wait is bounded', async () => {
        const t = await setup([{}, {}]);
        await t.submit(1);
        t.clock.advance(1);
        const writing = held(t.store, 'checkpointStep');
        const a = t.worker('a', { store: writing.store });
        const refused = assert.rejects(a.runOnce(), /halted/u);
        await writing.entered;

        const began = Date.now();
        await a.stop({ timeoutMs: 20 });
        assert.ok(Date.now() - began < 1_500, 'stop came back without the call that never did');
        writing.release();
        await refused;
      });

      it('claims nothing after it was told to stop, and works again after `start`', async () => {
        const t = await setup([{}]);
        const a = t.worker('a', { pollMs: 5 });
        await a.stop();
        const id = await t.submit(1);
        assert.equal(await a.runOnce(), null);
        assert.equal((await t.store.getRun(id))?.state, 'queued');

        a.start();
        await until(async () => (await t.store.getRun(id))?.state === 'succeeded');
        await a.stop();
      });

      it('starts no step when it is told to stop while it is still reading the run', async () => {
        const t = await setup([{}, {}]);
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}]);
        t.clock.advance(1);
        const reading = held(t.store, 'getSteps');
        const a = t.worker('a', { store: reading.store });
        const running = a.runOnce();
        await reading.entered;
        const stopping = a.stop();
        reading.release();
        await stopping;

        assert.deepEqual(await running, { kind: 'stopped', runId: id });
        assert.equal(callsOf(t.world, id, 0), 0);
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['pending', 'pending'],
        );
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'queued');
        assert.equal(run.waiting, 'worker_stopped');
        assert.deepEqual(await t.store.listLocks(), []);

        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.deepEqual(t.world.order, ['test.step-0#1', 'test.step-1#1']);
      });

      it('does not call `apply` when it is told to stop while the start of the step is being written', async () => {
        const t = await setup([{}, {}]);
        const id = await t.submit(1, [{ locks: [server('s-1')] }, {}]);
        t.clock.advance(1);
        const beginning = held(t.store, 'beginStep');
        const a = t.worker('a', { store: beginning.store });
        const running = a.runOnce();
        await beginning.entered;
        const stopping = a.stop();
        beginning.release();
        await stopping;

        // The start of the step is on record, the step itself never ran, so it goes back to `pending` (a step that cannot be
        // repeated is not mistaken for one that a crash left half done) and the run is back in the queue at once.
        assert.deepEqual(await running, { kind: 'stopped', runId: id });
        assert.equal(callsOf(t.world, id, 0), 0);
        assert.deepEqual(
          (await t.store.getSteps(id)).map((s) => s.state),
          ['pending', 'pending'],
        );
        const run = await t.store.getRun(id);
        assert.equal(run?.state, 'queued');
        assert.equal(run.waiting, 'worker_stopped');
        assert.deepEqual(await t.store.listLocks(), []);

        // Another worker starts it as the second attempt, the first having been counted.
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.deepEqual(t.world.order, ['test.step-0#2', 'test.step-1#1']);
      });
    });

    describe('what the full review of the loop found', () => {
      it('leaves a run that asked for a rollback alone: the steps of the workflow are not run forward', async () => {
        const t = await setup([{}, {}]);
        const id = await t.submit(1);
        await t.store.applyEvent(id, 'cancel', { now: t.clock.now() });
        await t.store.applyEvent(id, 'request_rollback', { now: t.clock.now() });
        t.clock.advance(10 * LEASE);
        assert.equal(await t.worker('a').runOnce(), null);
        assert.equal(t.world.calls.size, 0);
        assert.equal((await t.store.getRun(id))?.state, 'rollback_requested');
      });

      it('aborts the step of a worker whose lock went to another run, and writes nothing about that step', async () => {
        const started = gate();
        const hold = gate();
        const reasons: unknown[] = [];
        const stalled = runId(2);
        const t = await setup([{}], () => ({
          apply: async (ctx: StepContext<null>) => {
            if (ctx.runId !== stalled) {
              return { rival: true };
            }
            started.open();
            await new Promise<never>((_, reject) => {
              ctx.signal.addEventListener(
                'abort',
                () => {
                  reasons.push(ctx.signal.reason);
                  reject(new Error('the step gave up'));
                },
                { once: true },
              );
            });
            return null;
          },
        }));
        t.clock.advance(4_000);
        await t.submit(2, [{ locks: [server('s-1')] }]);
        // The renewals of the stalled worker are held back, as if it did not run for a while.
        let frozen = false;
        const renewals = new Proxy(t.store, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== 'function') {
              return value;
            }
            const bound = (value as (...args: unknown[]) => unknown).bind(target);
            if (property !== 'renewLease') {
              return bound;
            }
            return async (...args: unknown[]): Promise<unknown> => {
              if (frozen) {
                await hold.promise;
              }
              return bound(...args);
            };
          },
        });
        const a = t.worker('a', { store: renewals, heartbeat: true, renewIntervalMs: 20 });
        const running = a.runOnce();
        await started.promise;
        frozen = true;

        // An older run wants the same server; the lock of the stalled run ran out, so the older run takes it, does its step and
        // lets go of it.
        const rival = runId(1);
        await t.store.createRun({
          id: rival,
          plan: plan([{ locks: [server('s-1')] }]),
          risk: 'low',
          requestedBy: null,
          now: t.clock.now() - 3_000,
        });
        await t.store.applyEvent(rival, 'queue', { now: t.clock.now() });
        t.clock.advance(10_000);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: rival });

        // The stalled worker wakes up: its next renewal finds the lock gone, the step is aborted at once with that reason, and
        // the run is given up. Nothing about the step is written (it is for whoever takes the run to find it running).
        hold.open();
        assert.equal((await running)?.kind, 'lost');
        assert.ok(reasons[0] instanceof LockLostError);
        assert.equal((await t.store.getSteps(stalled))[0]?.state, 'running');
        assert.ok(!(await types(t.store, stalled)).includes('step.fail'));
      });

      it('does not apply a step after a cancel that came while its reconcile was looking', async () => {
        let cancel: () => Promise<void> = () => Promise.resolve();
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                idempotent: false,
                reconcile: async () => {
                  await cancel();
                  return { status: 'not_done' } as const;
                },
              }
            : {},
        );
        const id = await t.submit(1);
        cancel = async () => {
          await t.store.requestCancel(id, t.clock.now());
        };
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_intent', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'cancelled', runId: id });
        assert.equal(callsOf(t.world, id, 1), 0);
        // The reconcile said that nothing was done, so the step goes back to `pending` and not to `running`.
        assert.deepEqual(
          (await t.store.getSteps(id)).map((step) => step.state),
          ['succeeded', 'pending', 'pending'],
        );
      });

      it('pauses, before its effect, a run whose person asked for a pause while the intent of the step was being written', async () => {
        const t = await setup();
        const id = await t.submit(1);
        const a = t.worker('a', {
          crash: async (point, info) => {
            if (point === 'after_intent' && info.stepIndex === 1) {
              await t.store.requestPause(id, t.clock.now());
            }
          },
        });
        assert.deepEqual(await a.runOnce(), { kind: 'paused', runId: id });
        assert.equal(callsOf(t.world, id, 1), 0);
        assert.deepEqual(
          (await t.store.getSteps(id)).map((step) => step.state),
          ['succeeded', 'pending', 'pending'],
        );
        await t.store.applyEvent(id, 'resume', { now: t.clock.now() });
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(callsOf(t.world, id, 1), 1);
      });

      it('honours a cancel that was asked for before the run was claimed again, whatever the locks say', async () => {
        const t = await setup([{}]);
        const id = await t.submit(1, [{ locks: [server('s-1')] }]);
        await assert.rejects(
          t
            .worker('a', {
              crash: async (point) => {
                if (point === 'after_claim') {
                  await t.store.requestCancel(id, t.clock.now());
                  throw new WorkerCrash(point);
                }
              },
            })
            .runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'cancelled', runId: id });
        assert.equal(callsOf(t.world, id, 0), 0);
        assert.ok(!(await types(t.store, id)).includes('locks.acquired'));
      });

      describe('the output of a step is checked once', () => {
        // The schema adds one to what it is given: parsed twice, the value would be 3.
        const counting: Schema<JsonValue> = {
          parse: (input) => ({ n: (input as { n: number }).n + 1 }),
        };

        it('gives the checkpoint, `verify` and `undo` the same value, after `apply`', async () => {
          const seen: JsonValue[] = [];
          const t = await setup([{}], () => ({
            output: counting,
            apply: () => Promise.resolve({ n: 1 }),
            verify: (_: StepContext<null>, output: JsonValue) => {
              seen.push(output);
              return Promise.resolve();
            },
            undo: (_: StepContext<null>, output: JsonValue) => {
              seen.push(output);
              return Promise.resolve([{ kind: 'undo.n', data: output }]);
            },
          }));
          const id = await t.submit(1);
          assert.deepEqual(await t.worker('a').runOnce(), { kind: 'succeeded', runId: id });
          assert.deepEqual((await t.store.getSteps(id))[0]?.output, { n: 2 });
          assert.deepEqual(seen, [{ n: 2 }, { n: 2 }]);
          assert.deepEqual((await t.store.getUndoRecords(id))[0]?.data, { n: 2 });
        });

        it('and after what the reconcile found', async () => {
          const seen: JsonValue[] = [];
          const t = await setup(undefined, (index) =>
            index === 1
              ? {
                  idempotent: false,
                  output: counting,
                  apply: () => Promise.resolve({ n: 1 }),
                  reconcile: () => Promise.resolve({ status: 'done', output: { n: 1 } } as const),
                  verify: (_: StepContext<null>, output: JsonValue) => {
                    seen.push(output);
                    return Promise.resolve();
                  },
                  undo: (_: StepContext<null>, output: JsonValue) => {
                    seen.push(output);
                    return Promise.resolve([{ kind: 'undo.n', data: output }]);
                  },
                }
              : {},
          );
          const id = await t.submit(1);
          await assert.rejects(
            t.worker('a', { crash: dieAt('after_apply', 1) }).runOnce(),
            WorkerCrash,
          );
          t.clock.advance(LEASE);
          assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
          assert.deepEqual((await t.store.getSteps(id))[1]?.output, { n: 2 });
          // `apply` of the first run did it with `{ n: 1 }`, which the schema made `{ n: 2 }` for verify and undo too (twice, then once more).
          assert.ok(seen.every((value) => (value as { n: number }).n === 2));
          assert.ok(seen.length >= 2);
          assert.ok(
            (await t.store.getUndoRecords(id)).every((r) => (r.data as { n: number }).n === 2),
          );
        });
      });

      describe('what no store can keep fails the step, and is not repeated for ever', () => {
        it('an output with a NUL in a text', async () => {
          const t = await setup([{}], () => ({
            apply: () => Promise.resolve({ text: 'a\u0000b' }),
          }));
          const id = await t.submit(1);
          assert.deepEqual(await t.worker('a').runOnce(), { kind: 'failed', runId: id });
          const failed = (await t.store.getSteps(id))[0];
          assert.equal(failed?.state, 'failed');
          assert.equal(failed.errorCode, 'output_invalid');
        });

        it('an undo record whose kind is longer than its column', async () => {
          const t = await setup([{}], () => ({
            undo: () => Promise.resolve([{ kind: 'k'.repeat(81), data: null }]),
          }));
          const id = await t.submit(1);
          assert.deepEqual(await t.worker('a').runOnce(), { kind: 'failed', runId: id });
          assert.equal((await t.store.getSteps(id))[0]?.errorCode, 'undo_invalid');
          assert.deepEqual(await t.store.getUndoRecords(id), []);
        });

        it('a failure whose code is longer than its column keeps the failure and not the code', async () => {
          const t = await setup([{}], () => ({
            apply: () =>
              Promise.reject(new StepFailure('c'.repeat(100), 'a message\u0000with a NUL')),
          }));
          const id = await t.submit(1);
          assert.deepEqual(await t.worker('a').runOnce(), { kind: 'failed', runId: id });
          const failed = (await t.store.getSteps(id))[0];
          assert.equal(failed?.errorCode, 'step_error');
          assert.equal(failed.errorMessage, 'a messagewith a NUL');
        });

        it('a reason to wait that is longer than its column is cut, not refused', async () => {
          const t = await setup([{}], () => ({
            apply: () => Promise.reject(new StepDeferredError('r'.repeat(400))),
          }));
          const id = await t.submit(1);
          const outcome = await t.worker('a').runOnce();
          assert.equal(outcome?.kind, 'waiting');
          assert.equal((await t.store.getRun(id))?.waiting, 'r'.repeat(300));
        });
      });

      it('does not apply a step whose run another worker took over while the first was parked after its intent', async () => {
        const parked = gate();
        const release = gate();
        const t = await setup(undefined, (index) =>
          index === 1
            ? {
                idempotent: false,
                reconcile: () => Promise.resolve({ status: 'not_done' } as const),
              }
            : {},
        );
        const id = await t.submit(1);
        const a = t.worker('a', {
          crash: async (point, info) => {
            if (point === 'after_intent' && info.stepIndex === 1) {
              parked.open();
              await release.promise;
            }
          },
        });
        const running = a.runOnce();
        await parked.promise;
        t.clock.advance(LEASE);
        // The second worker finds the begun step, reconciles (nothing was done) and does it.
        assert.deepEqual(await t.worker('b').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal(callsOf(t.world, id, 1), 1);
        // The first one wakes up: the renewal before its effect is refused, and the step is not done a second time.
        release.open();
        const parkedOutcome = await running;
        assert.equal(parkedOutcome?.kind, 'lost');
        assert.equal(callsOf(t.world, id, 1), 1);
      });

      it('does not turn a retry into a cancel: a request that came too late for a failed step is gone with the run', async () => {
        let cancel: () => Promise<void> = () => Promise.resolve();
        let failing = true;
        const t = await setup([{}], () => ({
          apply: async () => {
            if (failing) {
              failing = false;
              await cancel();
              throw new StepFailure('host_unreachable', 'no route');
            }
            return { ok: true };
          },
        }));
        const id = await t.submit(1);
        cancel = async () => {
          await t.store.requestCancel(id, t.clock.now());
        };
        assert.deepEqual(await t.worker('a').runOnce(), { kind: 'failed', runId: id });
        assert.equal((await t.store.getRun(id))?.cancelRequestedAt, null);
        await t.store.applyEvent(id, 'retry', { now: t.clock.now() });
        assert.deepEqual(await t.worker('a').runOnce(), { kind: 'succeeded', runId: id });
      });

      it('leaves a run that waits for a sealed vault to a worker whose vault is open', async () => {
        let sealed = true;
        const t = await setup([{}], () => ({
          apply: () =>
            sealed
              ? Promise.reject(new StepDeferredError('vault_sealed'))
              : Promise.resolve({ ok: true }),
        }));
        const id = await t.submit(1);
        assert.deepEqual(await t.worker('open').runOnce(), {
          kind: 'waiting',
          runId: id,
          reason: 'vault_sealed',
        });
        t.clock.advance(8 * BACKOFF + 1);
        // The worker whose vault is sealed polls first, as often as it likes, and takes nothing: the run is not written to again.
        const closed = t.worker('closed', { skipWaiting: () => ['vault_sealed'] });
        for (let poll = 0; poll < 3; poll += 1) {
          assert.equal(await closed.runOnce(), null);
        }
        sealed = false;
        assert.deepEqual(await t.worker('open').runOnce(), { kind: 'succeeded', runId: id });
        assert.equal((await types(t.store, id)).filter((type) => type === 'run.claim').length, 2);
      });

      it('carries out a cancel that was accepted while the step was deferring for the vault, even on a worker whose vault is sealed', async () => {
        let cancel: () => Promise<void> = () => Promise.resolve();
        const t = await setup([{}], () => ({
          apply: async () => {
            await cancel();
            throw new StepDeferredError('vault_sealed');
          },
        }));
        const id = await t.submit(1);
        cancel = async () => {
          await t.store.requestCancel(id, t.clock.now());
        };
        assert.deepEqual(await t.worker('open').runOnce(), {
          kind: 'waiting',
          runId: id,
          reason: 'vault_sealed',
        });
        t.clock.advance(8 * BACKOFF + 1);
        // Nobody's vault is open, and the person is still waiting for the cancel that was accepted.
        const closed = t.worker('closed', { skipWaiting: () => ['vault_sealed'] });
        assert.deepEqual(await closed.runOnce(), { kind: 'cancelled', runId: id });
        assert.equal((await t.store.getRun(id))?.state, 'cancelled');
      });

      it('cancels a run whose person asked for a cancel after the worker had read only a pause', async () => {
        const t = await setup();
        const id = await t.submit(1);
        let armed = true;
        const racing = new Proxy(t.store, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== 'function') {
              return value;
            }
            const bound = (value as (...args: unknown[]) => unknown).bind(target);
            if (property !== 'renewLease') {
              return bound;
            }
            return async (...args: unknown[]): Promise<unknown> => {
              const run = await bound(...args);
              if (armed) {
                // The renewal has answered with the pause; the cancel comes after it.
                armed = false;
                await t.store.requestCancel(id, t.clock.now());
              }
              return run;
            };
          },
        });
        const worker = t.worker('a', {
          store: racing,
          crash: async (point) => {
            if (point === 'after_locks') {
              await t.store.requestPause(id, t.clock.now());
            }
          },
        });
        assert.deepEqual(await worker.runOnce(), { kind: 'cancelled', runId: id });
        assert.equal((await t.store.getRun(id))?.state, 'cancelled');
        assert.equal(await t.worker('b').runOnce(), null);
        assert.equal(callsOf(t.world, id, 0), 0);
      });

      it('cancels, and does not park, a run whose person asked for a cancel just before the step asked for a person', async () => {
        const t = await setup(undefined, (index) => (index === 1 ? { idempotent: false } : {}));
        const id = await t.submit(1);
        await assert.rejects(
          t.worker('a', { crash: dieAt('after_intent', 1) }).runOnce(),
          WorkerCrash,
        );
        t.clock.advance(LEASE);
        // The cancel arrives after the worker read the run and before the step that cannot be repeated asks for a person.
        let armed = true;
        const racing = new Proxy(t.store, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== 'function') {
              return value;
            }
            const bound = (value as (...args: unknown[]) => unknown).bind(target);
            if (property !== 'getSteps') {
              return bound;
            }
            return async (...args: unknown[]): Promise<unknown> => {
              const steps = await bound(...args);
              if (armed) {
                armed = false;
                await t.store.requestCancel(id, t.clock.now());
              }
              return steps;
            };
          },
        });
        assert.deepEqual(await t.worker('b', { store: racing }).runOnce(), {
          kind: 'cancelled',
          runId: id,
        });
        assert.equal((await t.store.getRun(id))?.state, 'cancelled');
        // The step that was interrupted stays as it was: it is on record for whoever looks at the run.
        assert.equal((await t.store.getSteps(id))[1]?.state, 'running');
        assert.equal(callsOf(t.world, id, 1), 0);
      });

      it('makes a run that waits for a lock wait longer each time, up to eight times the backoff', async () => {
        const t = await setup([{}]);
        const holder = await t.submit(1, [{ locks: [server('s-1')] }]);
        const kept = await t.store.claimNext({
          workerId: 'holder',
          now: t.clock.now(),
          leaseMs: 1000 * LEASE,
        });
        assert.equal(kept?.claim.runId, holder);
        await t.store.acquireLocks(kept.claim, { now: t.clock.now(), ttlMs: 1000 * LEASE });
        t.clock.advance(1);
        const waiting = await t.submit(2, [{ locks: [server('s-1')] }]);
        const worker = t.worker('w');
        const delays: number[] = [];
        for (let poll = 0; poll < 6; poll += 1) {
          assert.equal((await worker.runOnce())?.kind, 'waiting');
          const delay = ((await t.store.getRun(waiting))?.retryAfter ?? 0) - t.clock.now();
          delays.push(delay);
          t.clock.advance(delay);
        }
        assert.deepEqual(
          delays,
          [1, 2, 4, 8, 8, 8].map((n) => n * BACKOFF),
        );
      });
    });

    describe('the loop in the background', () => {
      it('works through the queued runs and stops when told to', async () => {
        const t = await setup([{}]);
        const a = await t.submit(1);
        const b = await t.submit(2);
        const worker = t.worker('a', { pollMs: 5 });
        worker.start();
        worker.start();
        await until(
          async () =>
            (await t.store.getRun(a))?.state === 'succeeded' &&
            (await t.store.getRun(b))?.state === 'succeeded',
        );
        // A run that arrives later is found by the next poll.
        const c = await t.submit(3);
        await until(async () => (await t.store.getRun(c))?.state === 'succeeded');
        await worker.stop();
        await worker.stop();
        const d = await t.submit(4);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal((await t.store.getRun(d))?.state, 'queued');
      });

      it('reports an error of the store and keeps going', async () => {
        const t = await setup([{}]);
        const errors: unknown[] = [];
        let failures = 1;
        const flaky = new Proxy(t.store, {
          get(target, property, receiver) {
            if (property === 'claimNext' && failures > 0) {
              failures -= 1;
              return () => Promise.reject(new Error('the database is down'));
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
        const id = await t.submit(1);
        const worker = new Worker<null>({
          store: flaky,
          registry: t.registry,
          ports: null,
          workerId: 'a',
          now: t.clock.now,
          renewIntervalMs: RENEW,
          pollMs: 5,
          heartbeat: false,
          onError: (error) => errors.push(error),
        });
        worker.start();
        await until(async () => (await t.store.getRun(id))?.state === 'succeeded');
        await worker.stop();
        assert.equal(errors.length, 1);
        assert.match((errors[0] as Error).message, /database is down/u);
      });
    });
  });
}
