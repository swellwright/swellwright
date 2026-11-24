// The state of one step of a run (ADR 0048): the intent, the effect and the checkpoint of a step, and the undo of it.
//
// `apply` runs between `start` and `succeed`/`fail`. A crash between them leaves the step `running` with an expired lease;
// `restart` is the next worker running it again (see `recovery.ts` for who decides that). The undo of a step is possible
// only for a step that succeeded, because its undo records were written in the transaction that recorded the success.

import { createMachine, type Edge } from './machine.js';

export const STEP_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'undone',
  'undo_failed',
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const STEP_EVENTS = [
  /** The intent is recorded: the attempt grows and `apply` is about to run. */
  'start',
  /** A worker found the step `running` after a crash and runs it again (the attempt grows). */
  'restart',
  /** The step said that it did nothing yet and cannot go on now (the vault is sealed): it goes back to waiting. */
  'defer',
  /** The checkpoint: the output and the undo records are written with this transition. */
  'succeed',
  /** A person says the interrupted step did its work: it is `succeeded` with no output and no undo records. */
  'mark_done',
  'fail',
  'skip',
  /** A person (or the run's `retry`) lets a failed step run again. */
  'retry',
  'undo_done',
  'undo_fail',
] as const;
export type StepEvent = (typeof STEP_EVENTS)[number];

export const STEP_TRANSITIONS = {
  pending: { start: 'running', skip: 'skipped' },
  running: {
    restart: 'running',
    defer: 'pending',
    succeed: 'succeeded',
    mark_done: 'succeeded',
    fail: 'failed',
  },
  succeeded: { undo_done: 'undone', undo_fail: 'undo_failed' },
  failed: { retry: 'pending' },
  skipped: {},
  undone: {},
  undo_failed: { undo_done: 'undone', undo_fail: 'undo_failed' },
} as const satisfies Record<StepState, Partial<Record<StepEvent, StepState>>>;

export const stepMachine = createMachine<StepState, StepEvent>({
  name: 'step',
  states: STEP_STATES,
  events: STEP_EVENTS,
  table: STEP_TRANSITIONS,
});

export function transitionStep(state: StepState, event: StepEvent): StepState {
  return stepMachine.transition(state, event);
}

export function canApplyToStep(state: StepState, event: StepEvent): boolean {
  return stepMachine.canApply(state, event);
}

export function stepEdges(): readonly Edge<StepState, StepEvent>[] {
  return stepMachine.edges();
}

export const isStepState = stepMachine.isState;
export const isStepEvent = stepMachine.isEvent;

/** A step that is `skipped` or `undone` is over for good. */
export function isFinalStepState(state: StepState): boolean {
  return stepMachine.isFinal(state);
}
