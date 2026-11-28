import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  type AuditEvent,
  AuditPageSchema,
  ChainVerificationSchema,
  PERMISSIONS,
  permissionsOf,
  roleCatalog,
  RoleCatalogSchema,
  SessionInfoSchema,
} from '@swellwright/contracts';

import {
  type Client,
  codeFor,
  createOwner,
  createUser,
  databaseUrl,
  errorCode,
  type Instance,
  PASSWORD,
  SETUP_TOKEN,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { AuditService, toAuditEvent } from './audit.service.js';
import { chainHash, GENESIS_HASH } from './chain.js';

/** The event at a position (negative counts from the end), or a failed test. */
function at(events: readonly AuditEvent[], index: number): AuditEvent {
  const event = events.at(index);
  assert.ok(event, `there is no event at position ${String(index)}`);
  return event;
}

/** Every event in the database, oldest first, as the API would show it. */
async function stored(instance: Instance): Promise<AuditEvent[]> {
  const rows = await instance.isolated.database.client.auditEvent.findMany({
    orderBy: { seq: 'asc' },
  });
  return rows.map(toAuditEvent);
}

const page = async (
  client: Client,
  query = '',
): Promise<ReturnType<typeof AuditPageSchema.parse>> => {
  const reply = await client.get(`/audit${query}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return AuditPageSchema.parse(reply.body);
};

const verify = async (
  client: Client,
): Promise<ReturnType<typeof ChainVerificationSchema.parse>> => {
  const reply = await client.post('/audit/verify-chain');
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return ChainVerificationSchema.parse(reply.body);
};

describe('the audit log through the API', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
  });
  after(async () => {
    await stop(instance);
  });

  it('records the first run and the sign-ins in order, each linked to the one before', async () => {
    const events = await stored(instance);
    assert.deepEqual(
      events.map((e) => [e.seq, e.action, e.outcome]),
      [
        [1, 'setup.owner.created', 'success'],
        [2, 'auth.totp.enrolled', 'success'],
        [3, 'auth.login.succeeded', 'success'],
        [4, 'auth.login.succeeded', 'success'],
      ],
    );
    assert.deepEqual(at(events, 0).details, {});
    assert.deepEqual(at(events, 2).details, { method: 'enrollment' });
    assert.deepEqual(at(events, 3).details, { method: 'totp' });
    assert.equal(at(events, 0).prevHash, GENESIS_HASH);
    for (let i = 1; i < events.length; i += 1) {
      assert.equal(at(events, i).prevHash, at(events, i - 1).hash);
    }
    const created = at(events, 0);
    assert.equal(created.actor?.name, 'owner');
    // Narrowed by the line above: there is an actor.
    assert.deepEqual(created.object, { type: 'user', id: created.actor.id });
    for (const event of events) {
      assert.ok(event.ip, 'the client address is kept');
      assert.ok(event.requestId, 'the request id is kept');
    }
  });

  it('lists newest first, in pages, with filters', async () => {
    const first = await page(owner, '?limit=2');
    assert.deepEqual(
      first.events.map((e) => e.seq),
      [4, 3],
    );
    assert.equal(first.nextCursor, 3);
    const second = await page(owner, `?limit=2&cursor=${String(first.nextCursor)}`);
    assert.deepEqual(
      second.events.map((e) => e.seq),
      [2, 1],
    );
    assert.equal(second.nextCursor, null);
    assert.equal(first.total, 4);

    // A table with page numbers asks by offset, and learns how many events the filters match.
    const third = await page(owner, '?limit=2&offset=2');
    assert.deepEqual(
      third.events.map((e) => e.seq),
      [2, 1],
    );
    assert.equal(third.nextCursor, null);
    assert.equal(third.total, 4);
    const beyond = await page(owner, '?limit=2&offset=4');
    assert.deepEqual(beyond.events, []);
    assert.equal(beyond.total, 4);
    const middle = await page(owner, '?limit=1&offset=1');
    assert.deepEqual(
      middle.events.map((e) => e.seq),
      [3],
    );
    assert.equal(middle.nextCursor, 3);

    const logins = await page(owner, '?action=auth.login.succeeded');
    assert.equal(logins.total, 2);
    assert.deepEqual(
      logins.events.map((e) => e.seq),
      [4, 3],
    );
    assert.equal((await page(owner, '?outcome=failure')).events.length, 0);
    assert.equal((await page(owner, '?outcome=failure')).total, 0);
    const actorId = (await stored(instance))[0]?.actor?.id ?? '';
    assert.equal((await page(owner, `?actorId=${actorId}`)).events.length, 4);
    assert.equal(
      (await page(owner, `?actorId=0193a0b0-0000-7000-8000-000000000009`)).events.length,
      0,
    );
  });

  it('refuses a query that does not match the contract', async () => {
    for (const bad of [
      '?limit=0',
      '?limit=1000',
      '?outcome=maybe',
      '?actorId=nobody',
      '?cursor=0',
      '?offset=-1',
    ]) {
      const reply = await owner.get(`/audit${bad}`);
      assert.equal(reply.status, 400, bad);
      assert.equal(errorCode(reply), 'validation_failed', bad);
    }
  });

  it('verifies an intact chain, and records that it did', async () => {
    const result = await verify(owner);
    assert.deepEqual(result, {
      ok: true,
      checked: 4,
      head: { seq: 4, hash: (await stored(instance))[3]?.hash },
      problem: null,
    });
    const newest = at((await page(owner, '?limit=1')).events, 0);
    assert.equal(newest.action, 'audit.chain.verified');
    assert.equal(newest.outcome, 'success');
    assert.deepEqual(newest.details, { ok: true, checked: 4 });
    // The next check sees the event the previous one left.
    assert.equal((await verify(owner)).checked, 5);
  });
});

describe('tampering with the audit log', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
  });
  after(async () => {
    await stop(instance);
  });

  /** What someone with write access to the table, and the triggers out of the way, could do. */
  async function withoutTrigger(work: () => Promise<void>): Promise<void> {
    const db = instance.isolated.database.client;
    // Raw SQL is not qualified by the client: name the schema of this test instance.
    const table = `"${instance.isolated.schema}"."audit_events"`;
    await db.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER "audit_events_append_only"`);
    try {
      await work();
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER "audit_events_append_only"`);
    }
  }

  it('finds a changed event', async () => {
    const db = instance.isolated.database.client;
    await withoutTrigger(async () => {
      await db.auditEvent.update({ where: { seq: 2n }, data: { outcome: 'failure' } });
      assert.deepEqual(await verify(owner), {
        ok: false,
        checked: 1,
        head: { seq: 4, hash: (await stored(instance))[3]?.hash },
        problem: { seq: 2, reason: 'content' },
      });
      await db.auditEvent.update({ where: { seq: 2n }, data: { outcome: 'success' } });
    });
    assert.equal((await verify(owner)).ok, true);
  });

  it('finds a broken link', async () => {
    const db = instance.isolated.database.client;
    const original = await db.auditEvent.findUniqueOrThrow({ where: { seq: 3n } });
    await withoutTrigger(async () => {
      await db.auditEvent.update({ where: { seq: 3n }, data: { prevHash: 'b'.repeat(64) } });
      const result = await verify(owner);
      assert.equal(result.ok, false);
      assert.deepEqual(result.problem, { seq: 3, reason: 'link' });
      await db.auditEvent.update({ where: { seq: 3n }, data: { prevHash: original.prevHash } });
    });
    assert.equal((await verify(owner)).ok, true);
  });

  it('finds a removed event in the middle, at the place it should have been', async () => {
    const db = instance.isolated.database.client;
    const original = await db.auditEvent.findUniqueOrThrow({ where: { seq: 2n } });
    await withoutTrigger(async () => {
      await db.auditEvent.delete({ where: { seq: 2n } });
      const result = await verify(owner);
      assert.equal(result.ok, false);
      assert.deepEqual(result.problem, { seq: 2, reason: 'missing' });
      await db.auditEvent.create({ data: original });
    });
    assert.equal((await verify(owner)).ok, true);
  });

  it('is not fooled by one event rewritten together with its own hash', async () => {
    const db = instance.isolated.database.client;
    const original = await db.auditEvent.findUniqueOrThrow({ where: { seq: 2n } });
    await withoutTrigger(async () => {
      const forged = { ...original, details: '{"forged":true}' };
      await db.auditEvent.update({
        where: { seq: 2n },
        data: { details: forged.details, hash: chainHash(forged) },
      });
      const result = await verify(owner);
      assert.equal(result.ok, false);
      // Event 2 now agrees with itself; event 3 still points at the hash event 2 used to have.
      assert.deepEqual(result.problem, { seq: 3, reason: 'link' });
      await db.auditEvent.update({
        where: { seq: 2n },
        data: { details: original.details, hash: original.hash },
      });
    });
    assert.equal((await verify(owner)).ok, true);
  });

  it('cannot see the newest events cut off: only a head noted earlier shows that', async () => {
    const db = instance.isolated.database.client;
    // Straight to the service: the API route would append an event of its own after the check.
    const audit = instance.app.get(AuditService);
    const newest = await db.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } });
    await withoutTrigger(async () => {
      await db.auditEvent.delete({ where: { seq: newest.seq } });
      const result = await audit.verify();
      assert.equal(result.ok, true, 'the shorter chain is still a chain');
      assert.equal(result.head?.seq, Number(newest.seq) - 1, 'but its head went backwards');
      await db.auditEvent.create({ data: newest });
    });
    assert.equal((await audit.verify()).head?.seq, Number(newest.seq));
  });

  it('is refused by the database itself while the triggers are on', async () => {
    const db = instance.isolated.database.client;
    await assert.rejects(db.auditEvent.update({ where: { seq: 1n }, data: { action: 'x' } }));
    await assert.rejects(db.auditEvent.delete({ where: { seq: 1n } }));
  });
});

describe('who may read the audit log', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let observer: Client;
  let operator: Client;
  let auditor: Client;
  let observerId: string;

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const o = await createUser(instance, 'obs', 'observer');
    observerId = o.id;
    observer = await signInAs(instance, 'obs', o.secret);
    const p = await createUser(instance, 'op', 'operator');
    operator = await signInAs(instance, 'op', p.secret);
    const a = await createUser(instance, 'aud', 'auditor');
    auditor = await signInAs(instance, 'aud', a.secret);
  });
  after(async () => {
    await stop(instance);
  });

  it('asks for a session first: nobody signed in gets 401, not 403', async () => {
    const anonymous = instance.client();
    for (const reply of [
      await anonymous.get('/audit'),
      await anonymous.post('/audit/verify-chain'),
      await anonymous.get('/roles'),
    ]) {
      assert.equal(reply.status, 401);
      assert.equal(errorCode(reply), 'unauthorized');
    }
  });

  it('keeps the audit log and the roles from observers and operators', async () => {
    for (const client of [observer, operator]) {
      for (const reply of [
        await client.get('/audit'),
        await client.post('/audit/verify-chain'),
        await client.get('/roles'),
      ]) {
        assert.equal(reply.status, 403);
        assert.equal(errorCode(reply), 'forbidden');
      }
    }
  });

  it('lets the auditor and the owner read, verify and see the roles', async () => {
    for (const client of [owner, auditor]) {
      assert.equal((await client.get('/audit')).status, 200);
      assert.equal((await client.post('/audit/verify-chain')).status, 200);
      const roles = RoleCatalogSchema.parse((await client.get('/roles')).body);
      assert.deepEqual(roles, roleCatalog());
    }
  });

  it('tells every signed-in user what their role allows', async () => {
    const mine = SessionInfoSchema.parse((await observer.get('/auth/me')).body);
    assert.deepEqual(mine.permissions, [...permissionsOf('observer')]);
    const theirs = SessionInfoSchema.parse((await owner.get('/auth/me')).body);
    assert.deepEqual([...theirs.permissions].sort(), [...PERMISSIONS].sort());
  });

  it('records a refusal with who, what and which permission was missing', async () => {
    const denied = (await page(owner, '?action=authz.denied')).events;
    assert.ok(denied.length >= 2);
    const first = denied.find((e) => e.object?.id === 'listAudit' && e.actor?.name === 'obs');
    assert.ok(first, 'the observer was refused the audit list');
    assert.equal(first.outcome, 'denied');
    assert.equal(first.actor?.id, observerId);
    assert.deepEqual(first.object, { type: 'route', id: 'listAudit' });
    assert.deepEqual(first.details, { permission: 'audit:read', via: 'session' });
  });

  it('applies a changed role on the next request, without signing in again', async () => {
    const users = instance.isolated.database.client.user;
    assert.equal((await observer.get('/audit')).status, 403);
    await users.update({ where: { id: observerId }, data: { role: 'auditor' } });
    assert.equal((await observer.get('/audit')).status, 200);
    const me = SessionInfoSchema.parse((await observer.get('/auth/me')).body);
    assert.deepEqual(me.permissions, [...permissionsOf('auditor')]);
    await users.update({ where: { id: observerId }, data: { role: 'observer' } });
    assert.equal((await observer.get('/audit')).status, 403);
    await users.update({ where: { id: observerId }, data: { status: 'disabled' } });
    assert.equal((await observer.get('/auth/me')).status, 401);
  });
});

describe('what the audit log keeps about failures', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let secret: string;
  let recoveryCodes: string[];

  before(async () => {
    instance = await start();
    ({ secret, recoveryCodes } = await createOwner(instance));
  });
  after(async () => {
    await stop(instance);
  });

  const typedByCaller = ['ghost-typed-name', 'ghost-typed-password', 'another wrong password!'];

  it('records a wrong password with the account, an unknown account without any name', async () => {
    const client = instance.client();
    await client.post('/auth/login', { username: 'owner', password: typedByCaller[2] });
    await client.post('/auth/login', { username: typedByCaller[0], password: typedByCaller[1] });
    const events = (await stored(instance)).filter((e) => e.action === 'auth.login.failed');
    assert.equal(events.length, 2);
    assert.equal(at(events, 0).actor?.name, 'owner');
    assert.deepEqual(at(events, 0).details, { reason: 'invalid_credentials' });
    assert.equal(at(events, 0).outcome, 'failure');
    assert.equal(at(events, 1).actor, null);
    assert.deepEqual(at(events, 1).details, { reason: 'unknown_account' });
    // Nothing the caller typed, and no secret of ours, is anywhere in the chain.
    const everything = JSON.stringify(await stored(instance));
    for (const text of [...typedByCaller, PASSWORD, secret, ...recoveryCodes]) {
      assert.ok(!everything.includes(text), `the chain must not contain ${text}`);
    }
  });

  it('records the lock once, and stays quiet about refusals while the account is locked', async () => {
    // Wrong passwords never lock (ADR 0049): the lock comes from wrong second factors.
    const client = instance.client();
    assert.equal(
      (await client.post('/auth/login', { username: 'owner', password: PASSWORD })).status,
      200,
    );
    const wrongCode = codeFor(secret) === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await client.post('/auth/totp', { code: wrongCode })).status, 401);
    }
    const locks = (await stored(instance)).filter((e) => e.action === 'auth.account.locked');
    assert.equal(locks.length, 1);
    assert.deepEqual(at(locks, 0).details, { failures: 3, minutes: 15 });
    assert.equal(at(locks, 0).actor?.name, 'owner');

    const before = (await stored(instance)).length;
    for (let i = 0; i < 4; i += 1) {
      assert.equal(
        (await client.post('/auth/login', { username: 'owner', password: PASSWORD })).status,
        429,
      );
    }
    assert.equal((await stored(instance)).length, before, 'refusals while locked add nothing');
  });

  it('records a wrong second step, a recovery code used up, the sign-in and the sign-out', async () => {
    const db = instance.isolated.database.client;
    await db.mfaSourceFailure.deleteMany();
    await db.credential.updateMany({ data: { totpLastStep: null } });
    const client = instance.client();
    await client.post('/auth/login', { username: 'owner', password: PASSWORD });
    const wrong = codeFor(secret) === '000000' ? '000001' : '000000';
    assert.equal((await client.post('/auth/totp', { code: wrong })).status, 401);
    const recovery = recoveryCodes[0] ?? '';
    assert.equal((await client.post('/auth/totp', { code: recovery })).status, 200);
    assert.equal((await client.post('/auth/logout')).status, 204);

    const tail = (await stored(instance)).slice(-4);
    assert.deepEqual(
      tail.map((e) => [e.action, e.outcome, e.details]),
      [
        ['auth.second_step.failed', 'failure', { method: 'totp' }],
        ['auth.recovery_code.used', 'success', {}],
        ['auth.login.succeeded', 'success', { method: 'recovery_code' }],
        ['auth.logout', 'success', {}],
      ],
    );
    assert.ok(!JSON.stringify(tail).includes(recovery));
  });
});

describe('volume limits on records anyone can provoke', { skip: !databaseUrl }, () => {
  let instance: Instance;

  before(async () => {
    instance = await start({ SW_LOCKOUT_ATTEMPTS: '20' });
  });
  after(async () => {
    await stop(instance);
  });

  it('records only the first ten sign-ins for unknown accounts from one address', async () => {
    await createOwner(instance);
    const client = instance.client();
    for (let i = 0; i < 14; i += 1) {
      assert.equal(
        (await client.post('/auth/login', { username: `ghost${String(i)}`, password: 'whatever' }))
          .status,
        401,
      );
    }
    const events = (await stored(instance)).filter(
      (e) => e.details['reason'] === 'unknown_account',
    );
    assert.equal(events.length, 10);
  });

  it('records at most twenty refusals per user in a quarter of an hour', async () => {
    const o = await createUser(instance, 'obs', 'observer');
    const observer = await signInAs(instance, 'obs', o.secret);
    for (let i = 0; i < 25; i += 1) {
      assert.equal((await observer.get('/audit')).status, 403);
    }
    const denied = (await stored(instance)).filter((e) => e.action === 'authz.denied');
    assert.equal(denied.length, 20);
  });
});

describe('appending to the chain', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let audit: AuditService;
  let owner: Client;

  before(async () => {
    instance = await start();
    audit = instance.app.get(AuditService);
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
  });
  after(async () => {
    await stop(instance);
  });

  it('numbers concurrent events without a gap or a repeat, and the chain verifies', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        audit.record({
          action: 'auth.logout',
          outcome: 'success',
          details: { n: i },
          meta: { ip: '203.0.113.1', requestId: `r${String(i)}` },
        }),
      ),
    );
    const events = await stored(instance);
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    const result = await verify(owner);
    assert.equal(result.ok, true);
    assert.equal(result.checked, events.length);
  });

  it('refuses details that are not flat, and writes nothing for them', async () => {
    const count = (await stored(instance)).length;
    await assert.rejects(
      audit.record({
        action: 'auth.logout',
        outcome: 'success',
        details: { nested: { a: 1 } } as never,
        meta: { ip: undefined, requestId: undefined },
      }),
    );
    assert.equal((await stored(instance)).length, count);
  });

  it('cuts a value to its column before hashing, so a long one still verifies', async () => {
    await audit.record({
      action: 'auth.logout',
      outcome: 'success',
      actor: { id: '0193a0b0-0000-7000-8000-000000000003', name: 'n'.repeat(100) },
      object: { type: 't'.repeat(50), id: 'i'.repeat(100) },
      meta: { ip: '1'.repeat(100), requestId: 'q'.repeat(100) },
    });
    const last = at(await stored(instance), -1);
    assert.equal(last.actor?.name.length, 64);
    assert.equal(last.object?.type.length, 32);
    assert.equal(last.object.id.length, 64);
    assert.equal(last.ip?.length, 64);
    assert.equal(last.requestId?.length, 64);
    assert.equal((await verify(owner)).ok, true);
  });

  it('swallows a failed write for a refusal, and not for a change', async () => {
    const broken = new AuditService({
      client: {
        $transaction: () => Promise.reject(new Error('store down')),
      },
    } as never);
    const input = {
      action: 'auth.login.failed',
      outcome: 'failure',
      meta: { ip: undefined, requestId: undefined },
    } as const;
    await broken.note(input);
    await assert.rejects(broken.record(input), /store down/u);
  });
});

describe('the first run in the audit log', { skip: !databaseUrl }, () => {
  let instance: Instance;
  before(async () => {
    instance = await start();
  });
  after(async () => {
    await stop(instance);
  });

  it('keeps a refused setup, then the owner it let in', async () => {
    const wrong = await instance
      .client()
      .post('/setup/owner', { setupToken: 'not-the-token', username: 'owner', password: PASSWORD });
    assert.equal(wrong.status, 403);
    const right = await instance
      .client()
      .post('/setup/owner', { setupToken: SETUP_TOKEN, username: 'owner', password: PASSWORD });
    assert.equal(right.status, 200);
    const events = await stored(instance);
    assert.deepEqual(
      events.map((e) => [e.seq, e.action, e.outcome, e.actor?.name ?? null]),
      [
        [1, 'setup.owner.refused', 'failure', null],
        [2, 'setup.owner.created', 'success', 'owner'],
      ],
    );
    assert.deepEqual(events[0]?.details, { reason: 'invalid_token' });
    assert.ok(!JSON.stringify(events).includes('not-the-token'));
    assert.ok(!JSON.stringify(events).includes(SETUP_TOKEN));
  });
});
