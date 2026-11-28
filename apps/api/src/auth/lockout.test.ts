import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  TotpConfirmedSchema,
  TotpEnrollmentSchema,
  UserInvitationSchema,
} from '@swellwright/contracts';

import { AuditService } from '../audit/audit.service.js';
import {
  auditEvents,
  type Client,
  codeFor,
  createOwner,
  createUser,
  databaseUrl,
  errorCode,
  forgetLastStep,
  type Instance,
  NEW_PASSWORD_FOR_TESTS,
  overlapSkip,
  PASSWORD,
  raceBehindAccountLock,
  type Reply,
  SETUP_TOKEN,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { PASSWORD_HASHER } from '../tokens.js';
import { AuthService } from './auth.service.js';
import { AuthFailureNotes } from './failure-notes.js';
import type { PasswordHasher } from './password.js';
import { SessionManagementService } from './session-management.service.js';
import { SessionService } from './session.service.js';
import { hashToken, newSessionToken } from './tokens.js';

const WRONG_PASSWORD = 'not the password at all';

/** A six-digit code that is none of the codes of the current, previous or next time step. */
const wrongCodeFor = (secret: string): string => {
  const valid = [-1, 0, 1].map((n) => codeFor(secret, n));
  return ['000000', '000001', '000002'].find((c) => !valid.includes(c)) ?? '999999';
};

const invalidCodes = (secret: string, count: number): string[] => {
  const valid = [-2, -1, 0, 1, 2].map((step) => codeFor(secret, step));
  return Array.from({ length: count + valid.length }, (_, i) => String(i).padStart(6, '0'))
    .filter((code) => !valid.includes(code))
    .slice(0, count);
};

/** Sign-in attempts as if they came through the trusted proxy from `ip`. */
const loginFrom = (instance: Instance, ip: string, password: string): Promise<Reply> =>
  instance.client().post('/auth/login', { username: 'owner', password }, { 'x-forwarded-for': ip });

describe(
  'wrong passwords slow sign-ins down and never end a session',
  { skip: !databaseUrl },
  () => {
    let instance: Instance;
    let secret: string;
    let ownerId: string;
    let signedIn: Client;

    const db = () => instance.isolated.database.client;
    const credential = () => db().credential.findUniqueOrThrow({ where: { userId: ownerId } });

    before(async () => {
      instance = await start({ SW_TRUSTED_PROXIES: 'loopback' });
      ({ secret } = await createOwner(instance));
      ownerId = (await db().user.findFirstOrThrow()).id;
      signedIn = await signInAs(instance, 'owner', secret);
    });
    after(async () => {
      await stop(instance);
    });
    beforeEach(async () => {
      await db().credential.updateMany({
        data: { passwordFailures: 0, passwordWindowEndsAt: null, passwordRetryAt: null },
      });
      await db().passwordSourceFailure.deleteMany();
    });

    it('makes one source wait after five, and leaves other sources and signed-in sessions alone', async () => {
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await loginFrom(instance, '198.51.100.7', WRONG_PASSWORD)).status, 401);
      }
      const waiting = await loginFrom(instance, '198.51.100.7', PASSWORD);
      assert.equal(waiting.status, 429, 'the right password waits as well');
      assert.equal(errorCode(waiting), 'rate_limited');
      const retry = Number(waiting.headers.get('retry-after'));
      assert.ok(
        retry > 800 && retry <= 900,
        `until the 15-minute window ends, got ${String(retry)}`,
      );

      assert.equal((await loginFrom(instance, '198.51.100.8', PASSWORD)).status, 200);
      assert.equal((await signedIn.get('/auth/me')).status, 200, 'the owner stays signed in');
      const row = await credential();
      assert.equal(row.passwordFailures, 5);
      assert.equal(await db().mfaSourceFailure.count(), 0, 'no second-factor lock');
      const sources = await db().passwordSourceFailure.findMany();
      assert.deepEqual(
        sources.map((s) => [s.sourceBucket, s.failures]),
        [['198.51.100.7', 5]],
      );
    });

    it('counts an IPv6 /64 as one source, and an IPv4 address in every spelling as one', async () => {
      for (let i = 1; i <= 5; i += 1) {
        const status = (await loginFrom(instance, `2001:db8:1:2::${String(i)}`, WRONG_PASSWORD))
          .status;
        assert.equal(status, 401);
      }
      assert.equal((await loginFrom(instance, '2001:db8:1:2::abcd', PASSWORD)).status, 429);
      assert.equal((await loginFrom(instance, '2001:db8:1:3::1', PASSWORD)).status, 200);

      for (let i = 0; i < 4; i += 1) {
        assert.equal((await loginFrom(instance, '198.51.100.20', WRONG_PASSWORD)).status, 401);
      }
      assert.equal((await loginFrom(instance, '::ffff:198.51.100.20', WRONG_PASSWORD)).status, 401);
      assert.equal((await loginFrom(instance, '198.51.100.20', PASSWORD)).status, 429);
      const buckets = (await db().passwordSourceFailure.findMany())
        .map((s) => s.sourceBucket)
        .sort();
      assert.deepEqual(buckets, ['198.51.100.20', '2001:db8:1:2::/64']);
    });

    it('slows every source down from twenty, by 1, 2, 4 and at most 8 seconds; a refusal moves nothing', async () => {
      const windowEndsAt = new Date(Date.now() + 10 * 60_000);
      await db().credential.update({
        where: { userId: ownerId },
        data: { passwordFailures: 19, passwordWindowEndsAt: windowEndsAt },
      });
      const waitAfter = async (ip: string): Promise<number> => {
        assert.equal((await loginFrom(instance, ip, WRONG_PASSWORD)).status, 401);
        const row = await credential();
        assert.ok(row.passwordRetryAt, 'a wait starts');
        return row.passwordRetryAt.getTime() - Date.now();
      };
      const first = await waitAfter('203.0.113.1');
      assert.ok(first > 0 && first <= 1_000, `one second, got ${String(first)}`);

      const before = await credential();
      const refused = await loginFrom(instance, '203.0.113.2', PASSWORD);
      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get('retry-after'), '1');
      const unchanged = await credential();
      assert.equal(unchanged.passwordFailures, 20, 'a refused request counts nothing');
      assert.deepEqual(unchanged.passwordRetryAt, before.passwordRetryAt, 'and moves no deadline');

      const expected = [2_000, 4_000, 8_000, 8_000];
      for (const [i, ms] of expected.entries()) {
        await db().credential.update({
          where: { userId: ownerId },
          data: { passwordRetryAt: new Date(Date.now() - 1) },
        });
        const wait = await waitAfter(`203.0.113.${String(10 + i)}`);
        assert.ok(wait > ms - 1_000 && wait <= ms, `about ${String(ms)} ms, got ${String(wait)}`);
      }
      assert.equal((await credential()).passwordFailures, 23, 'the count stops at 23');
      assert.deepEqual((await credential()).passwordWindowEndsAt, windowEndsAt, 'a fixed window');
      const throttled = (await auditEvents(instance)).filter(
        (e) => e.action === 'auth.password.throttled',
      );
      assert.equal(throttled.length, 1);
      assert.equal(throttled[0]?.actor?.id, ownerId);
      assert.deepEqual(throttled[0].details, { failures: 20 });

      await db().credential.update({
        where: { userId: ownerId },
        data: { passwordRetryAt: new Date(Date.now() - 1) },
      });
      assert.equal((await loginFrom(instance, '203.0.113.99', PASSWORD)).status, 200);
    });

    it('keeps at most 64 source rows per account, removing expired ones first', async () => {
      const live = new Date(Date.now() + 10 * 60_000);
      await db().passwordSourceFailure.createMany({
        data: Array.from({ length: 64 }, (_, i) => ({
          userId: ownerId,
          sourceBucket: `192.0.2.${String(i)}`,
          failures: 1,
          windowEndsAt: live,
        })),
      });
      assert.equal((await loginFrom(instance, '192.0.2.200', WRONG_PASSWORD)).status, 401);
      assert.equal(await db().passwordSourceFailure.count(), 64);
      assert.equal(
        await db().passwordSourceFailure.count({ where: { sourceBucket: '192.0.2.200' } }),
        0,
        'a further source counts account-wide only',
      );
      assert.equal((await credential()).passwordFailures, 1);

      await db().passwordSourceFailure.update({
        where: { userId_sourceBucket: { userId: ownerId, sourceBucket: '192.0.2.0' } },
        data: { windowEndsAt: new Date(Date.now() - 1000) },
      });
      assert.equal((await loginFrom(instance, '192.0.2.200', WRONG_PASSWORD)).status, 401);
      assert.equal(await db().passwordSourceFailure.count(), 64);
      assert.equal(
        await db().passwordSourceFailure.count({ where: { sourceBucket: '192.0.2.0' } }),
        0,
        'the expired row made room',
      );
      assert.equal(
        await db().passwordSourceFailure.count({ where: { sourceBucket: '192.0.2.200' } }),
        1,
      );
    });

    it('lets an owner with a session step up and act while sign-ins of the account wait', async () => {
      await db().credential.update({
        where: { userId: ownerId },
        data: {
          passwordFailures: 23,
          passwordWindowEndsAt: new Date(Date.now() + 10 * 60_000),
          passwordRetryAt: new Date(Date.now() + 8_000),
        },
      });
      assert.equal((await loginFrom(instance, '203.0.113.50', PASSWORD)).status, 429);
      await db().session.updateMany({ data: { elevatedUntil: new Date(Date.now() - 1000) } });
      await forgetLastStep(instance);
      assert.equal((await signedIn.post('/auth/step-up', { code: codeFor(secret) })).status, 200);
      assert.equal(
        (await signedIn.post('/users', { username: 'while-guessed', role: 'observer' })).status,
        201,
      );
    });
  },
);

describe('wrong second factors', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let secret: string;
  let ownerId: string;

  const db = () => instance.isolated.database.client;
  const count = async (action: string): Promise<number> =>
    (await auditEvents(instance)).filter((e) => e.action === action).length;
  const pending = async (): Promise<Client> => {
    const client = instance.client();
    assert.equal(
      (await client.post('/auth/login', { username: 'owner', password: PASSWORD })).status,
      200,
    );
    return client;
  };

  before(async () => {
    // SW_LOCKOUT_ATTEMPTS is 3 in the tests.
    instance = await start({ SW_TRUSTED_PROXIES: 'loopback' });
    ({ secret } = await createOwner(instance));
    ownerId = (await db().user.findFirstOrThrow()).id;
  });
  after(async () => {
    await stop(instance);
  });
  beforeEach(async () => {
    await db().mfaSourceFailure.deleteMany();
    await db().credential.updateMany({
      data: { pendingFactorFailures: 0, pendingFactorWindowEndsAt: null },
    });
    await forgetLastStep(instance);
  });

  it('locks only the account/source pair and leaves an already elevated session usable', async () => {
    const active = await signInAs(instance, 'owner', secret);
    const signingIn = await pending();
    const otherAddress = '192.0.2.7';
    const remote = instance.client();
    const fromRemote = { 'x-forwarded-for': otherAddress };
    const body = { username: 'owner', password: PASSWORD };
    assert.equal((await remote.post('/auth/login', body, fromRemote)).status, 200);
    const wrong = wrongCodeFor(secret);
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);

    const refused = await instance.client().post('/auth/login', body);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    const wrongPassword = await instance
      .client()
      .post('/auth/login', { ...body, password: WRONG_PASSWORD });
    assert.equal(wrongPassword.status, refused.status);
    assert.equal(errorCode(wrongPassword), errorCode(refused));
    assert.equal(
      (await db().credential.findUniqueOrThrow({ where: { userId: ownerId } })).passwordFailures,
      0,
    );
    assert.equal((await active.get('/auth/me')).status, 200);
    await forgetLastStep(instance);
    assert.equal((await active.post('/auth/step-up', { code: codeFor(secret) })).status, 200);
    assert.equal(
      (await active.post('/users', { username: 'still-elevated', role: 'observer' })).status,
      201,
    );
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    await forgetLastStep(instance);
    assert.equal(
      (await remote.post('/auth/totp', { code: codeFor(secret) }, fromRemote)).status,
      200,
    );
    assert.equal((await instance.client().post('/auth/login', body, fromRemote)).status, 200);
    assert.equal((await instance.client().post('/auth/login', body)).status, 429);
  });

  it('locks the source and ends only pending sessions, not a session whose elevation lapsed', async () => {
    const active = await signInAs(instance, 'owner', secret);
    await db().session.updateMany({ data: { elevatedUntil: null } });
    const signingIn = await pending();
    const wrong = wrongCodeFor(secret);
    const epoch = (await db().user.findUniqueOrThrow({ where: { id: ownerId } })).credentialEpoch;
    const locksBefore = await count('auth.account.locked');

    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    assert.equal((await active.get('/auth/me')).status, 200, 'two failures end nothing');
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);

    assert.equal(await count('auth.account.locked'), locksBefore + 1);
    assert.equal(
      (await active.get('/auth/me')).status,
      200,
      'the active session can still step up',
    );
    await forgetLastStep(instance);
    assert.equal(
      (await signingIn.post('/auth/totp', { code: codeFor(secret) })).status,
      401,
      'the pending one too',
    );
    const fresh = await instance
      .client()
      .post('/auth/login', { username: 'owner', password: PASSWORD });
    assert.equal(fresh.status, 429);
    const row = await db().user.findUniqueOrThrow({ where: { id: ownerId } });
    assert.equal(row.credentialEpoch, epoch, 'the source lock is not an account-wide revocation');
    assert.ok((await db().mfaSourceFailure.findFirstOrThrow()).lockedUntil);
  });

  it('evaluates only three proofs in a 200-request HTTP burst and refuses a queued correct code', async () => {
    const signingIn = await pending();
    const failedBefore = await count('auth.second_step.failed');
    const locksBefore = await count('auth.account.locked');
    const codes = invalidCodes(secret, 200);
    const correct = codeFor(secret);
    const auth = instance.app.get(AuthService);
    const verify = auth.verifySecondStep.bind(auth);
    const queued = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const deferCorrect: AuthService['verifySecondStep'] = async (ctx, code, meta, tokenHash) => {
      if (code === correct) {
        queued.resolve(undefined);
        await release.promise;
      }
      return verify(ctx, code, meta, tokenHash);
    };
    const hook = mock.method(auth, 'verifySecondStep', deferCorrect);
    const good = signingIn.post('/auth/totp', { code: correct });
    let replies: Reply[];
    try {
      await Promise.race([
        queued.promise,
        good.then((reply) =>
          assert.fail(`Correct request returned before its transaction: ${String(reply.status)}`),
        ),
      ]);
      replies = await Promise.all(codes.map((code) => signingIn.post('/auth/totp', { code })));
    } finally {
      hook.mock.restore();
      release.resolve(undefined);
    }
    assert.equal((await good).status, 401);
    assert.deepEqual(
      [
        ...new Set(
          replies.filter((r) => r.status !== 401 && r.status !== 429).map((r) => r.status),
        ),
      ],
      [],
    );
    assert.equal((await count('auth.second_step.failed')) - failedBefore, 3);
    assert.equal((await count('auth.account.locked')) - locksBefore, 1);
  });

  it('keeps a correct proof that committed before requests with the old pending cookie', async () => {
    const signingIn = await pending();
    const old = instance.client();
    old.cookie = signingIn.cookie;
    const locksBefore = await count('auth.account.locked');
    const wrong = wrongCodeFor(secret);
    const auth = instance.app.get(AuthService);
    const verify = auth.verifySecondStep.bind(auth);
    const queued = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const deferWrong: AuthService['verifySecondStep'] = async (ctx, code, meta, tokenHash) => {
      if (code === wrong) {
        queued.resolve(undefined);
        await release.promise;
      }
      return verify(ctx, code, meta, tokenHash);
    };
    const hook = mock.method(auth, 'verifySecondStep', deferWrong);
    const bad = old.post('/auth/totp', { code: wrong });
    try {
      await Promise.race([
        queued.promise,
        bad.then((reply) =>
          assert.fail(`Wrong request returned before its transaction: ${String(reply.status)}`),
        ),
      ]);
      assert.equal((await signingIn.post('/auth/totp', { code: codeFor(secret) })).status, 200);
    } finally {
      hook.mock.restore();
      release.resolve(undefined);
    }
    assert.equal((await bad).status, 401);
    assert.equal(await count('auth.account.locked'), locksBefore);
    assert.equal(await db().mfaSourceFailure.count(), 0);
    assert.equal((await signingIn.get('/auth/me')).status, 200);
  });

  it('starts the count over after a proof that worked', async () => {
    const signingIn = await pending();
    const wrong = wrongCodeFor(secret);
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
    assert.equal((await signingIn.post('/auth/totp', { code: codeFor(secret) })).status, 200);
    assert.equal(await db().mfaSourceFailure.count(), 0);
  });

  it('rolls back a factor claim and keeps the pending session if the strict audit record fails', async () => {
    const signingIn = await pending();
    const audit = instance.app.get(AuditService);
    const record = audit.record.bind(audit);
    const failLoginRecord: AuditService['record'] = (input, tx) =>
      input.action === 'auth.login.succeeded'
        ? Promise.reject(new Error('Synthetic audit failure'))
        : record(input, tx);
    const failure = mock.method(audit, 'record', failLoginRecord);
    const code = codeFor(secret);
    try {
      const rejected = await signingIn.post('/auth/totp', { code });
      assert.equal(rejected.status, 500);
      assert.deepEqual(rejected.setCookie, []);
      assert.equal(
        (await db().credential.findUniqueOrThrow({ where: { userId: ownerId } })).totpLastStep,
        null,
      );
    } finally {
      failure.mock.restore();
    }
    assert.equal((await signingIn.post('/auth/totp', { code })).status, 200);
  });

  it('commits the source lock and ends its pending session even when failure notes cannot be written', async () => {
    const signingIn = await pending();
    const audit = instance.app.get(AuditService);
    const failed = mock.method(audit, 'record', () =>
      Promise.reject(new Error('Synthetic audit failure')),
    );
    try {
      const wrong = wrongCodeFor(secret);
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await signingIn.post('/auth/totp', { code: wrong })).status, 401);
      }
      assert.equal((await signingIn.post('/auth/totp', { code: codeFor(secret) })).status, 401);
      assert.equal(
        (await instance.client().post('/auth/login', { username: 'owner', password: PASSWORD }))
          .status,
        429,
      );
    } finally {
      failed.mock.restore();
    }
  });

  it('keeps a wrong current password to its own limit per session, apart from the sign-in counts', async () => {
    const active = await signInAs(instance, 'owner', secret);
    const body = { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD_FOR_TESTS };
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await active.post('/auth/password', body)).status, 401);
    }
    const refused = await active.post('/auth/password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD_FOR_TESTS,
    });
    assert.equal(refused.status, 429);
    const row = await db().credential.findUniqueOrThrow({ where: { userId: ownerId } });
    assert.equal(row.passwordFailures, 0);
    assert.equal(await db().mfaSourceFailure.count(), 0);
    assert.equal((await active.get('/auth/me')).status, 200);
  });

  it('accepts a correct factor from an untracked source without taking or evicting a slot', async () => {
    const signingIn = await pending();
    const windowEndsAt = new Date(Date.now() + 10 * 60_000);
    await db().mfaSourceFailure.createMany({
      data: Array.from({ length: 64 }, (_, i) => ({
        userId: ownerId,
        sourceBucket: `192.0.2.${String(i)}`,
        failures: 1,
        windowEndsAt,
      })),
    });
    const code = codeFor(secret);
    const accepted = await signingIn.post('/auth/totp', { code });
    assert.equal(accepted.status, 200);
    assert.equal(await db().mfaSourceFailure.count(), 64);
  });

  it('bounds all password-only factor attempts together without denying an established owner step-up', async () => {
    const active = await signInAs(instance, 'owner', secret);
    await db().session.updateMany({ where: { stage: 'active' }, data: { elevatedUntil: null } });
    const codes = invalidCodes(secret, 7);
    const signInFrom = async (address: string) => {
      const client = instance.client();
      const headers = { 'x-forwarded-for': address };
      const reply = await client.post(
        '/auth/login',
        { username: 'owner', password: PASSWORD },
        headers,
      );
      assert.equal(reply.status, 200);
      return (code: string) => client.post('/auth/totp', { code }, headers);
    };
    const attempts = await Promise.all(
      Array.from({ length: 7 }, (_, i) => signInFrom(`192.0.2.${String(i + 1)}`)),
    );
    for (const [index, attempt] of attempts.entries()) {
      const reply = await attempt(codes[index] ?? '');
      assert.equal(reply.status, index < 6 ? 401 : 429);
    }
    await forgetLastStep(instance);
    assert.equal((await active.post('/auth/step-up', { code: codeFor(secret) })).status, 200);
  });

  it('does not let a password-only cookie move to a different source bucket', async () => {
    const signingIn = await pending();
    const reply = await signingIn.post(
      '/auth/totp',
      { code: codeFor(secret) },
      { 'x-forwarded-for': '192.0.2.30' },
    );
    assert.equal(reply.status, 401);
    assert.deepEqual(reply.setCookie, []);
  });

  it('evicts the oldest unlocked source on a wrong proof, never a live lock', async () => {
    const signingIn = await pending();
    const windowEndsAt = new Date(Date.now() + 10 * 60_000);
    const locked = '192.0.2.0';
    const oldest = '192.0.2.1';
    await db().mfaSourceFailure.createMany({
      data: [
        { userId: ownerId, sourceBucket: locked, failures: 0, lockedUntil: windowEndsAt },
        ...Array.from({ length: 63 }, (_, i) => ({
          userId: ownerId,
          sourceBucket: `192.0.2.${String(i + 1)}`,
          failures: 1,
          windowEndsAt: new Date(windowEndsAt.getTime() + i),
        })),
      ],
    });
    assert.equal((await signingIn.post('/auth/totp', { code: wrongCodeFor(secret) })).status, 401);
    assert.equal(await db().mfaSourceFailure.count(), 64);
    assert.equal(await db().mfaSourceFailure.count({ where: { sourceBucket: oldest } }), 0);
    assert.equal(
      await db().mfaSourceFailure.count({
        where: { sourceBucket: locked, lockedUntil: windowEndsAt },
      }),
      1,
    );
    assert.equal(
      await db().mfaSourceFailure.count({ where: { sourceBucket: '127.0.0.1', failures: 1 } }),
      1,
    );
  });

  it('admits only one current-password verification at a time per session', async () => {
    const client = await signInAs(instance, 'owner', secret);
    const another = instance.client();
    another.cookie = client.cookie;
    const hasher = instance.app.get<PasswordHasher>(PASSWORD_HASHER);
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let checks = 0;
    const pause = mock.method(hasher, 'verify', async () => {
      checks += 1;
      started.resolve(undefined);
      if (checks === 1) {
        await release.promise;
      }
      return false;
    });
    const body = { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD_FOR_TESTS };
    const first = client.post('/auth/password', body);
    try {
      await started.promise;
      const refused = await another.post('/auth/password', body);
      assert.equal(refused.status, 429);
      assert.equal(checks, 1);
    } finally {
      release.resolve(undefined);
      await first;
      pause.mock.restore();
    }
    assert.equal((await first).status, 401);
  });
});

describe('authentication failure-note budget', { skip: !databaseUrl }, () => {
  it('a distributed anonymous flood cannot consume the record for a known account', async () => {
    const instance = await start({ SW_TRUSTED_PROXIES: 'loopback' });
    try {
      await createOwner(instance);
      for (let i = 1; i <= 61; i += 1) {
        const reply = await instance.client().post(
          '/auth/login',
          { username: 'missing', password: WRONG_PASSWORD },
          {
            'x-forwarded-for': `198.51.100.${String(i)}`,
          },
        );
        assert.equal(reply.status, 401);
      }
      assert.equal((await loginFrom(instance, '192.0.2.10', WRONG_PASSWORD)).status, 401);
      const events = await auditEvents(instance);
      assert.equal(
        events.filter((e) => e.action === 'auth.login.failed' && e.actor?.name === 'owner').length,
        1,
      );
    } finally {
      await stop(instance);
    }
  });

  it('samples by source and lane, and summarizes suppressed notes outside the sample budget', async () => {
    const instance = await start();
    try {
      const notes = instance.app.get(AuthFailureNotes);
      for (let i = 0; i < 12; i += 1) {
        await notes.note({
          action: i % 2 === 0 ? 'auth.login.failed' : 'auth.second_step.failed',
          outcome: 'failure',
          meta: { ip: undefined, requestId: undefined },
        });
      }
      await notes.flushSuppressed();
      const events = await auditEvents(instance);
      assert.equal(events.filter((e) => e.action === 'auth.login.failed').length, 5);
      assert.equal(events.filter((e) => e.action === 'auth.second_step.failed').length, 5);
      assert.deepEqual(events.find((e) => e.action === 'auth.failures.summarized')?.details, {
        unverified: 0,
        account: 2,
        setup: 0,
      });
    } finally {
      await stop(instance);
    }
  });
});

describe('password hasher admission', { skip: !databaseUrl }, () => {
  it('reserves Argon2 admission for an elevated session and a known account under a dummy flood', async () => {
    const instance = await start(
      { SW_TRUSTED_PROXIES: 'loopback' },
      {
        hasherLimits: { concurrent: 1, queue: 2, waitMs: 15_000 },
      },
    );
    try {
      const { secret } = await createOwner(instance);
      const owner = await signInAs(instance, 'owner', secret);
      await createUser(instance, 'known', 'observer');
      const hasher = instance.app.get<PasswordHasher>(PASSWORD_HASHER);
      const slots = hasher as unknown as { release(...args: unknown[]): void };
      const release = slots.release.bind(slots);
      const held = Promise.withResolvers<undefined>();
      const queued = Promise.withResolvers<undefined>();
      const checking = Promise.withResolvers<undefined>();
      let verifiedCalls = 0;
      let slot: unknown[] | undefined;
      let unknown = 0;
      const hold = mock.method(slots, 'release', (...args: unknown[]) => {
        hold.mock.restore();
        slot = args;
        held.resolve(undefined);
      });
      const dummy = hasher.verifyDummy.bind(hasher);
      const observeUnknown = mock.method(hasher, 'verifyDummy', (password: string) => {
        const result = dummy(password);
        unknown += 1;
        if (unknown === 3) {
          queued.resolve(undefined);
        }
        return result;
      });
      const verify = hasher.verify.bind(hasher);
      const observeOwner = mock.method(
        hasher,
        'verify',
        (...args: Parameters<PasswordHasher['verify']>) => {
          const result = verify(...args);
          verifiedCalls += 1;
          if (verifiedCalls === 2) {
            checking.resolve(undefined);
          }
          return result;
        },
      );
      const login = (i: number) =>
        instance.client().post(
          '/auth/login',
          { username: 'missing', password: WRONG_PASSWORD },
          {
            'x-forwarded-for': `198.51.100.${String(i)}`,
          },
        );
      const pending = [login(1)];
      let changed: Promise<Reply> | undefined;
      let known: Promise<Reply> | undefined;
      try {
        await held.promise;
        pending.push(login(2), login(3));
        await queued.promise;
        changed = owner.post('/auth/password', {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD_FOR_TESTS,
        });
        known = instance.client().post('/auth/login', { username: 'known', password: PASSWORD });
        await checking.promise;
      } finally {
        hold.mock.restore();
        observeUnknown.mock.restore();
        observeOwner.mock.restore();
        if (slot) {
          release(...slot);
        }
        await Promise.all(pending);
      }
      assert.equal((await changed).status, 204);
      assert.equal((await known).status, 200);
    } finally {
      await stop(instance);
    }
  });

  it('applies the same source hash budget to unknown and known usernames', async () => {
    const instance = await start({ SW_TRUSTED_PROXIES: 'loopback' });
    try {
      await createOwner(instance);
      const hasher = instance.app.get<PasswordHasher>(PASSWORD_HASHER);
      const tracked = mock.method(hasher, 'verifyDummy');
      const verify = mock.method(hasher, 'verify');
      try {
        const client = instance.client();
        const body = { username: 'missing', password: WRONG_PASSWORD };
        for (let i = 0; i < 20; i += 1) {
          assert.equal((await client.post('/auth/login', body)).status, 401);
        }
        const unknown = await client.post('/auth/login', body);
        const known = await client.post('/auth/login', { ...body, username: 'owner' });
        assert.equal(unknown.status, 429);
        assert.equal(known.status, unknown.status);
        assert.equal(errorCode(known), errorCode(unknown));
        assert.equal(tracked.mock.callCount(), 20);
        assert.equal(verify.mock.callCount(), 0);
      } finally {
        tracked.mock.restore();
        verify.mock.restore();
      }
    } finally {
      await stop(instance);
    }
  });
});

describe('the credential epoch', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let secret: string;
  let ownerId: string;

  const db = () => instance.isolated.database.client;
  const epoch = async (): Promise<bigint> =>
    (await db().user.findUniqueOrThrow({ where: { id: ownerId } })).credentialEpoch;

  before(async () => {
    instance = await start();
    ({ secret } = await createOwner(instance));
    ownerId = (await db().user.findFirstOrThrow()).id;
  });
  after(async () => {
    await stop(instance);
  });

  it('refuses a session of an older epoch than its user', async () => {
    const client = await signInAs(instance, 'owner', secret);
    assert.equal((await client.get('/auth/me')).status, 200);
    await db().user.update({ where: { id: ownerId }, data: { credentialEpoch: { increment: 1 } } });
    assert.equal((await client.get('/auth/me')).status, 401);
  });

  it('moves on when the other sessions end, also with none to end, and keeps the current one', async () => {
    const current = await signInAs(instance, 'owner', secret);
    const newest = await db().session.findFirstOrThrow({
      where: { userId: ownerId },
      orderBy: { createdAt: 'desc' },
    });
    // Nothing else is left to end: the epoch still moves, for a sign-in that could be in flight.
    await db().session.deleteMany({ where: { userId: ownerId, id: { not: newest.id } } });
    const before = await epoch();
    const reply = await current.post('/auth/sessions/revoke-others');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body, { revoked: 0 });
    assert.equal(await epoch(), before + 1n);
    assert.equal((await current.get('/auth/me')).status, 200, 'carried over to the new epoch');
    const recorded = (await auditEvents(instance))
      .filter((e) => e.action === 'session.revoked')
      .at(-1);
    assert.deepEqual(recorded?.details, { scope: 'others', user: 'owner', count: 0 });
  });

  it('carries the caller over a password change and ends every other session, pending ones too', async () => {
    const changer = await signInAs(instance, 'owner', secret);
    const other = await signInAs(instance, 'owner', secret);
    const signingIn = instance.client();
    await signingIn.post('/auth/login', { username: 'owner', password: PASSWORD });
    const before = await epoch();
    assert.equal(
      (
        await changer.post('/auth/password', {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD_FOR_TESTS,
        })
      ).status,
      204,
    );
    assert.equal(await epoch(), before + 1n);
    assert.equal((await changer.get('/auth/me')).status, 200);
    assert.equal((await other.get('/auth/me')).status, 401);
    await forgetLastStep(instance);
    assert.equal((await signingIn.post('/auth/totp', { code: codeFor(secret) })).status, 401);
    // Back to the shared password for the tests after this one.
    assert.equal(
      (
        await changer.post('/auth/password', {
          currentPassword: NEW_PASSWORD_FOR_TESTS,
          newPassword: PASSWORD,
        })
      ).status,
      204,
    );
  });

  it('ends a pending session at sign-out: the second step is refused after it', async () => {
    const client = instance.client();
    await client.post('/auth/login', { username: 'owner', password: PASSWORD });
    const cookie = client.cookie;
    assert.equal((await client.post('/auth/logout')).status, 204);
    client.cookie = cookie;
    await forgetLastStep(instance);
    assert.equal((await client.post('/auth/totp', { code: codeFor(secret) })).status, 401);
  });

  it('does not turn a rehash of the old password into a session after a concurrent password change', async () => {
    const changer = await signInAs(instance, 'owner', secret);
    const hasher = instance.app.get<PasswordHasher>(PASSWORD_HASHER);
    const hash = hasher.hash.bind(hasher);
    const upgrade = mock.method(hasher, 'needsRehash', () => true);
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const pause = mock.method(hasher, 'hash', async (password: string) => {
      if (password === PASSWORD) {
        started.resolve(undefined);
        await release.promise;
      }
      return hash(password);
    });
    const client = instance.client();
    const login = client.post('/auth/login', { username: 'owner', password: PASSWORD });
    try {
      await Promise.race([
        started.promise,
        login.then((reply) => assert.fail(`Login returned before rehash: ${String(reply.status)}`)),
      ]);
      assert.equal(
        (
          await changer.post('/auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD_FOR_TESTS,
          })
        ).status,
        204,
      );
    } finally {
      pause.mock.restore();
      upgrade.mock.restore();
      release.resolve(undefined);
    }
    assert.equal((await login).status, 401);
    assert.equal(client.cookie, undefined);
    assert.equal((await changer.get('/auth/me')).status, 200);
    assert.equal(
      (
        await changer.post('/auth/password', {
          currentPassword: NEW_PASSWORD_FOR_TESTS,
          newPassword: PASSWORD,
        })
      ).status,
      204,
      'the old rehash did not overwrite the new password',
    );
  });

  it('orders second-step completion against individual revocation in both directions', async () => {
    const owner = await signInAs(instance, 'owner', secret);
    const sessions = instance.app.get(SessionService);
    const management = instance.app.get(SessionManagementService);
    const auth = instance.app.get(AuthService);
    const sessionOf = async (client: Client) => {
      const ctx = await sessions.authenticate(client.cookie?.split('=')[1] ?? '');
      assert.ok(ctx);
      return ctx;
    };
    const open = async () => {
      const client = instance.client();
      assert.equal(
        (await client.post('/auth/login', { username: 'owner', password: PASSWORD })).status,
        200,
      );
      return sessionOf(client);
    };
    const actor = await sessionOf(owner);
    const meta = { ip: '127.0.0.1', requestId: undefined, userAgent: undefined };
    const revoked = await open();
    await forgetLastStep(instance);
    await management.revoke(actor, revoked.sessionId, 'own', meta);
    await assert.rejects(
      auth.verifySecondStep(revoked, codeFor(secret), meta, hashToken(newSessionToken())),
      UnauthorizedException,
    );
    assert.equal(
      (await db().credential.findUniqueOrThrow({ where: { userId: ownerId } })).totpLastStep,
      null,
    );

    const pending = await open();
    const token = newSessionToken();
    await auth.verifySecondStep(pending, codeFor(secret), meta, hashToken(token));
    await assert.rejects(
      management.revoke(actor, pending.sessionId, 'own', meta),
      NotFoundException,
    );
    const promoted = await sessions.authenticate(token);
    assert.equal(promoted?.stage, 'active');
    assert.notEqual(promoted.sessionId, pending.sessionId);
  });
});

describe('enrollment and invitations', { skip: !databaseUrl }, () => {
  let instance: Instance;

  before(async () => {
    instance = await start();
  });
  after(async () => {
    await stop(instance);
  });

  it('hands out one proposal to starts at once, and lets one of two confirmations at once through', async () => {
    const client = instance.client();
    const created = await client.post('/setup/owner', {
      setupToken: SETUP_TOKEN,
      username: 'owner',
      password: PASSWORD,
    });
    assert.equal(created.status, 200);
    const starts = await Promise.all(
      Array.from({ length: 4 }, () => client.post('/auth/totp/enrollment')),
    );
    const secrets = new Set(starts.map((r) => TotpEnrollmentSchema.parse(r.body).secret));
    assert.equal(secrets.size, 1, 'the same proposal for every start');
    const [secret = ''] = [...secrets];

    const replies = await Promise.all([
      client.post('/auth/totp/confirm', { code: codeFor(secret) }),
      client.post('/auth/totp/confirm', { code: codeFor(secret, 1) }),
    ]);
    const ok = replies.filter((r) => r.status === 200);
    assert.equal(ok.length, 1, JSON.stringify(replies.map((r) => r.status)));
    assert.equal(TotpConfirmedSchema.parse(ok[0]?.body).recoveryCodes.length, 10);
    const db = instance.isolated.database.client;
    assert.equal(await db.recoveryCode.count(), 10);
    const enrolled = (await auditEvents(instance)).filter((e) => e.action === 'auth.totp.enrolled');
    assert.equal(enrolled.length, 1);
  });

  it('refuses an invitation a reset replaced, and takes the new one', async () => {
    const db = instance.isolated.database.client;
    await db.credential.updateMany({ data: { totpLastStep: null } });
    const secret = (await createUser(instance, 'helper', 'owner')).secret;
    const owner = await signInAs(instance, 'helper', secret);
    const invited = UserInvitationSchema.parse(
      (await owner.post('/users', { username: 'invitee', role: 'observer' })).body,
    );
    const reset = UserInvitationSchema.parse(
      (await owner.post(`/users/${invited.user.id}/reset-credentials`)).body,
    );
    const old = await instance
      .client()
      .post('/auth/invitations/accept', { token: invited.invitation.token, password: PASSWORD });
    assert.equal(old.status, 401);
    assert.equal(await db.credential.count({ where: { userId: invited.user.id } }), 0);
    const fresh = await instance
      .client()
      .post('/auth/invitations/accept', { token: reset.invitation.token, password: PASSWORD });
    assert.equal(fresh.status, 200);
  });

  it('cannot redeem the old invitation when reset commits during hashing', async () => {
    const db = instance.isolated.database.client;
    const helper = await createUser(instance, 'resetter', 'owner');
    const owner = await signInAs(instance, 'resetter', helper.secret);
    const invited = UserInvitationSchema.parse(
      (await owner.post('/users', { username: 'waiting-invite', role: 'observer' })).body,
    );
    const userId = invited.user.id;
    const hasher = instance.app.get<PasswordHasher>(PASSWORD_HASHER);
    const hash = hasher.hash.bind(hasher);
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const pause = mock.method(hasher, 'hash', async (password: string) => {
      started.resolve(undefined);
      await release.promise;
      return hash(password);
    });
    const invitee = instance.client();
    const accepting = invitee.post('/auth/invitations/accept', {
      token: invited.invitation.token,
      password: PASSWORD,
    });
    let replacement: string;
    try {
      await Promise.race([
        started.promise,
        accepting.then((reply) =>
          assert.fail(`Invitation returned early: ${String(reply.status)}`),
        ),
      ]);
      const response = await owner.post(`/users/${userId}/reset-credentials`);
      assert.equal(response.status, 200);
      replacement = UserInvitationSchema.parse(response.body).invitation.token;
    } finally {
      pause.mock.restore();
      release.resolve(undefined);
    }
    const refused = await accepting;
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.setCookie, []);
    assert.equal(await db.credential.count({ where: { userId } }), 0);
    assert.equal(await db.session.count({ where: { userId } }), 0);
    const accepted = await invitee.post('/auth/invitations/accept', {
      token: replacement,
      password: NEW_PASSWORD_FOR_TESTS,
    });
    assert.equal(accepted.status, 200);
  });
});

describe('the budget of authentication requests per source', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let ownerSecret: string;

  before(async () => {
    instance = await start(
      { SW_TRUSTED_PROXIES: 'loopback' },
      {
        attemptPolicy: {
          secondFactor: { limit: 3, windowMs: 60_000 },
          stepUp: { limit: 2, windowMs: 60_000 },
          changePassword: { limit: 1, windowMs: 60_000 },
        },
      },
    );
    ({ secret: ownerSecret } = await createOwner(instance));
  });
  after(async () => {
    await stop(instance);
  });

  it('admits an owner from a new address after 4097 distinct IPv6 /64s', async () => {
    for (let i = 0; i <= 4096; i += 1) {
      const reply = await instance.client().post(
        '/auth/login',
        {},
        {
          'x-forwarded-for': `2001:db8:${i.toString(16)}:1::1`,
        },
      );
      assert.equal(reply.status, 400, `source ${String(i)} reaches validation`);
    }
    assert.equal((await loginFrom(instance, '203.0.113.15', PASSWORD)).status, 200);
  });

  it('caps setup and invitation independently across sources without charging login', async () => {
    const test = await start(
      { SW_TRUSTED_PROXIES: 'loopback' },
      {
        attemptPolicy: { ingress: { limit: 2, windowMs: 60_000 } },
      },
    );
    try {
      const post = (path: string, address: string) =>
        test.client().post(path, {}, { 'x-forwarded-for': address });
      for (const path of ['/setup/owner', '/auth/invitations/accept']) {
        assert.equal((await post(path, '192.0.2.1')).status, 400);
        assert.equal((await post(path, '192.0.2.2')).status, 400);
        assert.equal((await post(path, '192.0.2.3')).status, 429);
      }
      assert.equal((await post('/auth/login', '192.0.2.3')).status, 400);
    } finally {
      await stop(test);
    }
  });

  it('admits a previously seen source after eight distinct login requests with ingress set to eight', async () => {
    const test = await start(
      { SW_TRUSTED_PROXIES: 'loopback' },
      {
        attemptPolicy: { ingress: { limit: 8, windowMs: 60_000 } },
      },
    );
    try {
      await createOwner(test);
      for (let i = 0; i < 8; i += 1) {
        const reply = await test.client().post(
          '/auth/login',
          {},
          {
            'x-forwarded-for': `2001:db8:${i.toString(16)}:1::1`,
          },
        );
        assert.equal(reply.status, 400);
      }
      assert.equal((await loginFrom(test, '2001:db8:0:1::2', PASSWORD)).status, 200);
    } finally {
      await stop(test);
    }
  });

  it('shares IPv6 /64 budgets independently for the pending factor, step-up and password change', async () => {
    const from = (ip: string, path: string): Promise<Reply> =>
      instance.client().post(path, { code: '123456' }, { 'x-forwarded-for': ip });
    assert.equal((await from('2001:db8:5:6::1', '/auth/totp')).status, 401);
    assert.equal((await from('2001:db8:5:6::2', '/auth/totp/confirm')).status, 401);
    assert.equal((await from('2001:db8:5:6::3', '/auth/step-up')).status, 401);
    assert.equal((await from('2001:db8:5:6::3', '/auth/totp/confirm')).status, 401);
    const refused = await from('2001:db8:5:6::4', '/auth/totp');
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal((await from('2001:db8:5:6::5', '/auth/step-up')).status, 401);
    assert.equal((await from('2001:db8:5:6::6', '/auth/step-up')).status, 429);
    const active = await signInAs(instance, 'owner', ownerSecret);
    await forgetLastStep(instance);
    assert.equal(
      (
        await active.post(
          '/auth/step-up',
          { code: codeFor(ownerSecret) },
          { 'x-forwarded-for': '2001:db8:5:6::6' },
        )
      ).status,
      200,
      'anonymous traffic at the same address cannot use this active session’s step-up budget',
    );
    assert.equal((await from('2001:db8:5:6::7', '/auth/password')).status, 401);
    assert.equal((await from('2001:db8:5:6::8', '/auth/password')).status, 429);
    assert.equal((await from('2001:db8:5:7::1', '/auth/totp')).status, 401, 'another /64');
  });
});

describe('requests that race a change of the credentials', { skip: overlapSkip }, () => {
  let instance: Instance;
  let secret: string;
  let ownerId: string;

  const db = () => instance.isolated.database.client;

  before(async () => {
    instance = await start();
    ({ secret } = await createOwner(instance));
    ownerId = (await db().user.findFirstOrThrow()).id;
  });
  after(async () => {
    await stop(instance);
  });

  it('issues no session for a password checked before a change that committed first', async () => {
    const client = instance.client();
    const reply = await raceBehindAccountLock(
      instance,
      ownerId,
      async (tx) => {
        await tx.user.update({
          where: { id: ownerId },
          data: { credentialEpoch: { increment: 1 } },
        });
      },
      () => client.post('/auth/login', { username: 'owner', password: PASSWORD }),
    );
    assert.equal(reply.status, 401);
    assert.equal(client.cookie, undefined);
    assert.equal(
      await db().session.count({ where: { userId: ownerId, stage: 'password_verified' } }),
      0,
    );
    assert.equal(
      (await instance.client().post('/auth/login', { username: 'owner', password: PASSWORD }))
        .status,
      200,
      'a fresh sign-in works',
    );
  });

  it('completes no second step whose session a bulk revocation ended first', async () => {
    const client = instance.client();
    await client.post('/auth/login', { username: 'owner', password: PASSWORD });
    await forgetLastStep(instance);
    const reply = await raceBehindAccountLock(
      instance,
      ownerId,
      async (tx) => {
        await tx.user.update({
          where: { id: ownerId },
          data: { credentialEpoch: { increment: 1 } },
        });
        await tx.session.deleteMany({ where: { userId: ownerId } });
      },
      () => client.post('/auth/totp', { code: codeFor(secret) }),
    );
    assert.equal(reply.status, 401);
    assert.equal(
      await db().session.count({ where: { userId: ownerId, stage: 'password_verified' } }),
      0,
    );
    const row = await db().credential.findUniqueOrThrow({ where: { userId: ownerId } });
    assert.equal(row.totpLastStep, null, 'the code was not claimed');
  });

  it('commits one source lock during 200 parallel invalid factor attempts and rejects the later good proof', async () => {
    await db().mfaSourceFailure.deleteMany();
    await forgetLastStep(instance);
    await db().session.deleteMany({ where: { userId: ownerId } });
    const client = instance.client();
    assert.equal(
      (await client.post('/auth/login', { username: 'owner', password: PASSWORD })).status,
      200,
    );
    const codes = invalidCodes(secret, 200);
    const started = (await auditEvents(instance)).length;
    const replies = await raceBehindAccountLock(
      instance,
      ownerId,
      () => Promise.resolve(),
      () => Promise.all(codes.map((code) => client.post('/auth/totp', { code }))),
      // The pool of the API has three connections in the CI: at most three transactions queue on the lock at once.
      3,
    );
    assert.deepEqual(
      [
        ...new Set(
          replies.filter((r) => r.status !== 401 && r.status !== 429).map((r) => r.status),
        ),
      ],
      [],
    );
    const events = (await auditEvents(instance)).slice(started);
    assert.equal(events.filter((e) => e.action === 'auth.account.locked').length, 1);
    assert.equal(events.filter((e) => e.action === 'auth.second_step.failed').length, 3);
    assert.equal((await client.post('/auth/totp', { code: codeFor(secret) })).status, 401);
    assert.equal(await db().session.count({ where: { userId: ownerId } }), 0);
    assert.equal(
      (await db().credential.findUniqueOrThrow({ where: { userId: ownerId } })).totpLastStep,
      null,
    );
  });

  it('sets no password with an invitation a reset replaced while it was hashed', async () => {
    const helper = await createUser(instance, 'racer-admin', 'owner');
    const owner = await signInAs(instance, 'racer-admin', helper.secret);
    const invited = UserInvitationSchema.parse(
      (await owner.post('/users', { username: 'racer', role: 'observer' })).body,
    );
    const userId = invited.user.id;
    const reply = await raceBehindAccountLock(
      instance,
      userId,
      async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { credentialEpoch: { increment: 1 } },
        });
        await tx.invitation.deleteMany({ where: { userId } });
      },
      () =>
        instance.client().post('/auth/invitations/accept', {
          token: invited.invitation.token,
          password: PASSWORD,
        }),
    );
    assert.equal(reply.status, 401);
    assert.equal(await db().credential.count({ where: { userId } }), 0);
    assert.equal(await db().session.count({ where: { userId } }), 0);
  });
});
