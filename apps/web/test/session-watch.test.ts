import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  announceSessionChange,
  createSessionWatch,
  onSessionChange,
  type SessionChannel,
} from '../src/auth/session-watch.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Session {
  readonly user: { readonly id: string };
}
const as = (id: string): Session => ({ user: { id } });

/** A watch for Alice's console that records what it decided. */
function aliceWatch(current: () => Promise<Session | null>, stillCurrent = () => true) {
  const outcome: { ended: number; changedTo: string[] } = { ended: 0, changedTo: [] };
  /** Every answer the watch published (about the same account too). */
  const same: (Session | null)[] = [];
  const watch = createSessionWatch<Session>({
    userId: 'alice',
    current: () =>
      current().then((session) => ({
        session,
        publish: () => {
          if (!stillCurrent()) {
            return false;
          }
          same.push(session);
          return true;
        },
      })),
    onEnded: () => {
      outcome.ended += 1;
    },
    onChanged: (session) => {
      outcome.changedTo.push(session.user.id);
    },
  });
  return { watch, outcome, same };
}

/** BroadcastChannel between tabs, in memory: every channel of the bus hears what another posts. */
class FakeBus {
  readonly #open = new Set<FakeChannel>();
  open = (): SessionChannel => new FakeChannel(this.#open);
}
class FakeChannel implements SessionChannel {
  readonly #listeners = new Set<() => void>();
  readonly #bus: Set<FakeChannel>;
  constructor(bus: Set<FakeChannel>) {
    this.#bus = bus;
    bus.add(this);
  }
  postMessage(): void {
    for (const channel of this.#bus) {
      if (channel !== this) {
        for (const listener of channel.#listeners) {
          listener();
        }
      }
    }
  }
  addEventListener(_type: 'message', listener: () => void): void {
    this.#listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: () => void): void {
    this.#listeners.delete(listener);
  }
  close(): void {
    this.#bus.delete(this);
  }
}

describe('noticing that the session of the console changed', () => {
  it('ends the session once when the server says nobody is signed in', async () => {
    let asked = 0;
    const { watch, outcome } = aliceWatch(() => {
      asked += 1;
      return Promise.resolve(null);
    });
    // Several calls fail with 401 at once (the page's queries, a poll): one check, and one more after it.
    watch.check();
    watch.check();
    watch.check();
    await settle();
    watch.check();
    await settle();
    assert.equal(asked, 2);
    assert.equal(outcome.ended, 1);
  });

  it('does not drop a hint that comes while a check is out: the older answer is thrown away', async () => {
    const answers: ((session: Session | null) => void)[] = [];
    const { watch, outcome } = aliceWatch(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    watch.check(); // a 401, say; the first /auth/me is held
    watch.check(); // meanwhile another tab signs in as Bob and says so
    watch.check(); // and the tab gets the focus: still one more check, not two
    assert.equal(answers.length, 1);

    answers[0]?.(as('alice')); // the first answer was made before Bob signed in
    await settle();
    assert.deepEqual(outcome, { ended: 0, changedTo: [] }, 'not accepted: it is superseded');
    assert.equal(answers.length, 2, 'one more check is made');

    answers[1]?.(as('bob'));
    await settle();
    assert.deepEqual(outcome.changedTo, ['bob']);
  });

  it('replaces the console when another account is signed in now (not "still signed in")', async () => {
    // Alice's call got a 401 because another tab signed in as Bob: the check answers Bob's session.
    const { watch, outcome } = aliceWatch(() => Promise.resolve(as('bob')));
    watch.check();
    await settle();
    assert.equal(outcome.ended, 0);
    assert.deepEqual(outcome.changedTo, ['bob']);
  });

  it('keeps the session when the 401 was about a wrong password or code', async () => {
    let asked = 0;
    const { watch, outcome } = aliceWatch(() => {
      asked += 1;
      return Promise.resolve(as('alice'));
    });
    watch.check();
    await settle();
    watch.check();
    await settle();
    assert.deepEqual(outcome, { ended: 0, changedTo: [] });
    assert.equal(asked, 2, 'each later hint is checked again');
  });

  it('hands on every answer about the same account, so changed permissions reach the console', async () => {
    const fresh = { user: { id: 'alice' }, permissions: ['servers:read', 'vault:reveal'] };
    const { watch, outcome, same } = aliceWatch(() => Promise.resolve(fresh));
    watch.check();
    await settle();
    assert.deepEqual(outcome, { ended: 0, changedTo: [] }, 'not an account change');
    assert.deepEqual(same, [fresh]);
  });

  it('acts on nothing when its answer can no longer be published', async () => {
    const { watch, outcome, same } = aliceWatch(
      () => Promise.resolve(as('bob')),
      () => false,
    );
    watch.check();
    await settle();
    assert.deepEqual(outcome, { ended: 0, changedTo: [] });
    assert.deepEqual(same, []);
  });

  it('keeps the session when the question itself fails', async () => {
    const { watch, outcome } = aliceWatch(() => Promise.reject(new Error('offline')));
    watch.check();
    await settle();
    assert.deepEqual(outcome, { ended: 0, changedTo: [] });
  });

  it('does nothing once the console is gone', async () => {
    let answer!: (session: Session | null) => void;
    const { watch, outcome } = aliceWatch(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    watch.check();
    watch.dispose();
    answer(as('bob'));
    await settle();
    assert.deepEqual(outcome, { ended: 0, changedTo: [] });
  });

  it('hears another tab that signed in as somebody else, without waiting for a 401', async () => {
    const bus = new FakeBus();
    let cookieOf = 'alice';
    const { watch, outcome } = aliceWatch(() => Promise.resolve(as(cookieOf)));
    const stop = onSessionChange(watch.check, bus.open);

    // The other tab signs in as Bob and says so.
    cookieOf = 'bob';
    announceSessionChange(bus.open);
    await settle();
    assert.deepEqual(outcome.changedTo, ['bob']);
    stop();
  });

  it('stops listening to the other tabs when asked', async () => {
    const bus = new FakeBus();
    let heard = 0;
    const stop = onSessionChange(() => {
      heard += 1;
    }, bus.open);
    stop();
    announceSessionChange(bus.open);
    await settle();
    assert.equal(heard, 0);
  });
});
