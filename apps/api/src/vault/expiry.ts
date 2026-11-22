/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Whether a secret has expired. The one place that decides it (ADR 0042): a secret whose `expiresAt` is now or in the
 * past is expired, so the boundary itself counts as expired and a secret never works a moment past its time.
 */
export function isExpired(expiresAt: Date | null, nowMs: number): boolean {
  return expiresAt !== null && expiresAt.getTime() <= nowMs;
}

/**
 * What the views say about the expiry of a secret: whether it passed, and the whole days that are left, rounded up (a
 * secret that expires in an hour has 1 day left, one that expired an hour ago has 0). Null days when there is no expiry.
 */
export function expiryView(
  expiresAt: Date | null,
  nowMs: number,
): { readonly expired: boolean; readonly expiresInDays: number | null } {
  if (expiresAt === null) {
    return { expired: false, expiresInDays: null };
  }
  // `+ 0` turns the -0 that `Math.ceil` gives for "less than a day ago" into 0.
  return {
    expired: isExpired(expiresAt, nowMs),
    expiresInDays: Math.ceil((expiresAt.getTime() - nowMs) / DAY_MS) + 0,
  };
}
