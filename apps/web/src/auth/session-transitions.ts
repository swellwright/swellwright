import { hashKey, type QueryClient } from '@tanstack/react-query';

import type { SessionQueryClients } from './session-cache.js';

/** The query of the gate: who is signed in (null: nobody). */
export const ME_KEY = ['auth', 'me'] as const;
const ME_HASH = hashKey(ME_KEY);

/** Queries of the sign-in screens that belong to one person (the authenticator secret being enrolled). */
const PERSONAL_AUTH_KEYS = [['auth', 'enrollment']] as const;

/** The account a value of the gate's query names: an id, null for "nobody", undefined while not known. */
function principalOf(data: unknown): string | null | undefined {
  if (data === null) {
    return null;
  }
  if (typeof data === 'object') {
    const user = (data as { user?: { id?: unknown } }).user;
    return typeof user?.id === 'string' ? user.id : undefined;
  }
  return undefined;
}

/**
 * Tears a session down whenever the account the gate's query names changes away from it: to nobody or to another
 * account, whatever changed it (a sign-out, the watch, a refetch after a reconnect, another tab). It listens to the
 * query cache itself, so no path can skip it, and it acts synchronously, before React draws the next screen.
 * Returns the function that stops listening.
 */
export function watchSessionTransitions(options: {
  /** The client of the sign-in screens, which holds the gate's query. */
  readonly outer: QueryClient;
  readonly sessions: SessionQueryClients;
  /** Closes the dialogs and the toasts of the session. */
  readonly closeFeedback: () => void;
  /** Resets what the gate keeps for one person (the recovery codes, the step). */
  readonly resetLocal: () => void;
}): () => void {
  const cache = options.outer.getQueryCache();
  let principal = principalOf(cache.get(ME_HASH)?.state.data);
  return cache.subscribe((event) => {
    if (event.query.queryHash !== ME_HASH || event.type !== 'updated') {
      return;
    }
    const next = principalOf(event.query.state.data);
    if (next === undefined || next === principal) {
      return;
    }
    const previous = principal;
    principal = next;
    if (typeof previous !== 'string') {
      return; // somebody signed in where nobody was: nothing to tear down
    }
    options.closeFeedback();
    options.sessions.end();
    for (const key of PERSONAL_AUTH_KEYS) {
      options.outer.removeQueries({ queryKey: key });
    }
    options.resetLocal();
  });
}

/** A check or a sign-in step whose answer was outrun by a newer change of the session. */
export class SupersededError extends Error {
  constructor() {
    super('A newer answer about the session is already in.');
  }
}

/** The generation of the session an operation started in: its answer counts only while that is still the one. */
export type AuthTicket = number;

/** The answer of a check, with the one way to publish it: valid only while no newer change came. */
export interface CheckedSession<S> {
  readonly session: S;
  /** Writes the answer if nothing changed the session since the check started; false when it was superseded. */
  readonly publish: () => boolean;
}

/**
 * The one writer of the gate's query. Several things learn who is signed in: this tab's own sign-in and sign-out, the
 * watch's checks, and a refetch the gate asks for. Each change of the account named by the query (whoever made it)
 * starts a new generation, and so does every sign-in or sign-out of this tab. An operation (a check, a sign-in step)
 * takes a ticket when it starts; its answer is written only if the ticket is still current, and that is verified in
 * the same synchronous step as the write, so nothing can slip in between. A write also cancels any fetch of the query
 * still out, which TanStack would otherwise let overwrite the new value later.
 */
export class AuthState {
  #generation = 0;
  #principal: string | null | undefined;
  readonly #outer: QueryClient;
  #stop: (() => void) | undefined;

  constructor(outer: QueryClient) {
    this.#outer = outer;
    this.follow();
  }

  /** Follows the query (again, after `dispose`: React mounts an effect twice in development). */
  follow(): void {
    if (this.#stop !== undefined) {
      return;
    }
    const cache = this.#outer.getQueryCache();
    this.#principal = principalOf(cache.get(ME_HASH)?.state.data);
    this.#stop = cache.subscribe((event) => {
      if (event.query.queryHash !== ME_HASH || event.type !== 'updated') {
        return;
      }
      const next = principalOf(event.query.state.data);
      if (next !== undefined && next !== this.#principal) {
        this.#principal = next;
        this.#generation += 1;
      }
    });
  }

  /** Stops following the query. */
  dispose(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** The account the gate's query names now: an id, null for nobody, undefined while not known. */
  get principal(): string | null | undefined {
    return this.#principal;
  }

  /** Taken when an operation starts. */
  ticket(): AuthTicket {
    return this.#generation;
  }

  isCurrent(ticket: AuthTicket): boolean {
    return ticket === this.#generation;
  }

  /** The result of this tab's own sign-out (null), or a sign-in nothing can outrun. */
  commit(session: unknown): void {
    this.#generation += 1;
    this.#write(session);
  }

  /**
   * The result of a sign-in step that started with `ticket`: committed only if no change of the session came since,
   * checked and written in one step. False when it was superseded (the caller asks the server instead).
   */
  commitIf(ticket: AuthTicket, session: unknown): boolean {
    if (!this.isCurrent(ticket)) {
      return false;
    }
    this.commit(session);
    return true;
  }

  /**
   * Asks `read` who is signed in. Rejects with `SupersededError` when the session changed while it asked; otherwise
   * gives the answer with a `publish` that writes it only if the session still has not changed when it is called.
   * Every published answer reaches the console, also one that only changed the permissions or the role; the watch of
   * transitions tears down only when the account changed.
   */
  async check<S>(read: () => Promise<S>): Promise<CheckedSession<S>> {
    const ticket = this.ticket();
    const session = await read();
    if (!this.isCurrent(ticket)) {
      throw new SupersededError();
    }
    return {
      session,
      publish: () => {
        if (!this.isCurrent(ticket)) {
          return false;
        }
        this.#write(session);
        return true;
      },
    };
  }

  #write(session: unknown): void {
    void this.#outer.cancelQueries({ queryKey: ME_KEY });
    this.#outer.setQueryData(ME_KEY, session);
  }
}

/** Recovery codes, with the account they were made for: they are shown to that account only. */
export interface RecoveryCodesFor {
  readonly userId: string;
  readonly codes: readonly string[];
}

/** The codes to show now: none when the account signed in is not the one they were made for. */
export const visibleRecoveryCodes = (
  held: RecoveryCodesFor | undefined,
  signedInAs: string | undefined,
): readonly string[] | undefined =>
  held !== undefined && held.userId === signedInAs ? held.codes : undefined;

/**
 * Runs a sign-in step (a password, a code, an enrollment) with the ticket its submit handler took, and gives its
 * answer with that ticket. A step whose session changed before it could start (it waited for the network, and another
 * account was read meanwhile) is not sent at all: it fails with `SupersededError`, which the forms do not report.
 */
export async function startedWith<R>(
  auth: { isCurrent(ticket: AuthTicket): boolean },
  ticket: AuthTicket,
  run: () => Promise<R>,
): Promise<{ readonly value: R; readonly ticket: AuthTicket }> {
  if (!auth.isCurrent(ticket)) {
    throw new SupersededError();
  }
  return { value: await run(), ticket };
}

/**
 * An enrollment confirmed after the session changed (its answer was slow, and the server was asked meanwhile): the
 * cookie may well be the new account's own. Asks the server who is signed in, publishes it, and tells whether that is
 * the account the recovery codes were made for, so that they are shown to it (they cannot be read again later).
 */
export async function reconcileEnrollment(
  auth: AuthState,
  enrolledId: string,
  read: () => Promise<unknown>,
): Promise<boolean> {
  try {
    const checked = await auth.check(read);
    checked.publish();
  } catch {
    // Superseded or unreachable: what the gate holds now decides.
  }
  return auth.principal === enrolledId;
}
