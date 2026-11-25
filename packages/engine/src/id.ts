// The id of a run: a UUIDv7 (RFC 9562), made by the caller, so rows are written in the order the runs were made and the
// oldest queued run is the first in the index (ADR 0048, "The data").

import { randomBytes } from 'node:crypto';

/**
 * A UUIDv7: 48 bits of the time in milliseconds, then random bits with the version and the variant set. `now` and the
 * source of randomness are arguments so that a test can make the same id twice. Two ids made in one millisecond are told
 * apart by their random bits and are not ordered between themselves.
 */
export function uuidv7(now: number, random: (size: number) => Uint8Array = randomBytes): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError('The time of a UUIDv7 is a whole number of milliseconds below 2^48.');
  }
  const bytes = new Uint8Array(16);
  const entropy = random(10);
  if (entropy.length !== 10) {
    throw new RangeError('A UUIDv7 needs ten random bytes.');
  }
  for (let index = 0; index < 6; index += 1) {
    // 48 bits, most significant first; the division keeps the arithmetic exact above 2^32.
    bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) % 256;
  }
  bytes.set(entropy, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
