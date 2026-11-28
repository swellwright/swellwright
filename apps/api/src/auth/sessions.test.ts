import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { UnauthorizedException } from '@nestjs/common';
import { SessionListSchema, SessionsRevokedSchema } from '@swellwright/contracts';
import type { Database } from '@swellwright/db';

import type { AppConfig } from '../config.js';
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
  PASSWORD,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { CONFIG } from '../tokens.js';
import { SessionManagementService } from './session-management.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/** Lets the elevation of every session lapse, as if the step-up window had run out. */
async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() - 1000) },
  });
}

const sessionsOf = async (client: Client, path = '/auth/sessions') => {
  const reply = await client.get(path);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return SessionListSchema.parse(reply.body).sessions;
};

describe('sessions', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let ownerSecret: string;
  let aliceId: string;
  let aliceSecret: string;
  let auditorSecret: string;

  // Each scenario starts with an empty set of sessions and a fresh per-source login budget.
  beforeEach(async () => {
    instance = await start();
    ({ secret: ownerSecret } = await createOwner(instance));
    ({ id: aliceId, secret: aliceSecret } = await createUser(instance, 'alice', 'observer'));
    ({ secret: auditorSecret } = await createUser(instance, 'auditor', 'auditor'));
  });
  afterEach(async () => {
    await stop(instance);
  });

  it('lists your own sessions and marks the one in use', async () => {
    const first = await signInAs(instance, 'owner', ownerSecret);
    const second = await signInAs(instance, 'owner', ownerSecret);
    const mine = await sessionsOf(first);
    assert.ok(mine.length >= 2);
    assert.ok(mine.every((s) => s.username === 'owner'));
    assert.equal(mine.filter((s) => s.current).length, 1);
    // The other client sees the same sessions with another one marked.
    const theirs = await sessionsOf(second);
    assert.equal(theirs.length, mine.length);
    const markedByFirst = found(
      mine.find((s) => s.current),
      'current session',
    );
    const markedBySecond = found(
      theirs.find((s) => s.current),
      'current session',
    );
    assert.notEqual(markedByFirst.id, markedBySecond.id);
    assert.equal(markedBySecond.elevated, true, 'a fresh sign-in is elevated');
  });

  it('refuses an already authorized revocation after the caller changes epoch', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const sessions = instance.app.get(SessionService);
    const management = instance.app.get(SessionManagementService);
    const stale = await sessions.authenticate(owner.cookie?.split('=')[1] ?? '');
    assert.ok(stale);
    const meta = { ip: undefined, userAgent: undefined, requestId: undefined };
    const tokens = instance.app.get(TokenService);
    const token = await tokens.create(
      stale,
      {
        name: 'epoch-test',
        permissions: ['sessions:read'],
        ipAllowlist: [],
        expiresInDays: 1,
      },
      meta,
    );
    assert.equal((await owner.post('/auth/sessions/revoke-others')).status, 200);
    const newest = await signInAs(instance, 'owner', ownerSecret);
    const other = await signInAs(instance, 'alice', aliceSecret);
    const id = (mine: Awaited<ReturnType<typeof sessionsOf>>) =>
      found(
        mine.find((s) => s.current),
        'current',
      ).id;
    await assert.rejects(
      management.revoke(stale, id(await sessionsOf(newest)), 'own', meta),
      UnauthorizedException,
    );
    await assert.rejects(
      management.revoke(stale, id(await sessionsOf(other)), 'any', meta),
      UnauthorizedException,
    );
    await assert.rejects(management.revokeUser(stale, aliceId, meta), UnauthorizedException);
    await assert.rejects(tokens.revoke(stale, token.view.id, 'own', meta), UnauthorizedException);
    assert.equal(
      (
        await instance.isolated.database.client.apiToken.findUniqueOrThrow({
          where: { id: token.view.id },
        })
      ).revokedAt,
      null,
    );
    assert.equal((await newest.get('/auth/me')).status, 200);
    assert.equal((await other.get('/auth/me')).status, 200);
  });

  it('does not reject a kept cookie when an epoch change races its idle extension', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const id = found(
      (await sessionsOf(owner)).find((s) => s.current),
      'current',
    ).id;
    const sessions = instance.app.get(SessionService);
    const db = instance.isolated.database.client;
    const ctx = await sessions.authenticate(owner.cookie?.split('=')[1] ?? '');
    assert.ok(ctx);
    await db.session.update({
      where: { id },
      data: { lastSeenAt: new Date(Date.now() - 120_000) },
    });
    const update = db.session.updateMany.bind(db.session);
    const management = instance.app.get(SessionManagementService);
    const rollover = async (args: Parameters<typeof update>[0]) => {
      await management.revokeOthers(ctx, {
        ip: undefined,
        userAgent: undefined,
        requestId: undefined,
      });
      return update(args);
    };
    const delegate = new Proxy(db.session, {
      get: (target, name) =>
        name === 'updateMany' ? rollover : (Reflect.get(target, name) as unknown),
    });
    const wrapped = new Proxy(db, {
      get: (target, name) =>
        name === 'session' ? delegate : (Reflect.get(target, name) as unknown),
    });
    const database = Object.create(instance.isolated.database, {
      client: { value: wrapped },
    }) as Database;
    const auth = new SessionService(database, instance.app.get<AppConfig>(CONFIG));
    const kept = await auth.authenticate(owner.cookie?.split('=')[1] ?? '');
    assert.equal(kept?.sessionEpoch, (ctx.sessionEpoch ?? 0n) + 1n);
    const stored = await db.session.findUniqueOrThrow({ where: { id } });
    assert.ok(Date.now() - stored.lastSeenAt.getTime() < 60_000);
  });

  it('timestamps a token revocation with the database clock, not the application clock', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const auth = await instance.app
      .get(SessionService)
      .authenticate(owner.cookie?.split('=')[1] ?? '');
    assert.ok(auth);
    const tokens = instance.app.get(TokenService);
    const meta = { ip: undefined, userAgent: undefined, requestId: undefined };
    const token = await tokens.create(
      auth,
      {
        name: 'clock-test',
        permissions: ['sessions:read'],
        ipAllowlist: [],
        expiresInDays: 1,
      },
      meta,
    );
    const before = Date.now();
    mock.timers.enable({ apis: ['Date'], now: before + 86_400_000 });
    try {
      await tokens.revoke(auth, token.view.id, 'own', meta);
    } finally {
      mock.timers.reset();
    }
    const stored = await instance.isolated.database.client.apiToken.findUniqueOrThrow({
      where: { id: token.view.id },
    });
    assert.ok(stored.revokedAt && Math.abs(stored.revokedAt.getTime() - before) < 60_000);
  });

  it('never lists a session that is only half signed in, or one of someone else', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const ids = (sessions: Awaited<ReturnType<typeof sessionsOf>>) =>
      sessions.map((s) => s.id).sort();
    const before = ids(await sessionsOf(owner));
    const half = instance.client();
    assert.equal(
      (await half.post('/auth/login', { username: 'owner', password: PASSWORD })).status,
      200,
    );
    await signInAs(instance, 'alice', aliceSecret);
    const mine = await sessionsOf(owner);
    assert.deepEqual(ids(mine), before);
  });

  it('ends another session of your own account, and the other browser is signed out at once', async () => {
    const keep = await signInAs(instance, 'owner', ownerSecret);
    const doomed = await signInAs(instance, 'owner', ownerSecret);
    const doomedId = found(
      (await sessionsOf(doomed)).find((s) => s.current),
      'doomed session',
    ).id;
    const reply = await keep.call('DELETE', `/auth/sessions/${doomedId}`);
    assert.equal(reply.status, 204);
    assert.equal((await doomed.get('/auth/me')).status, 401);
    assert.equal((await keep.get('/auth/me')).status, 200);
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'session.revoked'),
      'the revocation record',
    );
    assert.equal(event.object?.id, doomedId);
    assert.deepEqual(event.details, { scope: 'own', user: 'owner' });
    assert.equal(event.actor?.name, 'owner');
  });

  it('does not end the session in use, and does not reveal sessions of others', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const alice = await signInAs(instance, 'alice', aliceSecret);
    const ownId = found(
      (await sessionsOf(owner)).find((s) => s.current),
      'own session',
    ).id;
    const aliceSession = found(
      (await sessionsOf(alice)).find((s) => s.current),
      'alice session',
    ).id;
    const self = await owner.call('DELETE', `/auth/sessions/${ownId}`);
    assert.equal(self.status, 409);
    assert.equal(errorCode(self), 'conflict');
    // Through the personal route a session of someone else does not exist.
    const foreign = await owner.call('DELETE', `/auth/sessions/${aliceSession}`);
    assert.equal(foreign.status, 404);
    assert.equal((await alice.get('/auth/me')).status, 200, 'alice is still signed in');
    assert.equal((await owner.call('DELETE', '/auth/sessions/not-a-uuid')).status, 400);
  });

  it('ends all your other sessions and keeps the current one', async () => {
    const keep = await signInAs(instance, 'owner', ownerSecret);
    // One after the other: a code works once, so two sign-ins at the same moment would fight over it.
    const others = [
      await signInAs(instance, 'owner', ownerSecret),
      await signInAs(instance, 'owner', ownerSecret),
    ];
    const before = (await sessionsOf(keep)).length;
    const reply = await keep.post('/auth/sessions/revoke-others');
    assert.equal(reply.status, 200);
    const { revoked } = SessionsRevokedSchema.parse(reply.body);
    assert.equal(revoked, before - 1);
    const after = await sessionsOf(keep);
    assert.equal(after.length, 1);
    assert.equal(found(after[0], 'remaining session').current, true);
    for (const client of others) {
      assert.equal((await client.get('/auth/me')).status, 401);
    }
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'session.revoked'),
      'the record',
    );
    assert.equal(event.details['scope'], 'others');
    assert.equal(event.details['count'], revoked);
    // Nothing left to end: the credential epoch still moves on (ADR 0049), so a sign-in that was in flight cannot
    // leave a session behind, and that change is recorded with a count of zero. The current session keeps working.
    const count = (await auditEvents(instance)).filter(
      (e) => e.action === 'session.revoked',
    ).length;
    const again = await keep.post('/auth/sessions/revoke-others');
    assert.equal(again.status, 200);
    assert.deepEqual(SessionsRevokedSchema.parse(again.body), { revoked: 0 });
    const records = (await auditEvents(instance)).filter((e) => e.action === 'session.revoked');
    assert.equal(records.length, count + 1);
    assert.equal(records.at(-1)?.details['count'], 0);
    assert.equal((await keep.get('/auth/me')).status, 200);
  });

  it('lets only those with the permission see everyone’s sessions', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const alice = await signInAs(instance, 'alice', aliceSecret);
    const auditor = await signInAs(instance, 'auditor', auditorSecret);
    assert.equal((await alice.get('/sessions')).status, 403);
    const all = await sessionsOf(owner, '/sessions');
    assert.ok(all.some((s) => s.username === 'alice'));
    assert.ok(all.some((s) => s.username === 'owner'));
    const onlyAlice = await sessionsOf(owner, `/sessions?userId=${aliceId}`);
    assert.ok(onlyAlice.length > 0 && onlyAlice.every((s) => s.username === 'alice'));
    assert.ok((await sessionsOf(auditor, '/sessions')).length > 0, 'the auditor may read');
    assert.equal((await owner.get('/sessions?userId=nope')).status, 400);
  });

  it('needs the second factor, and a permission, to end the session of someone else', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const alice = await signInAs(instance, 'alice', aliceSecret);
    const auditor = await signInAs(instance, 'auditor', auditorSecret);
    const aliceSession = found(
      (await sessionsOf(alice)).find((s) => s.current),
      'alice session',
    ).id;

    assert.equal((await alice.call('DELETE', `/sessions/${aliceSession}`)).status, 403);
    // The auditor may read sessions but not end them: forbidden, not a request for a code.
    const denied = await auditor.call('DELETE', `/sessions/${aliceSession}`);
    assert.equal(denied.status, 403);
    assert.equal(errorCode(denied), 'forbidden');

    await lapse(instance);
    const needsCode = await owner.call('DELETE', `/sessions/${aliceSession}`);
    assert.equal(needsCode.status, 403);
    assert.equal(errorCode(needsCode), 'step_up_required');
    assert.equal((await alice.get('/auth/me')).status, 200);

    await forgetLastStep(instance);
    assert.equal((await owner.post('/auth/step-up', { code: codeFor(ownerSecret) })).status, 200);
    assert.equal((await owner.call('DELETE', `/sessions/${aliceSession}`)).status, 204);
    assert.equal((await alice.get('/auth/me')).status, 401);
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'session.revoked'),
      'the record',
    );
    assert.deepEqual(event.details, { scope: 'user', user: 'alice' });
    assert.equal(event.actor?.name, 'owner');
  });

  it('ends every session of a user, but not through your own account', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    const aliceA = await signInAs(instance, 'alice', aliceSecret);
    const aliceB = await signInAs(instance, 'alice', aliceSecret);
    const ownerUser = await instance.isolated.database.client.user.findFirstOrThrow({
      where: { username: 'owner' },
    });
    const mine = await owner.post(`/users/${ownerUser.id}/sessions/revoke`);
    assert.equal(mine.status, 409);
    assert.equal(
      (await owner.post('/users/018f0000-0000-7000-8000-000000000000/sessions/revoke')).status,
      404,
    );
    const reply = await owner.post(`/users/${aliceId}/sessions/revoke`);
    assert.equal(reply.status, 200);
    assert.ok(SessionsRevokedSchema.parse(reply.body).revoked >= 2);
    assert.equal((await aliceA.get('/auth/me')).status, 401);
    assert.equal((await aliceB.get('/auth/me')).status, 401);
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'session.revoked'),
      'the record',
    );
    assert.equal(event.details['scope'], 'user');
    assert.equal(event.object?.type, 'user');
  });

  it('keeps sessions that ended on their own out of the list', async () => {
    const owner = await signInAs(instance, 'owner', ownerSecret);
    await signInAs(instance, 'alice', aliceSecret);
    assert.ok((await sessionsOf(owner, '/sessions')).some((s) => s.username === 'alice'));
    await instance.isolated.database.client.session.updateMany({
      where: { user: { username: 'alice' } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const all = await sessionsOf(owner, '/sessions');
    assert.ok(all.every((s) => s.username !== 'alice'));
  });
});
