// The lease and the fence of a run (ADR 0048, "A lease and a fence"): the arithmetic only.
//
// The statements that take and renew a lease are the database layer's. These functions say what they must mean, so the
// real store and the in-memory one of the tests cannot drift apart. Times are milliseconds since the epoch.

import { holdsLease, needsWorker, type RunState } from './run-state.js';

/** The lease lasts three renewal intervals: two renewals can be lost and a live worker still keeps its run. */
export const LEASE_TTL_FACTOR = 3;

function assertInterval(renewIntervalMs: number): void {
  if (!Number.isSafeInteger(renewIntervalMs) || renewIntervalMs <= 0) {
    throw new RangeError(
      'The lease renewal interval must be a positive whole number of milliseconds.',
    );
  }
}

export function leaseTtlMs(renewIntervalMs: number): number {
  assertInterval(renewIntervalMs);
  return renewIntervalMs * LEASE_TTL_FACTOR;
}

export function leaseExpiresAt(now: number, renewIntervalMs: number): number {
  return now + leaseTtlMs(renewIntervalMs);
}

/** A lease that was never taken, or that has run out, is expired: the run may be taken by another worker. */
export function isLeaseExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt === null || expiresAt <= now;
}

/** The fence only grows, by one for every claim of the run. */
export const nextFence = (fence: number): number => fence + 1;

/**
 * A write about a run is accepted only from the worker whose fence is the one on the row. A stalled worker that wakes up
 * after another one took the run has an older fence, so nothing it writes is accepted.
 */
export function fenceAccepts(rowFence: number, writerFence: number): boolean {
  return rowFence === writerFence;
}

/**
 * Can a worker claim a run in this state now? A queued run and a rollback that was asked for can always be claimed; a run
 * that is `running` or `rolling_back` only when the worker that had it let its lease run out.
 */
export function isClaimable(
  state: RunState,
  leaseExpiresAtMs: number | null,
  now: number,
): boolean {
  if (!needsWorker(state)) {
    return false;
  }
  return holdsLease(state) ? isLeaseExpired(leaseExpiresAtMs, now) : true;
}
