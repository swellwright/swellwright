// The state of a run as one table (docs/en/design/08-engine.md section 1, ADR 0048).
//
// The table is the whole truth about which state may follow which. A run is created `planned`. The people who act on a
// run (approve, cancel, pause, resume, retry, ask for a rollback) and the worker that executes it (claim, wait, succeed,
// fail, ...) are the sources of the events; the audit chain records the people, the run's own timeline records the rest.

import { createMachine, type Edge } from './machine.js';

export const RUN_STATES = [
  'planned',
  'awaiting_approval',
  'queued',
  'running',
  'paused',
  'awaiting_input',
  'succeeded',
  'failed',
  'cancelled',
  'rollback_requested',
  'rolling_back',
  'rolled_back',
  'rollback_partial',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_EVENTS = [
  /** The plan is shown to the people who approve it. */
  'request_approval',
  'approve',
  'reject',
  /** A plan that needs no approval goes straight to the queue. */
  'queue',
  /** A worker takes the lease: a queued run starts, a running one whose lease expired is taken over. */
  'claim',
  /** The run cannot go on for now (a lock is held by another run); the reason is on the run. */
  'wait',
  'pause',
  /** A paused run goes back to the queue; a worker claims it. */
  'resume',
  /** The run needs a person (a step that cannot be repeated was interrupted, a manual step at a provider). */
  'await_input',
  /** Run again from the first step that is not done: after a failure, or when a person chose it. */
  'retry',
  /** A person says that the interrupted step did its work: the run goes on after it. */
  'mark_done',
  'succeed',
  'fail',
  'cancel',
  'request_rollback',
  'rollback_done',
  'rollback_partial',
] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

/**
 * Reading it: a row is a state, a key is an event, a value is the state that follows. Two of the choices are decisions of
 * this slice and not of the diagram in the design: `paused` goes back through `queued` (a paused run has let go of its
 * lease, so a worker must claim it again), and a `succeeded` run has no way back: rolling one back is not decided yet.
 */
export const RUN_TRANSITIONS = {
  planned: { request_approval: 'awaiting_approval', queue: 'queued', cancel: 'cancelled' },
  awaiting_approval: { approve: 'queued', reject: 'cancelled', cancel: 'cancelled' },
  queued: { claim: 'running', pause: 'paused', cancel: 'cancelled' },
  running: {
    claim: 'running',
    wait: 'queued',
    pause: 'paused',
    await_input: 'awaiting_input',
    succeed: 'succeeded',
    fail: 'failed',
    cancel: 'cancelled',
  },
  paused: { resume: 'queued', cancel: 'cancelled' },
  awaiting_input: {
    retry: 'queued',
    mark_done: 'queued',
    request_rollback: 'rollback_requested',
    cancel: 'cancelled',
  },
  succeeded: {},
  failed: { retry: 'queued', request_rollback: 'rollback_requested' },
  cancelled: { request_rollback: 'rollback_requested' },
  rollback_requested: { claim: 'rolling_back' },
  rolling_back: {
    claim: 'rolling_back',
    rollback_done: 'rolled_back',
    rollback_partial: 'rollback_partial',
  },
  rolled_back: {},
  rollback_partial: { request_rollback: 'rollback_requested' },
} as const satisfies Record<RunState, Partial<Record<RunEvent, RunState>>>;

export const runMachine = createMachine<RunState, RunEvent>({
  name: 'run',
  states: RUN_STATES,
  events: RUN_EVENTS,
  table: RUN_TRANSITIONS,
});

/** The state the event leads to. Throws `InvalidTransitionError` when the run's state does not take the event. */
export function transition(state: RunState, event: RunEvent): RunState {
  return runMachine.transition(state, event);
}

export function canApply(state: RunState, event: RunEvent): boolean {
  return runMachine.canApply(state, event);
}

export function legalEvents(state: RunState): readonly RunEvent[] {
  return runMachine.legalEvents(state);
}

export function runEdges(): readonly Edge<RunState, RunEvent>[] {
  return runMachine.edges();
}

export const isRunState = runMachine.isState;
export const isRunEvent = runMachine.isEvent;

/** Nothing happens to a run in a final state, ever. */
export function isFinalRunState(state: RunState): boolean {
  return runMachine.isFinal(state);
}

/**
 * A worker has something to do: it can claim a run in one of these states (a queued one, a rollback that was asked for,
 * and a running or rolling-back one whose lease expired).
 */
export function needsWorker(state: RunState): boolean {
  return runMachine.canApply(state, 'claim');
}

/** A worker is working on a run in one of these states: it holds the lease and the locks of the run. */
export const LEASED_RUN_STATES = ['running', 'rolling_back'] as const satisfies readonly RunState[];

export function holdsLease(state: RunState): boolean {
  return (LEASED_RUN_STATES as readonly RunState[]).includes(state);
}
