import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ElevationSchema } from '@swellwright/contracts';

import {
  auditEvents,
  type Client,
  codeFor,
  createOwner,
  createUser,
  databaseUrl,
  errorCode,
  forgetLastStep,
  found,
  type Instance,
  NEW_PASSWORD_FOR_TESTS,
  PASSWORD,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { base32Decode, totpCode } from './totp.js';

/** Lets the elevation of every session lapse, as if the step-up window had run out. */
async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() - 1000) },
  });
}

describe('step-up authentication', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerSecret: string;
  let targetId: string;

  before(async () => {
    instance = await start();
    ({ secret: ownerSecret } = await createOwner(instance));
    owner = await signInAs(instance, 'owner', ownerSecret);
    ({ id: targetId } = await createUser(instance, 'target', 'observer'));
  });
  after(async () => {
    await stop(instance);
  });

  const createSomeone = (client: Client, username: string) =>
    client.post('/users', { username, role: 'observer' });

  it('lets a fresh sign-in act at once, and marks the session as elevated', async () => {
    assert.equal((await createSomeone(owner, 'fresh-one')).status, 201);
    const row = await instance.isolated.database.client.session.findFirstOrThrow({
      where: { stage: 'active', user: { username: 'owner' } },
    });
    assert.ok(row.elevatedUntil);
    const minutes = (row.elevatedUntil.getTime() - row.createdAt.getTime()) / 60_000;
    assert.ok(minutes > 4.9 && minutes <= 5, `five minutes by default, got ${String(minutes)}`);
  });

  it('refuses a sensitive action once the elevation has lapsed, with its own error code', async () => {
    await lapse(instance);
    for (const reply of [
      await createSomeone(owner, 'too-late'),
      await owner.call('PATCH', `/users/${targetId}`, { displayName: 'Changed' }),
      await owner.post(`/users/${targetId}/reset-credentials`),
      await owner.post('/auth/password', {
        currentPassword: PASSWORD,
        newPassword: 'a new long passphrase',
      }),
    ]) {
      assert.equal(reply.status, 403);
      assert.equal(errorCode(reply), 'step_up_required');
    }
    assert.equal(
      await instance.isolated.database.client.user.count({ where: { username: 'too-late' } }),
      0,
    );
  });

  it('leaves reading and the step-up route itself open without elevation', async () => {
    assert.equal((await owner.get('/users')).status, 200);
    assert.equal((await owner.get('/audit')).status, 200);
    assert.equal((await owner.get('/auth/me')).status, 200);
  });

  it('keeps asking "who may" before "how fresh": a role without the permission hears forbidden', async () => {
    const o = await createUser(instance, 'plain', 'observer');
    const plain = await signInAs(instance, 'plain', o.secret);
    await lapse(instance);
    const reply = await createSomeone(plain, 'nope');
    assert.equal(reply.status, 403);
    assert.equal(errorCode(reply), 'forbidden');
  });

  it('elevates with a fresh authenticator code, and then the action works', async () => {
    await forgetLastStep(instance);
    const reply = await owner.post('/auth/step-up', { code: codeFor(ownerSecret) });
    assert.equal(reply.status, 200);
    const { elevatedUntil } = ElevationSchema.parse(reply.body);
    const minutes = (Date.parse(elevatedUntil) - Date.now()) / 60_000;
    assert.ok(minutes > 4.8 && minutes <= 5);
    assert.equal((await createSomeone(owner, 'after-step-up')).status, 201);

    const event = found(
      (await auditEvents(instance)).filter((e) => e.action === 'auth.step_up.succeeded').at(-1),
      'the step-up event',
    );
    assert.equal(event.actor?.name, 'owner');
    assert.deepEqual(event.details, { method: 'totp' });
    const details = JSON.stringify((await auditEvents(instance)).map((e) => e.details));
    assert.ok(!details.includes(codeFor(ownerSecret)), 'the code is not recorded');
  });

  it('does not accept a code that was used already', async () => {
    await lapse(instance);
    const db = instance.isolated.database.client;
    const { totpLastStep } = await db.credential.findFirstOrThrow({
      where: { user: { username: 'owner' } },
    });
    assert.ok(totpLastStep !== null, 'the previous test used a code');
    // The very code of the last step, which the previous test used: it must not elevate again.
    const used = totpCode(base32Decode(ownerSecret), totpLastStep);
    const reply = await owner.post('/auth/step-up', { code: used });
    assert.equal(reply.status, 401);
    assert.equal(errorCode(reply), 'unauthorized');
    assert.equal((await createSomeone(owner, 'replay')).status, 403);
    // The next code is fine.
    assert.equal(
      (await owner.post('/auth/step-up', { code: codeFor(ownerSecret, 1) })).status,
      200,
    );
  });

  it('refuses a malformed or missing body and a call without a session', async () => {
    assert.equal((await owner.post('/auth/step-up', { code: '12' })).status, 400);
    assert.equal((await owner.post('/auth/step-up', {})).status, 400);
    assert.equal((await instance.client().post('/auth/step-up', { code: '123456' })).status, 401);
  });

  it('is a fact about one session: another browser of the same user is not elevated by it', async () => {
    await forgetLastStep(instance);
    const other = await signInAs(instance, 'owner', ownerSecret);
    await lapse(instance);
    await forgetLastStep(instance);
    assert.equal((await owner.post('/auth/step-up', { code: codeFor(ownerSecret) })).status, 200);
    assert.equal((await createSomeone(owner, 'this-one')).status, 201);
    const reply = await createSomeone(other, 'that-one');
    assert.equal(reply.status, 403);
    assert.equal(errorCode(reply), 'step_up_required');
  });

  it('never outlives the session', async () => {
    const db = instance.isolated.database.client;
    const client = await signInAs(instance, 'owner', ownerSecret);
    const row = await db.session.findFirstOrThrow({
      where: { stage: 'active', user: { username: 'owner' } },
      orderBy: { createdAt: 'desc' },
    });
    // The session has a minute left; the window is five.
    const soon = new Date(Date.now() + 60_000);
    await db.session.update({
      where: { id: row.id },
      data: { absoluteExpiresAt: soon, elevatedUntil: null },
    });
    await forgetLastStep(instance);
    const reply = await client.post('/auth/step-up', { code: codeFor(ownerSecret) });
    assert.equal(reply.status, 200);
    const { elevatedUntil } = ElevationSchema.parse(reply.body);
    assert.ok(Date.parse(elevatedUntil) <= soon.getTime(), 'cut at the end of the session');
  });
});

describe('step-up with a recovery code, and under the lockout', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerSecret: string;
  let recoveryCodes: string[];

  before(async () => {
    instance = await start();
    ({ secret: ownerSecret, recoveryCodes } = await createOwner(instance));
    owner = await signInAs(instance, 'owner', ownerSecret);
  });
  after(async () => {
    await stop(instance);
  });

  it('accepts a recovery code once, and records it', async () => {
    await lapse(instance);
    const code = recoveryCodes[0] ?? '';
    assert.equal((await owner.post('/auth/step-up', { code })).status, 200);
    assert.equal(
      (await owner.post('/users', { username: 'by-recovery', role: 'observer' })).status,
      201,
    );
    await lapse(instance);
    assert.equal((await owner.post('/auth/step-up', { code })).status, 401, 'used up');
    const events = await auditEvents(instance);
    assert.ok(events.some((e) => e.action === 'auth.recovery_code.used'));
    assert.deepEqual(events.filter((e) => e.action === 'auth.step_up.succeeded').at(-1)?.details, {
      method: 'recovery_code',
    });
    assert.ok(!JSON.stringify(events).includes(code));
  });

  it('counts wrong codes towards the lockout, records them, and ends the sessions at the limit', async () => {
    owner = await signInAs(instance, 'owner', ownerSecret);
    await lapse(instance);
    const valid = [-1, 0, 1].map((n) => codeFor(ownerSecret, n));
    const wrong = ['000000', '000001'].find((c) => !valid.includes(c)) ?? '000002';
    const countFailures = async (): Promise<number> =>
      (await auditEvents(instance)).filter((e) => e.action === 'auth.step_up.failed').length;
    const before = await countFailures();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await owner.post('/auth/step-up', { code: wrong })).status, 401);
    }
    assert.equal((await countFailures()) - before, 3);
    const last = (await auditEvents(instance))
      .filter((e) => e.action === 'auth.step_up.failed')
      .at(-1);
    assert.deepEqual(last?.details, { method: 'totp' });
    assert.equal((await owner.get('/auth/me')).status, 401, 'the third failure ended this session');
    const login = await instance
      .client()
      .post('/auth/login', { username: 'owner', password: PASSWORD });
    assert.equal(login.status, 200, 'a session-specific step-up lock does not block new sign-in');
  });

  it('keeps the password change behind the same elevation', async () => {
    await forgetLastStep(instance);
    const client = await signInAs(instance, 'owner', ownerSecret);
    await lapse(instance);
    const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD_FOR_TESTS };
    assert.equal(errorCode(await client.post('/auth/password', body)), 'step_up_required');
    await forgetLastStep(instance);
    assert.equal((await client.post('/auth/step-up', { code: codeFor(ownerSecret) })).status, 200);
    assert.equal((await client.post('/auth/password', body)).status, 204);
  });
});
