// The loop: it takes a run, locks what the run changes, and does the steps one after another with a checkpoint after each
// (ADR 0048). It knows nothing about a database or a server: everything it touches is the `RunStore` and the ports of the
// steps, so the same loop is tested on the store in memory and runs on the one over PostgreSQL.
//
// What it promises, and what the tests hold it to:
//   - a worker that dies at any point leaves rows from which another worker goes on, and every effect is done once;
//   - a worker whose run was taken by another (the lease ran out and a claim came) cannot write anything, and stops;
//   - a step that cannot be repeated is never repeated by itself;
//   - a run that cannot get its locks, or whose step cannot go on yet, waits and does not fail.

import { leaseTtlMs } from './lease.js';
import {
  MAX_ERROR_CODE,
  MAX_ERROR_MESSAGE,
  MAX_UNDO_KIND,
  MAX_WAITING,
  assertIdentifier,
  cleanText,
  isIdentifier,
  storableJson,
} from './limits.js';
import { canonicalJson, type JsonValue } from './plan.js';
import { afterReconcile, decideRecovery, resumePoint } from './recovery.js';
import type { RegisteredStep, StepRegistry } from './registry.js';
import {
  FenceLostError,
  type Claim,
  type Claimed,
  type FinishEvent,
  type RunStore,
  type StepRecord,
} from './store.js';
import { StepDeferredError, StepFailure, type StepContext, type UndoRecordDraft } from './step.js';

/** Where a test makes the worker die. The names are the points of ADR 0048, "How it is tested". */
export const CRASH_POINTS = [
  'after_claim',
  'after_locks',
  'before_intent',
  'after_intent',
  'after_apply',
  'after_checkpoint',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

/**
 * The process died. It is thrown by a test hook, or by a step that a test makes die in the middle of `apply`; the worker
 * never treats it as the failure of a step and never writes anything after it, as nothing is written by a dead process.
 */
export class WorkerCrash extends Error {
  constructor(readonly point: string) {
    super(`The worker died at ${point}.`);
    this.name = 'WorkerCrash';
  }
}

/**
 * The reason a step's signal is aborted with when the worker is told to stop (the process is closing). A person's cancel
 * aborts the signal with another error: a step that runs something on a server stops that work for a cancel and leaves
 * it running for a shutdown, because the run goes on after another worker takes it over (ADR 0048, "The fourth slice").
 */
export class ShutdownError extends Error {
  constructor() {
    super('The worker is stopping.');
    this.name = 'ShutdownError';
  }
}

/** What the store of a worker that gave up waiting for its step (see `stop`) answers to every call: nothing more is written. */
class HaltedError extends Error {
  constructor() {
    super('The worker was halted: it writes nothing more.');
    this.name = 'HaltedError';
  }
}

/**
 * The store as the worker sees it: once halted, every call is refused, so a step that outlives `stop` cannot start a write.
 * A call that is already on its way cannot be called back (the port has no way to cancel a transaction), so the calls in
 * flight are kept in `inflight` and `stop` waits for them.
 */
function haltable(
  store: RunStore,
  halted: () => boolean,
  inflight: Set<Promise<unknown>>,
): RunStore {
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]): Promise<unknown> => {
        if (halted()) {
          return Promise.reject(new HaltedError());
        }
        const call = Promise.resolve(Reflect.apply(value, target, args) as unknown);
        inflight.add(call);
        const done = (): void => {
          inflight.delete(call);
        };
        call.then(done, done);
        return call;
      };
    },
  });
}

/**
 * How long `stop` waits, at most, for the store calls that were already on their way when it gave up on the step (and so how
 * long it can take beyond its `timeoutMs`). A transaction that is longer than this is left to the database.
 */
export const STOP_DRAIN_MS = 5000;

export interface WorkerOptions<Ports> {
  readonly store: RunStore;
  readonly registry: StepRegistry<Ports>;
  readonly ports: Ports;
  readonly workerId: string;
  /** Milliseconds since the epoch. A test supplies a fake one. */
  readonly now: () => number;
  /** How often the lease is renewed; the lease lasts three times as long. */
  readonly renewIntervalMs: number;
  /** How long a run that waited is left alone before it is claimed again. Default: ten renewal intervals. */
  readonly waitBackoffMs?: number;
  /** How long `start` sleeps when there is nothing to do. Default: the renewal interval. */
  readonly pollMs?: number;
  /** Renew the lease on a timer while a step runs. Default `true`; a test with a fake clock turns it off. */
  readonly heartbeat?: boolean;
  /** Called at each point of `CRASH_POINTS`; whatever it throws ends the worker as a crash would. */
  readonly crash?: (
    point: CrashPoint,
    info: { runId: string; stepIndex: number | null },
  ) => void | Promise<void>;
  /** What happened that the loop cannot handle (the store is down). The run is not failed: its lease runs out. */
  readonly onError?: (error: unknown) => void;
  /**
   * The reasons a run may wait with that this worker can do nothing about now (`vault_sealed` while the vault of this process
   * is sealed). Asked at every poll; a run that waits with one of them is left for a worker that can.
   */
  readonly skipWaiting?: () => readonly string[];
}

export type RunOutcome =
  | { readonly kind: 'succeeded' | 'failed' | 'cancelled' | 'paused'; readonly runId: string }
  | { readonly kind: 'waiting' | 'awaiting_input'; readonly runId: string; readonly reason: string }
  | { readonly kind: 'lost'; readonly runId: string; readonly reason: string }
  /** The worker was told to stop: the run was handed back at a step boundary, or left to its lease in the middle of a step. */
  | { readonly kind: 'stopped'; readonly runId: string };

type StepResult = 'continue' | RunOutcome;

/** Sleeps for `ms`, or until the signal is aborted. Whichever ends it takes away the other, so an idle loop leaks no listener. */
export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** What a step gave, as the JSON that is stored: anything JSON cannot say is an error. */
const toJson = (value: unknown): JsonValue => JSON.parse(canonicalJson(value)) as JsonValue;

export class Worker<Ports> {
  private readonly store: RunStore;
  private readonly registry: StepRegistry<Ports>;
  private readonly ports: Ports;
  private readonly workerId: string;
  private readonly now: () => number;
  private readonly renewIntervalMs: number;
  private readonly leaseMs: number;
  private readonly waitBackoffMs: number;
  private readonly pollMs: number;
  private readonly heartbeatOn: boolean;
  private readonly crashHook: WorkerOptions<Ports>['crash'];
  private readonly onError: (error: unknown) => void;
  private readonly skipWaiting: () => readonly string[];

  private loopDone: Promise<void> | null = null;
  /** Aborted by `stop`: the loop claims nothing more, and the signal of the step in hand is aborted with a `ShutdownError`. */
  private shutdown = new AbortController();
  /** Every `runOnce` in flight, so `stop` waits for the ones a caller started by hand too. */
  private readonly jobs = new Set<Promise<unknown>>();
  /** Every call to the store that has not come back, so that a halted worker can wait for the writes already on their way. */
  private readonly inflight = new Set<Promise<unknown>>();
  private halted = false;

  constructor(options: WorkerOptions<Ports>) {
    this.store = haltable(options.store, () => this.halted, this.inflight);
    this.registry = options.registry;
    this.ports = options.ports;
    this.workerId = options.workerId;
    this.now = options.now;
    this.renewIntervalMs = options.renewIntervalMs;
    this.leaseMs = leaseTtlMs(options.renewIntervalMs);
    this.waitBackoffMs = options.waitBackoffMs ?? options.renewIntervalMs * 10;
    this.pollMs = options.pollMs ?? options.renewIntervalMs;
    this.heartbeatOn = options.heartbeat ?? true;
    this.crashHook = options.crash;
    this.skipWaiting = options.skipWaiting ?? (() => []);
    const report = options.onError ?? (() => undefined);
    // A halted worker's own refusals are not news: the process asked for them.
    this.onError = (error) => {
      if (!(error instanceof HaltedError)) {
        report(error);
      }
    };
  }

  /** Takes the oldest run that can be taken and works on it until it lets go of it. `null` when there is nothing to take. */
  async runOnce(): Promise<RunOutcome | null> {
    if (this.shutdown.signal.aborted) {
      return null;
    }
    const job = this.claimAndExecute();
    this.jobs.add(job);
    try {
      return await job;
    } finally {
      this.jobs.delete(job);
    }
  }

  private async claimAndExecute(): Promise<RunOutcome | null> {
    const claimed = await this.store.claimNext({
      workerId: this.workerId,
      now: this.now(),
      leaseMs: this.leaseMs,
      skipWaiting: this.skipWaiting(),
    });
    if (claimed === null) {
      return null;
    }
    try {
      return await this.execute(claimed);
    } catch (error) {
      if (error instanceof FenceLostError) {
        return { kind: 'lost', runId: claimed.claim.runId, reason: error.message };
      }
      throw error;
    }
  }

  /** Works in the background until `stop`: a run after a run, and a short sleep when there is none. */
  start(): void {
    if (this.halted) {
      throw new Error('A halted worker cannot be started again: make another one.');
    }
    if (this.loopDone !== null) {
      return;
    }
    if (this.shutdown.signal.aborted) {
      this.shutdown = new AbortController();
    }
    this.loopDone = this.loop(this.shutdown.signal);
  }

  /**
   * Tells the worker to stop and waits until it has. It claims nothing more. A step in hand gets its signal aborted with a
   * `ShutdownError` and, if it gives up, leaves its run as it is: the step stays `running` and the lease runs out, which is
   * what a crash leaves and what recovery is for. A step that finishes anyway gets its checkpoint; then the run is handed
   * back (`queued`, waiting `worker_stopped`) at the boundary of the step, where nothing is in flight.
   *
   * With `timeoutMs`, a step that has not given up by then is left behind and the worker is halted: its store refuses
   * every new call and it starts no callback of a step (`verify`, `undo`), so the step cannot touch a port or start a write
   * after the caller closes the database. A call that was already on its way cannot be called back, so `stop` waits for those
   * too, for `STOP_DRAIN_MS` at most (or `timeoutMs` when that is shorter): `stop` takes `timeoutMs + STOP_DRAIN_MS` at the
   * very most, and whoever closes the process (a container's stop grace period) must allow for it. A transaction that takes
   * longer than that is left to the database (closing the pool waits for it). The lease runs out as for a crash.
   */
  async stop(options: { readonly timeoutMs?: number } = {}): Promise<void> {
    this.shutdown.abort(new ShutdownError());
    const finished = Promise.allSettled([...this.jobs, ...(this.loopDone ? [this.loopDone] : [])]);
    if (options.timeoutMs === undefined) {
      await finished;
    } else if (await this.stopTimedOut(finished, options.timeoutMs)) {
      this.halted = true;
      await this.stopTimedOut(
        Promise.allSettled([...this.inflight]),
        Math.min(options.timeoutMs, STOP_DRAIN_MS),
      );
    }
    this.loopDone = null;
  }

  /** Schedules one shutdown deadline; tests can control it without changing the store's timers. */
  protected scheduleStopDeadline(expire: () => void, ms: number): () => void {
    const timer = setTimeout(expire, ms);
    return () => {
      clearTimeout(timer);
    };
  }

  /** Waits for the work for at most `ms`; says whether the time ran out first. */
  private async stopTimedOut(work: Promise<unknown>, ms: number): Promise<boolean> {
    let cancel = (): void => undefined;
    try {
      return await Promise.race([
        work.then(() => false),
        new Promise<boolean>((resolve) => {
          cancel = this.scheduleStopDeadline(() => {
            resolve(true);
          }, ms);
        }),
      ]);
    } finally {
      cancel();
    }
  }

  /**
   * Asked before a callback of a step that was not asked for yet (`verify`, `undo`): a worker that gave up waiting for its step
   * must not let the step reach the ports of an application that is closing. It is the same refusal as the store's.
   */
  private assertLive(): void {
    if (this.halted) {
      throw new HaltedError();
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let outcome: RunOutcome | null = null;
      try {
        outcome = await this.runOnce();
      } catch (error) {
        this.onError(error);
      }
      if (outcome === null || outcome.kind === 'lost') {
        await abortableSleep(this.pollMs, signal);
      }
    }
  }

  /** Asked as a method, not read as a property, so that a stop that came during an `await` is not taken for the old answer. */
  private isStopping(): boolean {
    return this.shutdown.signal.aborted;
  }

  private async crash(point: CrashPoint, runId: string, stepIndex: number | null): Promise<void> {
    await this.crashHook?.(point, { runId, stepIndex });
  }

  private async execute(claimed: Claimed): Promise<RunOutcome> {
    const { claim } = claimed;
    const runId = claim.runId;
    await this.crash('after_claim', runId, null);
    // A request of the people that came while the run waited is honoured before anything is taken: a run that cannot get its
    // locks would otherwise never read it.
    if (claimed.run.cancelRequestedAt !== null) {
      return this.finish(claim, 'cancel', 'cancelled');
    }
    if (claimed.run.pauseRequestedAt !== null) {
      return this.finish(claim, 'pause', 'paused');
    }
    const locks = await this.store.acquireLocks(claim, { now: this.now(), ttlMs: this.leaseMs });
    if (!locks.ok) {
      await this.store.finishRun(claim, 'wait', {
        now: this.now(),
        waiting: locks.reason,
        // Each claim of the run is one more wait here, so the waits grow (up to eight times the backoff): a run that waits an
        // hour for a server is not written to the timeline every fifteen seconds.
        retryAfter: this.now() + this.deferBackoffMs(claim.fence),
      });
      return { kind: 'waiting', runId, reason: locks.reason };
    }
    await this.crash('after_locks', runId, null);
    for (;;) {
      if (this.shutdown.signal.aborted) {
        return this.handBack(claim);
      }
      const run = await this.store.renewLease(claim, { now: this.now(), leaseMs: this.leaseMs });
      if (run.cancelRequestedAt !== null) {
        return this.finish(claim, 'cancel', 'cancelled');
      }
      if (run.pauseRequestedAt !== null) {
        return this.finish(claim, 'pause', 'paused');
      }
      const steps = await this.store.getSteps(runId);
      const point = resumePoint(steps);
      if (point.kind === 'done') {
        return this.finish(claim, 'succeed', 'succeeded');
      }
      const row = steps[point.index];
      if (row === undefined || point.state === 'failed') {
        // A step that failed ends the run in the same transaction of the loop; meeting one here is a state nobody writes.
        return this.failRun(
          claim,
          'engine_state',
          `Step ${String(point.index)} is ${point.state}.`,
        );
      }
      const step = this.registry.get(row.key);
      if (step === undefined) {
        return this.failRun(claim, 'step_unknown', `No step "${row.key}" is registered.`);
      }
      if (this.isStopping()) {
        // Told to stop while the run was being read: nothing is in flight yet, so no step starts and the run goes back.
        return this.handBack(claim);
      }
      const result =
        point.state === 'running'
          ? await this.recover(claim, step, row)
          : await this.runStep(claim, step, row);
      if (result !== 'continue') {
        return result;
      }
    }
  }

  private async finish(
    claim: Claim,
    event: FinishEvent,
    kind: 'succeeded' | 'failed' | 'cancelled' | 'paused',
    data: JsonValue = null,
    failedStep?: { readonly index: number; readonly code: string; readonly message: string },
  ): Promise<RunOutcome> {
    const after = await this.store.finishRun(claim, event, {
      now: this.now(),
      data,
      ...(failedStep === undefined ? {} : { failedStep }),
    });
    // A pause that met a cancel that came meanwhile is a cancel: the store decided, and the outcome says what it did.
    return { kind: after.state === 'cancelled' ? 'cancelled' : kind, runId: claim.runId };
  }

  private async failRun(claim: Claim, code: string, message: string): Promise<RunOutcome> {
    return this.finish(claim, 'fail', 'failed', { code, message });
  }

  /**
   * The worker was told to stop and no step is in flight (the claim is just made, or a checkpoint was just written): the run
   * goes back to the queue at once, with its locks released, so another worker goes on without waiting for the lease.
   */
  private async handBack(claim: Claim): Promise<RunOutcome> {
    await this.store.finishRun(claim, 'wait', {
      now: this.now(),
      waiting: 'worker_stopped',
      retryAfter: this.now(),
    });
    return { kind: 'stopped', runId: claim.runId };
  }

  /**
   * A step was begun and `apply` was not called, and the run goes back to the queue (the worker is told to stop, a person asked to
   * cancel or pause just now): the step goes back to `pending`, so whoever takes the run next starts it and does not mistake it
   * for one that a crash interrupted. Nothing was done on any server, which is what `deferStep` says.
   */
  private async putBack(claim: Claim, index: number, reason: string): Promise<void> {
    await this.store.deferStep(claim, index, { now: this.now(), reason });
  }

  private async askPerson(claim: Claim, row: StepRecord, why: string): Promise<RunOutcome> {
    const reason = `step ${String(row.index)} (${row.key}) ${why}`;
    const after = await this.store.finishRun(claim, 'await_input', {
      now: this.now(),
      waiting: reason,
    });
    // A cancel that was accepted meanwhile is carried out by the store in the same transaction: the run is not parked.
    if (after.state === 'cancelled') {
      return { kind: 'cancelled', runId: claim.runId };
    }
    return { kind: 'awaiting_input', runId: claim.runId, reason };
  }

  /** What a step is given: it is aborted by a person's cancel (the controller of the heartbeat) and by the worker's stop. */
  private context(claim: Claim, row: StepRecord, controller: AbortController): StepContext<Ports> {
    return {
      ports: this.ports,
      signal: AbortSignal.any([controller.signal, this.shutdown.signal]),
      now: this.now,
      runId: claim.runId,
      stepIndex: row.index,
      attempt: row.attempt,
      fence: claim.fence,
      remoteId: row.remoteId,
    };
  }

  /** A step that a crash left `running`: decided from what the step declares, as `decideRecovery` says. */
  private async recover(
    claim: Claim,
    step: RegisteredStep<Ports>,
    row: StepRecord,
  ): Promise<StepResult> {
    const action = decideRecovery(
      { idempotent: step.idempotent, hasReconcile: step.reconcile !== null },
      { personChoseRetry: row.retryApproved },
    );
    if (action === 'ask_person') {
      return this.askPerson(claim, row, 'was interrupted and cannot be repeated by itself');
    }
    if (action === 'rerun' || step.reconcile === null) {
      return this.runStep(claim, step, row);
    }
    const controller = new AbortController();
    const beat = this.heartbeat(claim, controller);
    // What the reconcile found, when the effect is there. It is a record of its own, not a nullable output, because `null` is a
    // valid output of a step and must not be taken for "nothing found" (that would apply a step that cannot be repeated again).
    let found: { readonly output: JsonValue; readonly drafts: readonly UndoRecordDraft[] } | null =
      null;
    let verdict: ReturnType<typeof afterReconcile>;
    let phase = 'reconcile_failed';
    try {
      const ctx = this.context(claim, row, controller);
      const seen = await step.reconcile(ctx, row.input);
      verdict = afterReconcile({ idempotent: step.idempotent }, seen.status);
      if (seen.status === 'done') {
        // The output was checked once, by the registry, and `verify` and `undo` are bound to that value.
        const { checked } = seen;
        phase = 'output_invalid';
        const output = toJson(checked.value);
        // The effect is there; whether it is right is what `verify` says, as after `apply`. A step that deferred in `verify`
        // is found here by the next claim, and it is not recorded before its verification has been done.
        phase = 'verify_failed';
        this.assertLive();
        await checked.verify(ctx);
        phase = 'undo_failed';
        this.assertLive();
        const made = await checked.undo(ctx);
        phase = 'undo_invalid';
        found = { output, drafts: this.storableUndo(made) };
      }
    } catch (error) {
      await beat.stop();
      return this.stepError(claim, row, error, beat, phase);
    }
    await beat.stop();
    beat.throwIfLost();
    if (verdict === 'record_success' && found !== null) {
      await this.store.checkpointStep(claim, row.index, {
        now: this.now(),
        output: found.output,
        undo: found.drafts,
      });
      return 'continue';
    }
    if (verdict === 'ask_person') {
      return this.askPerson(claim, row, 'was interrupted and only partly done');
    }
    return this.runStep(claim, step, row);
  }

  private async runStep(
    claim: Claim,
    step: RegisteredStep<Ports>,
    row: StepRecord,
  ): Promise<StepResult> {
    const { runId } = claim;
    await this.crash('before_intent', runId, row.index);
    if (this.isStopping()) {
      return this.handBack(claim);
    }
    const begun = await this.store.beginStep(claim, row.index, { now: this.now() });
    await this.crash('after_intent', runId, row.index);

    // The last look before the effect. The renewal is a write that the store accepts only from the worker that holds the run and
    // all its locks, so a worker that stalled between the start of the step and here (and whose run another worker took over,
    // found the step `running`, reconciled and did it) learns it now and does not repeat the effect. Not even this is a proof:
    // the worker can stall after it too, and a step that cannot be repeated must also use `ctx.fence` where the target can refuse
    // an old one. The renewal also reads what the people asked for: a cancel or a pause that came while the step was being
    // recorded stops the run before the effect, which a flag read at the top of the loop would miss.
    const live = await this.store.renewLease(claim, { now: this.now(), leaseMs: this.leaseMs });
    if (live.cancelRequestedAt !== null || live.pauseRequestedAt !== null) {
      await this.putBack(claim, row.index, 'run_interrupted');
      return live.cancelRequestedAt !== null
        ? this.finish(claim, 'cancel', 'cancelled')
        : this.finish(claim, 'pause', 'paused');
    }
    if (this.isStopping()) {
      // Told to stop while the start of the step was being written: `apply` was not called, so no effect started. The step
      // goes back to `pending` and the run to the queue.
      await this.putBack(claim, row.index, 'worker_stopped');
      return this.handBack(claim);
    }

    const controller = new AbortController();
    const beat = this.heartbeat(claim, controller);
    const ctx = this.context(claim, begun, controller);
    let output: JsonValue;
    let drafts: readonly UndoRecordDraft[];
    let phase = 'step_error';
    try {
      const raw = await step.apply(ctx, begun.input);
      // The output is checked once, by the schema of the step; what is stored, what `verify` looks at and what `undo` is made
      // from are the same value.
      phase = 'output_invalid';
      const checked = step.check(raw);
      output = toJson(checked.value);
      phase = 'verify_failed';
      this.assertLive();
      await checked.verify(ctx);
      phase = 'undo_failed';
      this.assertLive();
      const made = await checked.undo(ctx);
      phase = 'undo_invalid';
      drafts = this.storableUndo(made);
    } catch (error) {
      await beat.stop();
      return this.stepError(claim, begun, error, beat, phase);
    }
    await beat.stop();
    beat.throwIfLost();

    await this.crash('after_apply', runId, row.index);
    await this.store.checkpointStep(claim, row.index, { now: this.now(), output, undo: drafts });
    await this.crash('after_checkpoint', runId, row.index);
    return 'continue';
  }

  /** What an error from a step means: a crash, a lost run, a wait, or the failure of the step and with it of the run. */
  private async stepError(
    claim: Claim,
    row: StepRecord,
    error: unknown,
    beat: Heartbeat,
    phase: string,
  ): Promise<StepResult> {
    if (error instanceof WorkerCrash) {
      throw error;
    }
    beat.throwIfLost();
    if (error instanceof FenceLostError) {
      throw error;
    }
    if (this.shutdown.signal.aborted && !(error instanceof StepDeferredError)) {
      // The error may be the step giving up because it was asked to: it is not a failure of the step. Nothing is written; the
      // step stays `running` and the lease runs out, as after a crash, and recovery decides what is next.
      return { kind: 'stopped', runId: claim.runId };
    }
    if (error instanceof StepDeferredError) {
      // The reason is a text that the step chose: it is cleaned and cut here, so what the store writes is what the outcome says.
      const reason = cleanText(error.reason, MAX_WAITING);
      // Only an `apply` that waits before it did anything sends its step back to `pending`. A wait that comes later (the
      // reconcile of an interrupted step, `verify` or `undo` after `apply`) means the effect may be there: the step stays
      // `running`, so that whoever takes the run next reconciles or asks a person, and nothing is repeated by a wait.
      if (phase === 'step_error') {
        await this.store.deferStep(claim, row.index, { now: this.now(), reason });
      }
      await this.store.finishRun(claim, 'wait', {
        now: this.now(),
        waiting: reason,
        // A wait from `apply` is counted by the attempts of the step; one from a later phase does not start the step again, so
        // its attempt stands still, and what grows is the fence of the run (one for every claim): the waits get longer too.
        retryAfter:
          this.now() + this.deferBackoffMs(phase === 'step_error' ? row.attempt : claim.fence),
      });
      return { kind: 'waiting', runId: claim.runId, reason };
    }
    // A code that a step chose is kept only when the store can hold it as it is (a cut code would be another code); the message
    // is a diagnostic and is cleaned and cut. The failure of the step and the end of the run are one write, so a worker that
    // dies between them cannot leave a run that is `running` with a `failed` step.
    const code =
      error instanceof StepFailure && isIdentifier(error.code, MAX_ERROR_CODE) ? error.code : phase;
    const message = cleanText(
      error instanceof Error ? error.message : String(error),
      MAX_ERROR_MESSAGE,
    );
    const failedStep = { index: row.index, code, message };
    if (beat.cancelRequested()) {
      return this.finish(claim, 'cancel', 'cancelled', null, failedStep);
    }
    return this.finish(claim, 'fail', 'failed', { index: row.index, code }, failedStep);
  }

  /** The undo records of a step as the stores keep them: the kind checked, the data as JSON. A record that cannot be kept fails the step. */
  private storableUndo(made: readonly UndoRecordDraft[]): readonly UndoRecordDraft[] {
    return made.map((draft) => {
      assertIdentifier('The kind of an undo record', draft.kind, MAX_UNDO_KIND);
      return { kind: draft.kind, data: storableJson('The data of an undo record', draft.data) };
    });
  }

  /**
   * How long a run is left alone after its step deferred (the vault is sealed). `count` says how many times the run has waited
   * here: the attempts of the step for a wait from `apply` (every start counts, a deferred one too), the fence of the run for a
   * wait from the recovery of a step. Each wait is twice the one before, up to eight times the backoff. A vault that stays
   * sealed all night is looked at some thirty times an hour, not some hundreds, and a run that was deferred once is tried
   * again after one backoff.
   */
  private deferBackoffMs(count: number): number {
    return this.waitBackoffMs * Math.min(2 ** Math.max(count - 1, 0), 8);
  }

  /**
   * Renews the lease on a timer while a step runs, so a long step does not lose its run. It reads the flag of the people: a
   * cancel aborts the step's signal; a pause waits for the step to end. A renewal that the store refuses means the run is
   * another worker's: the signal is aborted and the loop stops at the next write.
   */
  private heartbeat(claim: Claim, controller: AbortController): Heartbeat {
    let lost: FenceLostError | null = null;
    let cancelRequested = false;
    let stopped = false;
    let pending: Promise<void> = Promise.resolve();
    const tick = (): void => {
      pending = pending.then(async () => {
        // After a stop the lease is left to run out: renewing it would keep another worker from taking the run over.
        if (stopped || lost !== null || this.shutdown.signal.aborted) {
          return;
        }
        try {
          const run = await this.store.renewLease(claim, {
            now: this.now(),
            leaseMs: this.leaseMs,
          });
          if (run.cancelRequestedAt !== null && !cancelRequested) {
            cancelRequested = true;
            controller.abort(new Error('A person asked to cancel the run.'));
          }
        } catch (error) {
          if (error instanceof FenceLostError) {
            lost = error;
            controller.abort(error);
          } else {
            this.onError(error);
          }
        }
      });
    };
    const timer = this.heartbeatOn ? setInterval(tick, this.renewIntervalMs) : null;
    timer?.unref();
    return {
      async stop(): Promise<void> {
        stopped = true;
        if (timer !== null) {
          clearInterval(timer);
        }
        await pending;
      },
      throwIfLost(): void {
        if (lost !== null) {
          throw lost;
        }
      },
      cancelRequested: () => cancelRequested,
    };
  }
}

interface Heartbeat {
  stop(): Promise<void>;
  throwIfLost(): void;
  cancelRequested(): boolean;
}
