import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  RevealedSecretSchema,
  SecretListSchema,
  SecretViewSchema,
  VaultInitializedSchema,
  VaultStatusSchema,
} from '@swellwright/contracts';

import { AuditService } from '../audit/audit.service.js';
import { VaultSealedException } from '../http.js';
import {
  auditEvents,
  CHEAP_KDF,
  type Client,
  createOwner,
  createUser,
  databaseUrl,
  errorCode,
  found,
  type Instance,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { VaultService } from './vault.service.js';

const PASSPHRASE = 'a long passphrase for the vault, used in tests';
const SSH_KEY = 'FAKE ssh key material, this-is-not-a-real-key, only for tests\nsecond line\n';

/** Lets the elevation of every session lapse, as if the step-up window had run out. */
async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() - 1000) },
  });
}

const status = async (client: Client): Promise<ReturnType<typeof VaultStatusSchema.parse>> => {
  const reply = await client.get('/vault/status');
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return VaultStatusSchema.parse(reply.body);
};

describe('setting the vault up', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerKey: string;
  let recoveryKey = '';

  before(async () => {
    instance = await start();
    ({ secret: ownerKey } = await createOwner(instance));
    owner = await signInAs(instance, 'owner', ownerKey);
  });
  after(async () => {
    await stop(instance);
  });

  it('starts without a vault', async () => {
    assert.deepEqual(await status(owner), {
      state: 'uninitialized',
      secretCount: 0,
      kekVersion: null,
      createdAt: null,
      passphraseChangedAt: null,
      recoveryKeyRotatedAt: null,
      kekRotatedAt: null,
      dataKeysRotatedAt: null,
    });
  });

  it('refuses a short passphrase, and asks for a fresh second factor first', async () => {
    const short = await owner.post('/vault/initialize', { passphrase: 'too short' });
    assert.equal(short.status, 400);
    assert.equal(errorCode(short), 'validation_failed');
    await lapse(instance);
    const stale = await owner.post('/vault/initialize', { passphrase: PASSPHRASE });
    assert.equal(stale.status, 403);
    assert.equal(errorCode(stale), 'step_up_required');
    assert.equal(await instance.isolated.database.client.vaultMeta.count(), 0);
  });

  it('sets up once, opens, and hands over the recovery key that is stored nowhere', async () => {
    // The previous test let the elevation lapse; signing in again elevates a new session.
    owner = await signInAs(instance, 'owner', ownerKey);
    const reply = await owner.post('/vault/initialize', { passphrase: PASSPHRASE });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const body = VaultInitializedSchema.parse(reply.body);
    recoveryKey = body.recoveryKey;
    assert.match(recoveryKey, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/u);
    assert.equal(body.status.state, 'unsealed');
    assert.equal(body.status.kekVersion, 1);

    const meta = await instance.isolated.database.client.vaultMeta.findUniqueOrThrow({
      where: { id: 1 },
    });
    const stored = JSON.stringify([
      Buffer.from(meta.passphraseWrappedKek).toString('latin1'),
      Buffer.from(meta.recoveryWrappedKek).toString('latin1'),
    ]);
    assert.ok(!stored.includes(PASSPHRASE));
    assert.ok(!stored.includes(recoveryKey.replace(/-/gu, '')));
    assert.equal(meta.kdfMemoryKib, CHEAP_KDF.memoryKib);

    const again = await owner.post('/vault/initialize', { passphrase: `${PASSPHRASE} again` });
    assert.equal(again.status, 409);
    assert.equal(errorCode(again), 'conflict');
  });

  it('records the setup without the passphrase or the key', async () => {
    const events = await auditEvents(instance);
    const setup = found(
      events.find((e) => e.action === 'vault.initialized'),
      'the vault.initialized event',
    );
    assert.equal(setup.actor?.name, 'owner');
    assert.deepEqual(setup.details, { kek_version: 1 });
    const everything = JSON.stringify(events);
    assert.ok(!everything.includes(PASSPHRASE));
    assert.ok(!everything.includes(recoveryKey));
  });
});

describe('keeping secrets', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let recoveryKey = '';
  let sshId = '';

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const init = VaultInitializedSchema.parse(
      (await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).body,
    );
    recoveryKey = init.recoveryKey;
  });
  after(async () => {
    await stop(instance);
  });

  it('stores a secret encrypted, returns it without its value, and lists it', async () => {
    const reply = await owner.post('/secrets', {
      name: '  Fleet SSH key  ',
      type: 'ssh_key',
      value: SSH_KEY,
      description: 'The key every node trusts',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const view = SecretViewSchema.parse(reply.body);
    sshId = view.id;
    assert.equal(view.name, 'Fleet SSH key', 'the name is trimmed');
    assert.equal(view.version, 1);
    assert.ok(
      !JSON.stringify(reply.body).includes('this-is-not-a-real-key'),
      'no value in the answer',
    );

    const row = await instance.isolated.database.client.secret.findUniqueOrThrow({
      where: { id: sshId },
    });
    assert.ok(
      !Buffer.from(row.ciphertext).includes('this-is-not-a-real-key'),
      'no value in the database',
    );
    assert.ok(!Buffer.from(row.wrappedDek).includes('this-is-not-a-real-key'));

    const list = SecretListSchema.parse((await owner.get('/secrets')).body);
    assert.deepEqual(
      list.secrets.map((s) => s.name),
      ['Fleet SSH key'],
    );
    assert.ok(!JSON.stringify(list).includes('this-is-not-a-real-key'));
    assert.equal((await status(owner)).secretCount, 1);
  });

  it('refuses a taken name, an unknown type and an empty value', async () => {
    const taken = await owner.post('/secrets', {
      name: 'Fleet SSH key',
      type: 'generic',
      value: 'x',
    });
    assert.equal(taken.status, 409);
    assert.equal(errorCode(taken), 'conflict');
    for (const bad of [
      { name: 'a', type: 'password', value: 'x' },
      { name: 'a', type: 'generic', value: '' },
      { name: '', type: 'generic', value: 'x' },
      { type: 'generic', value: 'x' },
    ]) {
      const reply = await owner.post('/secrets', bad);
      assert.equal(reply.status, 400, JSON.stringify(bad));
      assert.equal(errorCode(reply), 'validation_failed');
    }
  });

  it('shows a value only through reveal, and records that before the value leaves', async () => {
    const reply = await owner.post(`/secrets/${sshId}/reveal`);
    assert.equal(reply.status, 200);
    const revealed = RevealedSecretSchema.parse(reply.body);
    assert.equal(revealed.value, SSH_KEY);
    assert.equal(revealed.version, 1);

    const events = await auditEvents(instance);
    const event = found(
      events.filter((e) => e.action === 'secret.revealed').at(-1),
      'the secret.revealed event',
    );
    assert.equal(event.actor?.name, 'owner');
    assert.deepEqual(event.object, { type: 'secret', id: sshId });
    assert.deepEqual(event.details, { secret_type: 'ssh_key', version: 1 });
    assert.ok(!JSON.stringify(events).includes('this-is-not-a-real-key'));
    assert.equal(
      (await owner.post('/secrets/0193a0b0-0000-7000-8000-000000000009/reveal')).status,
      404,
    );
    assert.equal((await owner.post('/secrets/nope/reveal')).status, 400);
  });

  it('replaces a value under a new version and a new data key, and keeps no old copy', async () => {
    const db = instance.isolated.database.client;
    const before = await db.secret.findUniqueOrThrow({ where: { id: sshId } });
    const reply = await owner.call('PATCH', `/secrets/${sshId}`, { value: 'the-second-value' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(SecretViewSchema.parse(reply.body).version, 2);
    const after = await db.secret.findUniqueOrThrow({ where: { id: sshId } });
    assert.notDeepEqual(after.ciphertext, before.ciphertext);
    assert.notDeepEqual(after.wrappedDek, before.wrappedDek);
    assert.ok(after.valueChangedAt.getTime() >= before.valueChangedAt.getTime());
    const revealed = RevealedSecretSchema.parse(
      (await owner.post(`/secrets/${sshId}/reveal`)).body,
    );
    assert.deepEqual([revealed.value, revealed.version], ['the-second-value', 2]);
    const event = found(
      (await auditEvents(instance)).filter((e) => e.action === 'secret.updated').at(-1),
      'the secret.updated event',
    );
    assert.deepEqual(event.details, { changed: 'value', version: 2 });
  });

  it('changes the details without touching the value, and clears them with null', async () => {
    const db = instance.isolated.database.client;
    const before = await db.secret.findUniqueOrThrow({ where: { id: sshId } });
    const renamed = SecretViewSchema.parse(
      (
        await owner.call('PATCH', `/secrets/${sshId}`, {
          name: 'Node SSH key',
          description: null,
          expiresAt: null,
        })
      ).body,
    );
    assert.deepEqual(
      [renamed.name, renamed.description, renamed.expiresAt, renamed.version],
      ['Node SSH key', null, null, 2],
    );
    const after = await db.secret.findUniqueOrThrow({ where: { id: sshId } });
    assert.deepEqual(after.ciphertext, before.ciphertext, 'the value stays as it was');
    assert.equal((await owner.call('PATCH', `/secrets/${sshId}`, {})).status, 400);
    assert.equal(
      (await owner.call('PATCH', '/secrets/0193a0b0-0000-7000-8000-000000000009', { name: 'x' }))
        .status,
      404,
    );
  });

  it('does not let two secrets share a name by renaming', async () => {
    const other = SecretViewSchema.parse(
      (await owner.post('/secrets', { name: 'Telegram bot', type: 'telegram', value: 'bot-token' }))
        .body,
    );
    assert.equal(
      (await owner.call('PATCH', `/secrets/${other.id}`, { name: 'Node SSH key' })).status,
      409,
    );
  });

  it('works with metadata while sealed, and with nothing that needs the key', async () => {
    const sealed = await owner.post('/vault/seal');
    assert.equal(sealed.status, 200);
    assert.equal(VaultStatusSchema.parse(sealed.body).state, 'sealed');
    assert.equal((await status(owner)).state, 'sealed');
    assert.equal(SecretListSchema.parse((await owner.get('/secrets')).body).secrets.length, 2);

    for (const reply of [
      await owner.post('/secrets', { name: 'new', type: 'generic', value: 'x' }),
      await owner.post(`/secrets/${sshId}/reveal`),
      await owner.call('PATCH', `/secrets/${sshId}`, { value: 'another' }),
    ]) {
      assert.equal(reply.status, 423);
      assert.equal(errorCode(reply), 'vault_sealed');
    }
    assert.equal(
      (await owner.call('PATCH', `/secrets/${sshId}`, { description: 'metadata only' })).status,
      200,
    );
  });

  it('refuses a wrong passphrase and a wrong recovery key, and records the failures', async () => {
    const wrong = await owner.post('/vault/unseal', { passphrase: 'not the passphrase at all' });
    assert.equal(wrong.status, 401);
    assert.equal(errorCode(wrong), 'unauthorized');
    // The right key with its first character changed (always to a different one).
    const wrongKey = recoveryKey.replace(/^./u, recoveryKey.startsWith('A') ? 'B' : 'A');
    for (const key of ['AAAA-AAAA', wrongKey, 'not a key']) {
      assert.equal((await owner.post('/vault/unseal', { recoveryKey: key })).status, 401, key);
    }
    assert.equal((await status(owner)).state, 'sealed');
    const failures = (await auditEvents(instance)).filter(
      (e) => e.action === 'vault.unseal.failed',
    );
    assert.ok(failures.length >= 4);
    assert.deepEqual(failures[0]?.details, { method: 'passphrase' });
    assert.deepEqual(failures.at(-1)?.details, { method: 'recovery_key' });
    assert.ok(!JSON.stringify(failures).includes('not the passphrase'));
  });

  it('refuses a request that names both or neither', async () => {
    for (const body of [{}, { passphrase: PASSPHRASE, recoveryKey }]) {
      const reply = await owner.post('/vault/unseal', body);
      assert.equal(reply.status, 400);
      assert.equal(errorCode(reply), 'validation_failed');
    }
  });

  it('opens with the passphrase, and again with the recovery key typed carelessly', async () => {
    const opened = await owner.post('/vault/unseal', { passphrase: PASSPHRASE });
    assert.equal(opened.status, 200);
    assert.equal(VaultStatusSchema.parse(opened.body).state, 'unsealed');
    const revealed = RevealedSecretSchema.parse(
      (await owner.post(`/secrets/${sshId}/reveal`)).body,
    );
    assert.equal(revealed.value, 'the-second-value');

    await owner.post('/vault/seal');
    const careless = recoveryKey.toLowerCase().replace(/-/gu, ' ');
    const viaKey = await owner.post('/vault/unseal', { recoveryKey: careless });
    assert.equal(viaKey.status, 200, JSON.stringify(viaKey.body));
    assert.equal(
      RevealedSecretSchema.parse((await owner.post(`/secrets/${sshId}/reveal`)).body).value,
      'the-second-value',
    );
    const methods = (await auditEvents(instance))
      .filter((e) => e.action === 'vault.unsealed')
      .map((e) => e.details['method']);
    assert.deepEqual(methods.slice(-2), ['passphrase', 'recovery_key']);
    assert.ok((await auditEvents(instance)).some((e) => e.action === 'vault.sealed'));
  });

  it('starts sealed in a new process, and opens there with the passphrase', async () => {
    const db = instance.isolated.database;
    const fresh = new VaultService(db, new AuditService(db), CHEAP_KDF, () => Date.now());
    assert.equal((await fresh.status()).state, 'sealed');
    assert.equal((await status(owner)).state, 'unsealed', 'the running one is not affected');
    const actor = { id: '0193a0b0-0000-7000-8000-000000000001', name: 'owner' };
    const meta = { ip: undefined, userAgent: undefined, requestId: undefined };
    await assert.rejects(fresh.reveal(actor, sshId, meta), VaultSealedException);
    await fresh.unseal(actor, { passphrase: PASSPHRASE }, meta);
    assert.equal((await fresh.reveal(actor, sshId, meta)).value, 'the-second-value');
    fresh.onApplicationShutdown();
  });

  it('deletes a secret, with a record, also while sealed', async () => {
    await owner.post('/vault/seal');
    const list = SecretListSchema.parse((await owner.get('/secrets')).body);
    const doomed = found(
      list.secrets.find((s) => s.name === 'Telegram bot'),
      'the Telegram secret',
    );
    assert.equal((await owner.call('DELETE', `/secrets/${doomed.id}`)).status, 204);
    assert.equal((await owner.call('DELETE', `/secrets/${doomed.id}`)).status, 404);
    const event = found(
      (await auditEvents(instance)).filter((e) => e.action === 'secret.deleted').at(-1),
      'the secret.deleted event',
    );
    assert.deepEqual(event.details, { secret_type: 'telegram', version: 1 });
    assert.equal((await status(owner)).secretCount, 1);
    await owner.post('/vault/unseal', { passphrase: PASSPHRASE });
  });

  it('notices a blob that was altered or moved to another secret', async () => {
    const db = instance.isolated.database.client;
    const second = SecretViewSchema.parse(
      (await owner.post('/secrets', { name: 'Second', type: 'generic', value: 'second value' }))
        .body,
    );
    const a = await db.secret.findUniqueOrThrow({ where: { id: sshId } });
    const b = await db.secret.findUniqueOrThrow({ where: { id: second.id } });
    // The ciphertext of one secret under the other's id: the context does not match.
    await db.secret.update({
      where: { id: second.id },
      data: { ciphertext: a.ciphertext, wrappedDek: a.wrappedDek },
    });
    const moved = await owner.post(`/secrets/${second.id}/reveal`);
    assert.equal(moved.status, 500);
    assert.equal(errorCode(moved), 'internal_error');
    assert.ok(!JSON.stringify(moved.body).includes('the-second-value'));
    await db.secret.update({
      where: { id: second.id },
      data: { ciphertext: b.ciphertext, wrappedDek: b.wrappedDek },
    });
    const flipped = Buffer.from(b.ciphertext);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await db.secret.update({
      where: { id: second.id },
      data: { ciphertext: new Uint8Array(flipped) },
    });
    assert.equal((await owner.post(`/secrets/${second.id}/reveal`)).status, 500);
  });
});

describe('who may touch the vault, and how fresh they must be', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let observer: Client;
  let operator: Client;
  let secretId = '';

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    await owner.post('/vault/initialize', { passphrase: PASSPHRASE });
    secretId = SecretViewSchema.parse(
      (await owner.post('/secrets', { name: 'Shared', type: 'generic', value: 'v' })).body,
    ).id;
    const o = await createUser(instance, 'obs', 'observer');
    observer = await signInAs(instance, 'obs', o.secret);
    const p = await createUser(instance, 'op', 'operator');
    operator = await signInAs(instance, 'op', p.secret);
  });
  after(async () => {
    await stop(instance);
  });

  it('lets observers and operators see the status and the list, and nothing more', async () => {
    for (const client of [observer, operator]) {
      assert.equal((await client.get('/vault/status')).status, 200);
      assert.equal((await client.get('/secrets')).status, 200);
      for (const reply of [
        await client.post('/vault/seal'),
        await client.post('/vault/unseal', { passphrase: PASSPHRASE }),
        await client.post('/vault/initialize', { passphrase: PASSPHRASE }),
        await client.post('/secrets', { name: 'x', type: 'generic', value: 'x' }),
        await client.call('PATCH', `/secrets/${secretId}`, { name: 'y' }),
        await client.call('DELETE', `/secrets/${secretId}`),
        await client.post(`/secrets/${secretId}/reveal`),
      ]) {
        assert.equal(reply.status, 403);
        assert.equal(errorCode(reply), 'forbidden');
      }
    }
    assert.equal((await status(owner)).state, 'unsealed', 'nothing they tried changed it');
    assert.equal((await status(owner)).secretCount, 1);
  });

  it('asks the owner for a fresh second factor before every change and every reveal', async () => {
    await lapse(instance);
    for (const reply of [
      await owner.post('/vault/seal'),
      await owner.post('/vault/unseal', { passphrase: PASSPHRASE }),
      await owner.post('/secrets', { name: 'x', type: 'generic', value: 'x' }),
      await owner.call('PATCH', `/secrets/${secretId}`, { name: 'y' }),
      await owner.call('DELETE', `/secrets/${secretId}`),
      await owner.post(`/secrets/${secretId}/reveal`),
    ]) {
      assert.equal(reply.status, 403);
      assert.equal(errorCode(reply), 'step_up_required');
    }
    // Reading never needs it.
    assert.equal((await owner.get('/vault/status')).status, 200);
    assert.equal((await owner.get('/secrets')).status, 200);
    assert.equal((await status(owner)).state, 'unsealed');
  });

  it('answers the unauthenticated with 401', async () => {
    for (const reply of [
      await instance.client().get('/vault/status'),
      await instance.client().get('/secrets'),
      await instance.client().post(`/secrets/${secretId}/reveal`),
    ]) {
      assert.equal(reply.status, 401);
    }
  });
});

describe('guessing the passphrase', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    await owner.post('/vault/initialize', { passphrase: PASSPHRASE });
    await owner.post('/vault/seal');
  });
  after(async () => {
    await stop(instance);
  });

  it('is limited for everyone after ten attempts, even for the right passphrase', async () => {
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        (await owner.post('/vault/unseal', { passphrase: `guess number ${String(i)} here` }))
          .status,
        401,
      );
    }
    const blocked = await owner.post('/vault/unseal', { passphrase: PASSPHRASE });
    assert.equal(blocked.status, 429);
    assert.equal(errorCode(blocked), 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await status(owner)).state, 'sealed');
  });
});
