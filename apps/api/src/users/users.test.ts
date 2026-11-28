import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import {
  SessionInfoSchema,
  UserInvitationSchema,
  UserListSchema,
  UserViewSchema,
} from '@swellwright/contracts';

import { hashToken } from '../auth/tokens.js';
import {
  acceptInvitation,
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
  PASSWORD,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { UsersService } from './users.service.js';

const NEW_PASSWORD = 'a brand new passphrase';
const THEIR_PASSWORD = 'their own long passphrase';

const invite = async (
  owner: Client,
  body: Record<string, unknown>,
): Promise<ReturnType<typeof UserInvitationSchema.parse>> => {
  const reply = await owner.post('/users', body);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return UserInvitationSchema.parse(reply.body);
};

describe('inviting a user', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerSecret: string;

  before(async () => {
    instance = await start();
    ({ secret: ownerSecret } = await createOwner(instance));
    owner = await signInAs(instance, 'owner', ownerSecret);
  });
  after(async () => {
    await stop(instance);
  });

  it('creates an account without a password and hands over a one-time invitation', async () => {
    const { user, invitation } = await invite(owner, {
      username: 'newbie',
      role: 'operator',
      displayName: 'New Person',
      email: 'New.Person@example.org',
    });
    assert.equal(user.username, 'newbie');
    assert.equal(user.role, 'operator');
    assert.equal(user.state, 'invited');
    assert.equal(user.email, 'new.person@example.org', 'stored in lower case');
    assert.equal(invitation.purpose, 'invite');
    assert.ok(invitation.token.length >= 40);
    const hours = (Date.parse(invitation.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours > 71.9 && hours <= 72, `valid for 72 hours, got ${String(hours)}`);

    const db = instance.isolated.database.client;
    const stored = await db.invitation.findFirstOrThrow({ where: { userId: user.id } });
    assert.notEqual(stored.tokenHash, invitation.token);
    assert.equal(stored.tokenHash, hashToken(invitation.token), 'only the hash is kept');
    assert.equal(await db.credential.count({ where: { userId: user.id } }), 0, 'no password yet');

    const event = found(
      (await auditEvents(instance)).find((e) => e.action === 'user.created'),
      'the user.created event',
    );
    assert.equal(event.actor?.name, 'owner');
    assert.deepEqual(event.object, { type: 'user', id: user.id });
    assert.deepEqual(event.details, { role: 'operator' });
    assert.ok(!JSON.stringify(await auditEvents(instance)).includes(invitation.token));
  });

  it('cannot sign in before the invitation is accepted', async () => {
    const reply = await instance.client().post('/auth/login', {
      username: 'newbie',
      password: PASSWORD,
    });
    assert.equal(reply.status, 401);
  });

  it('refuses a taken login name or e-mail address, and bad input', async () => {
    const taken = await owner.post('/users', { username: 'newbie', role: 'observer' });
    assert.equal(taken.status, 409);
    assert.equal(errorCode(taken), 'conflict');
    const email = await owner.post('/users', {
      username: 'other',
      role: 'observer',
      email: 'NEW.PERSON@example.org',
    });
    assert.equal(email.status, 409);
    for (const bad of [
      { username: 'Not Allowed', role: 'observer' },
      { username: 'fine', role: 'root' },
      { username: 'fine' },
      { username: 'fine', role: 'observer', email: 'not-an-address' },
    ]) {
      const reply = await owner.post('/users', bad);
      assert.equal(reply.status, 400, JSON.stringify(bad));
      assert.equal(errorCode(reply), 'validation_failed');
    }
    assert.equal(
      await instance.isolated.database.client.user.count({ where: { username: 'other' } }),
      0,
    );
  });

  it('lists users in pages', async () => {
    const all = UserListSchema.parse((await owner.get('/users')).body);
    assert.deepEqual(
      all.users.map((u) => u.username),
      ['owner', 'newbie'],
    );
    assert.equal(all.nextCursor, null);
    const first = UserListSchema.parse((await owner.get('/users?limit=1')).body);
    assert.equal(first.users.length, 1);
    assert.ok(first.nextCursor);
    const second = UserListSchema.parse(
      (await owner.get(`/users?limit=1&cursor=${first.nextCursor}`)).body,
    );
    assert.equal(second.users[0]?.username, 'newbie');
    assert.equal(second.nextCursor, null);
    assert.equal((await owner.get('/users?limit=0')).status, 400);
    assert.equal((await owner.get('/users?cursor=nope')).status, 400);
  });

  it('lets the invitee choose a password and an authenticator, once', async () => {
    const { user, invitation } = await invite(owner, { username: 'second', role: 'auditor' });
    const { client } = await acceptInvitation(instance, invitation.token, THEIR_PASSWORD);
    const me = SessionInfoSchema.parse((await client.get('/auth/me')).body);
    assert.equal(me.user.username, 'second');
    assert.equal(me.user.role, 'auditor');
    assert.ok(me.permissions.includes('users:read'));

    const listed = UserListSchema.parse((await owner.get('/users')).body);
    assert.equal(listed.users.find((u) => u.id === user.id)?.state, 'active');
    assert.equal(listed.users.find((u) => u.id === user.id)?.invitationExpiresAt, null);

    // The token is used up.
    const again = await instance.client().post('/auth/invitations/accept', {
      token: invitation.token,
      password: NEW_PASSWORD,
    });
    assert.equal(again.status, 401);
    const event = (await auditEvents(instance)).find(
      (e) => e.action === 'auth.invitation.accepted' && e.actor?.name === 'second',
    );
    assert.deepEqual(event?.details, { purpose: 'invite' });
    assert.ok(!JSON.stringify(await auditEvents(instance)).includes(invitation.token));
  });

  it('answers alike to an unknown, expired or replaced token, and to a disabled user', async () => {
    const db = instance.isolated.database.client;
    const accept = (token: string, password = THEIR_PASSWORD) =>
      instance.client().post('/auth/invitations/accept', { token, password });

    assert.equal((await accept('x'.repeat(43))).status, 401);

    const expired = await invite(owner, { username: 'late', role: 'observer' });
    await db.invitation.updateMany({
      where: { userId: expired.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await accept(expired.invitation.token)).status, 401);

    const first = await invite(owner, { username: 'twice', role: 'observer' });
    const reissued = UserInvitationSchema.parse(
      (await owner.post(`/users/${first.user.id}/reset-credentials`)).body,
    );
    assert.equal((await accept(first.invitation.token)).status, 401, 'the old token is replaced');
    assert.equal(await db.invitation.count({ where: { userId: first.user.id } }), 1);

    const off = await invite(owner, { username: 'off', role: 'observer' });
    await owner.call('PATCH', `/users/${off.user.id}`, { status: 'disabled' });
    assert.equal((await accept(off.invitation.token)).status, 401);

    const weak = await accept(reissued.invitation.token, 'short');
    assert.equal(weak.status, 400);
    assert.equal(errorCode(weak), 'validation_failed');
    assert.equal(
      await db.invitation.count({ where: { userId: first.user.id } }),
      1,
      'a refused password does not use the token up',
    );
  });

  it('lets only one of two simultaneous requests use a token', async () => {
    const { invitation } = await invite(owner, { username: 'racer', role: 'observer' });
    const attempts = await Promise.all(
      [1, 2, 3].map((n) =>
        instance.client().post('/auth/invitations/accept', {
          token: invitation.token,
          password: `${THEIR_PASSWORD} ${String(n)}`,
        }),
      ),
    );
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 401, 401]);
  });
});

describe('changing users', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerId: string;
  let obs: Client;
  let aud: Client;
  let targetId: string;
  let targetSecret: string;

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    ownerId = (await instance.isolated.database.client.user.findFirstOrThrow()).id;
    const o = await createUser(instance, 'obs', 'observer');
    obs = await signInAs(instance, 'obs', o.secret);
    const a = await createUser(instance, 'aud', 'auditor');
    aud = await signInAs(instance, 'aud', a.secret);
    const t = await createUser(instance, 'target', 'operator');
    targetId = t.id;
    targetSecret = t.secret;
  });
  after(async () => {
    await stop(instance);
  });

  const patch = (client: Client, id: string, body: unknown) =>
    client.call('PATCH', `/users/${id}`, body);

  it('changes a role and records what changed', async () => {
    const reply = await patch(owner, targetId, { role: 'auditor' });
    assert.equal(reply.status, 200);
    assert.equal(UserViewSchema.parse(reply.body).role, 'auditor');
    const event = found(
      (await auditEvents(instance)).filter((e) => e.action === 'user.updated').at(-1),
      'the user.updated event',
    );
    assert.deepEqual(event.details, {
      changed: 'role',
      role_from: 'operator',
      role_to: 'auditor',
    });
    assert.equal(event.actor?.name, 'owner');
    await patch(owner, targetId, { role: 'operator' });
  });

  it('records nothing when nothing changes', async () => {
    const before = (await auditEvents(instance)).length;
    const reply = await patch(owner, targetId, { role: 'operator' });
    assert.equal(reply.status, 200);
    assert.equal((await auditEvents(instance)).length, before);
  });

  it('changes the display name and clears the e-mail address', async () => {
    await patch(owner, targetId, { displayName: 'Target Person', email: 'target@example.org' });
    const cleared = UserViewSchema.parse(
      (await patch(owner, targetId, { displayName: null, email: null })).body,
    );
    assert.equal(cleared.displayName, null);
    assert.equal(cleared.email, null);
    const event = (await auditEvents(instance)).filter((e) => e.action === 'user.updated').at(-1);
    assert.equal(event?.details['changed'], 'display_name,email');
    assert.ok(!JSON.stringify(event).includes('target@example.org'), 'no personal data in the log');
  });

  it('refuses an empty change, an unknown user and a malformed id', async () => {
    assert.equal((await patch(owner, targetId, {})).status, 400);
    assert.equal((await patch(owner, targetId, { role: 'root' })).status, 400);
    const unknown = await patch(owner, '0193a0b0-0000-7000-8000-000000000009', {
      role: 'observer',
    });
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(unknown), 'not_found');
    assert.equal((await patch(owner, 'not-an-id', { role: 'observer' })).status, 400);
  });

  it('does not let anyone change their own role or status, but lets them rename themselves', async () => {
    for (const body of [{ role: 'observer' }, { status: 'disabled' }]) {
      const reply = await patch(owner, ownerId, body);
      assert.equal(reply.status, 409);
      assert.equal(errorCode(reply), 'conflict');
    }
    assert.equal((await patch(owner, ownerId, { displayName: 'The Owner' })).status, 200);
    assert.equal((await patch(owner, ownerId, { role: 'owner' })).status, 200, 'no change is fine');
  });

  it('never leaves the instance without an active owner', async () => {
    const db = instance.isolated.database.client;
    const second = await db.user.create({ data: { username: 'second-owner', role: 'owner' } });
    const users = instance.app.get(UsersService);
    const meta = { ip: undefined, userAgent: undefined, requestId: undefined };
    // The second owner is disabled; then the first is the last. A request of the second that was already
    // under way when that happened must not remove the first.
    await db.user.update({ where: { id: second.id }, data: { status: 'disabled' } });
    await assert.rejects(
      users.update({ id: second.id, name: 'second-owner' }, ownerId, { status: 'disabled' }, meta),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message.includes('at least one enrolled active owner'),
    );
    await assert.rejects(
      users.update({ id: second.id, name: 'second-owner' }, ownerId, { role: 'operator' }, meta),
      ConflictException,
    );
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).role, 'owner');
    await db.user.delete({ where: { id: second.id } });
  });

  it('counts only owners who can sign in: invited, half-enrolled and disabled owners do not keep one', async () => {
    const db = instance.isolated.database.client;
    const users = instance.app.get(UsersService);
    const meta = { ip: undefined, userAgent: undefined, requestId: undefined };
    // An owner invited and never signed in, one who began the authenticator and never confirmed it, and an enrolled
    // owner who is disabled. None of them can act, so the first owner is still the last one.
    const pending = await db.user.create({ data: { username: 'pending-owner', role: 'owner' } });
    const half = await db.user.create({ data: { username: 'half-owner', role: 'owner' } });
    await db.credential.create({
      data: { userId: half.id, passwordHash: 'x', totpSecret: new Uint8Array([1, 2, 3]) },
    });
    const off = await createUser(instance, 'off-owner', 'owner');
    await db.user.update({ where: { id: off.id }, data: { status: 'disabled' } });
    const actor = { id: pending.id, name: 'pending-owner' };
    const before = (await auditEvents(instance)).length;

    for (const body of [{ role: 'operator' as const }, { status: 'disabled' as const }]) {
      await assert.rejects(users.update(actor, ownerId, body, meta), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.match(error.message, /enrolled active owner/u);
        return true;
      });
    }
    await assert.rejects(
      users.resetCredentials(actor, ownerId, meta, 'console'),
      (error: unknown) =>
        error instanceof ConflictException && error.message.includes('enrolled active owner'),
    );
    const row = await db.user.findUniqueOrThrow({
      where: { id: ownerId },
      include: { credential: true },
    });
    assert.equal(row.role, 'owner');
    assert.equal(row.status, 'active');
    assert.ok(row.credential?.totpConfirmedAt, 'the reset was not applied');
    assert.equal((await auditEvents(instance)).length, before, 'nothing was recorded');

    // An owner who is not enrolled is no last owner: the rule does not stand in the way of changing them.
    assert.equal((await patch(owner, pending.id, { role: 'operator' })).status, 200);
    assert.equal((await patch(owner, half.id, { status: 'disabled' })).status, 200);

    // With a second enrolled owner, either may be demoted, disabled or reset from the console.
    const spare = await createUser(instance, 'spare-owner', 'owner');
    const spareActor = { id: spare.id, name: 'spare-owner' };
    await users.update(spareActor, ownerId, { role: 'operator' }, meta);
    await users.update(spareActor, ownerId, { role: 'owner' }, meta);
    assert.equal((await patch(owner, spare.id, { status: 'disabled' })).status, 200);
    assert.equal((await patch(owner, spare.id, { status: 'active' })).status, 200);
    assert.equal((await owner.post(`/users/${spare.id}/reset-credentials`)).status, 200);
    for (const id of [pending.id, half.id, off.id, spare.id]) {
      await db.user.update({ where: { id }, data: { status: 'disabled' } });
      await db.user.delete({ where: { id } });
    }
  });

  it('ends the sessions of a disabled user at once, and lets them back in when enabled', async () => {
    const client = await signInAs(instance, 'target', targetSecret);
    assert.equal((await client.get('/auth/me')).status, 200);
    const off = UserViewSchema.parse((await patch(owner, targetId, { status: 'disabled' })).body);
    assert.equal(off.state, 'disabled');
    assert.equal((await client.get('/auth/me')).status, 401);
    assert.equal(
      await instance.isolated.database.client.session.count({ where: { userId: targetId } }),
      0,
    );
    const event = (await auditEvents(instance)).filter((e) => e.action === 'user.updated').at(-1);
    assert.deepEqual(event?.details, {
      changed: 'status',
      status_from: 'active',
      status_to: 'disabled',
      tokens_revoked: 0,
    });
    const on = UserViewSchema.parse((await patch(owner, targetId, { status: 'active' })).body);
    assert.equal(on.state, 'active');
    await signInAs(instance, 'target', targetSecret);
  });

  it('keeps writing from everyone but the owner, and reading from the auditor and the owner', async () => {
    for (const client of [obs, aud]) {
      assert.equal((await client.post('/users', { username: 'x1', role: 'observer' })).status, 403);
      assert.equal((await patch(client, targetId, { role: 'owner' })).status, 403);
      assert.equal((await client.post(`/users/${targetId}/reset-credentials`)).status, 403);
    }
    assert.equal((await obs.get('/users')).status, 403);
    assert.equal((await aud.get('/users')).status, 200);
    assert.equal((await instance.client().get('/users')).status, 401);
    assert.equal(
      await instance.isolated.database.client.user.count({ where: { username: 'x1' } }),
      0,
    );
  });
});

describe('resetting credentials', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerId: string;
  let secret: string;
  let userId: string;
  let userSecret: string;

  before(async () => {
    instance = await start();
    ({ secret } = await createOwner(instance));
    owner = await signInAs(instance, 'owner', secret);
    ownerId = (await instance.isolated.database.client.user.findFirstOrThrow()).id;
    const u = await createUser(instance, 'person', 'operator');
    userId = u.id;
    userSecret = u.secret;
  });
  after(async () => {
    await stop(instance);
  });

  it('ends the old credentials at once and hands over an invitation', async () => {
    const session = await signInAs(instance, 'person', userSecret);
    const db = instance.isolated.database.client;
    await db.recoveryCode.create({ data: { userId, codeHash: 'a'.repeat(64) } });
    await db.credential.update({
      where: { userId },
      data: { passwordFailures: 2 },
    });
    await db.mfaSourceFailure.create({
      data: {
        userId,
        sourceBucket: '192.0.2.9',
        failures: 2,
        windowEndsAt: new Date(Date.now() + 60_000),
      },
    });
    await db.passwordSourceFailure.create({
      data: {
        userId,
        sourceBucket: '192.0.2.9',
        failures: 2,
        windowEndsAt: new Date(Date.now() + 60_000),
      },
    });
    const epochBefore = (await db.user.findUniqueOrThrow({ where: { id: userId } }))
      .credentialEpoch;

    const reply = await owner.post(`/users/${userId}/reset-credentials`);
    assert.equal(reply.status, 200);
    const { user, invitation } = UserInvitationSchema.parse(reply.body);
    assert.equal(invitation.purpose, 'reset');
    assert.equal(user.state, 'invited');

    assert.equal((await session.get('/auth/me')).status, 401, 'the session is gone');
    const login = await instance.client().post('/auth/login', {
      username: 'person',
      password: PASSWORD,
    });
    assert.equal(login.status, 401, 'the old password stops working');
    assert.equal(await db.credential.count({ where: { userId } }), 0);
    assert.equal(await db.recoveryCode.count({ where: { userId } }), 0);
    assert.equal(await db.session.count({ where: { userId } }), 0);
    assert.equal(await db.passwordSourceFailure.count({ where: { userId } }), 0);
    assert.equal(await db.mfaSourceFailure.count({ where: { userId } }), 0);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: userId } })).credentialEpoch,
      epochBefore + 1n,
      'the credential epoch moved on',
    );

    const event = found(
      (await auditEvents(instance)).find((e) => e.action === 'user.credentials.reset'),
      'the reset event',
    );
    assert.equal(event.actor?.name, 'owner');
    assert.deepEqual(event.details, { via: 'console', tokens_revoked: 0 });
    assert.deepEqual(event.object, { type: 'user', id: userId });

    const taken = await acceptInvitation(instance, invitation.token, NEW_PASSWORD);
    assert.equal(
      SessionInfoSchema.parse((await taken.client.get('/auth/me')).body).user.username,
      'person',
    );
    const again = await instance.client().post('/auth/login', {
      username: 'person',
      password: NEW_PASSWORD,
    });
    assert.equal(again.status, 200, 'the new password works');
    assert.equal(
      (await instance.client().post('/auth/login', { username: 'person', password: PASSWORD }))
        .status,
      401,
    );
    const accepted = (await auditEvents(instance)).filter(
      (e) => e.action === 'auth.invitation.accepted',
    );
    assert.deepEqual(accepted.at(-1)?.details, { purpose: 'reset' });
  });

  it('refuses a reset of your own account, and of someone who is not there', async () => {
    const self = await owner.post(`/users/${ownerId}/reset-credentials`);
    assert.equal(self.status, 409);
    assert.equal(errorCode(self), 'conflict');
    assert.equal(
      await instance.isolated.database.client.credential.count({ where: { userId: ownerId } }),
      1,
    );
    const unknown = await owner.post(
      '/users/0193a0b0-0000-7000-8000-000000000009/reset-credentials',
    );
    assert.equal(unknown.status, 404);
    assert.equal((await owner.post('/users/nope/reset-credentials')).status, 400);
  });
});

describe('changing your own password', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let secret: string;

  before(async () => {
    instance = await start();
    ({ secret } = await createUser(instance, 'person', 'operator'));
  });
  after(async () => {
    await stop(instance);
  });

  it('ends the other sessions, keeps this one, and swaps the password', async () => {
    const here = await signInAs(instance, 'person', secret);
    const elsewhere = await signInAs(instance, 'person', secret);
    assert.equal((await elsewhere.get('/auth/me')).status, 200);
    const reply = await here.post('/auth/password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    assert.equal(reply.status, 204);
    assert.equal(reply.body, undefined);
    assert.equal((await here.get('/auth/me')).status, 200);
    assert.equal((await elsewhere.get('/auth/me')).status, 401);

    const old = await instance
      .client()
      .post('/auth/login', { username: 'person', password: PASSWORD });
    assert.equal(old.status, 401);
    await forgetLastStep(instance);
    const fresh = instance.client();
    assert.equal(
      (await fresh.post('/auth/login', { username: 'person', password: NEW_PASSWORD })).status,
      200,
    );
    assert.equal((await fresh.post('/auth/totp', { code: codeFor(secret) })).status, 200);

    const event = found(
      (await auditEvents(instance)).filter((e) => e.action === 'auth.password.changed').at(-1),
      'the password change event',
    );
    assert.equal(event.outcome, 'success');
    assert.equal(event.actor?.name, 'person');
    assert.ok(!JSON.stringify(event).includes(NEW_PASSWORD));
  });

  it('refuses a weak new password, and a call without a session', async () => {
    const client = await signInAs(instance, 'person', secret, NEW_PASSWORD);
    const weak = await client.post('/auth/password', {
      currentPassword: NEW_PASSWORD,
      newPassword: 'short',
    });
    assert.equal(weak.status, 400);
    assert.equal(errorCode(weak), 'validation_failed');
    assert.equal(
      (
        await instance
          .client()
          .post('/auth/password', { currentPassword: 'x', newPassword: THEIR_PASSWORD })
      ).status,
      401,
    );
  });

  it('limits a wrong current password to this session, records it, and leaves sign-in alone (ADR 0049)', async () => {
    const client = await signInAs(instance, 'person', secret, NEW_PASSWORD);
    const wrong = (): Promise<{ status: number }> =>
      client.post('/auth/password', {
        currentPassword: 'not it at all',
        newPassword: THEIR_PASSWORD,
      });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await wrong()).status, 401);
    }
    assert.equal((await wrong()).status, 429, 'this session waits now');
    assert.equal((await client.get('/auth/me')).status, 200, 'and is not ended');
    const failures = (await auditEvents(instance)).filter(
      (e) => e.action === 'auth.password.changed' && e.outcome === 'failure',
    );
    assert.equal(failures.length, 5);
    assert.deepEqual(failures[0]?.details, { reason: 'invalid_current_password' });
    assert.equal(
      (await instance.client().post('/auth/login', { username: 'person', password: NEW_PASSWORD }))
        .status,
      200,
      'signing in is not affected',
    );
  });
});
