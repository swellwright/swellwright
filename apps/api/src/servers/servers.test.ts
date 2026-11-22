import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  type AuditEvent,
  ServerAccessSchema,
  ServerHostKeySchema,
  ServerListSchema,
  type ServerView,
  ServerViewSchema,
  SecretViewSchema,
} from '@swellwright/contracts';

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
import { parseFacts } from './facts/parse-facts.js';
import { DEBIAN_12_NODE } from './facts/samples.js';
import { byName } from './servers.service.js';

const PASSPHRASE = 'a long passphrase for the vault, used in tests';
const KEY_VALUE = 'FAKE private key material, this-is-not-a-real-key, only for the tests';
const PASSWORD_VALUE = 'a-throwaway-login-password-for-tests';
const SUDO_VALUE = 'a-throwaway-sudo-password-for-tests';
const FP_A = `SHA256:${'A'.repeat(43)}`;
const FP_C = `SHA256:${'C'.repeat(42)}w`;

const idFor = (n: number): string =>
  `SHA256:${n.toString(36).padStart(42, 'A').slice(-42)}${'AEIMQUYcgkosw048'[n % 16] ?? 'A'}`;

const server = (reply: { body: unknown }): ServerView => ServerViewSchema.parse(reply.body);

async function create(client: Client, body: Record<string, unknown>): Promise<ServerView> {
  const reply = await client.post('/servers', body);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return server(reply);
}

const events = async (instance: Instance, action: string): Promise<AuditEvent[]> =>
  (await auditEvents(instance)).filter((event) => event.action === action);

/** Every server audit action, in the order of the chain. */
const serverEvents = async (instance: Instance): Promise<AuditEvent[]> =>
  (await auditEvents(instance)).filter((event) => event.action.startsWith('server.'));

describe('the server inventory', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let operator: Client;
  let observer: Client;
  let passwordSecret = '';
  let sudoSecret = '';
  let keySecret = '';
  let genericSecret = '';

  const makeSecret = async (name: string, type: string, value: string): Promise<string> => {
    const reply = await owner.post('/secrets', { name, type, value });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body).id;
  };

  before(async () => {
    instance = await start();
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const ops = await createUser(instance, 'ops', 'operator');
    operator = await signInAs(instance, 'ops', ops.secret);
    const viewer = await createUser(instance, 'viewer', 'observer');
    observer = await signInAs(instance, 'viewer', viewer.secret);

    assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
    passwordSecret = await makeSecret('login password', 'ssh_password', PASSWORD_VALUE);
    sudoSecret = await makeSecret('sudo password', 'ssh_password', SUDO_VALUE);
    keySecret = await makeSecret('login key', 'ssh_key', KEY_VALUE);
    genericSecret = await makeSecret('note', 'generic', 'not for a server');
  });
  after(async () => {
    await stop(instance);
  });

  describe('who may do what', () => {
    let target: ServerView;

    before(async () => {
      target = await create(owner, { name: 'perm-target', address: '192.0.2.50' });
    });

    it('answers 401 to everything without a session', async () => {
      const anonymous = instance.client();
      const id = target.id;
      const key = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
      const calls: [string, string, unknown?][] = [
        ['GET', '/servers'],
        ['POST', '/servers', { name: 'x', address: 'example.com' }],
        ['GET', `/servers/${id}`],
        ['PATCH', `/servers/${id}`, { notes: 'x' }],
        ['DELETE', `/servers/${id}`],
        ['POST', `/servers/${id}/host-keys`, { algorithm: 'ssh-ed25519', fingerprintSha256: FP_A }],
        ['DELETE', `/servers/${id}/host-keys/${key}`],
        ['POST', `/servers/${id}/access`, { method: 'password', username: 'root', secretId: key }],
        ['PATCH', `/servers/${id}/access/${key}`, { username: 'root' }],
        ['DELETE', `/servers/${id}/access/${key}`],
      ];
      for (const [method, path, body] of calls) {
        const reply = await anonymous.call(method, path, body);
        assert.equal(reply.status, 401, `${method} ${path}`);
      }
    });

    it('lets an observer read and nothing else', async () => {
      const list = await observer.get('/servers');
      assert.equal(list.status, 200);
      assert.ok(ServerListSchema.parse(list.body).servers.length >= 1);
      assert.equal((await observer.get(`/servers/${target.id}`)).status, 200);

      const id = target.id;
      const key = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
      const writes: [string, string, unknown?][] = [
        ['POST', '/servers', { name: 'nope', address: 'example.com' }],
        ['PATCH', `/servers/${id}`, { notes: 'x' }],
        ['DELETE', `/servers/${id}`],
        ['POST', `/servers/${id}/host-keys`, { algorithm: 'ssh-ed25519', fingerprintSha256: FP_A }],
        ['DELETE', `/servers/${id}/host-keys/${key}`],
        [
          'POST',
          `/servers/${id}/access`,
          { method: 'password', username: 'root', secretId: passwordSecret },
        ],
        ['PATCH', `/servers/${id}/access/${key}`, { username: 'root' }],
        ['DELETE', `/servers/${id}/access/${key}`],
      ];
      for (const [method, path, body] of writes) {
        const reply = await observer.call(method, path, body);
        assert.equal(reply.status, 403, `${method} ${path}`);
        assert.equal(errorCode(reply), 'forbidden');
      }
      assert.equal(
        await instance.isolated.database.client.server.count({ where: { name: 'nope' } }),
        0,
      );
      const denied = await events(instance, 'authz.denied');
      assert.ok(denied.length >= writes.length, 'every refusal is recorded');
    });

    it('lets an operator change the inventory', async () => {
      const made = await create(operator, { name: 'by-operator', address: 'example.net' });
      assert.equal(made.state, 'draft');
      const changed = await operator.call('PATCH', `/servers/${made.id}`, { notes: 'checked' });
      assert.equal(changed.status, 200);
      assert.equal((await operator.call('DELETE', `/servers/${made.id}`)).status, 204);
      const created = (await events(instance, 'server.created')).find(
        (event) => event.details['name'] === 'by-operator',
      );
      assert.equal(found(created, 'its created event').actor?.name, 'ops');
    });
  });

  describe('adding and reading servers', () => {
    it('stores what it is given, with defaults for the rest', async () => {
      const made = await create(owner, { name: 'web-01', address: 'host.example.com' });
      assert.equal(made.sshPort, 22);
      assert.equal(made.state, 'draft');
      assert.equal(made.country, null);
      assert.equal(made.provider, null);
      assert.deepEqual(made.tags, []);
      assert.equal(made.notes, null);
      assert.deepEqual(made.hostKeys, []);
      assert.deepEqual(made.access, []);
      assert.equal(made.facts, null);

      const full = await create(owner, {
        name: 'edge 2.b_c',
        address: '2001:db8::7',
        sshPort: 2222,
        country: 'de',
        provider: 'Example Hosting',
        state: 'active',
        tags: ['edge', 'eu', 'edge'],
        notes: 'the second edge box',
      });
      assert.equal(full.address, '2001:db8::7');
      assert.equal(full.sshPort, 2222);
      assert.equal(full.country, 'DE', 'stored in upper case');
      assert.equal(full.provider, 'Example Hosting');
      assert.equal(full.state, 'active');
      assert.deepEqual(full.tags, ['edge', 'eu'], 'a repeated tag is dropped');
      const row = await instance.isolated.database.client.server.findUniqueOrThrow({
        where: { id: full.id },
      });
      assert.ok(row.createdById, 'remembers who added it');
    });

    it('answers 409 to a taken name', async () => {
      const reply = await owner.post('/servers', { name: 'web-01', address: '192.0.2.99' });
      assert.equal(reply.status, 409);
      assert.equal(errorCode(reply), 'conflict');
    });

    it('refuses bad input with 400 and writes nothing', async () => {
      const before = await instance.isolated.database.client.server.count();
      const ok = { name: 'valid-name', address: 'example.com' };
      const bad: Record<string, unknown>[] = [
        {},
        { name: 'only-a-name' },
        { address: 'example.com' },
        { ...ok, name: '' },
        { ...ok, name: 'x'.repeat(65) },
        { ...ok, name: 'semi;colon' },
        { ...ok, address: 'not an address' },
        { ...ok, address: '999.1.1.1' },
        { ...ok, address: 'http://example.com' },
        { ...ok, sshPort: 0 },
        { ...ok, sshPort: 65536 },
        { ...ok, sshPort: 22.5 },
        { ...ok, country: 'DEU' },
        { ...ok, state: 'running' },
        { ...ok, tags: ['has space'] },
        { ...ok, tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) },
        { ...ok, notes: 'n'.repeat(2001) },
        { ...ok, provider: 'p'.repeat(65) },
      ];
      for (const body of bad) {
        const reply = await owner.post('/servers', body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.equal(errorCode(reply), 'validation_failed');
      }
      assert.equal(await instance.isolated.database.client.server.count(), before);
    });

    it('answers 404 to an unknown id and 400 to one that is not an id', async () => {
      const unknown = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
      assert.equal((await owner.get(`/servers/${unknown}`)).status, 404);
      assert.equal((await owner.call('PATCH', `/servers/${unknown}`, { notes: 'x' })).status, 404);
      assert.equal((await owner.call('DELETE', `/servers/${unknown}`)).status, 404);
      const malformed = await owner.get('/servers/not-an-id');
      assert.equal(malformed.status, 400);
      assert.equal(errorCode(malformed), 'validation_failed');
    });

    it('records the creation without anything it should not', async () => {
      const created = await events(instance, 'server.created');
      const nl = found(
        created.find((event) => event.details['name'] === 'web-01'),
        'the web-01 event',
      );
      assert.equal(nl.outcome, 'success');
      assert.equal(nl.actor?.name, 'owner');
      assert.equal(nl.object?.type, 'server');
      assert.deepEqual(nl.details, { name: 'web-01', state: 'draft' });
    });
  });

  describe('listing', () => {
    before(async () => {
      const a = await create(owner, {
        name: 'list-a',
        address: 'Alpha.Example.com',
        state: 'active',
        tags: ['list-tag', 'other'],
      });
      await create(owner, { name: 'list-b', address: '198.51.100.7', tags: ['list-tag'] });
      await create(owner, { name: 'list-c', address: '198.51.100.8', state: 'retired' });
      await instance.isolated.database.client.serverFact.create({
        data: {
          serverId: a.id,
          facts: parseFacts(DEBIAN_12_NODE, { receivedAtMs: 0, viaSudo: false, truncated: false })
            .facts,
          collectedAt: new Date('2026-11-20T10:00:00Z'),
          source: 'ssh',
          scriptSha256: 'a'.repeat(64),
        },
      });
      // Facts of a shape this version does not know (an older or a newer one): shown as unreadable, never a 500.
      const odd = await create(owner, { name: 'list-odd', address: '198.51.100.9' });
      await instance.isolated.database.client.serverFact.create({
        data: {
          serverId: odd.id,
          facts: { os: 'Debian GNU/Linux 12', kernel: '6.1.0-test' },
          collectedAt: new Date('2026-11-20T11:00:00Z'),
          source: 'ssh',
        },
      });
      const keyed = found(
        (await owner.get('/servers?q=list-b')).body as { servers: { id: string }[] },
        'list',
      ).servers[0];
      await owner.post(`/servers/${found(keyed, 'list-b').id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: FP_A,
      });
    });

    it('is ordered by name and counts keys, access entries and facts', async () => {
      const list = ServerListSchema.parse((await owner.get('/servers')).body).servers;
      const names = list.map((s) => s.name);
      assert.deepEqual(names, [...names].sort(byName));
      const a = found(
        list.find((s) => s.name === 'list-a'),
        'list-a',
      );
      assert.deepEqual(a.facts, {
        os: 'Debian GNU/Linux 12 (bookworm)',
        kernel: '6.1.0-28-amd64',
        collectedAt: '2026-11-20T10:00:00.000Z',
      });
      const odd = found(
        list.find((s) => s.name === 'list-odd'),
        'list-odd',
      );
      assert.deepEqual(odd.facts, {
        os: null,
        kernel: null,
        collectedAt: '2026-11-20T11:00:00.000Z',
      });
      assert.equal(a.pinned, false);
      assert.equal(a.hostKeyCount, 0);
      assert.equal(a.accessCount, 0);
      const b = found(
        list.find((s) => s.name === 'list-b'),
        'list-b',
      );
      assert.equal(b.facts, null);
      assert.equal(b.pinned, true);
      assert.equal(b.hostKeyCount, 1);
    });

    it('filters by state, tag and text, and the filters combine', async () => {
      const names = async (query: string): Promise<string[]> =>
        ServerListSchema.parse((await owner.get(`/servers${query}`)).body).servers.map(
          (s) => s.name,
        );
      assert.deepEqual(await names('?tag=list-tag'), ['list-a', 'list-b']);
      assert.deepEqual(await names('?state=retired'), ['list-c']);
      assert.deepEqual(await names('?tag=list-tag&state=active'), ['list-a']);
      assert.deepEqual(await names('?q=ALPHA'), ['list-a'], 'case is ignored, the address counts');
      assert.deepEqual(await names('?q=list-'), ['list-a', 'list-b', 'list-c', 'list-odd']);
      assert.deepEqual(await names('?q=198.51.100'), ['list-b', 'list-c', 'list-odd']);
      assert.deepEqual(await names('?q=nothing-matches-this'), []);
      assert.equal((await owner.get('/servers?state=gone')).status, 400);
    });

    it('shows the facts in full on the server itself', async () => {
      const list = ServerListSchema.parse((await owner.get('/servers?q=list-a')).body).servers;
      const one = server(await owner.get(`/servers/${found(list[0], 'list-a').id}`));
      assert.equal(one.facts?.source, 'ssh');
      assert.equal(one.facts.scriptSha256, 'a'.repeat(64));
      const facts = found(one.facts, 'the facts').facts;
      assert.equal(facts.os?.id, 'debian');
      assert.equal(facts.containers?.[0]?.imageTag, '3.4.6');
      assert.equal(facts.disks?.[0]?.mount, '/');

      const oddList = ServerListSchema.parse((await owner.get('/servers?q=list-odd')).body).servers;
      const oddOne = server(await owner.get(`/servers/${found(oddList[0], 'list-odd').id}`));
      assert.equal(oddOne.facts?.facts.os, null);
      assert.equal(oddOne.facts.facts.warnings.length, 1, 'it says it could not read them');
      assert.equal(oddOne.facts.scriptSha256, null);
    });
  });

  describe('changing a server', () => {
    let id = '';

    before(async () => {
      id = (await create(owner, { name: 'change-me', address: '192.0.2.60', tags: ['a', 'b'] })).id;
    });

    it('changes only what is given, and records the old and the new state', async () => {
      const reply = await owner.call('PATCH', `/servers/${id}`, {
        state: 'active',
        notes: 'in service',
        sshPort: 2200,
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      const after = server(reply);
      assert.equal(after.state, 'active');
      assert.equal(after.notes, 'in service');
      assert.equal(after.sshPort, 2200);
      assert.equal(after.address, '192.0.2.60');
      assert.deepEqual(after.tags, ['a', 'b']);
      const event = found((await events(instance, 'server.updated')).at(-1), 'the update event');
      assert.equal(event.details['state_from'], 'draft');
      assert.equal(event.details['state_to'], 'active');
      assert.equal(event.details['changed'], 'ssh_port,state,notes');
      assert.deepEqual(event.object, { type: 'server', id });
    });

    it('lets the five states follow one another freely', async () => {
      for (const state of ['retired', 'draft', 'draining', 'provisioning', 'active']) {
        const reply = await owner.call('PATCH', `/servers/${id}`, { state });
        assert.equal(reply.status, 200, state);
        assert.equal(server(reply).state, state);
      }
    });

    it('renames, replaces the tags and clears the optional fields', async () => {
      await owner.call('PATCH', `/servers/${id}`, { country: 'nl', provider: 'Example' });
      const reply = await owner.call('PATCH', `/servers/${id}`, {
        name: 'changed-me',
        tags: ['z'],
        country: null,
        provider: null,
        notes: null,
      });
      const after = server(reply);
      assert.equal(after.name, 'changed-me');
      assert.deepEqual(after.tags, ['z']);
      assert.equal(after.country, null);
      assert.equal(after.provider, null);
      assert.equal(after.notes, null);
      const event = found((await events(instance, 'server.updated')).at(-1), 'the rename event');
      assert.equal(event.details['name_from'], 'change-me');
      assert.equal(event.details['name_to'], 'changed-me');
    });

    it('records nothing when nothing changes', async () => {
      const count = (await events(instance, 'server.updated')).length;
      const reply = await owner.call('PATCH', `/servers/${id}`, {
        name: 'changed-me',
        tags: ['z'],
      });
      assert.equal(reply.status, 200);
      assert.equal((await events(instance, 'server.updated')).length, count);
    });

    it('refuses a taken name, an empty change and bad values', async () => {
      const taken = await owner.call('PATCH', `/servers/${id}`, { name: 'web-01' });
      assert.equal(taken.status, 409);
      assert.equal(server(await owner.get(`/servers/${id}`)).name, 'changed-me');
      for (const body of [
        {},
        { name: null },
        { address: 'bad address' },
        { state: 'gone' },
        { sshPort: 0 },
      ]) {
        const reply = await owner.call('PATCH', `/servers/${id}`, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
      }
    });
  });

  describe('deleting a server', () => {
    it('needs a draft or a retired server', async () => {
      const draft = await create(owner, { name: 'del-draft', address: '192.0.2.70' });
      const retired = await create(owner, {
        name: 'del-retired',
        address: '192.0.2.71',
        state: 'retired',
      });
      assert.equal((await owner.call('DELETE', `/servers/${draft.id}`)).status, 204);
      assert.equal((await owner.call('DELETE', `/servers/${retired.id}`)).status, 204);
      assert.equal((await owner.get(`/servers/${draft.id}`)).status, 404);

      for (const state of ['provisioning', 'active', 'draining']) {
        const live = await create(owner, { name: `del-${state}`, address: '192.0.2.72', state });
        const reply = await owner.call('DELETE', `/servers/${live.id}`);
        assert.equal(reply.status, 409, state);
        assert.equal(errorCode(reply), 'conflict');
        assert.match(JSON.stringify(reply.body), /draft or a retired/u);
        assert.equal((await owner.get(`/servers/${live.id}`)).status, 200, 'still there');
        // Once it is out of service it can go.
        await owner.call('PATCH', `/servers/${live.id}`, { state: 'retired' });
        assert.equal((await owner.call('DELETE', `/servers/${live.id}`)).status, 204);
      }
      const deleted = (await events(instance, 'server.deleted')).map((event) => event.details);
      assert.ok(deleted.some((d) => d['name'] === 'del-draft' && d['state'] === 'draft'));
      assert.ok(deleted.some((d) => d['name'] === 'del-retired' && d['state'] === 'retired'));
    });

    it('takes its host keys, access entries and facts with it, and leaves the secrets', async () => {
      const db = instance.isolated.database.client;
      const made = await create(owner, { name: 'del-cascade', address: '192.0.2.73' });
      await owner.post(`/servers/${made.id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: FP_C,
      });
      await owner.post(`/servers/${made.id}/access`, {
        method: 'key',
        username: 'deploy',
        secretId: keySecret,
      });
      await db.serverFact.create({
        data: { serverId: made.id, facts: { os: 'x' }, collectedAt: new Date(), source: 'ssh' },
      });
      assert.equal((await owner.call('DELETE', `/servers/${made.id}`)).status, 204);
      assert.equal(await db.serverHostKey.count({ where: { serverId: made.id } }), 0);
      assert.equal(await db.serverAccess.count({ where: { serverId: made.id } }), 0);
      assert.equal(await db.serverFact.count({ where: { serverId: made.id } }), 0);
      assert.equal(await db.secret.count({ where: { id: keySecret } }), 1);
    });
  });

  describe('host keys', () => {
    let id = '';

    before(async () => {
      id = (await create(owner, { name: 'hk-server', address: '192.0.2.80' })).id;
    });

    it('pins a fingerprint, once: the same one again answers 200 and records nothing', async () => {
      const body = { algorithm: 'ssh-ed25519', fingerprintSha256: FP_A };
      const first = await operator.post(`/servers/${id}/host-keys`, body);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const key = ServerHostKeySchema.parse(first.body);
      assert.equal(key.source, 'manual');
      assert.equal(key.acceptedBy, 'ops');
      assert.equal(key.fingerprintSha256, FP_A);

      const count = (await events(instance, 'server.host_key.pinned')).length;
      const again = await owner.post(`/servers/${id}/host-keys`, body);
      assert.equal(again.status, 200);
      assert.equal(ServerHostKeySchema.parse(again.body).id, key.id);
      assert.equal((await events(instance, 'server.host_key.pinned')).length, count);

      const one = server(await owner.get(`/servers/${id}`));
      assert.equal(one.hostKeys.length, 1);
      assert.equal(found(one.hostKeys[0], 'the key').acceptedBy, 'ops');
      const list = ServerListSchema.parse((await owner.get('/servers?q=hk-server')).body);
      assert.equal(found(list.servers[0], 'the server').pinned, true);

      const event = found((await events(instance, 'server.host_key.pinned')).at(-1), 'pin event');
      assert.deepEqual(event.details, {
        algorithm: 'ssh-ed25519',
        fingerprint: FP_A,
        source: 'manual',
      });
      assert.deepEqual(event.object, { type: 'server', id });
    });

    it('takes a second key of another type', async () => {
      const reply = await owner.post(`/servers/${id}/host-keys`, {
        algorithm: 'ecdsa-sha2-nistp256',
        fingerprintSha256: FP_C,
      });
      assert.equal(reply.status, 201);
      assert.equal(server(await owner.get(`/servers/${id}`)).hostKeys.length, 2);
    });

    it('refuses a fingerprint that cannot be a SHA-256 digest', async () => {
      for (const fingerprintSha256 of [
        '',
        'SHA256:short',
        `SHA256:${'A'.repeat(42)}B`,
        `SHA256:${'A'.repeat(44)}`,
        `md5:${'A'.repeat(43)}`,
        `SHA256:${'A'.repeat(42)}a`,
      ]) {
        const reply = await owner.post(`/servers/${id}/host-keys`, {
          algorithm: 'ssh-ed25519',
          fingerprintSha256,
        });
        assert.equal(reply.status, 400, fingerprintSha256);
      }
      const noAlgorithm = await owner.post(`/servers/${id}/host-keys`, { fingerprintSha256: FP_A });
      assert.equal(noAlgorithm.status, 400);
      const unknownServer = await owner.post(
        '/servers/0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b/host-keys',
        {
          algorithm: 'ssh-ed25519',
          fingerprintSha256: FP_A,
        },
      );
      assert.equal(unknownServer.status, 404);
    });

    it('may pin the same key on another server', async () => {
      const other = await create(owner, { name: 'hk-other', address: '192.0.2.81' });
      const reply = await owner.post(`/servers/${other.id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: FP_A,
      });
      assert.equal(reply.status, 201);
    });

    it('revokes a key, and only on the server it belongs to', async () => {
      const keys = server(await owner.get(`/servers/${id}`)).hostKeys;
      const target = found(keys[0], 'a key');
      const other = await create(owner, { name: 'hk-wrong', address: '192.0.2.82' });
      assert.equal(
        (await owner.call('DELETE', `/servers/${other.id}/host-keys/${target.id}`)).status,
        404,
      );
      assert.equal(
        server(await owner.get(`/servers/${id}`)).hostKeys.length,
        2,
        'nothing was removed',
      );

      assert.equal(
        (await owner.call('DELETE', `/servers/${id}/host-keys/${target.id}`)).status,
        204,
      );
      assert.equal(server(await owner.get(`/servers/${id}`)).hostKeys.length, 1);
      assert.equal(
        (await owner.call('DELETE', `/servers/${id}/host-keys/${target.id}`)).status,
        404,
      );
      const event = found(
        (await events(instance, 'server.host_key.revoked')).at(-1),
        'revoke event',
      );
      assert.equal(event.details['fingerprint'], target.fingerprintSha256);
      assert.deepEqual(event.object, { type: 'server', id });
    });

    it('allows at most sixteen keys per server', async () => {
      const crowded = await create(owner, { name: 'hk-crowded', address: '192.0.2.83' });
      for (let n = 0; n < 16; n += 1) {
        const reply = await owner.post(`/servers/${crowded.id}/host-keys`, {
          algorithm: 'ssh-ed25519',
          fingerprintSha256: idFor(n),
        });
        assert.equal(reply.status, 201, `${String(n)} ${JSON.stringify(reply.body)}`);
      }
      const over = await owner.post(`/servers/${crowded.id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: idFor(16),
      });
      assert.equal(over.status, 409);
      // A key that is already there is still answered, not refused.
      const same = await owner.post(`/servers/${crowded.id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: idFor(0),
      });
      assert.equal(same.status, 200);
    });
  });

  describe('access entries', () => {
    let id = '';

    before(async () => {
      id = (await create(owner, { name: 'acc-server', address: '192.0.2.90' })).id;
    });

    it('adds a password entry and a key entry, with secret names and never values', async () => {
      const password = await owner.post(`/servers/${id}/access`, {
        method: 'password',
        username: 'root',
        secretId: passwordSecret,
        sudoSecretId: sudoSecret,
      });
      assert.equal(password.status, 201, JSON.stringify(password.body));
      const entry = ServerAccessSchema.parse(password.body);
      assert.equal(entry.method, 'password');
      assert.equal(entry.username, 'root');
      assert.deepEqual(entry.secret, {
        id: passwordSecret,
        name: 'login password',
        type: 'ssh_password',
        expiresAt: null,
        expired: false,
        expiresInDays: null,
      });
      assert.deepEqual(entry.sudoSecret, {
        id: sudoSecret,
        name: 'sudo password',
        type: 'ssh_password',
        expiresAt: null,
        expired: false,
        expiresInDays: null,
      });
      assert.equal(entry.priority, 0);

      const key = await operator.post(`/servers/${id}/access`, {
        method: 'key',
        username: 'deploy',
        secretId: keySecret,
      });
      assert.equal(key.status, 201, JSON.stringify(key.body));
      const second = ServerAccessSchema.parse(key.body);
      assert.equal(second.sudoSecret, null);
      assert.equal(second.priority, 1, 'after the last entry by default');

      const one = server(await owner.get(`/servers/${id}`));
      assert.deepEqual(
        one.access.map((a) => a.username),
        ['root', 'deploy'],
      );
      const everything = JSON.stringify([one, await auditEvents(instance)]);
      for (const value of [PASSWORD_VALUE, SUDO_VALUE, KEY_VALUE]) {
        assert.ok(!everything.includes(value), 'a secret value appears nowhere');
      }
      const list = ServerListSchema.parse((await owner.get('/servers?q=acc-server')).body);
      assert.equal(found(list.servers[0], 'the server').accessCount, 2);

      const event = found(
        (await events(instance, 'server.access.added')).at(-2),
        'the first event',
      );
      assert.equal(event.details['method'], 'password');
      assert.equal(event.details['username'], 'root');
      assert.equal(event.details['secret_id'], passwordSecret);
      assert.equal(event.details['sudo_secret_id'], sudoSecret);
      assert.deepEqual(event.object, { type: 'server', id });
    });

    it('checks the kind of every secret', async () => {
      const cases: [string, Record<string, unknown>, RegExp][] = [
        [
          'a key secret for a password entry',
          { method: 'password', username: 'u', secretId: keySecret },
          /ssh_password/u,
        ],
        [
          'a password secret for a key entry',
          { method: 'key', username: 'u', secretId: passwordSecret },
          /ssh_key/u,
        ],
        [
          'a generic secret',
          { method: 'password', username: 'u', secretId: genericSecret },
          /generic/u,
        ],
        [
          'a key secret for sudo',
          { method: 'password', username: 'u', secretId: passwordSecret, sudoSecretId: keySecret },
          /sudo/u,
        ],
        [
          'a secret that does not exist',
          { method: 'password', username: 'u', secretId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b' },
          /does not exist/u,
        ],
        [
          'a sudo secret that does not exist',
          {
            method: 'password',
            username: 'u',
            secretId: passwordSecret,
            sudoSecretId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
          },
          /does not exist/u,
        ],
      ];
      const count = await instance.isolated.database.client.serverAccess.count();
      for (const [label, body, message] of cases) {
        const reply = await owner.post(`/servers/${id}/access`, body);
        assert.equal(reply.status, 400, label);
        assert.equal(errorCode(reply), 'bad_request', label);
        assert.match(JSON.stringify(reply.body), message, label);
      }
      assert.equal(await instance.isolated.database.client.serverAccess.count(), count);
    });

    it('refuses bad input', async () => {
      for (const body of [
        {},
        { method: 'certificate', username: 'root', secretId: passwordSecret },
        { method: 'password', username: 'Root', secretId: passwordSecret },
        { method: 'password', username: '', secretId: passwordSecret },
        { method: 'password', username: 'root', secretId: 'not-an-id' },
        { method: 'password', username: 'root', secretId: passwordSecret, priority: -1 },
        { method: 'password', secretId: passwordSecret },
      ]) {
        const reply = await owner.post(`/servers/${id}/access`, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.equal(errorCode(reply), 'validation_failed');
      }
      const unknown = await owner.post('/servers/0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b/access', {
        method: 'password',
        username: 'root',
        secretId: passwordSecret,
      });
      assert.equal(unknown.status, 404);
    });

    it('changes an entry and keeps the result consistent', async () => {
      const entries = server(await owner.get(`/servers/${id}`)).access;
      const password = found(
        entries.find((a) => a.method === 'password'),
        'the password entry',
      );
      const renamed = await owner.call('PATCH', `/servers/${id}/access/${password.id}`, {
        username: 'admin',
        priority: 5,
        sudoSecretId: null,
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      const entry = ServerAccessSchema.parse(renamed.body);
      assert.equal(entry.username, 'admin');
      assert.equal(entry.priority, 5);
      assert.equal(entry.sudoSecret, null);
      const event = found(
        (await events(instance, 'server.access.updated')).at(-1),
        'the update event',
      );
      assert.equal(event.details['changed'], 'username,sudo_secret,priority');
      assert.equal(event.details['access_id'], password.id);

      // The method alone must not leave a password secret on a key entry.
      const wrong = await owner.call('PATCH', `/servers/${id}/access/${password.id}`, {
        method: 'key',
      });
      assert.equal(wrong.status, 400);
      const both = await owner.call('PATCH', `/servers/${id}/access/${password.id}`, {
        method: 'key',
        secretId: keySecret,
      });
      assert.equal(both.status, 200, JSON.stringify(both.body));
      assert.equal(ServerAccessSchema.parse(both.body).method, 'key');
      // Back to a password entry for the rest of the tests.
      const back = await owner.call('PATCH', `/servers/${id}/access/${password.id}`, {
        method: 'password',
        secretId: passwordSecret,
      });
      assert.equal(back.status, 200);

      const noop = (await events(instance, 'server.access.updated')).length;
      await owner.call('PATCH', `/servers/${id}/access/${password.id}`, { username: 'admin' });
      assert.equal(
        (await events(instance, 'server.access.updated')).length,
        noop,
        'no change, no record',
      );

      assert.equal(
        (await owner.call('PATCH', `/servers/${id}/access/${password.id}`, {})).status,
        400,
      );
      const other = await create(owner, { name: 'acc-other', address: '192.0.2.91' });
      const wrongServer = await owner.call('PATCH', `/servers/${other.id}/access/${password.id}`, {
        username: 'x',
      });
      assert.equal(wrongServer.status, 404);
    });

    it('allows at most five entries per server', async () => {
      const crowded = await create(owner, { name: 'acc-crowded', address: '192.0.2.92' });
      for (let n = 0; n < 5; n += 1) {
        const reply = await owner.post(`/servers/${crowded.id}/access`, {
          method: 'password',
          username: `user${String(n)}`,
          secretId: passwordSecret,
        });
        assert.equal(reply.status, 201, String(n));
      }
      const over = await owner.post(`/servers/${crowded.id}/access`, {
        method: 'password',
        username: 'one-too-many',
        secretId: passwordSecret,
      });
      assert.equal(over.status, 409);
      assert.equal(errorCode(over), 'conflict');
      assert.equal(server(await owner.get(`/servers/${crowded.id}`)).access.length, 5);
      // Removing one makes room.
      const first = found(server(await owner.get(`/servers/${crowded.id}`)).access[0], 'an entry');
      assert.equal(
        (await owner.call('DELETE', `/servers/${crowded.id}/access/${first.id}`)).status,
        204,
      );
      const again = await owner.post(`/servers/${crowded.id}/access`, {
        method: 'password',
        username: 'fits-now',
        secretId: passwordSecret,
      });
      assert.equal(again.status, 201);
    });

    it('removes an entry and leaves its secrets in the vault', async () => {
      const lone = await create(owner, { name: 'acc-remove', address: '192.0.2.93' });
      const added = ServerAccessSchema.parse(
        (
          await owner.post(`/servers/${lone.id}/access`, {
            method: 'password',
            username: 'root',
            secretId: passwordSecret,
          })
        ).body,
      );
      assert.equal(
        (await owner.call('DELETE', `/servers/${lone.id}/access/${added.id}`)).status,
        204,
      );
      assert.equal(
        (await owner.call('DELETE', `/servers/${lone.id}/access/${added.id}`)).status,
        404,
      );
      assert.equal(server(await owner.get(`/servers/${lone.id}`)).access.length, 0);
      const event = found((await events(instance, 'server.access.removed')).at(-1), 'the removal');
      assert.equal(event.details['username'], 'root');
      assert.equal(event.details['method'], 'password');
      assert.equal((await owner.get('/secrets')).status, 200);
    });
  });

  describe('a secret that a server uses', () => {
    it('cannot be deleted, and the answer names the servers', async () => {
      const used = await makeSecret('used password', 'ssh_password', 'used-value-for-tests');
      const sudoOnly = await makeSecret('used sudo', 'ssh_password', 'used-sudo-value-for-tests');
      const a = await create(owner, { name: 'use-a', address: '192.0.2.100' });
      const b = await create(owner, { name: 'use-b', address: '192.0.2.101' });
      const entryA = ServerAccessSchema.parse(
        (
          await owner.post(`/servers/${a.id}/access`, {
            method: 'password',
            username: 'root',
            secretId: used,
          })
        ).body,
      );
      const entryB = ServerAccessSchema.parse(
        (
          await owner.post(`/servers/${b.id}/access`, {
            method: 'password',
            username: 'root',
            secretId: used,
            sudoSecretId: sudoOnly,
          })
        ).body,
      );

      const deletedBefore = (await events(instance, 'secret.deleted')).length;
      const refused = await owner.call('DELETE', `/secrets/${used}`);
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(errorCode(refused), 'conflict');
      const message = JSON.stringify(refused.body);
      assert.match(message, /use-a/u);
      assert.match(message, /use-b/u);
      assert.match(message, /2 servers/u);

      const sudoRefused = await owner.call('DELETE', `/secrets/${sudoOnly}`);
      assert.equal(sudoRefused.status, 409, 'a sudo secret is in use too');
      assert.match(JSON.stringify(sudoRefused.body), /use-b/u);

      const db = instance.isolated.database.client;
      assert.equal(await db.secret.count({ where: { id: { in: [used, sudoOnly] } } }), 2);
      assert.equal(
        (await events(instance, 'secret.deleted')).length,
        deletedBefore,
        'a refused deletion is not a deletion',
      );

      // Free the secrets one entry at a time: it stays in use until the last entry is gone.
      assert.equal(
        (await owner.call('DELETE', `/servers/${a.id}/access/${entryA.id}`)).status,
        204,
      );
      const stillUsed = await owner.call('DELETE', `/secrets/${used}`);
      assert.equal(stillUsed.status, 409);
      assert.match(JSON.stringify(stillUsed.body), /use-b/u);
      assert.ok(!JSON.stringify(stillUsed.body).includes('use-a'));
      assert.equal(
        (await owner.call('DELETE', `/servers/${b.id}/access/${entryB.id}`)).status,
        204,
      );
      assert.equal((await owner.call('DELETE', `/secrets/${used}`)).status, 204);
      assert.equal((await owner.call('DELETE', `/secrets/${sudoOnly}`)).status, 204);
      assert.equal(await db.secret.count({ where: { id: { in: [used, sudoOnly] } } }), 0);
    });

    it('can be deleted after the server that used it is deleted', async () => {
      const secret = await makeSecret('briefly used', 'ssh_key', 'briefly-used-value-for-tests');
      const made = await create(owner, { name: 'use-gone', address: '192.0.2.102' });
      await owner.post(`/servers/${made.id}/access`, {
        method: 'key',
        username: 'root',
        secretId: secret,
      });
      assert.equal((await owner.call('DELETE', `/secrets/${secret}`)).status, 409);
      assert.equal((await owner.call('DELETE', `/servers/${made.id}`)).status, 204);
      assert.equal((await owner.call('DELETE', `/secrets/${secret}`)).status, 204);
    });
  });

  describe('the audit log', () => {
    it('holds every action of this slice, in one chain, without secrets', async () => {
      const seen = new Set((await serverEvents(instance)).map((event) => event.action));
      for (const action of [
        'server.created',
        'server.updated',
        'server.deleted',
        'server.host_key.pinned',
        'server.host_key.revoked',
        'server.access.added',
        'server.access.updated',
        'server.access.removed',
      ]) {
        assert.ok(seen.has(action), `${action} was written`);
      }
      const reply = await owner.post('/audit/verify-chain');
      assert.equal(reply.status, 200);
      assert.equal((reply.body as { ok: boolean }).ok, true);
    });
  });
});
