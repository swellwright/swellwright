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
}

export type RunOutcome =
  | { readonly kind: 'succeeded' | 'failed' | 'cancelled' | 'paused'; readonly runId: string }
  | { readonly kind: 'waiting' | 'awaiting_input'; readonly runId: string; readonly reason: string }
  | { readonly kind: 'lost'; readonly runId: string; readonly reason: string };

type StepResult = 'continue' | RunOutcome;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
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

  private loopDone: Promise<void> | null = null;
  private stopping: AbortController | null = null;

  constructor(options: WorkerOptions<Ports>) {
    this.store = options.store;
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
    this.onError = options.onError ?? (() => undefined);
  }

  /** Takes the oldest run that can be taken and works on it until it lets go of it. `null` when there is nothing to take. */
  async runOnce(): Promise<RunOutcome | null> {
    const claimed = await this.store.claimNext({
      workerId: this.workerId,
      now: this.now(),
      leaseMs: this.leaseMs,
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
    if (this.loopDone !== null) {
      return;
    }
    const stopping = new AbortController();
    this.stopping = stopping;
    this.loopDone = this.loop(stopping.signal);
  }

  /** Lets the run in hand finish its step, then stops. */
  async stop(): Promise<void> {
    this.stopping?.abort();
    await this.loopDone;
    this.loopDone = null;
    this.stopping = null;
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
        await sleep(this.pollMs, signal);
      }
    }
  }

  private async crash(point: CrashPoint, runId: string, stepIndex: number | null): Promise<void> {
    await this.crashHook?.(point, { runId, stepIndex });
  }

  private async execute(claimed: Claimed): Promise<RunOutcome> {
    const { claim } = claimed;
    const runId = claim.runId;
    await this.crash('after_claim', runId, null);
    const locks = await this.store.acquireLocks(claim, { now: this.now(), ttlMs: this.leaseMs });
    if (!locks.ok) {
      await this.store.finishRun(claim, 'wait', {
        now: this.now(),
        waiting: locks.reason,
        retryAfter: this.now() + this.waitBackoffMs,
      });
      return { kind: 'waiting', runId, reason: locks.reason };
    }
    await this.crash('after_locks', runId, null);
    for (;;) {
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
  ): Promise<RunOutcome> {
    await this.store.finishRun(claim, event, { now: this.now(), data });
    return { kind, runId: claim.runId };
  }

  private async failRun(claim: Claim, code: string, message: string): Promise<RunOutcome> {
    return this.finish(claim, 'fail', 'failed', { code, message });
  }

  private async askPerson(claim: Claim, row: StepRecord, why: string): Promise<RunOutcome> {
    const reason = `step ${String(row.index)} (${row.key}) ${why}`;
    await this.store.finishRun(claim, 'await_input', { now: this.now(), waiting: reason });
    return { kind: 'awaiting_input', runId: claim.runId, reason };
  }

  private context(claim: Claim, row: StepRecord, signal: AbortSignal): StepContext<Ports> {
    return {
      ports: this.ports,
      signal,
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
    let output: JsonValue | null = null;
    let drafts: readonly UndoRecordDraft[] = [];
    let verdict: ReturnType<typeof afterReconcile>;
    try {
      const found = await step.reconcile(this.context(claim, row, controller.signal), row.input);
      verdict = afterReconcile({ idempotent: step.idempotent }, found.status);
      if (found.status === 'done') {
        output = toJson(found.output);
        drafts =
          step.undo === null
            ? []
            : await step.undo(this.context(claim, row, controller.signal), found.output);
      }
    } catch (error) {
      await beat.stop();
      return this.stepError(claim, row, error, beat, 'reconcile_failed');
    }
    await beat.stop();
    beat.throwIfLost();
    if (verdict === 'record_success' && output !== null) {
      await this.store.checkpointStep(claim, row.index, { now: this.now(), output, undo: drafts });
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
    const begun = await this.store.beginStep(claim, row.index, { now: this.now() });
    await this.crash('after_intent', runId, row.index);

    const controller = new AbortController();
    const beat = this.heartbeat(claim, controller);
    const ctx = this.context(claim, begun, controller.signal);
    let output: JsonValue;
    let drafts: readonly UndoRecordDraft[];
    let phase = 'step_error';
    try {
      const raw = await step.apply(ctx, begun.input);
      phase = 'output_invalid';
      const parsed = step.parseOutput(raw);
      output = toJson(parsed);
      phase = 'verify_failed';
      if (step.verify !== null) {
        await step.verify(ctx, parsed);
      }
      phase = 'undo_failed';
      drafts = step.undo === null ? [] : await step.undo(ctx, parsed);
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
    if (error instanceof StepDeferredError) {
      await this.store.deferStep(claim, row.index, { now: this.now(), reason: error.reason });
      await this.store.finishRun(claim, 'wait', {
        now: this.now(),
        waiting: error.reason,
        retryAfter: this.now() + this.waitBackoffMs,
      });
      return { kind: 'waiting', runId: claim.runId, reason: error.reason };
    }
    const code = error instanceof StepFailure ? error.code : phase;
    const message = error instanceof Error ? error.message : String(error);
    await this.store.failStep(claim, row.index, { now: this.now(), code, message });
    if (beat.cancelRequested()) {
      return this.finish(claim, 'cancel', 'cancelled');
    }
    return this.finish(claim, 'fail', 'failed', { index: row.index, code });
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
        if (stopped || lost !== null) {
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
