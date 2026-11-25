import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOpenApi } from './openapi.js';
import {
  AcceptInvitationRequestSchema,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  PasswordSchema,
  SetupOwnerRequestSchema,
  TotpCodeRequestSchema,
  UsernameSchema,
  USER_ROLES,
} from './index.js';

type Json = Record<string, unknown>;

describe('sign-in schemas', () => {
  it('accepts only lower-case login names of 2 to 32 characters', () => {
    for (const ok of ['ab', 'owner', 'a.b-c_d', 'a'.repeat(32), '0day']) {
      assert.ok(UsernameSchema.safeParse(ok).success, ok);
    }
    for (const bad of ['a', 'Owner', '-ab', '.ab', 'a b', 'a'.repeat(33), '', 'ab@example.com']) {
      assert.ok(!UsernameSchema.safeParse(bad).success, bad);
    }
  });

  it('applies the password policy only when a password is chosen', () => {
    assert.ok(PasswordSchema.safeParse('a-long-enough-passphrase').success);
    assert.ok(!PasswordSchema.safeParse('short').success);
    assert.ok(!PasswordSchema.safeParse('x'.repeat(129)).success);
    // A login must not reveal the policy or fail early on an old, shorter password.
    assert.ok(LoginRequestSchema.safeParse({ username: 'owner', password: 'short' }).success);
    assert.ok(
      !SetupOwnerRequestSchema.safeParse({ setupToken: 't', username: 'owner', password: 'short' })
        .success,
    );
  });

  it('counts the length of a chosen password after NFKC normalization, as the hash sees it', () => {
    const fullwidthDigits = '１２３４５６７８９０１２'; // fullwidth digits fold to ASCII, one each
    assert.ok(PasswordSchema.safeParse(fullwidthDigits).success);
    // `ﬃ` is one code unit typed and three characters hashed: four of them and two letters make 14.
    const contracts = 'ﬃﬃﬃﬃab';
    assert.equal(contracts.length, 6);
    assert.ok(PasswordSchema.safeParse(contracts).success, 'long enough after normalization');
    // 43 ligatures are 43 code units and 129 characters once normalized: too long.
    assert.ok(!PasswordSchema.safeParse('ﬃ'.repeat(43)).success);
    assert.ok(PasswordSchema.safeParse(`${'ﬃ'.repeat(42)}ab`).success, '128 is the bound');
    // A decomposed é (two code units) is one character after NFKC: 21 code units typed, eleven hashed.
    const decomposed = `${'é'.repeat(10)}x`;
    assert.equal(decomposed.length, 21);
    assert.ok(!PasswordSchema.safeParse(decomposed).success, 'eleven characters, not 21');
    assert.ok(PasswordSchema.safeParse(`${'é'.repeat(11)}x`).success, 'twelve is enough');
    // The exact bounds, and the raw cap on what is sent at all.
    assert.ok(!PasswordSchema.safeParse('x'.repeat(11)).success);
    assert.ok(PasswordSchema.safeParse('x'.repeat(12)).success);
    assert.ok(PasswordSchema.safeParse('x'.repeat(128)).success);
    assert.ok(!PasswordSchema.safeParse('x'.repeat(129)).success);
    // Every request that chooses a password applies the rule; the value itself is kept as typed.
    for (const schema of [
      SetupOwnerRequestSchema.shape.password,
      AcceptInvitationRequestSchema.shape.password,
      ChangePasswordRequestSchema.shape.newPassword,
    ]) {
      assert.ok(!schema.safeParse(decomposed).success);
      assert.equal(schema.parse(contracts), contracts);
    }
    // A password chosen before still passes the login and current-password checks.
    assert.ok(LoginRequestSchema.safeParse({ username: 'owner', password: decomposed }).success);
    assert.ok(ChangePasswordRequestSchema.shape.currentPassword.safeParse(fullwidthDigits).success);
  });

  it('takes a six-digit code or a longer recovery code', () => {
    assert.ok(TotpCodeRequestSchema.safeParse({ code: '123456' }).success);
    assert.ok(TotpCodeRequestSchema.safeParse({ code: 'ABCD-EFGH-IJKL' }).success);
    assert.ok(!TotpCodeRequestSchema.safeParse({ code: '123' }).success);
  });

  it('lists the five built-in roles', () => {
    assert.deepEqual([...USER_ROLES], ['owner', 'operator', 'observer', 'terminal', 'auditor']);
  });
});

describe('OpenAPI description of the sign-in routes', () => {
  const doc = buildOpenApi() as { paths: Record<string, Record<string, Json>> };

  it('marks entry points as public and the rest as needing the session cookie', () => {
    const security = (path: string, method: string): unknown =>
      doc.paths[path]?.[method]?.['security'];
    for (const [path, method] of [
      ['/setup/status', 'get'],
      ['/setup/owner', 'post'],
      ['/auth/login', 'post'],
      ['/auth/logout', 'post'],
    ] as const) {
      assert.deepEqual(security(path, method), [], `${method} ${path}`);
    }
    for (const [path, method] of [
      ['/auth/totp', 'post'],
      ['/auth/totp/enrollment', 'post'],
      ['/auth/totp/confirm', 'post'],
    ] as const) {
      assert.deepEqual(security(path, method), [{ session: [] }], `${method} ${path}`);
    }
    // Routes that take a session or an API token (ADR 0023).
    assert.deepEqual(security('/auth/me', 'get'), [{ session: [] }, { bearer: [] }]);
  });

  it('describes a bodiless 204 without content', () => {
    const responses = doc.paths['/auth/logout']?.['post']?.['responses'] as Json;
    assert.deepEqual(responses['204'], { description: 'The session is gone.' });
  });

  it('requires a body only where the contract has one', () => {
    assert.ok(doc.paths['/auth/login']?.['post']?.['requestBody']);
    assert.ok(!doc.paths['/auth/totp/enrollment']?.['post']?.['requestBody']);
  });
});
