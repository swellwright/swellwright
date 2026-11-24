import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTransitionError } from './machine.js';
import {
  STEP_EVENTS,
  STEP_STATES,
  canApplyToStep,
  isFinalStepState,
  isStepEvent,
  isStepState,
  stepEdges,
  transitionStep,
  type StepEvent,
  type StepState,
} from './step-state.js';

/** The oracle, written out once more (see the one for runs). */
const LEGAL: readonly (readonly [StepState, StepEvent, StepState])[] = [
  ['pending', 'start', 'running'],
  ['pending', 'skip', 'skipped'],
  ['running', 'restart', 'running'],
  ['running', 'succeed', 'succeeded'],
  ['running', 'mark_done', 'succeeded'],
  ['running', 'fail', 'failed'],
  ['succeeded', 'undo_done', 'undone'],
  ['succeeded', 'undo_fail', 'undo_failed'],
  ['failed', 'retry', 'pending'],
  ['undo_failed', 'undo_done', 'undone'],
  ['undo_failed', 'undo_fail', 'undo_failed'],
];

const expected = (state: StepState, event: StepEvent): StepState | undefined =>
  LEGAL.find(([from, on]) => from === state && on === event)?.[2];

describe('the state of a step', () => {
  it('answers every state against every event as the oracle does', () => {
    for (const state of STEP_STATES) {
      for (const event of STEP_EVENTS) {
        const target = expected(state, event);
        if (target === undefined) {
          assert.equal(canApplyToStep(state, event), false, `${state} must not take ${event}`);
          assert.throws(
            () => transitionStep(state, event),
            (error: unknown) =>
              error instanceof InvalidTransitionError &&
              error.machine === 'step' &&
              error.state === state &&
              error.event === event,
          );
        } else {
          assert.equal(transitionStep(state, event), target, `${state} + ${event}`);
        }
      }
    }
    assert.equal(stepEdges().length, LEGAL.length);
  });

  it('has `skipped` and `undone` as its final states', () => {
    assert.deepEqual(STEP_STATES.filter(isFinalStepState), ['skipped', 'undone']);
  });

  it('can be undone only after it succeeded: nothing else has undo records', () => {
    assert.deepEqual(
      LEGAL.filter(([, event]) => event === 'undo_done' || event === 'undo_fail').map(
        ([from]) => from,
      ),
      ['succeeded', 'succeeded', 'undo_failed', 'undo_failed'],
    );
  });

  it('writes a success only from `running`, whether the step reported it or a person did', () => {
    assert.deepEqual(
      LEGAL.filter(([, , to]) => to === 'succeeded').map(([from, event]) => `${from}/${event}`),
      ['running/succeed', 'running/mark_done'],
    );
  });

  it('cannot go from `succeeded` back to running: a done step is not done again', () => {
    for (const event of STEP_EVENTS) {
      const target = expected('succeeded', event);
      assert.ok(target === undefined || target === 'undone' || target === 'undo_failed');
    }
  });

  it('recognises its own states and events', () => {
    assert.equal(isStepState('running'), true);
    assert.equal(isStepState('start'), false);
    assert.equal(isStepEvent('start'), true);
    assert.equal(isStepEvent('__proto__'), false);
  });
});
