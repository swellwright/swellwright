/**
 * Options of a mutation whose answer is a secret (a revealed value, a new token): the answer leaves the mutation cache
 * as soon as nothing shows it, instead of staying there for TanStack Query's default five minutes.
 */
export const NOT_RETAINED = { gcTime: 0 } as const;

/** The expiry field of the secret form: the date (UTC) of the stored instant, or empty. */
export const expiryDateOf = (expiresAt: string | null | undefined): string =>
  expiresAt?.slice(0, 10) ?? '';

/**
 * What a change of a secret sends about its expiry. A date the person did not touch is not sent, so an expiry set to
 * an exact time (through the API) stays as it is; a cleared date removes it; a new date is midnight UTC of that day.
 */
export function expiryChange(
  initial: string | null | undefined,
  date: string,
): { expiresAt?: string | null } {
  if (date === expiryDateOf(initial)) {
    return {};
  }
  return { expiresAt: date === '' ? null : new Date(`${date}T00:00:00.000Z`).toISOString() };
}
