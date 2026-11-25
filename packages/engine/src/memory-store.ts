// The run store in memory: the reference for what every store must do (ADR 0048), and the one the golden and the fault tests
// of the loop run on. It is the same port with the same rules as the store over PostgreSQL, and both are held to them by
// `testing/store-contract.ts`.
//
// Every operation checks everything first and changes the tables at the end, with no `await` between, so an operation is
// either done whole or not at all, as a transaction is.

import { isClaimable } from './lease.js';
import {
  MAX_ERROR_CODE,
  MAX_ERROR_MESSAGE,
  MAX_WAITING,
  assertIdentifier,
  assertStorableCheckpoint,
  cleanText,
  storableJson,
} from './limits.js';
import { parseLockKey, planAcquisition, waitingReason, type HeldLock } from './locks.js';
import { planHash, type JsonValue } from './plan.js';
import { holdsLease, runMachine, transition, type RunState } from './run-state.js';
import { remoteId, type UndoRecordDraft } from './step.js';
import { transitionStep } from './step-state.js';
import {
  FINISH_EVENTS,
  FenceLostError,
  LockLostError,
  NotFoundError,
  PERSON_EVENTS,
  StateConflictError,
  type Claim,
  type Claimed,
  type FinishEvent,
  type LockResult,
  type NewRun,
  type PersonEvent,
  type RunEventRow,
  type RunRecord,
  type RunStore,
  type StepRecord,
  type TimelineType,
  type UndoRecordRow,
} from './store.js';

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly steps = new Map<string, StepRecord[]>();
  private readonly undo = new Map<string, UndoRecordRow[]>();
  private readonly events = new Map<string, RunEventRow[]>();
  private readonly locks = new Map<string, HeldLock>();

  /** Runs the operation at once, so nothing else can happen in the middle of it; a thrown error is a rejected promise. */
  private op<T>(operation: () => T): Promise<T> {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  createRun(input: NewRun): Promise<RunRecord> {
    return this.op(() => {
      if (this.runs.has(input.id)) {
        throw new StateConflictError(`The run ${input.id} exists already.`);
      }
      const run: RunRecord = {
        id: input.id,
        workflowKey: input.plan.workflowKey,
        params: copy(input.plan.params),
        plan: copy(input.plan),
        planHash: planHash(input.plan),
        state: 'planned',
        risk: input.risk,
        requestedBy: input.requestedBy,
        createdAt: input.now,
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        pauseRequestedAt: null,
        workerId: null,
        leaseExpiresAt: null,
        fence: 0,
        waiting: null,
        retryAfter: null,
      };
      const steps = input.plan.steps.map((step): StepRecord => ({
        runId: input.id,
        index: step.index,
        key: step.key,
        state: 'pending',
        attempt: 0,
        remoteId: remoteId(input.id, step.index),
        input: copy(step.input),
        output: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        retryApproved: false,
      }));
      this.runs.set(run.id, run);
      this.steps.set(run.id, steps);
      this.undo.set(run.id, []);
      this.events.set(run.id, []);
      this.emit(run.id, input.now, 'run.created', {
        workflowKey: run.workflowKey,
        planHash: run.planHash,
        steps: steps.length,
      });
      return copy(run);
    });
  }

  getRun(id: string): Promise<RunRecord | null> {
    return this.op(() => {
      const run = this.runs.get(id);
      return run === undefined ? null : copy(run);
    });
  }

  getSteps(runId: string): Promise<readonly StepRecord[]> {
    return this.op(() => copy(this.stepsOf(runId)));
  }

  getUndoRecords(runId: string): Promise<readonly UndoRecordRow[]> {
    return this.op(() => {
      this.runOf(runId);
      return copy(this.undo.get(runId) ?? []);
    });
  }

  listEvents(runId: string, after: number, limit: number): Promise<readonly RunEventRow[]> {
    return this.op(() => {
      this.runOf(runId);
      return copy(
        (this.events.get(runId) ?? []).filter((event) => event.seq > after).slice(0, limit),
      );
    });
  }

  listLocks(): Promise<readonly HeldLock[]> {
    return this.op(() => copy([...this.locks.values()].sort((a, b) => a.key.localeCompare(b.key))));
  }

  applyEvent(
    runId: string,
    event: PersonEvent,
    input: {
      readonly now: number;
      readonly expectedState?: RunState;
      readonly actor?: string | null;
    },
  ): Promise<RunRecord> {
    return this.op(() => {
      if (!(PERSON_EVENTS as readonly string[]).includes(event)) {
        throw new StateConflictError(`"${event}" is not an event that a person applies.`);
      }
      const run = this.runOf(runId);
      if (input.expectedState !== undefined && run.state !== input.expectedState) {
        throw new StateConflictError(
          `The run is ${run.state}, not ${input.expectedState}: it changed since it was read.`,
        );
      }
      if (holdsLease(run.state)) {
        throw new StateConflictError(
          'A worker holds the run: ask it to cancel or pause (requestCancel, requestPause) instead.',
        );
      }
      // A cancel that was accepted comes before a pause: a run that is paused is claimed by nobody, so it would never be read.
      const effective: PersonEvent =
        event === 'pause' && run.cancelRequestedAt !== null ? 'cancel' : event;
      const next = transition(run.state, effective);
      const steps = this.stepsOf(runId);
      if (event === 'retry') {
        for (const step of steps) {
          if (step.state === 'failed') {
            this.setStep(runId, step.index, {
              state: transitionStep(step.state, 'retry'),
              errorCode: null,
              errorMessage: null,
              finishedAt: null,
            });
          } else if (step.state === 'running') {
            this.setStep(runId, step.index, { retryApproved: true });
          }
        }
      } else if (event === 'mark_done') {
        for (const step of steps) {
          if (step.state === 'running') {
            this.setStep(runId, step.index, {
              state: transitionStep(step.state, 'mark_done'),
              finishedAt: input.now,
            });
          }
        }
      }
      const ends = next === 'cancelled';
      this.setRun(runId, {
        state: next,
        waiting: null,
        retryAfter: null,
        finishedAt: ends ? input.now : run.finishedAt,
        pauseRequestedAt: effective === 'pause' || ends ? null : run.pauseRequestedAt,
        cancelRequestedAt: ends ? null : run.cancelRequestedAt,
      });
      this.emit(runId, input.now, `run.${effective}`, {
        from: run.state,
        to: next,
        actor: input.actor ?? null,
        ...(effective === event ? {} : { instead: event }),
      });
      return copy(this.runOf(runId));
    });
  }

  requestCancel(runId: string, now: number): Promise<RunRecord> {
    return this.requestFlag(runId, now, 'cancel');
  }

  requestPause(runId: string, now: number): Promise<RunRecord> {
    return this.requestFlag(runId, now, 'pause');
  }

  private requestFlag(runId: string, now: number, event: 'cancel' | 'pause'): Promise<RunRecord> {
    const run = this.runs.get(runId);
    if (run !== undefined && holdsLease(run.state)) {
      return this.op(() => {
        if (!runMachine.canApply(run.state, event)) {
          // Says the same as every other refusal: the state does not take the event.
          transition(run.state, event);
        }
        if (event === 'cancel' && run.cancelRequestedAt === null) {
          this.setRun(runId, { cancelRequestedAt: now });
          this.emit(runId, now, 'run.cancel_requested', {});
        } else if (event === 'pause' && run.pauseRequestedAt === null) {
          this.setRun(runId, { pauseRequestedAt: now });
          this.emit(runId, now, 'run.pause_requested', {});
        }
        return copy(this.runOf(runId));
      });
    }
    return this.applyEvent(runId, event, { now });
  }

  claimNext(input: {
    readonly workerId: string;
    readonly now: number;
    readonly leaseMs: number;
    readonly skipWaiting?: readonly string[];
  }): Promise<Claimed | null> {
    return this.op(() => {
      const skip = input.skipWaiting ?? [];
      const candidate = [...this.runs.values()]
        .filter(
          (run) =>
            isClaimable(run.state, run.leaseExpiresAt, input.now) &&
            (run.retryAfter ?? 0) <= input.now &&
            (run.waiting === null ||
              !skip.includes(run.waiting) ||
              run.cancelRequestedAt !== null ||
              run.pauseRequestedAt !== null),
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
      if (candidate === undefined) {
        return null;
      }
      const next = transition(candidate.state, 'claim');
      const fence = candidate.fence + 1;
      this.setRun(candidate.id, {
        state: next,
        workerId: input.workerId,
        leaseExpiresAt: input.now + input.leaseMs,
        fence,
        waiting: null,
        retryAfter: null,
        startedAt: candidate.startedAt ?? input.now,
      });
      this.emit(candidate.id, input.now, 'run.claim', {
        from: candidate.state,
        to: next,
        workerId: input.workerId,
        fence,
        takeover: holdsLease(candidate.state),
      });
      return {
        claim: { runId: candidate.id, workerId: input.workerId, fence },
        run: copy(this.runOf(candidate.id)),
        steps: copy(this.stepsOf(candidate.id)),
      };
    });
  }

  renewLease(
    claim: Claim,
    input: { readonly now: number; readonly leaseMs: number },
  ): Promise<RunRecord> {
    return this.op(() => {
      const run = this.verifyClaim(claim);
      this.verifyLocks(run, claim);
      const expiresAt = input.now + input.leaseMs;
      this.setRun(claim.runId, { leaseExpiresAt: expiresAt });
      for (const lock of this.locks.values()) {
        if (lock.holder === claim.runId && lock.fence === claim.fence) {
          this.locks.set(lock.key, { ...lock, expiresAt });
        }
      }
      return copy(this.runOf(claim.runId));
    });
  }

  acquireLocks(
    claim: Claim,
    input: { readonly now: number; readonly ttlMs: number },
  ): Promise<LockResult> {
    return this.op((): LockResult => {
      const run = this.verifyClaim(claim);
      const result = planAcquisition({
        run: claim.runId,
        wanted: run.plan.locks.map(parseLockKey),
        held: [...this.locks.values()],
        now: input.now,
      });
      if (!result.ok) {
        return {
          ok: false,
          blockedKey: result.blockedKey,
          heldBy: result.heldBy,
          reason: waitingReason(result),
        };
      }
      const keys = [...result.take, ...result.renew, ...result.supersede];
      for (const key of keys) {
        this.locks.set(key, {
          key,
          holder: claim.runId,
          fence: claim.fence,
          expiresAt: input.now + input.ttlMs,
        });
      }
      if (result.take.length + result.supersede.length > 0) {
        this.emit(claim.runId, input.now, 'locks.acquired', {
          keys: [...result.take, ...result.supersede],
        });
      }
      return { ok: true, keys: [...run.plan.locks] };
    });
  }

  beginStep(claim: Claim, index: number, input: { readonly now: number }): Promise<StepRecord> {
    return this.op(() => {
      const run = this.verifyClaim(claim);
      this.verifyLocks(run, claim);
      const step = this.stepOf(claim.runId, index);
      const event = step.state === 'running' ? 'restart' : 'start';
      const state = transitionStep(step.state, event);
      this.setStep(claim.runId, index, {
        state,
        attempt: step.attempt + 1,
        startedAt: step.startedAt ?? input.now,
        retryApproved: false,
      });
      this.emit(claim.runId, input.now, `step.${event}`, { index, attempt: step.attempt + 1 });
      return copy(this.stepOf(claim.runId, index));
    });
  }

  checkpointStep(
    claim: Claim,
    index: number,
    input: {
      readonly now: number;
      readonly output: JsonValue;
      readonly undo: readonly UndoRecordDraft[];
    },
  ): Promise<StepRecord> {
    return this.op(() => {
      const run = this.verifyClaim(claim);
      this.verifyLocks(run, claim);
      assertStorableCheckpoint(input.output, input.undo);
      const step = this.stepOf(claim.runId, index);
      const state = transitionStep(step.state, 'succeed');
      this.setStep(claim.runId, index, {
        state,
        output: storableJson('The output of a step', input.output),
        errorCode: null,
        errorMessage: null,
        finishedAt: input.now,
      });
      const records = this.undo.get(claim.runId) ?? [];
      input.undo.forEach((draft, seq) => {
        records.push({
          runId: claim.runId,
          stepIndex: index,
          seq,
          kind: draft.kind,
          data: storableJson('The data of an undo record', draft.data),
          state: 'pending',
        });
      });
      this.emit(claim.runId, input.now, 'step.succeed', { index, undo: input.undo.length });
      return copy(this.stepOf(claim.runId, index));
    });
  }

  failStep(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly code: string; readonly message: string },
  ): Promise<StepRecord> {
    return this.op(() => {
      const run = this.verifyClaim(claim);
      this.verifyLocks(run, claim);
      this.writeFailure(claim, index, input);
      return copy(this.stepOf(claim.runId, index));
    });
  }

  deferStep(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly reason: string },
  ): Promise<StepRecord> {
    return this.op(() => {
      const run = this.verifyClaim(claim);
      this.verifyLocks(run, claim);
      const step = this.stepOf(claim.runId, index);
      this.setStep(claim.runId, index, { state: transitionStep(step.state, 'defer') });
      this.emit(claim.runId, input.now, 'step.defer', {
        index,
        reason: cleanText(input.reason, MAX_WAITING),
      });
      return copy(this.stepOf(claim.runId, index));
    });
  }

  finishRun(
    claim: Claim,
    event: FinishEvent,
    input: {
      readonly now: number;
      readonly waiting?: string | null;
      readonly retryAfter?: number | null;
      readonly data?: JsonValue;
      readonly failedStep?: {
        readonly index: number;
        readonly code: string;
        readonly message: string;
      };
    },
  ): Promise<RunRecord> {
    return this.op(() => {
      if (!(FINISH_EVENTS as readonly string[]).includes(event)) {
        throw new StateConflictError(
          `"${event}" is not an event with which a worker lets go of a run.`,
        );
      }
      const run = this.verifyClaim(claim);
      if (event === 'succeed' || input.failedStep !== undefined) {
        this.verifyLocks(run, claim);
      }
      // A worker that asks for a person, or pauses, while a cancel is pending carries the cancel out: it was accepted, and
      // nothing claims a run that waits for a person or is paused, so it would never be read.
      const finish: FinishEvent =
        (event === 'await_input' || event === 'pause') && run.cancelRequestedAt !== null
          ? 'cancel'
          : event;
      const next = transition(run.state, finish);
      const ends = next === 'succeeded' || next === 'failed' || next === 'cancelled';
      const waiting =
        (finish === 'wait' || finish === 'await_input') && input.waiting != null
          ? cleanText(input.waiting, MAX_WAITING)
          : null;
      if (input.failedStep !== undefined) {
        // The failure checks its own values before it changes anything, and this runs before the run is changed, so a refused
        // failure leaves everything as it was.
        this.writeFailure(claim, input.failedStep.index, { now: input.now, ...input.failedStep });
      }
      this.setRun(claim.runId, {
        state: next,
        workerId: null,
        leaseExpiresAt: null,
        waiting,
        retryAfter: finish === 'wait' ? (input.retryAfter ?? null) : null,
        finishedAt: ends ? input.now : run.finishedAt,
        // A run that ended or stopped for a person has no request of the people left to honour. A pause keeps a cancel that was
        // asked for, and a wait keeps both, for whoever takes the run next.
        pauseRequestedAt: finish === 'wait' ? run.pauseRequestedAt : null,
        cancelRequestedAt: finish === 'wait' || finish === 'pause' ? run.cancelRequestedAt : null,
      });
      for (const lock of [...this.locks.values()]) {
        if (lock.holder === claim.runId) {
          this.locks.delete(lock.key);
        }
      }
      this.emit(claim.runId, input.now, `run.${finish}`, {
        from: run.state,
        to: next,
        data:
          finish === event
            ? (input.data ?? null)
            : { instead: event, reason: input.waiting ?? null },
        waiting,
      });
      return copy(this.runOf(claim.runId));
    });
  }

  appendEvent(
    claim: Claim,
    type: TimelineType,
    data: JsonValue,
    now: number,
  ): Promise<RunEventRow> {
    return this.op(() => {
      this.verifyClaim(claim);
      return copy(this.emit(claim.runId, now, type, data));
    });
  }

  /** The failure of a step, with its event: the code is checked, the message is cleaned and cut. */
  private writeFailure(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly code: string; readonly message: string },
  ): void {
    assertIdentifier('The code of an error', input.code, MAX_ERROR_CODE);
    const step = this.stepOf(claim.runId, index);
    const state = transitionStep(step.state, 'fail');
    this.setStep(claim.runId, index, {
      state,
      errorCode: input.code,
      errorMessage: cleanText(input.message, MAX_ERROR_MESSAGE),
      finishedAt: input.now,
    });
    this.emit(claim.runId, input.now, 'step.fail', { index, code: input.code });
  }

  private runOf(id: string): RunRecord {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new NotFoundError(`There is no run ${id}.`);
    }
    return run;
  }

  private stepsOf(runId: string): StepRecord[] {
    this.runOf(runId);
    return this.steps.get(runId) ?? [];
  }

  private stepOf(runId: string, index: number): StepRecord {
    const step = this.stepsOf(runId)[index];
    if (step === undefined) {
      throw new NotFoundError(`The run ${runId} has no step ${String(index)}.`);
    }
    return step;
  }

  private setRun(id: string, patch: Partial<RunRecord>): void {
    this.runs.set(id, { ...this.runOf(id), ...patch });
  }

  private setStep(runId: string, index: number, patch: Partial<StepRecord>): void {
    const steps = this.stepsOf(runId);
    steps[index] = { ...this.stepOf(runId, index), ...patch };
  }

  private emit(runId: string, at: number, type: TimelineType, data: JsonValue): RunEventRow {
    const list = this.events.get(runId) ?? [];
    const row: RunEventRow = { runId, seq: list.length + 1, at, type, data: copy(data) };
    list.push(row);
    this.events.set(runId, list);
    return row;
  }

  /** The write is from the worker that holds the run now: the fence, the worker and a state in which a run is held. */
  private verifyClaim(claim: Claim): RunRecord {
    const run = this.runOf(claim.runId);
    if (run.fence !== claim.fence || run.workerId !== claim.workerId || !holdsLease(run.state)) {
      throw new FenceLostError(
        claim.runId,
        `The run ${claim.runId} is not held by ${claim.workerId} with the fence ${String(claim.fence)} (the row has ${String(run.fence)}, ${run.state}).`,
      );
    }
    return run;
  }

  /** Every lock of the plan is still a row of this run with this worker's fence. */
  private verifyLocks(run: RunRecord, claim: Claim): void {
    for (const key of run.plan.locks) {
      const lock = this.locks.get(key);
      if (lock?.holder !== claim.runId || lock.fence !== claim.fence) {
        throw new LockLostError(claim.runId, key);
      }
    }
  }
}
