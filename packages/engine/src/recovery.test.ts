import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RECONCILE_ANSWERS,
  afterReconcile,
  decideRecovery,
  resumePoint,
  type RecoveryAction,
} from './recovery.js';
import { STEP_STATES, type StepState } from './step-state.js';

describe('what to do with a step that a crash left running', () => {
  // idempotent, hasReconcile, a person chose to retry -> what happens.
  const TABLE: readonly (readonly [boolean, boolean, boolean, RecoveryAction])[] = [
    [true, false, false, 'rerun'],
    [true, true, false, 'reconcile'],
    [false, true, false, 'reconcile'],
    [false, false, false, 'ask_person'],
    [true, false, true, 'rerun'],
    [true, true, true, 'rerun'],
    [false, true, true, 'rerun'],
    [false, false, true, 'rerun'],
  ];

  it('decides by what the step declares, and a person who chose to retry decides over it', () => {
    for (const [idempotent, hasReconcile, personChoseRetry, action] of TABLE) {
      assert.equal(
        decideRecovery({ idempotent, hasReconcile }, { personChoseRetry }),
        action,
        `idempotent ${String(idempotent)}, reconcile ${String(hasReconcile)}, person ${String(personChoseRetry)}`,
      );
    }
    assert.equal(TABLE.length, 8);
  });

  it('never repeats a step that is not idempotent and cannot look at the world, unless a person said so', () => {
    assert.equal(decideRecovery({ idempotent: false, hasReconcile: false }), 'ask_person');
    assert.equal(decideRecovery({ idempotent: false, hasReconcile: false }, {}), 'ask_person');
    assert.equal(
      decideRecovery({ idempotent: false, hasReconcile: false }, { personChoseRetry: false }),
      'ask_person',
    );
  });
});

describe('what to do with the answer of `reconcile`', () => {
  it('records the success when the effect is there, for any step', () => {
    assert.equal(afterReconcile({ idempotent: true }, 'done'), 'record_success');
    assert.equal(afterReconcile({ idempotent: false }, 'done'), 'record_success');
  });

  it('runs the step again when nothing was done, even one that is not idempotent', () => {
    assert.equal(afterReconcile({ idempotent: true }, 'not_done'), 'rerun');
    assert.equal(afterReconcile({ idempotent: false }, 'not_done'), 'rerun');
  });

  it('runs the step again after a part of it only when it is idempotent, and asks a person otherwise', () => {
    assert.equal(afterReconcile({ idempotent: true }, 'partial'), 'rerun');
    assert.equal(afterReconcile({ idempotent: false }, 'partial'), 'ask_person');
  });

  it('has an answer for everything `reconcile` can say', () => {
    assert.deepEqual([...RECONCILE_ANSWERS], ['done', 'not_done', 'partial']);
  });
});

describe('where a run goes on', () => {
  const at = (...states: StepState[]) => resumePoint(states.map((state) => ({ state })));

  it('is done when every step succeeded or was skipped, and for a run with no steps', () => {
    assert.deepEqual(at('succeeded', 'skipped', 'succeeded'), { kind: 'done' });
    assert.deepEqual(at(), { kind: 'done' });
  });

  it('is the first step that is not done, whatever state it is in', () => {
    assert.deepEqual(at('succeeded', 'pending', 'pending'), {
      kind: 'step',
      index: 1,
      state: 'pending',
    });
    assert.deepEqual(at('succeeded', 'succeeded', 'running', 'pending'), {
      kind: 'step',
      index: 2,
      state: 'running',
    });
    assert.deepEqual(at('succeeded', 'failed', 'pending'), {
      kind: 'step',
      index: 1,
      state: 'failed',
    });
    assert.deepEqual(at('skipped', 'pending'), { kind: 'step', index: 1, state: 'pending' });
  });

  it('does not look past the first step that is not done', () => {
    assert.deepEqual(at('pending', 'undone'), { kind: 'step', index: 0, state: 'pending' });
  });

  it('is an error to meet a step that was undone: a run that goes forward cannot', () => {
    for (const state of STEP_STATES.filter((s) => s === 'undone' || s === 'undo_failed')) {
      assert.throws(() => at('succeeded', state), RangeError);
    }
  });
});
