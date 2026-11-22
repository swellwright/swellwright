/**
 * When a panel token expires, read from the token itself. The API tokens of a panel are signed tokens (JWT) with the
 * usual `exp` claim, and the list of API tokens cannot be read with an API token, so the claim is the only way to know
 * the day. The signature is NOT checked: this is only to show a date to the person who holds the token (ADR 0041); the
 * panel decides whether a token works. A token without a readable expiry gives null, and nothing is guessed.
 */
export function tokenExpiry(token: string): Date | null {
  const parts = token.split('.');
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (payload === undefined || payload.length === 0 || payload.length > 4096) {
    return null;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) {
      return null;
    }
    const exp = (claims as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return null;
    }
    // Between 2000 and 2200: a number outside that is not a date in seconds.
    if (exp < 946_684_800 || exp > 7_258_118_400) {
      return null;
    }
    return new Date(exp * 1000);
  } catch {
    return null;
  }
}
