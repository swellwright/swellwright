import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { CreatedTokenSchema } from '@swellwright/contracts';

import { runAdmin } from './admin.js';
import {
  acceptInvitation,
  auditEvents,
  createOwner,
  createUser,
  databaseUrl,
  found,
  type Instance,
  PASSWORD,
  signInAs,
  start,
  stop,
} from './test-support.js';

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function admin(instance: Instance, ...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin(args, instance.isolated.database, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

describe('the server command', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let ownerSecret: string;

  before(async () => {
    instance = await start();
    ({ secret: ownerSecret } = await createOwner(instance));
    await createUser(instance, 'person', 'operator');
  });
  after(async () => {
    await stop(instance);
  });

  it('lists the accounts with role and state', async () => {
    const run = await admin(instance, 'users');
    assert.equal(run.code, 0);
    assert.equal(run.out.length, 2);
    assert.match(run.out[0] ?? '', /^owner\s+owner\s+active$/u);
    assert.match(run.out[1] ?? '', /^person\s+operator\s+active$/u);
  });

  it('gets an owner who lost everything back in, and leaves a record without an actor', async () => {
    const session = await signInAs(instance, 'owner', ownerSecret);
    // The sole enrolled owner: the console would refuse this reset, the server command is the way back in.
    const minted = await session.post('/tokens', { name: 'ci', permissions: ['users:read'] });
    assert.equal(minted.status, 201);
    const bearer = { authorization: `Bearer ${CreatedTokenSchema.parse(minted.body).token}` };
    assert.equal((await instance.client().call('GET', '/users', undefined, bearer)).status, 200);
    const run = await admin(instance, 'reset-credentials', ' OWNER ');
    assert.equal(run.code, 0);
    assert.deepEqual(run.err, []);
    const line = run.out.find((l) => l.includes('#invite='));
    const token = line?.split('#invite=')[1]?.trim() ?? '';
    assert.ok(token.length >= 40, 'the invitation is printed');
    assert.equal(run.out.filter((l) => l.includes(token)).length, 1, 'once');

    assert.equal((await session.get('/auth/me')).status, 401, 'the old session ended');
    const old = await instance
      .client()
      .post('/auth/login', { username: 'owner', password: PASSWORD });
    assert.equal(old.status, 401, 'the old password is gone');
    assert.equal(
      (await instance.client().call('GET', '/users', undefined, bearer)).status,
      401,
      'the API token of the owner was revoked with the credentials',
    );

    const { client } = await acceptInvitation(instance, token, 'the owner chose this one');
    const me = await client.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal((await client.get('/audit')).status, 200, 'still the owner');

    const events = await auditEvents(instance);
    const reset = found(
      events.find((e) => e.action === 'user.credentials.reset'),
      'the reset event',
    );
    assert.equal(reset.actor, null);
    assert.deepEqual(reset.details, { via: 'cli', tokens_revoked: 1 });
    assert.equal(reset.object?.type, 'user');
    assert.ok(!JSON.stringify(events).includes(token));
  });

  it('says what went wrong and exits non-zero', async () => {
    const unknown = await admin(instance, 'reset-credentials', 'nobody');
    assert.equal(unknown.code, 1);
    assert.match(unknown.err.join('\n'), /no account named "nobody"/u);

    const missing = await admin(instance, 'reset-credentials');
    assert.equal(missing.code, 2);
    const bad = await admin(instance, 'frobnicate');
    assert.equal(bad.code, 2);
    assert.match(bad.err.join('\n'), /Unknown command "frobnicate"/u);
    const help = await admin(instance, 'help');
    assert.equal(help.code, 0);
    assert.match(help.out.join('\n'), /reset-credentials <login>/u);
    assert.equal((await admin(instance)).code, 2);
  });
});
