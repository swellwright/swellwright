import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MutationObserver, onlineManager, QueryClient } from '@tanstack/react-query';

import { SessionQueryClient, SessionQueryClients } from '../src/auth/session-cache.js';
import { createSessionWatch } from '../src/auth/session-watch.js';
import {
  AuthState,
  ME_KEY,
  reconcileEnrollment,
  startedWith,
  SupersededError,
  type RecoveryCodesFor,
  visibleRecoveryCodes,
  watchSessionTransitions,
} from '../src/auth/session-transitions.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const as = (id: string) => ({ user: { id } });

/**
 * The gate without React: its query client, the caches of the sessions, and what it keeps for one person (the
 * recovery codes, the step), wired the way `gate.tsx` wires them.
 */
function gate() {
  const outer = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sessions = new SessionQueryClients();
  const state = {
    codes: undefined as RecoveryCodesFor | undefined,
    step: 'enroll' as string | undefined,
    feedbackClosed: 0,
    toasts: [] as string[],
  };
  const stop = watchSessionTransitions({
    outer,
    sessions,
    closeFeedback: () => {
      state.feedbackClosed += 1;
      state.toasts = [];
    },
    resetLocal: () => {
      state.codes = undefined;
      state.step = undefined;
    },
  });
  const signedInAs = () => (outer.getQueryData(ME_KEY) as { user: { id: string } } | null)?.user.id;
  return { outer, sessions, state, stop, signedInAs };
}

describe('the gate, when the account of the browser changes', () => {
  for (const [label, next] of [
    ['another tab signs in as Bob', as('bob')],
    ['the session ends', null],
  ] as const) {
    it(`hides and forgets Alice's recovery codes when ${label}`, () => {
      const g = gate();
      // Alice finishes enrolling: the codes are shown to her.
      g.state.codes = { userId: 'alice', codes: ['AAAA-BBBB-CCCC'] };
      g.outer.setQueryData(ME_KEY, as('alice'));
      assert.deepEqual(visibleRecoveryCodes(g.state.codes, g.signedInAs()), ['AAAA-BBBB-CCCC']);

      g.outer.setQueryData(ME_KEY, next);
      assert.equal(g.state.codes, undefined, 'forgotten');
      assert.equal(visibleRecoveryCodes(g.state.codes, g.signedInAs()), undefined, 'not shown');
      g.stop();
    });
  }

  it('shows recovery codes only to the account they were made for', () => {
    const held = { userId: 'alice', codes: ['X'] };
    assert.equal(visibleRecoveryCodes(held, 'bob'), undefined);
    assert.equal(visibleRecoveryCodes(held, undefined), undefined);
    assert.deepEqual(visibleRecoveryCodes(held, 'alice'), ['X']);
  });

  it('tears the session down when a refetch (after a reconnect) says nobody, and a late answer stays silent', async () => {
    const g = gate();
    let cookieOf: string | null = 'alice';
    await g.outer.query({
      queryKey: ME_KEY,
      queryFn: () => Promise.resolve(cookieOf === null ? null : as(cookieOf)),
    });
    const alice = g.sessions.clientFor('alice');
    assert.ok(alice instanceof SessionQueryClient);

    // Alice deletes a secret; the answer is late.
    let answer!: (value: { name: string }) => void;
    const observer = new MutationObserver(alice, {
      mutationFn: () =>
        new Promise<{ name: string }>((resolve) => {
          answer = resolve;
        }),
      onSuccess: (deleted) => g.state.toasts.push(`deleted ${deleted.name}`),
    });
    const pending = observer.mutate();

    // Offline, the session expires; the refetch after the reconnect answers "nobody" (not through the gate's own code).
    cookieOf = null;
    await g.outer.refetchQueries({ queryKey: ME_KEY });
    assert.equal(alice.disposed, true, "Alice's cache is disposed");
    assert.equal(g.state.feedbackClosed, 1);
    assert.equal(g.state.step, undefined);

    answer({ name: 'alice-db-password' });
    await pending;
    await settle();
    assert.deepEqual(g.state.toasts, [], 'no toast on the sign-in screen');

    // Bob signs in.
    g.outer.setQueryData(ME_KEY, as('bob'));
    const bob = g.sessions.clientFor('bob');
    assert.notEqual(bob, alice);
    assert.deepEqual(g.state.toasts, []);
    g.stop();
  });

  it('does not tear anything down when somebody signs in where nobody was, or the same account is read again', () => {
    const g = gate();
    g.outer.setQueryData(ME_KEY, null);
    g.outer.setQueryData(ME_KEY, as('alice'));
    const alice = g.sessions.clientFor('alice');
    assert.ok(alice instanceof SessionQueryClient);
    g.outer.setQueryData(ME_KEY, as('alice'));
    assert.equal(g.state.feedbackClosed, 0);
    assert.equal(alice.disposed, false);
    g.stop();
  });

  it('does not let an older "nobody" answer undo a sign-in that came after it', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    g.outer.setQueryData(ME_KEY, null);
    // Signed out here; another tab's message makes the gate ask again, and that answer is slow.
    let answer!: (value: null) => void;
    const refetch = g.outer
      .query({
        queryKey: ME_KEY,
        queryFn: () =>
          new Promise<null>((resolve) => {
            answer = resolve;
          }),
        staleTime: 0,
      })
      .catch(() => undefined);
    await settle();

    // Meanwhile Alice finishes enrolling in this tab: her codes are shown and her session committed.
    g.state.codes = { userId: 'alice', codes: ['AAAA-BBBB-CCCC'] };
    auth.commit(as('alice'));
    const alice = g.sessions.clientFor('alice');
    assert.ok(alice instanceof SessionQueryClient);

    answer(null); // the old answer arrives
    await refetch;
    await settle();

    assert.equal(g.signedInAs(), 'alice', 'the session survives');
    assert.deepEqual(visibleRecoveryCodes(g.state.codes, g.signedInAs()), ['AAAA-BBBB-CCCC']);
    assert.equal(alice.disposed, false);
    assert.equal(g.state.feedbackClosed, 0);
    g.stop();
  });

  it('throws away a check that a sign-in or a sign-out of this tab outran', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    let answer!: (value: { user: { id: string } }) => void;
    const check = auth.check(
      () =>
        new Promise<{ user: { id: string } }>((resolve) => {
          answer = resolve;
        }),
    );
    auth.commit(null); // this tab signed out while the check was out
    answer(as('alice'));
    await assert.rejects(check, SupersededError);
    assert.equal(g.signedInAs(), undefined);
    g.stop();
  });

  it('puts changed permissions of the same account into the console without tearing it down', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    auth.commit({ user: { id: 'alice' }, permissions: ['servers:read'] });
    const alice = g.sessions.clientFor('alice');
    assert.ok(alice instanceof SessionQueryClient);
    alice.setQueryData(['draft'], 'unsaved text');

    const checked = await auth.check(() =>
      Promise.resolve({ user: { id: 'alice' }, permissions: ['servers:read', 'servers:write'] }),
    );
    assert.equal(checked.publish(), true);
    assert.deepEqual(g.outer.getQueryData<{ permissions: string[] }>(ME_KEY)?.permissions, [
      'servers:read',
      'servers:write',
    ]);
    assert.equal(alice.disposed, false);
    assert.equal(alice.getQueryData(['draft']), 'unsaved text', 'what is open stays');
    assert.equal(g.state.feedbackClosed, 0);
    g.stop();
  });

  it('does not publish a check accepted just before a sign-out committed (exact microtask order)', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    auth.commit(as('alice'));
    const outcome: string[] = [];
    const watch = createSessionWatch<{ user: { id: string } }>({
      userId: 'alice',
      current: () => auth.check(() => read.promise),
      onEnded: () => outcome.push('ended'),
      onChanged: (session) => outcome.push(`changed to ${session.user.id}`),
    });
    let resolveRead!: (value: { user: { id: string } }) => void;
    const read = {
      promise: new Promise<{ user: { id: string } }>((resolve) => {
        resolveRead = resolve;
      }),
    };
    watch.check();
    await settle();

    // 1: the read answers Alice, so the check's continuation (generation still current) runs first;
    // 2: the sign-out of this tab commits null in the very next microtask;
    // 3: only then does the watch get the accepted answer and try to publish Alice again.
    resolveRead(as('alice'));
    queueMicrotask(() => {
      auth.commit(null);
    });
    await settle();
    await settle();

    assert.equal(g.signedInAs(), undefined, 'the sign-out stands: Alice is not published back');
    assert.equal(g.outer.getQueryData(ME_KEY), null);
    assert.deepEqual(outcome, []);
    watch.dispose();
    g.stop();
  });

  it('does not commit a sign-in whose answer arrives after another account was read', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    g.outer.setQueryData(ME_KEY, null);

    // Alice sends her code; the headers come, the body stalls.
    let body!: (value: { user: { id: string } }) => void;
    const signingIn = startedWith(
      auth,
      auth.ticket(),
      () =>
        new Promise<{ user: { id: string } }>((resolve) => {
          body = resolve;
        }),
    );
    // Another tab signs in as Bob, and this tab reads Bob (the refetch the other tab's message caused).
    await g.outer.query({
      queryKey: ME_KEY,
      queryFn: () => Promise.resolve(as('bob')),
      staleTime: 0,
    });
    assert.equal(g.signedInAs(), 'bob');

    body(as('alice'));
    const { value, ticket } = await signingIn;
    assert.equal(auth.commitIf(ticket, value), false, 'superseded: not committed');
    assert.equal(g.signedInAs(), 'bob', "Bob's session stays");
    g.stop();
  });

  it('commits a sign-in when nothing changed while it was on its way', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    g.outer.setQueryData(ME_KEY, null);
    const { value, ticket } = await startedWith(auth, auth.ticket(), () =>
      Promise.resolve(as('alice')),
    );
    // A refetch that still says "nobody" is not a change of the session.
    await g.outer.query({ queryKey: ME_KEY, queryFn: () => Promise.resolve(null), staleTime: 0 });
    assert.equal(auth.commitIf(ticket, value), true);
    assert.equal(g.signedInAs(), 'alice');
    g.stop();
  });

  it('still shows the recovery codes when the server named the enrolled account before the confirmation answered', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    g.outer.setQueryData(ME_KEY, null);

    // Alice confirms her authenticator; the server sets her cookie, the body of the answer is slow.
    const ticket = auth.ticket();
    // Meanwhile another tab's message makes this tab ask /auth/me, which already names Alice.
    const early = await auth.check(() => Promise.resolve(as('alice')));
    assert.equal(early.publish(), true);
    assert.equal(g.signedInAs(), 'alice');

    // The confirmation answers now, with the codes: its ticket is old.
    assert.equal(auth.commitIf(ticket, as('alice')), false);
    const mine = await reconcileEnrollment(auth, 'alice', () => Promise.resolve(as('alice')));
    assert.equal(mine, true, 'the codes are for the account signed in: they are shown');
    g.state.codes = { userId: 'alice', codes: ['AAAA-BBBB-CCCC'] };
    assert.deepEqual(visibleRecoveryCodes(g.state.codes, g.signedInAs()), ['AAAA-BBBB-CCCC']);
    g.stop();
  });

  it('drops superseded recovery codes when the server names another account', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    g.outer.setQueryData(ME_KEY, null);
    const ticket = auth.ticket();
    (await auth.check(() => Promise.resolve(as('bob')))).publish();
    assert.equal(auth.commitIf(ticket, as('alice')), false);
    assert.equal(await reconcileEnrollment(auth, 'alice', () => Promise.resolve(as('bob'))), false);
    assert.equal(g.signedInAs(), 'bob');
    g.stop();
  });

  it('never sends a sign-in that waited for the network while another account was read', async () => {
    const g = gate();
    const auth = new AuthState(g.outer);
    g.outer.setQueryData(ME_KEY, null);
    g.outer.mount();
    let sent = 0;
    onlineManager.setOnline(false);
    try {
      // Alice submits her password while offline: the ticket is taken in the submit handler, the mutation pauses.
      const form = new MutationObserver(g.outer, {
        mutationFn: (submitted: { ticket: number; password: string }) =>
          startedWith(auth, submitted.ticket, () => {
            sent += 1;
            return Promise.resolve(as('alice'));
          }),
      });
      const result = form.mutate({ ticket: auth.ticket(), password: 'x' }).then(
        () => 'committed',
        (error: unknown) => (error instanceof SupersededError ? 'superseded' : 'failed'),
      );
      await settle();
      assert.equal(form.getCurrentResult().isPaused, true);

      // An answer of /auth/me names Bob; the form unmounts; the network comes back.
      g.outer.setQueryData(ME_KEY, as('bob'));
      form.reset();
      onlineManager.setOnline(true);

      assert.equal(await result, 'superseded');
      assert.equal(sent, 0, 'the request is never sent');
      assert.equal(g.signedInAs(), 'bob');
    } finally {
      onlineManager.setOnline(true);
      g.outer.unmount();
      g.stop();
    }
  });

  it('forgets the authenticator secret being enrolled for the previous account', () => {
    const g = gate();
    g.outer.setQueryData(ME_KEY, as('alice'));
    g.outer.setQueryData(['auth', 'enrollment'], { secret: 'alice-totp-secret' });
    g.outer.setQueryData(ME_KEY, as('bob'));
    assert.equal(g.outer.getQueryData(['auth', 'enrollment']), undefined);
    g.stop();
  });
});
