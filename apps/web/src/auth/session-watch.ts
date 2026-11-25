/**
 * Notices that the session of this console is no longer the one the browser has: it ended on the server (expired,
 * revoked, signed out in another tab), or another tab signed in as somebody else and the cookie now belongs to them.
 * A hint starts a check (a 401 from a call, a message from another tab, the tab coming back into view, the network
 * coming back); the check asks the server who is signed in, one request at a time. A wrong password or code is a 401
 * too, so only the answer decides.
 */
export interface SessionWatch {
  /** Something suggests the session may have changed: ask the server. */
  readonly check: () => void;
  /** The console is gone: nothing that is still being checked may act. */
  readonly dispose: () => void;
}

/** An answer of the server about who is signed in, and the one way to publish it. */
export interface SessionAnswer<S> {
  readonly session: S | null;
  /** Writes the answer if it is still current; false when the session changed since the check began. */
  readonly publish: () => boolean;
}

export function createSessionWatch<S extends { readonly user: { readonly id: string } }>(options: {
  /** The account this console was opened for. */
  readonly userId: string;
  /**
   * Who the server says is signed in now (null: nobody), with the way to publish that answer. A failure to ask, or an
   * answer whose `publish` refuses (the session changed meanwhile), changes nothing.
   */
  readonly current: () => Promise<SessionAnswer<S>>;
  /** Nobody is signed in any more (already published). */
  readonly onEnded: () => void;
  /** Another account is signed in now (already published): this console must go. */
  readonly onChanged: (session: S) => void;
}): SessionWatch {
  let checking = false;
  // A hint that came while a check was out: that check's answer may be older than the hint (another tab signed in
  // after the server answered), so it is thrown away and one more check is made. Any number of such hints is one.
  let again = false;
  let done = false;
  const decide = ({ session, publish }: SessionAnswer<S>): void => {
    // Every answer is published, also one about the same account (its role or permissions may have changed). The
    // publication checks, in this same step, that nothing changed the session since the check began.
    if (!publish()) {
      return;
    }
    if (session === null) {
      done = true;
      options.onEnded();
    } else if (session.user.id !== options.userId) {
      done = true;
      options.onChanged(session);
    }
  };
  const run = (): void => {
    checking = true;
    again = false;
    const settle = (answer: SessionAnswer<S> | undefined): void => {
      if (done) {
        return;
      }
      if (again) {
        run();
        return;
      }
      checking = false;
      if (answer !== undefined) {
        decide(answer);
      }
    };
    options.current().then(settle, () => {
      settle(undefined);
    });
  };
  return {
    check: () => {
      if (done) {
        return;
      }
      if (checking) {
        again = true;
        return;
      }
      run();
    },
    dispose: () => {
      done = true;
    },
  };
}

/** The part of `BroadcastChannel` the console uses; a test passes its own. */
export interface SessionChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: () => void): void;
  removeEventListener(type: 'message', listener: () => void): void;
  close(): void;
}

const CHANNEL_NAME = 'swellwright-session';
const openChannel = (): SessionChannel | undefined =>
  typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(CHANNEL_NAME);

/**
 * Tells the other tabs of this console that this tab signed in or out, so they check their own session at once instead
 * of when their next call fails.
 */
export function announceSessionChange(open: () => SessionChannel | undefined = openChannel): void {
  const channel = open();
  if (channel === undefined) {
    return;
  }
  channel.postMessage('changed');
  channel.close();
}

/** Calls `listener` when another tab announces a change. Returns the function that stops listening. */
export function onSessionChange(
  listener: () => void,
  open: () => SessionChannel | undefined = openChannel,
): () => void {
  const channel = open();
  if (channel === undefined) {
    return () => undefined;
  }
  channel.addEventListener('message', listener);
  return () => {
    channel.removeEventListener('message', listener);
    channel.close();
  };
}

/** Calls `listener` when the tab comes back into view or gets the focus: another tab may have changed the account. */
export function onReturnToTab(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  const visible = () => {
    if (document.visibilityState === 'visible') {
      listener();
    }
  };
  window.addEventListener('focus', listener);
  document.addEventListener('visibilitychange', visible);
  return () => {
    window.removeEventListener('focus', listener);
    document.removeEventListener('visibilitychange', visible);
  };
}
