import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';

import { MemoryRunStore } from './memory-store.js';
import { runWorkerScenarios } from './testing/worker-scenarios.js';
import { abortableSleep } from './worker.js';

runWorkerScenarios('in memory', () => Promise.resolve({ store: new MemoryRunStore() }));

describe('the sleep of an idle loop', () => {
  it('leaves no listener on the signal when the timer ends it, so a loop that idles for days does not grow', async () => {
    const controller = new AbortController();
    for (let poll = 0; poll < 200; poll += 1) {
      await abortableSleep(0, controller.signal);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('is ended at once by the signal, and takes its timer and its listener away', async () => {
    const controller = new AbortController();
    const began = Date.now();
    const sleeping = abortableSleep(60_000, controller.signal);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await sleeping;
    assert.ok(Date.now() - began < 1_000);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    // A signal that is already aborted ends it without a timer.
    await abortableSleep(60_000, controller.signal);
  });
});
