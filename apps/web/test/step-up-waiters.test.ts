import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepUpWaiters } from '../src/auth/step-up-waiters.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Where a promise stands, without waiting for it. */
function track(promise: Promise<void>) {
  const state: { value: 'pending' | 'resolved' | 'rejected'; error?: unknown } = {
    value: 'pending',
  };
  promise.then(
    () => {
      state.value = 'resolved';
    },
    (error: unknown) => {
      state.value = 'rejected';
      state.error = error;
    },
  );
  return state;
}

describe('the calls that wait for the confirmation dialog', () => {
  it('lets every waiting call go on when the code is confirmed', async () => {
    const waiters = new StepUpWaiters();
    const first = track(waiters.wait());
    const second = track(waiters.wait());
    assert.equal(waiters.pending, true);
    waiters.resolveAll();
    await settle();
    assert.equal(first.value, 'resolved', 'the first call is not lost to the second');
    assert.equal(second.value, 'resolved');
    assert.equal(waiters.pending, false);
  });

  it('fails every waiting call when the dialog is closed or the console goes away', async () => {
    const waiters = new StepUpWaiters();
    const first = track(waiters.wait());
    const second = track(waiters.wait());
    const cancelled = new Error('cancelled');
    waiters.rejectAll(cancelled);
    await settle();
    assert.equal(first.value, 'rejected');
    assert.equal(first.error, cancelled);
    assert.equal(second.value, 'rejected');
  });

  it('keeps a call that starts waiting after a confirmation for the next one', async () => {
    const waiters = new StepUpWaiters();
    const first = track(waiters.wait());
    waiters.resolveAll();
    const later = track(waiters.wait());
    await settle();
    assert.equal(first.value, 'resolved');
    assert.equal(later.value, 'pending');
    assert.equal(waiters.pending, true);
    waiters.rejectAll(new Error('cancelled'));
    await settle();
    assert.equal(later.value, 'rejected');
  });

  it('tells the dialog when it has someone to answer', () => {
    const waiters = new StepUpWaiters();
    const states: boolean[] = [];
    const stop = waiters.subscribe(() => states.push(waiters.isPending()));
    void waiters.wait().catch(() => undefined);
    void waiters.wait().catch(() => undefined);
    waiters.rejectAll(new Error('cancelled'));
    stop();
    assert.deepEqual(states, [true, true, false]);
  });
});

describe('a step-up request that answers after the sign-out', () => {
  const STEP_UP = new Error('step_up_required');
  const needsCode = (error: unknown) => error === STEP_UP;

  it('fails at once with the cancellation instead of waiting for a dialog that is gone', async () => {
    const waiters = new StepUpWaiters();
    let calls = 0;
    let answer!: () => void;
    const pending = waiters.run(() => {
      calls += 1;
      return new Promise<string>((_resolve, reject) => {
        answer = () => {
          reject(STEP_UP);
        };
      });
    }, needsCode);
    const state = track(pending.then(() => undefined));

    const cancelled = new Error('cancelled');
    waiters.dispose(cancelled); // the console goes away while the request is out
    answer(); // ...and only now does the server ask for the code
    await settle();

    assert.equal(state.value, 'rejected');
    assert.equal(state.error, cancelled);
    assert.equal(calls, 1, 'the action is not sent again');
    assert.equal(waiters.pending, false, 'nobody is left in a queue no dialog can answer');
  });

  it('does not run the action again when the console went away while it waited', async () => {
    const waiters = new StepUpWaiters();
    let calls = 0;
    const pending = waiters.run(() => {
      calls += 1;
      return Promise.reject(STEP_UP);
    }, needsCode);
    const state = track(pending.then(() => undefined));
    await settle();
    assert.equal(waiters.pending, true);
    waiters.dispose(new Error('cancelled'));
    await settle();
    assert.equal(state.value, 'rejected');
    assert.equal(calls, 1);
  });

  it('runs the action again after the code, while the console is there', async () => {
    const waiters = new StepUpWaiters();
    let calls = 0;
    const pending = waiters.run(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(STEP_UP) : Promise.resolve('done');
    }, needsCode);
    await settle();
    waiters.resolveAll();
    assert.equal(await pending, 'done');
    assert.equal(calls, 2);
  });

  it('works again once React mounts the console again (development double mount)', async () => {
    const waiters = new StepUpWaiters();
    waiters.dispose(new Error('cancelled'));
    waiters.activate();
    const state = track(waiters.wait());
    await settle();
    assert.equal(state.value, 'pending');
    waiters.resolveAll();
    await settle();
    assert.equal(state.value, 'resolved');
  });
});
