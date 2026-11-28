import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TFunction } from 'i18next';

import type { Namespace } from '@swellwright/i18n';

import { ApiRequestError } from '../src/api.js';
import { describeError } from '../src/auth/messages.js';

/** Says which text was asked for, with its count, instead of translating it. */
const t = ((key: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}:${String(options.count)}`) as unknown as TFunction<
  Namespace[]
>;

const limited = (seconds: number | undefined): ApiRequestError =>
  new ApiRequestError(429, 'rate_limited', 'Too many failed attempts.', seconds);

describe('a refusal to try again yet', () => {
  it('says a short wait in seconds and a long one in minutes', () => {
    assert.equal(describeError(t, limited(1), 'x'), 'errors:rateLimitedSeconds:1');
    assert.equal(describeError(t, limited(8), 'x'), 'errors:rateLimitedSeconds:8');
    assert.equal(describeError(t, limited(59), 'x'), 'errors:rateLimitedSeconds:59');
    assert.equal(describeError(t, limited(60), 'x'), 'errors:rateLimited:1');
    assert.equal(describeError(t, limited(900), 'x'), 'errors:rateLimited:15');
    assert.equal(describeError(t, limited(undefined), 'x'), 'errors:rateLimitedShort');
  });
});
