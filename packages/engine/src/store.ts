// The port between the engine and the place where runs live (ADR 0048): everything the loop and the people who act on a run
// may do to the tables, as operations that each are one transaction.
//
// The rules that make the engine safe are rules of this port, not of the loop, so that every store has to keep them and one
// suite of tests (`testing/store-contract.ts`) can hold the in-memory store and the one over PostgreSQL to the same:
//   - a write about a run from a worker carries its `Claim`, and fails with `FenceLostError` when the row has another fence
//     (another worker took the run), another worker, or a state in which nobody holds the run;
//   - a write that changes a step also fails with `LockLostError` when a lock of the run now belongs to another run;
//   - a person's event is a compare-and-set on the state the person saw, and is refused while a worker holds the run;
//   - the time is always given, never read, so a test with a fake clock decides everything.

import type { HeldLock } from './locks.js';
import type { JsonValue, RunPlan } from './plan.js';
import type { RunEvent, RunState } from './run-state.js';
import type { StepEvent, StepState } from './step-state.js';
import type { UndoRecordDraft } from './step.js';
import type { UndoRecordRef } from './undo.js';

export const RUN_RISKS = ['low', 'medium', 'high'] as const;
export type RunRisk = (typeof RUN_RISKS)[number];

export interface RunRecord {
  readonly id: string;
  readonly workflowKey: string;
  readonly params: JsonValue;
  readonly plan: RunPlan;
  /** SHA-256 of the canonical plan; the approvals of a later ADR are bound to it. */
  readonly planHash: string;
  readonly state: RunState;
  readonly risk: RunRisk;
  readonly requestedBy: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** A person asked to cancel while a worker held the run; the worker reads it at its next renewal. */
  readonly cancelRequestedAt: number | null;
  readonly pauseRequestedAt: number | null;
  readonly workerId: string | null;
  readonly leaseExpiresAt: number | null;
  /** Only grows, by one for every claim. */
  readonly fence: number;
  /** Why a run that is `queued` or `awaiting_input` is not going on: `lock server:42 held by <run>`, `vault_sealed`. */
  readonly waiting: string | null;
  /** A run that waited is not claimed before this time, so one that waits does not keep the others from their turn. */
  readonly retryAfter: number | null;
}

export interface StepRecord {
  readonly runId: string;
  readonly index: number;
  readonly key: string;
  readonly state: StepState;
  /** How many times the step was started. */
  readonly attempt: number;
  /** The id of the step on a server: the same for every worker that runs it. */
  readonly remoteId: string;
  readonly input: JsonValue;
  readonly output: JsonValue | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** A person chose to retry a step that a crash interrupted and that cannot be retried by itself. */
  readonly retryApproved: boolean;
}

export interface UndoRecordRow extends UndoRecordRef {
  readonly runId: string;
  readonly kind: string;
  readonly data: JsonValue;
}

export type TimelineType =
  | 'run.created'
  | 'run.cancel_requested'
  | 'run.pause_requested'
  | 'locks.acquired'
  | `run.${RunEvent}`
  | `step.${StepEvent}`;

export interface RunEventRow {
  readonly runId: string;
  /** From 1, without gaps, in the order the events happened. */
  readonly seq: number;
  readonly at: number;
  readonly type: TimelineType;
  readonly data: JsonValue;
}

/** What a worker holds after it took a run: it must come with every write it makes. */
export interface Claim {
  readonly runId: string;
  readonly workerId: string;
  readonly fence: number;
}

export interface Claimed {
  readonly claim: Claim;
  readonly run: RunRecord;
  readonly steps: readonly StepRecord[];
}

export type LockResult =
  | { readonly ok: true; readonly keys: readonly string[] }
  | {
      readonly ok: false;
      readonly blockedKey: string;
      readonly heldBy: string;
      /** `lock server:42 held by <run>`. */
      readonly reason: string;
    };

/** The events that people (or the system on their behalf) apply to a run that no worker holds. */
export const PERSON_EVENTS = [
  'request_approval',
  'approve',
  'reject',
  'queue',
  'pause',
  'resume',
  'cancel',
  'retry',
  'mark_done',
  'request_rollback',
] as const satisfies readonly RunEvent[];
export type PersonEvent = (typeof PERSON_EVENTS)[number];

/** The events with which a worker lets go of a run. */
export const FINISH_EVENTS = [
  'succeed',
  'fail',
  'wait',
  'pause',
  'await_input',
  'cancel',
] as const satisfies readonly RunEvent[];
export type FinishEvent = (typeof FINISH_EVENTS)[number];

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends StoreError {}

/**
 * A value that no store can keep: a code or a kind longer than its column, a text with a NUL, a lone surrogate. Both stores
 * refuse it the same way (`limits.ts`), so a value that is stored in memory in a test is stored in PostgreSQL in production,
 * and the loop never meets a write that only the database refuses (it would repeat the step for ever).
 */
export class InvalidDataError extends StoreError {}

/** The run is not in the state the caller saw or expects, or the operation is not for a run in that state. */
export class StateConflictError extends StoreError {}

/**
 * A worker's write was refused: another worker holds the run now, or nobody does. The worker must stop and not touch the
 * run again; whatever it was doing on a server is for the next worker to find.
 */
export class FenceLostError extends StoreError {
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);
    this.runId = runId;
  }
}

/** A lock of the run belongs to another run now: the worker's write would change something it no longer owns. */
export class LockLostError extends FenceLostError {
  readonly key: string;

  constructor(runId: string, key: string) {
    super(runId, `The run no longer holds the lock ${key}.`);
    this.key = key;
  }
}

export interface NewRun {
  /** A UUIDv7, made by the caller. */
  readonly id: string;
  readonly plan: RunPlan;
  readonly risk: RunRisk;
  readonly requestedBy: string | null;
  readonly now: number;
}

export interface RunStore {
  /** Writes the run as `planned` with a `pending` step for every step of the plan, and its first event. */
  createRun(input: NewRun): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  getSteps(runId: string): Promise<readonly StepRecord[]>;
  getUndoRecords(runId: string): Promise<readonly UndoRecordRow[]>;
  /** The events after `after` (a `seq`, 0 for all), oldest first. */
  listEvents(runId: string, after: number, limit: number): Promise<readonly RunEventRow[]>;
  /** The lock rows that exist now, expired ones too. */
  listLocks(): Promise<readonly HeldLock[]>;

  /**
   * A person's event on a run that no worker holds, as a compare-and-set: with `expectedState` it is refused when the run is
   * in another state. `retry` puts the failed steps back to `pending` (or, for a run that waits for a person, records that the
   * person chose to repeat the interrupted step) and `mark_done` writes the interrupted step as succeeded.
   * @throws InvalidTransitionError when the state does not take the event.
   */
  applyEvent(
    runId: string,
    event: PersonEvent,
    input: {
      readonly now: number;
      readonly expectedState?: RunState;
      readonly actor?: string | null;
    },
  ): Promise<RunRecord>;
  /**
   * A run a worker holds gets a flag that the worker reads; any other run that can be cancelled is cancelled now. A pause for a
   * run that has a cancel pending (kept for it by a wait) is a cancel: the cancel that was accepted comes first.
   */
  requestCancel(runId: string, now: number): Promise<RunRecord>;
  requestPause(runId: string, now: number): Promise<RunRecord>;

  /**
   * Takes the oldest run a worker can take (`queued`, or `running` with an expired lease) in one step: state, worker, lease,
   * a fence one higher, and the event. A run that asked for a rollback is not taken: nothing executes an undo yet, and the
   * loop would run its steps forward.
   *
   * `skipWaiting` lists the reasons a run may be waiting with (`vault_sealed`) that this worker cannot do anything about: a
   * run that waits with one of them is left for a worker that can, so a worker that cannot never takes it just to put it
   * back with a later time. A run with a request of the people pending (a cancel or a pause that was accepted) is never left:
   * a cancel needs no vault, and a request that was accepted must not wait for one.
   */
  claimNext(input: {
    readonly workerId: string;
    readonly now: number;
    readonly leaseMs: number;
    readonly skipWaiting?: readonly string[];
  }): Promise<Claimed | null>;
  /**
   * Extends the lease and the expiry of the run's locks. Returns the run, with the flags of the people. It fails with
   * `LockLostError` when a lock of the plan is another run's now, so a worker whose resource was taken learns it at its next
   * renewal and not at its checkpoint.
   */
  renewLease(
    claim: Claim,
    input: { readonly now: number; readonly leaseMs: number },
  ): Promise<RunRecord>;
  /** All the locks of the plan or none, in the fixed order (`planAcquisition`). */
  acquireLocks(
    claim: Claim,
    input: { readonly now: number; readonly ttlMs: number },
  ): Promise<LockResult>;

  /** The intent: `pending → running` (`start`) or `running → running` (`restart`), the attempt grows, an event is written. */
  beginStep(claim: Claim, index: number, input: { readonly now: number }): Promise<StepRecord>;
  /** The checkpoint: the output, the undo records and `running → succeeded` are written together, then the event. */
  checkpointStep(
    claim: Claim,
    index: number,
    input: {
      readonly now: number;
      readonly output: JsonValue;
      readonly undo: readonly UndoRecordDraft[];
    },
  ): Promise<StepRecord>;
  /** Like every write that changes a step, it fails with `LockLostError` when a lock of the run is another run's now. */
  failStep(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly code: string; readonly message: string },
  ): Promise<StepRecord>;
  /** `running → pending` for a step that did nothing and cannot go on now. */
  deferStep(
    claim: Claim,
    index: number,
    input: { readonly now: number; readonly reason: string },
  ): Promise<StepRecord>;
  /**
   * Lets go of the run: its new state, no worker and no lease, its locks released. With `failedStep` the step is written as
   * failed in the same transaction, so a worker that dies here leaves either the run as it was or the failure whole, never a
   * run that is `running` with a `failed` step. A finished or paused run has no pending flag of the people left: a cancel
   * that came too late for a step that failed is moot, and must not turn a later retry into a cancel. A worker that asks for a
   * person (`await_input`) or pauses while a cancel is pending does not park the run: the cancel that was accepted is carried
   * out, in the same transaction, and the run is `cancelled` (the returned run says so). Nothing claims a run that waits for a
   * person or is paused, so a cancel kept for it would never be read.
   */
  finishRun(
    claim: Claim,
    event: FinishEvent,
    input: {
      readonly now: number;
      readonly waiting?: string | null;
      /** For `wait`: the time before which the run is not claimed again. */
      readonly retryAfter?: number | null;
      readonly data?: JsonValue;
      readonly failedStep?: {
        readonly index: number;
        readonly code: string;
        readonly message: string;
      };
    },
  ): Promise<RunRecord>;
  appendEvent(claim: Claim, type: TimelineType, data: JsonValue, now: number): Promise<RunEventRow>;
}
