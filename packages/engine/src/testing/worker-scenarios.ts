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
import type { RunStore } from '../store.js';
import { CRASH_POINTS, Worker, WorkerCrash, type CrashPoint } from '../worker.js';
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
async function until(condition: () => Promise<boolean>, ms = 2_000): Promise<void> {
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
        await until(async () => (await t.store.getSteps(id))[1]?.state === 'running');

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
        await until(async () => (await t.store.getSteps(id))[0]?.state === 'running');
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
