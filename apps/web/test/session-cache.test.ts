import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';

import { SessionQueryClients } from '../src/auth/session-cache.js';
import { NOT_RETAINED } from '../src/security/secret-form.js';

const SESSIONS_KEY = ['security', 'sessions', 'mine'] as const;

/** A promise whose answer the test gives when it wants: a request still on its way. */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets the queued microtasks (query and observer updates) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What a page sees first when it opens: the observer's result, as `useQuery` returns it. */
function observe(client: QueryClient, queryFn: () => Promise<string[]>) {
  const observer = new QueryObserver<string[]>(client, { queryKey: SESSIONS_KEY, queryFn });
  const seen: (string[] | undefined)[] = [observer.getCurrentResult().data];
  const stop = observer.subscribe((result) => seen.push(result.data));
  return { observer, seen, stop };
}

describe('the cache of a signed-in session', () => {
  it('shows the next account nothing of the previous one while its own request is pending', async () => {
    const clients = new SessionQueryClients();

    // Alice reads her sessions, then signs out.
    const alice = clients.clientFor('alice');
    await alice.query({
      queryKey: SESSIONS_KEY,
      queryFn: () => Promise.resolve(['alice-ip']),
    });
    assert.deepEqual(alice.getQueryData(SESSIONS_KEY), ['alice-ip']);
    clients.end();

    // Bob signs in in the same tab and opens the same page; his answer is held.
    const bob = clients.clientFor('bob');
    assert.notEqual(bob, alice);
    const answer = held<string[]>();
    const page = observe(bob, () => answer.promise);
    await settle();
    assert.equal(page.observer.getCurrentResult().isPending, true);
    assert.ok(
      page.seen.every((data) => data === undefined),
      'nothing of Alice is shown while Bob waits',
    );

    answer.resolve(['bob-ip']);
    await settle();
    assert.deepEqual(page.observer.getCurrentResult().data, ['bob-ip']);
    assert.ok(!JSON.stringify(page.seen).includes('alice-ip'));
    page.stop();
  });

  it('a shared cache, as before, would have shown the previous account: the test above guards that', async () => {
    // The old behaviour, kept as a negative: one client for both accounts shows Alice's rows to Bob at once.
    const clients = new SessionQueryClients();
    const shared = clients.clientFor('tab');
    await shared.query({
      queryKey: SESSIONS_KEY,
      queryFn: () => Promise.resolve(['alice-ip']),
    });
    const answer = held<string[]>();
    const page = observe(shared, () => answer.promise);
    assert.deepEqual(page.seen[0], ['alice-ip']);
    page.stop();
    answer.resolve([]);
  });

  it('does not let a request of the previous session fill the next one', async () => {
    const clients = new SessionQueryClients();
    const alice = clients.clientFor('alice');
    const late = held<string[]>();
    const pending = alice.query({ queryKey: SESSIONS_KEY, queryFn: () => late.promise });

    clients.end();
    const bob = clients.clientFor('bob');
    late.resolve(['alice-ip']);
    await pending.catch(() => undefined);
    await settle();

    assert.equal(bob.getQueryData(SESSIONS_KEY), undefined);
    assert.equal(alice.getQueryCache().getAll().length, 0, 'the old cache is emptied');
  });

  it('gives a different account a new cache even without a sign-out in between', () => {
    const clients = new SessionQueryClients();
    const alice = clients.clientFor('alice');
    alice.setQueryData(SESSIONS_KEY, ['alice-ip']);
    assert.equal(clients.clientFor('alice'), alice, 'the same session keeps its cache');
    const bob = clients.clientFor('bob');
    assert.equal(bob.getQueryData(SESSIONS_KEY), undefined);
    assert.equal(alice.getQueryData(SESSIONS_KEY), undefined, 'the previous cache is dropped');
  });

  it('drops a secret answer from the mutation cache as soon as it is let go', async () => {
    const clients = new SessionQueryClients();
    const client = clients.clientFor('alice');
    const observer = new MutationObserver(client, {
      ...NOT_RETAINED,
      mutationFn: () => Promise.resolve({ value: 's3cret' }),
    });
    await observer.mutate();
    assert.equal(client.getMutationCache().getAll().length, 1);
    observer.reset();
    await settle();
    assert.equal(client.getMutationCache().getAll().length, 0);
    clients.end();
  });
});

describe('what a session started, after it ended', () => {
  it('keeps the callbacks of a late mutation answer from acting in the next session', async () => {
    const clients = new SessionQueryClients();
    const alice = clients.clientFor('alice');
    const toasts: string[] = [];
    const answer = held<{ name: string }>();
    // Alice deletes a secret; the page would toast its name when the answer comes.
    const observer = new MutationObserver(alice, {
      mutationFn: () => answer.promise,
      onSuccess: (deleted) => toasts.push(`deleted ${deleted.name}`),
      onSettled: () => toasts.push('settled'),
    });
    const pending = observer.mutate().catch(() => undefined);

    clients.end(); // Alice signs out
    clients.clientFor('bob'); // Bob signs in before the answer arrives
    answer.resolve({ name: 'alice-db-password' });
    await pending;
    await settle();

    assert.deepEqual(toasts, [], "Bob sees nothing of Alice's late answer");
  });

  it('runs those callbacks while the session lasts', async () => {
    const clients = new SessionQueryClients();
    const alice = clients.clientFor('alice');
    const toasts: string[] = [];
    const observer = new MutationObserver(alice, {
      mutationFn: () => Promise.resolve({ name: 'x' }),
      onSuccess: (deleted) => toasts.push(deleted.name),
    });
    await observer.mutate();
    assert.deepEqual(toasts, ['x']);
    // Passing the options through again does not wrap them twice.
    const options = alice.defaultMutationOptions(alice.defaultMutationOptions(observer.options));
    assert.equal(options.onSuccess, observer.options.onSuccess);
    clients.end();
  });

  it('keeps a confirmation opened by one session from acting in the next', () => {
    const clients = new SessionQueryClients();
    clients.clientFor('alice');
    const done: string[] = [];
    // Alice opens "Delete user carol?"; the dialog outlives her session.
    const confirm = clients.fence(() => done.push('delete carol'));

    clients.end();
    clients.clientFor('bob');
    confirm();
    assert.equal(done.length, 0, "the confirm button does not act with Bob's cookie");

    // The same dialog in a session that is still on: it acts.
    const bobs = clients.fence(() => done.push('bob confirmed'));
    bobs();
    assert.deepEqual(done, ['bob confirmed']);
  });

  it('keeps a confirmation from acting when the same account signed in again', () => {
    const clients = new SessionQueryClients();
    clients.clientFor('alice');
    const done: string[] = [];
    const confirm = clients.fence(() => done.push('x'));
    clients.end();
    clients.clientFor('alice');
    confirm();
    assert.equal(done.length, 0);
  });
});
