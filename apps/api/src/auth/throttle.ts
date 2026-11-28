/**
 * The arithmetic of the sign-in limits (ADR 0049), apart from where the numbers are stored. Every decision here is
 * taken under the account lock, with one sampled time per transaction.
 *
 * - Wrong passwords slow new sign-ins down and never end a session. One source (an IPv4 address, an IPv6 /64) gets
 *   five wrong passwords per account in a fixed 15-minute window; then it waits for that window to end. All sources
 *   together get twenty; from the twentieth on, each admitted wrong password makes the account wait 1, 2, 4, then at
 *   most 8 seconds before the next password is checked. A request refused while a wait runs counts nothing and moves
 *   no deadline.
 * - Wrong second factors (an authenticator code or a recovery code) have a count of their own. Only someone who knew
 *   the password, or holds a session, can make one. Pending sign-ins and authenticated step-up use separate budgets.
 */

/** The fixed window of the password counters, from the first failure in it. */
export const PASSWORD_WINDOW_MS = 15 * 60_000;
/** Wrong passwords one source may send for one account per window. */
export const SOURCE_FAILURE_LIMIT = 5;
/** From this many wrong passwords of every source, the account waits between attempts. */
export const ACCOUNT_SLOWDOWN_FROM = 20;
/** The account-wide count stops here: the wait does not grow past `MAX_PASSWORD_WAIT_MS`. */
export const ACCOUNT_FAILURE_CAP = 23;
/** The longest wait between two password checks of one account. */
export const MAX_PASSWORD_WAIT_MS = 8_000;
/** Live rows per account and per failure table. The account budget still applies when the table is full. */
export const MAX_SOURCE_ROWS = 64;
/** The fixed window of the second-factor count. */
export const MFA_WINDOW_MS = 15 * 60_000;

/** A password proof alone does not qualify for the session-specific step-up budget. */
export const PENDING_FACTOR_LIMIT_MULTIPLIER = 2;

export interface PasswordState {
  readonly failures: number;
  readonly windowEndsAt: Date | null;
  readonly retryAt: Date | null;
}

export interface SourceState {
  readonly failures: number;
  readonly windowEndsAt: Date;
}

export interface MfaState {
  readonly failures: number;
  readonly windowEndsAt: Date | null;
  readonly lockedUntil: Date | null;
}

const live = (at: Date | null | undefined, now: Date): at is Date =>
  at != null && at.getTime() > now.getTime();

/** The account-wide password state as it stands at `now`: a window that ended counts nothing any more. */
export function currentPassword(state: PasswordState, now: Date): PasswordState {
  if (!live(state.windowEndsAt, now)) {
    return { failures: 0, windowEndsAt: null, retryAt: null };
  }
  return { ...state, retryAt: live(state.retryAt, now) ? state.retryAt : null };
}

/** A source row that still counts at `now`, or null. */
export function currentSource(state: SourceState | null, now: Date): SourceState | null {
  return state && live(state.windowEndsAt, now) ? state : null;
}

/**
 * How long a password for this account, from this source, must wait at `now` before it is checked. Zero: check it.
 * Covers a correct password as well, so the answer says nothing about the guess.
 */
export function passwordWaitMs(
  account: PasswordState,
  source: SourceState | null,
  now: Date,
): number {
  const a = currentPassword(account, now);
  const s = currentSource(source, now);
  let wait = 0;
  if (a.retryAt) {
    wait = a.retryAt.getTime() - now.getTime();
  }
  if (s && s.failures >= SOURCE_FAILURE_LIMIT) {
    wait = Math.max(wait, s.windowEndsAt.getTime() - now.getTime());
  }
  return Math.max(0, wait);
}

/** The account-wide state after one more wrong password at `now` (one that was admitted, not refused). */
export function afterPasswordFailure(account: PasswordState, now: Date): PasswordState {
  const current = currentPassword(account, now);
  const windowEndsAt = current.windowEndsAt ?? new Date(now.getTime() + PASSWORD_WINDOW_MS);
  const failures = Math.min(current.failures + 1, ACCOUNT_FAILURE_CAP);
  if (failures < ACCOUNT_SLOWDOWN_FROM) {
    return { failures, windowEndsAt, retryAt: null };
  }
  const waitMs = Math.min(1000 * 2 ** (failures - ACCOUNT_SLOWDOWN_FROM), MAX_PASSWORD_WAIT_MS);
  const retryAt = new Date(Math.min(now.getTime() + waitMs, windowEndsAt.getTime()));
  return { failures, windowEndsAt, retryAt };
}

/** The source row after one more wrong password at `now`. */
export function afterSourceFailure(source: SourceState | null, now: Date): SourceState {
  const current = currentSource(source, now);
  if (!current) {
    return { failures: 1, windowEndsAt: new Date(now.getTime() + PASSWORD_WINDOW_MS) };
  }
  return {
    failures: Math.min(current.failures + 1, SOURCE_FAILURE_LIMIT),
    windowEndsAt: current.windowEndsAt,
  };
}

/** Milliseconds the source or step-up session stays locked for the second factor at `now`. */
export function mfaLockMs(state: MfaState | null, now: Date): number {
  return live(state?.lockedUntil, now) ? state.lockedUntil.getTime() - now.getTime() : 0;
}

/**
 * The second-factor state after one more wrong code at `now`. At `threshold` the bucket locks for `lockMs` and the
 * count starts over; `locked` says this failure was the one that locked it.
 */
export function afterMfaFailure(
  state: MfaState | null,
  now: Date,
  threshold: number,
  lockMs: number,
): { readonly state: MfaState; readonly locked: boolean; readonly failures: number } {
  const window = state?.windowEndsAt;
  const failures = (state && live(window, now) ? state.failures : 0) + 1;
  const windowEndsAt = live(window, now) ? window : new Date(now.getTime() + MFA_WINDOW_MS);
  if (failures >= threshold) {
    return {
      state: { failures: 0, windowEndsAt: null, lockedUntil: new Date(now.getTime() + lockMs) },
      locked: true,
      failures,
    };
  }
  return { state: { failures, windowEndsAt, lockedUntil: null }, locked: false, failures };
}

export const CLEARED_PENDING_FACTOR_FAILURES = {
  pendingFactorFailures: 0,
  pendingFactorWindowEndsAt: null,
} as const;

export const CLEARED_STEP_UP_FAILURES = {
  stepUpFailures: 0,
  stepUpWindowEndsAt: null,
  stepUpLockedUntil: null,
} as const;

/**
 * Account-wide password counter back at zero. The per-source rows are deleted alongside.
 */
export const CLEARED_PASSWORD_FAILURES = {
  passwordFailures: 0,
  passwordWindowEndsAt: null,
  passwordRetryAt: null,
} as const;

/** Whole seconds for `Retry-After`, at least one. */
export const retrySeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));
