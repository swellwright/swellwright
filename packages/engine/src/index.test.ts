import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_VERSION } from '@swellwright/contracts';
import * as engine from './index.js';

describe('the entry point of the engine', () => {
  it('keeps the version that apps/worker reads', () => {
    assert.equal(engine.ENGINE_API_VERSION, API_VERSION);
  });

  it('gives out the core: the machines, the locks, the plan, the undo and the recovery', () => {
    for (const name of [
      'transition',
      'transitionStep',
      'createMachine',
      'InvalidTransitionError',
      'planAcquisition',
      'orderLocks',
      'buildPlan',
      'planHash',
      'undoOrder',
      'rollbackVerdict',
      'decideRecovery',
      'afterReconcile',
      'resumePoint',
      'defineStep',
      'remoteId',
      'isClaimable',
      'fenceAccepts',
    ]) {
      assert.equal(typeof (engine as Record<string, unknown>)[name], 'function', name);
    }
  });
});
