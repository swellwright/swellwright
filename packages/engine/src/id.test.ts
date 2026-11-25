import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { uuidv7 } from './id.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('uuidv7', () => {
  it('writes the time in the first 48 bits, the version 7 and the variant 10', () => {
    const id = uuidv7(0x018f_6b1e_c0de, () => new Uint8Array(10).fill(0xff));
    assert.equal(id, '018f6b1e-c0de-7fff-bfff-ffffffffffff');
    assert.match(id, UUID_V7);
  });

  it('keeps the time exact above 2^32 and at the largest value', () => {
    assert.equal(uuidv7(2 ** 48 - 1, () => new Uint8Array(10)).slice(0, 13), 'ffffffff-ffff');
    assert.equal(uuidv7(0, () => new Uint8Array(10)).slice(0, 13), '00000000-0000');
    assert.equal(uuidv7(2 ** 32, () => new Uint8Array(10)).slice(0, 13), '00010000-0000');
  });

  it('is ordered by the time and is random in the rest', () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_000_001);
    assert.ok(earlier < later);
    assert.match(earlier, UUID_V7);
    assert.notEqual(uuidv7(1_700_000_000_000), earlier);
  });

  it('refuses a time that is not a whole number below 2^48, and the wrong amount of randomness', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 48]) {
      assert.throws(() => uuidv7(bad), RangeError);
    }
    assert.throws(() => uuidv7(1, () => new Uint8Array(9)), RangeError);
  });
});
