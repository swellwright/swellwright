import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  RevealedSecretSchema,
  SecretViewSchema,
  VaultInitializedSchema,
  VaultRotatedSchema,
  VaultStatusSchema,
} from '@swellwright/contracts';
import { type Database } from '@swellwright/db';

import {
  auditEvents,
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
import { AuditService } from '../audit/audit.service.js';
import { VaultSealedException } from '../http.js';
import { CLOCK, DATABASE, VAULT_KDF } from '../tokens.js';
import { type KdfParams } from './kdf.js';
import { VaultService } from './vault.service.js';

const PASSPHRASE = 'a long passphrase for the vault, used in tests';
const NEW_PASSPHRASE = 'another long passphrase, chosen later on';
const VALUES: Readonly<Record<string, string>> = {
  'dns-token': 'dns-token-value-0123456789',
  'ssh-key': 'FAKE ssh key material, this-is-not-a-real-key\nsecond line\n',
  'panel-token': 'panel-token-value-abcdef',
};

/** Lets the elevation of every session lapse, as if the step-up window had run out. */
async function lapse(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() - 1000) },
  });
}

/** Makes every session freshly verified, as if its owner had just entered a code. */
async function elevate(instance: Instance): Promise<void> {
  await instance.isolated.database.client.session.updateMany({
    data: { elevatedUntil: new Date(Date.now() + 10 * 60_000) },
  });
}

describe('rotating the keys of the vault', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerSecret: string;
  let observerSecret: string;
  let recoveryKey: string;
  let passphrase = PASSPHRASE;
  const ids = new Map<string, string>();

  const db = () => instance.isolated.database.client;
  const status = async () => VaultStatusSchema.parse((await owner.get('/vault/status')).body);
  const rows = () => db().secret.findMany({ orderBy: { name: 'asc' } });
  const meta = () => db().vaultMeta.findUniqueOrThrow({ where: { id: 1 } });
  const seal = async (): Promise<void> => {
    assert.equal((await owner.post('/vault/seal')).status, 200);
  };
  const unseal = (body: Record<string, string>) => owner.post('/vault/unseal', body);
  const reveal = async (name: string): Promise<string> => {
    const reply = await owner.post(`/secrets/${found(ids.get(name), name)}/reveal`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return RevealedSecretSchema.parse(reply.body).value;
  };
  const expectAllValues = async () => {
    for (const [name, value] of Object.entries(VALUES)) {
      assert.equal(await reveal(name), value, name);
    }
  };

  before(async () => {
    instance = await start();
    ({ secret: ownerSecret } = await createOwner(instance));
    ({ secret: observerSecret } = await createUser(instance, 'observer', 'observer'));
    owner = await signInAs(instance, 'owner', ownerSecret);
    const created = await owner.post('/vault/initialize', { passphrase });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    recoveryKey = VaultInitializedSchema.parse(created.body).recoveryKey;
    for (const [name, value] of Object.entries(VALUES)) {
      const reply = await owner.post('/secrets', { name, type: 'generic', value });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      ids.set(name, SecretViewSchema.parse(reply.body).id);
    }
  });
  after(async () => {
    await stop(instance);
  });

  it('starts with nothing rotated', async () => {
    const s = await status();
    assert.equal(s.kekVersion, 1);
    assert.equal(s.passphraseChangedAt, null);
    assert.equal(s.recoveryKeyRotatedAt, null);
    assert.equal(s.kekRotatedAt, null);
    assert.equal(s.dataKeysRotatedAt, null);
  });

  it('changes the passphrase without touching a single secret', async () => {
    const before = await rows();
    const metaBefore = await meta();
    // A wrong current passphrase, the same passphrase and a short one are all refused.
    const wrong = await owner.post('/vault/passphrase', {
      currentPassphrase: 'not the passphrase at all',
      newPassphrase: NEW_PASSPHRASE,
    });
    assert.equal(wrong.status, 401);
    assert.equal(
      (
        await owner.post('/vault/passphrase', {
          currentPassphrase: passphrase,
          newPassphrase: passphrase,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await owner.post('/vault/passphrase', {
          currentPassphrase: passphrase,
          newPassphrase: 'short',
        })
      ).status,
      400,
    );
    const failure = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'vault.unseal.failed'),
      'the refused confirmation',
    );
    assert.deepEqual(failure.details, { method: 'passphrase', purpose: 'change_passphrase' });

    // It works while the vault is sealed: the current passphrase is the proof.
    await seal();
    const changed = await owner.post('/vault/passphrase', {
      currentPassphrase: passphrase,
      newPassphrase: NEW_PASSPHRASE,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    passphrase = NEW_PASSPHRASE;
    const s = VaultStatusSchema.parse(changed.body);
    assert.equal(s.state, 'sealed');
    assert.ok(s.passphraseChangedAt);
    assert.equal(s.kekVersion, 1, 'the key behind the secrets did not change');

    const metaAfter = await meta();
    assert.notDeepEqual(Buffer.from(metaAfter.kdfSalt), Buffer.from(metaBefore.kdfSalt));
    assert.notDeepEqual(
      Buffer.from(metaAfter.passphraseWrappedKek),
      Buffer.from(metaBefore.passphraseWrappedKek),
    );
    assert.deepEqual(
      Buffer.from(metaAfter.recoveryWrappedKek),
      Buffer.from(metaBefore.recoveryWrappedKek),
      'the recovery key is not affected',
    );
    assert.deepEqual(await rows(), before, 'no secret was written');

    // The old passphrase is dead, the new one opens the vault, and so does the recovery key.
    assert.equal((await unseal({ passphrase: PASSPHRASE })).status, 401);
    assert.equal((await unseal({ passphrase: NEW_PASSPHRASE })).status, 200);
    await seal();
    assert.equal((await unseal({ recoveryKey })).status, 200);
    await expectAllValues();
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'vault.passphrase.changed'),
      'the record',
    );
    assert.equal(event.actor?.name, 'owner');
    const everything = JSON.stringify(await auditEvents(instance));
    assert.ok(!everything.includes(NEW_PASSPHRASE) && !everything.includes(recoveryKey));
  });

  it('issues a new recovery key and kills the old one', async () => {
    const wrong = await owner.post('/vault/recovery-key/rotate', {
      passphrase: 'not the passphrase',
    });
    assert.equal(wrong.status, 401);
    const before = await meta();

    const reply = await owner.post('/vault/recovery-key/rotate', { passphrase });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const body = VaultInitializedSchema.parse(reply.body);
    assert.notEqual(body.recoveryKey, recoveryKey);
    assert.match(body.recoveryKey, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/u);
    assert.ok(body.status.recoveryKeyRotatedAt);
    assert.equal(body.status.kekVersion, 1);
    const after = await meta();
    assert.notDeepEqual(
      Buffer.from(after.recoveryWrappedKek),
      Buffer.from(before.recoveryWrappedKek),
    );
    assert.deepEqual(
      Buffer.from(after.passphraseWrappedKek),
      Buffer.from(before.passphraseWrappedKek),
    );

    await seal();
    assert.equal((await unseal({ recoveryKey })).status, 401, 'the old key is dead');
    assert.equal((await unseal({ recoveryKey: body.recoveryKey })).status, 200);
    recoveryKey = body.recoveryKey;
    await expectAllValues();
    const events = JSON.stringify(await auditEvents(instance));
    assert.ok(!events.includes(recoveryKey) && !events.includes(recoveryKey.replace(/-/gu, '')));
  });

  it('replaces the key that wraps the data keys, and every secret still opens', async () => {
    const before = await rows();
    const metaBefore = await meta();

    // It needs the vault open and the right passphrase, and a failure changes nothing.
    await seal();
    const sealed = await owner.post('/vault/rotate-kek', { passphrase });
    assert.equal(sealed.status, 423);
    assert.equal((await unseal({ passphrase })).status, 200);
    const wrong = await owner.post('/vault/rotate-kek', { passphrase: 'not the passphrase' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await rows(), before);

    const reply = await owner.post('/vault/rotate-kek', { passphrase });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const body = VaultInitializedSchema.parse(reply.body);
    assert.equal(body.status.kekVersion, 2);
    assert.ok(body.status.kekRotatedAt && body.status.recoveryKeyRotatedAt);
    assert.equal(body.status.state, 'unsealed');

    const after = await rows();
    for (const row of after) {
      const old = found(
        before.find((r) => r.id === row.id),
        row.name,
      );
      assert.deepEqual(
        Buffer.from(row.ciphertext),
        Buffer.from(old.ciphertext),
        'the value is not re-encrypted',
      );
      assert.notDeepEqual(
        Buffer.from(row.wrappedDek),
        Buffer.from(old.wrappedDek),
        'its data key is re-wrapped',
      );
      assert.equal(row.version, old.version);
    }
    const metaAfter = await meta();
    assert.equal(metaAfter.kekVersion, 2);
    assert.notDeepEqual(Buffer.from(metaAfter.kdfSalt), Buffer.from(metaBefore.kdfSalt));

    // Still open, and after sealing: the passphrase and the NEW recovery key open it, the old one does not.
    await expectAllValues();
    await seal();
    assert.equal((await unseal({ recoveryKey })).status, 401);
    assert.equal((await unseal({ recoveryKey: body.recoveryKey })).status, 200);
    recoveryKey = body.recoveryKey;
    await seal();
    assert.equal((await unseal({ passphrase })).status, 200);
    await expectAllValues();
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'vault.kek.rotated'),
      'the record',
    );
    assert.deepEqual(event.details, { kek_version: 2, secrets: 3 });
  });

  it('changes nothing when a secret cannot be re-wrapped', async () => {
    const victim = found(ids.get('dns-token'), 'dns-token');
    const good = await rows();
    const original = found(
      good.find((r) => r.id === victim),
      'victim',
    );
    await db().secret.update({
      where: { id: victim },
      data: { wrappedDek: new Uint8Array(Buffer.alloc(original.wrappedDek.length, 7)) },
    });
    const damaged = await rows();
    const metaBefore = await meta();
    const reply = await owner.post('/vault/rotate-kek', { passphrase });
    assert.equal(reply.status, 500);
    assert.deepEqual(await rows(), damaged, 'not one secret was touched');
    assert.equal((await meta()).kekVersion, metaBefore.kekVersion);
    assert.equal(
      await reveal('ssh-key'),
      VALUES['ssh-key'],
      'the old key is still the one in memory',
    );
    const refused = await owner.post('/vault/rotate-data-keys');
    assert.equal(refused.status, 500);
    assert.deepEqual(await rows(), damaged);
    await db().secret.update({
      where: { id: victim },
      data: { wrappedDek: new Uint8Array(original.wrappedDek) },
    });
  });

  it('encrypts every secret under a fresh data key, keeping values and versions', async () => {
    const before = await rows();
    const kekBefore = (await meta()).kekVersion;
    const reply = await owner.post('/vault/rotate-data-keys');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const body = VaultRotatedSchema.parse(reply.body);
    assert.equal(body.rotated, 3);
    assert.ok(body.status.dataKeysRotatedAt);
    assert.equal(body.status.kekVersion, kekBefore);
    for (const row of await rows()) {
      const old = found(
        before.find((r) => r.id === row.id),
        row.name,
      );
      assert.notDeepEqual(Buffer.from(row.ciphertext), Buffer.from(old.ciphertext));
      assert.notDeepEqual(Buffer.from(row.wrappedDek), Buffer.from(old.wrappedDek));
      assert.equal(row.version, old.version);
      assert.equal(row.valueChangedAt.getTime(), old.valueChangedAt.getTime());
    }
    await expectAllValues();
    const event = found(
      (await auditEvents(instance)).findLast((e) => e.action === 'vault.data_keys.rotated'),
      'the record',
    );
    assert.deepEqual(event.details, { secrets: 3 });
    assert.ok(!JSON.stringify(await auditEvents(instance)).includes(VALUES['dns-token'] ?? 'x'));

    await seal();
    assert.equal((await owner.post('/vault/rotate-data-keys')).status, 423);
    assert.equal((await unseal({ passphrase })).status, 200);
  });

  it('does not lose a secret that is written while the keys are rotated', async () => {
    const results = await Promise.all([
      owner.post('/vault/rotate-kek', { passphrase }),
      owner.post('/secrets', { name: 'written-meanwhile', type: 'generic', value: 'late-value' }),
      owner.post('/vault/rotate-data-keys'),
    ]);
    for (const reply of results) {
      assert.ok(reply.status === 200 || reply.status === 201, JSON.stringify(reply.body));
    }
    recoveryKey = VaultInitializedSchema.parse(results[0].body).recoveryKey;
    const late = found(
      (await rows()).find((r) => r.name === 'written-meanwhile'),
      'the secret written meanwhile',
    );
    ids.set('written-meanwhile', late.id);
    assert.equal(await reveal('written-meanwhile'), 'late-value');
    await expectAllValues();
    // And after a restart of the key in memory it still opens with what is stored.
    await seal();
    assert.equal((await unseal({ passphrase })).status, 200);
    assert.equal(await reveal('written-meanwhile'), 'late-value');
  });

  it('takes the same words typed another way for the same passphrase when it is changed', async () => {
    const composed = 'café au lait, a passphrase for the vault';
    const changed = await owner.post('/vault/passphrase', {
      currentPassphrase: passphrase,
      newPassphrase: composed,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    passphrase = composed;
    // The fullwidth letter has the same NFKC form but not the same NFC form.
    const same = await owner.post('/vault/passphrase', {
      currentPassphrase: composed,
      newPassphrase: 'ｃafé au lait, a passphrase for the vault',
    });
    assert.equal(same.status, 400);
  });

  /** A second API process on the same database, as a deployment with two replicas would have. */
  const secondProcess = (database = instance.app.get<Database>(DATABASE)) =>
    new VaultService(
      database,
      instance.app.get(AuditService),
      instance.app.get<KdfParams>(VAULT_KDF),
      instance.app.get<() => number>(CLOCK),
    );
  const META = { ip: undefined, userAgent: undefined, requestId: undefined };
  const ownerActor = async () => {
    const user = await db().user.findFirstOrThrow({ where: { username: 'owner' } });
    return { id: user.id, name: user.username };
  };

  it('seals a process that holds a key another process replaced, instead of writing under it', async () => {
    const actor = await ownerActor();
    const other = secondProcess();
    await other.unseal(actor, { passphrase }, META);
    const rotated = await owner.post('/vault/rotate-kek', { passphrase });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    recoveryKey = VaultInitializedSchema.parse(rotated.body).recoveryKey;

    assert.equal((await other.status()).state, 'sealed', 'status notices the retired key');
    assert.throws(() => {
      other.requireOpen();
    }, VaultSealedException);
    await assert.rejects(
      other.create(actor, { name: 'from-a-stale-process', type: 'generic', value: 'v' }, META),
      (error: unknown) => error instanceof VaultSealedException,
    );
    assert.equal(
      (await rows()).some((r) => r.name === 'from-a-stale-process'),
      false,
      'nothing was written under the retired key',
    );
    assert.equal((await other.status()).state, 'sealed', 'the stale process sealed itself');
    // Opened again it holds the key in use and writes what every process can read.
    await other.unseal(actor, { passphrase }, META);
    const made = await other.create(
      actor,
      { name: 'from-the-other-process', type: 'generic', value: 'other-value' },
      META,
    );
    ids.set('from-the-other-process', made.id);
    assert.equal(await reveal('from-the-other-process'), 'other-value');
  });

  it('keeps the new key when a rotation was committed but its answer was lost', async () => {
    const actor = await ownerActor();
    const real = instance.app.get<Database>(DATABASE);
    let committed = false;
    const lossy = new Proxy(real.client, {
      get(target, property) {
        if (property === '$transaction') {
          return async (...args: Parameters<typeof target.$transaction>) => {
            const result = await (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
              ...args,
            );
            if (!committed) {
              committed = true;
              throw new Error('the answer of the commit was lost');
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const other = secondProcess(
      new Proxy(real, {
        get: (target, property) =>
          property === 'client' ? lossy : (Reflect.get(target, property) as unknown),
      }),
    );
    await other.unseal(actor, { passphrase }, META);
    const version = (await meta()).kekVersion;
    const answer = await other.rotateKek(actor, { passphrase }, META);
    assert.equal((await meta()).kekVersion, version + 1, 'it was committed');
    assert.equal(answer.status.state, 'unsealed', 'the process keeps the key that is stored');
    assert.notEqual(answer.recoveryKey, recoveryKey);
    // The recovery key that came back is the one that opens the vault now.
    assert.equal((await unseal({ recoveryKey: answer.recoveryKey })).status, 200);
    recoveryKey = answer.recoveryKey;
    await expectAllValues();
  });

  it('returns the recovery key without needing another status read after a successful commit', async () => {
    const actor = await ownerActor();
    const real = instance.app.get<Database>(DATABASE);
    let committed = false;
    const interrupted = new Proxy(real.client, {
      get(target, property) {
        if (property === '$transaction') {
          return async (...args: Parameters<typeof target.$transaction>) => {
            const result = await (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
              ...args,
            );
            committed = true;
            return result;
          };
        }
        if (property === 'vaultMeta' && committed) {
          throw new Error('database disconnected after commit');
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    const other = secondProcess(
      new Proxy(real, {
        get: (target, property) =>
          property === 'client' ? interrupted : (Reflect.get(target, property) as unknown),
      }),
    );
    try {
      await other.unseal(actor, { passphrase }, META);
      const version = (await meta()).kekVersion;
      const answer = await other.rotateKek(actor, { passphrase }, META);
      assert.equal(answer.status.kekVersion, version + 1);
      assert.equal(answer.status.state, 'unsealed');
      assert.notEqual(answer.recoveryKey, recoveryKey);
      assert.equal((await unseal({ recoveryKey: answer.recoveryKey })).status, 200);
      recoveryKey = answer.recoveryKey;
      await expectAllValues();
    } finally {
      other.onApplicationShutdown();
    }
  });

  it('seals when the database cannot confirm the rotation, then recovers with the passphrase', async () => {
    const actor = await ownerActor();
    const real = instance.app.get<Database>(DATABASE);
    let disconnected = false;
    const interrupted = new Proxy(real.client, {
      get(target, property) {
        if (property === '$transaction') {
          return async (...args: Parameters<typeof target.$transaction>) => {
            if (disconnected) {
              throw new Error('connection is still down');
            }
            await (target.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
            disconnected = true;
            throw new Error('connection lost after commit');
          };
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    const other = secondProcess(
      new Proxy(real, {
        get: (target, property) =>
          property === 'client' ? interrupted : (Reflect.get(target, property) as unknown),
      }),
    );
    try {
      await other.unseal(actor, { passphrase }, META);
      await assert.rejects(other.rotateKek(actor, { passphrase }, META), {
        name: 'ServiceUnavailableException',
      });
      assert.throws(() => {
        other.requireOpen();
      }, VaultSealedException);
      assert.equal((await unseal({ passphrase })).status, 200);
      await expectAllValues();
      const renewed = await owner.post('/vault/recovery-key/rotate', { passphrase });
      assert.equal(renewed.status, 200);
      recoveryKey = VaultInitializedSchema.parse(renewed.body).recoveryKey;
      assert.equal((await unseal({ recoveryKey })).status, 200);
    } finally {
      other.onApplicationShutdown();
    }
  });

  it('needs the permission and a fresh second factor for every rotation', async () => {
    const observer = await signInAs(instance, 'observer', observerSecret);
    for (const [path, body] of [
      ['/vault/passphrase', { currentPassphrase: passphrase, newPassphrase: NEW_PASSPHRASE }],
      ['/vault/recovery-key/rotate', { passphrase }],
      ['/vault/rotate-kek', { passphrase }],
      ['/vault/rotate-data-keys', undefined],
    ] as const) {
      const denied = await observer.post(path, body);
      assert.equal(denied.status, 403, path);
      assert.equal(errorCode(denied), 'forbidden', path);
      await lapse(instance);
      const needsCode = await owner.post(path, body);
      assert.equal(needsCode.status, 403, path);
      assert.equal(errorCode(needsCode), 'step_up_required', path);
      await elevate(instance);
    }
  });
});
