import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  AccessVerificationSchema,
  ApiErrorSchema,
  type AuditEvent,
  HostKeyAcceptedSchema,
  HostKeyScanSchema,
  SecretViewSchema,
  ServerAccessSchema,
  ServerFactsRecordSchema,
  ServerListSchema,
  type ServerView,
  ServerViewSchema,
} from '@swellwright/contracts';
import {
  generateTestKeyPair,
  generateTestRsaKeyPair,
  publicKeyFingerprint,
  startStallingServer,
} from '@swellwright/ssh/test-support';

import {
  auditEvents,
  type Client,
  createOwner,
  createUser,
  databaseUrl,
  errorCode,
  found,
  type Instance,
  type Reply,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { VaultService } from '../vault/vault.service.js';
import { DEBIAN_12_NODE } from './facts/samples.js';
import { loadFactsScript } from './facts/script.js';
import { FakeHost, type FakeHostOptions } from './ssh-test-support.js';

const PASSPHRASE = 'a long passphrase for the vault, used in tests';
const LOGIN = 'the-login-password-for-ssh-tests';
const SUDO = 'the-sudo-password-for-ssh-tests';
const OTHER = 'not-the-password-of-anybody';
const FP_OTHER = `SHA256:${'B'.repeat(42)}Q`;
const KEY = generateTestKeyPair();

const secretsSeen = [LOGIN, SUDO, OTHER, KEY.privateKey];

const errorOf = (reply: Reply) => ApiErrorSchema.parse(reply.body).error;

/** Every audit event about one server, oldest first. */
async function trail(instance: Instance, serverId: string): Promise<AuditEvent[]> {
  return (await auditEvents(instance)).filter(
    (event) => event.object?.type === 'server' && event.object.id === serverId,
  );
}

const actions = (events: readonly AuditEvent[]): string[] => events.map((event) => event.action);

describe('servers over SSH', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let operator: Client;
  let observer: Client;
  let loginSecret = '';
  let wrongSecret = '';
  let sudoSecret = '';
  let wrongSudoSecret = '';
  let keySecret = '';
  let badKeySecret = '';
  const hosts: FakeHost[] = [];
  const stoppers: (() => Promise<void>)[] = [];

  const makeSecret = async (name: string, type: string, value: string): Promise<string> => {
    const reply = await owner.post('/secrets', { name, type, value });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body).id;
  };

  const startHost = async (options: FakeHostOptions): Promise<FakeHost> => {
    const host = await FakeHost.start(options);
    hosts.push(host);
    return host;
  };

  const createServer = async (
    client: Client,
    name: string,
    port: number,
    address = '127.0.0.1',
  ): Promise<ServerView> => {
    const reply = await client.post('/servers', { name, address, sshPort: port });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return ServerViewSchema.parse(reply.body);
  };

  const pin = async (serverId: string, fingerprint: string): Promise<void> => {
    const reply = await owner.post(`/servers/${serverId}/host-keys`, {
      algorithm: 'ssh-ed25519',
      fingerprintSha256: fingerprint,
    });
    assert.ok(reply.status === 200 || reply.status === 201, JSON.stringify(reply.body));
  };

  const addAccess = async (
    serverId: string,
    body: Record<string, unknown>,
  ): Promise<ReturnType<typeof ServerAccessSchema.parse>> => {
    const reply = await owner.post(`/servers/${serverId}/access`, body);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return ServerAccessSchema.parse(reply.body);
  };

  /** A host, a server that points at it with its key pinned, and one access entry. */
  const provision = async (
    name: string,
    host: FakeHost,
    access: Record<string, unknown>,
  ): Promise<{ server: ServerView; accessId: string }> => {
    const server = await createServer(owner, name, host.port);
    await pin(server.id, host.fingerprint);
    const entry = await addAccess(server.id, access);
    return { server, accessId: entry.id };
  };

  const verify = async (client: Client, serverId: string, accessId: string) =>
    client.post(`/servers/${serverId}/access/${accessId}/verify`);

  before(async () => {
    instance = await start({
      SW_SSH_ALLOW_LOOPBACK: 'true',
      SW_SSH_CONNECT_TIMEOUT_SECONDS: '2',
      SW_SSH_COMMAND_TIMEOUT_SECONDS: '2',
      SW_SSH_RATE_LIMIT_PER_MINUTE: '600',
    });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const ops = await createUser(instance, 'ops', 'operator');
    operator = await signInAs(instance, 'ops', ops.secret);
    const viewer = await createUser(instance, 'viewer', 'observer');
    observer = await signInAs(instance, 'viewer', viewer.secret);

    assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
    loginSecret = await makeSecret('ssh login', 'ssh_password', LOGIN);
    wrongSecret = await makeSecret('ssh wrong', 'ssh_password', OTHER);
    sudoSecret = await makeSecret('ssh sudo', 'ssh_password', SUDO);
    wrongSudoSecret = await makeSecret('ssh wrong sudo', 'ssh_password', OTHER);
    keySecret = await makeSecret('ssh key', 'ssh_key', KEY.privateKey);
    badKeySecret = await makeSecret('ssh bad key', 'ssh_key', 'this is not a private key at all');
  });

  after(async () => {
    for (const stopper of stoppers) {
      await stopper();
    }
    for (const host of hosts) {
      await host.close();
    }
    await stop(instance);
  });

  describe('the whole flow', () => {
    it('scans, confirms, pins, verifies and collects, with a record of every step', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const made = await createServer(owner, 'flow-root', host.port);

      const scanReply = await owner.post(`/servers/${made.id}/host-keys/scan`);
      assert.equal(scanReply.status, 200, JSON.stringify(scanReply.body));
      const scan = HostKeyScanSchema.parse(scanReply.body);
      assert.equal(scan.status, 'new');
      assert.equal(scan.fingerprintSha256, host.fingerprint);
      assert.equal(scan.algorithm, 'ssh-ed25519');
      assert.equal(scan.address, '127.0.0.1');
      assert.equal(scan.port, host.port);
      assert.deepEqual(scan.pinned, []);
      assert.equal(host.server.authAttempts.length, 0, 'a scan sends no credential at all');

      const accepted = await owner.post(`/servers/${made.id}/host-keys/accept`, {
        fingerprintSha256: scan.fingerprintSha256,
      });
      assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
      const first = HostKeyAcceptedSchema.parse(accepted.body);
      assert.equal(first.key.source, 'scan');
      assert.equal(first.key.acceptedBy, 'owner');
      assert.equal(first.key.fingerprintSha256, host.fingerprint);
      assert.equal(first.replaced, 0);
      assert.deepEqual(Object.keys(accepted.body as object).sort(), ['key', 'replaced']);

      const again = await owner.post(`/servers/${made.id}/host-keys/accept`, {
        fingerprintSha256: scan.fingerprintSha256,
      });
      assert.equal(again.status, 200, 'a key that is pinned already is not pinned twice');
      assert.equal(HostKeyAcceptedSchema.parse(again.body).key.id, first.key.id);

      const rescan = HostKeyScanSchema.parse(
        (await owner.post(`/servers/${made.id}/host-keys/scan`)).body,
      );
      assert.equal(rescan.status, 'pinned');
      assert.equal(rescan.pinned.length, 1);

      const entry = await addAccess(made.id, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      assert.equal(entry.lastVerifiedAt, null);
      assert.equal(entry.lastVerifyOk, null);

      const verified = await verify(owner, made.id, entry.id);
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      const check = AccessVerificationSchema.parse(verified.body);
      assert.equal(check.ok, true);
      assert.equal(check.remoteUser, 'root');
      assert.equal(check.isRoot, true);
      assert.equal(check.sudo, 'not_needed');
      assert.equal(check.error, undefined);
      assert.ok(check.latencyMs >= 0);
      assert.ok(
        host.server.authAttempts.some(
          (attempt) =>
            attempt.method === 'password' && attempt.username === 'root' && attempt.accepted,
        ),
      );

      const withEntry = ServerViewSchema.parse((await owner.get(`/servers/${made.id}`)).body);
      assert.equal(withEntry.access[0]?.lastVerifyOk, true);
      assert.equal(withEntry.access[0].lastVerifiedAt, check.verifiedAt);

      const missing = await owner.get(`/servers/${made.id}/facts`);
      assert.equal(missing.status, 404, 'nothing was collected yet');

      const refreshed = await owner.post(`/servers/${made.id}/facts/refresh`);
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      const record = ServerFactsRecordSchema.parse(refreshed.body);
      assert.equal(record.source, 'ssh');
      assert.equal(record.scriptSha256, loadFactsScript().sha256);
      assert.equal(record.facts.collectedAs, 'root');
      assert.equal(record.facts.os?.id, 'debian');
      assert.equal(record.facts.containers?.[0]?.imageTag, '3.4.6');
      assert.deepEqual(record.facts.warnings, []);
      assert.deepEqual(
        ServerFactsRecordSchema.parse((await owner.get(`/servers/${made.id}/facts`)).body),
        record,
      );

      const list = ServerListSchema.parse((await owner.get('/servers?q=flow-root')).body).servers;
      assert.equal(list[0]?.facts?.os, 'Debian GNU/Linux 12 (bookworm)');
      assert.equal(list[0].facts.kernel, '6.1.0-28-amd64');

      const events = await trail(instance, made.id);
      assert.deepEqual(actions(events), [
        'server.created',
        'server.host_key.scanned',
        'server.host_key.pinned',
        'server.host_key.scanned',
        'server.access.added',
        'server.access.verified',
        'server.facts.refreshed',
      ]);
      const [, scanned, pinned, , , verifiedEvent, refreshedEvent] = events;
      assert.deepEqual(found(scanned, 'scan').details, {
        algorithm: 'ssh-ed25519',
        fingerprint: host.fingerprint,
        status: 'new',
      });
      assert.equal(found(scanned, 'scan').outcome, 'success');
      assert.deepEqual(found(pinned, 'pin').details, {
        algorithm: 'ssh-ed25519',
        fingerprint: host.fingerprint,
        source: 'scan',
        replaced: 0,
      });
      assert.equal(found(pinned, 'pin').actor?.name, 'owner');
      const verifiedDetails = found(verifiedEvent, 'verify').details;
      assert.equal(found(verifiedEvent, 'verify').outcome, 'success');
      assert.equal(verifiedDetails['access_id'], entry.id);
      assert.equal(verifiedDetails['ok'], true);
      assert.equal(verifiedDetails['error_code'], null);
      assert.equal(verifiedDetails['remote_user'], 'root');
      assert.equal(verifiedDetails['sudo'], 'not_needed');
      const refreshedDetails = found(refreshedEvent, 'refresh').details;
      assert.equal(refreshedDetails['access_id'], entry.id);
      assert.equal(refreshedDetails['collected_as'], 'root');
      assert.equal(refreshedDetails['script_sha256'], loadFactsScript().sha256);
      assert.equal(refreshedDetails['warnings'], 0);
    });

    it('never puts a secret in an answer or in the audit log, and never records a reveal', async () => {
      const everything = JSON.stringify(await auditEvents(instance));
      for (const secret of secretsSeen) {
        assert.ok(!everything.includes(secret), 'a secret is in the audit log');
      }
      assert.equal(
        (await auditEvents(instance)).filter((event) => event.action === 'secret.revealed').length,
        0,
        'using a secret for a connection is not a reveal',
      );
    });
  });

  describe('logging in', () => {
    it('with a key', async () => {
      const host = await startHost({
        users: { deploy: { publicKeys: [KEY.publicKey] } },
        user: 'deploy',
        uid: 1000,
        sudo: 'passwordless',
      });
      const { server, accessId } = await provision('login-key', host, {
        method: 'key',
        username: 'deploy',
        secretId: keySecret,
      });
      const check = AccessVerificationSchema.parse((await verify(owner, server.id, accessId)).body);
      assert.equal(check.ok, true);
      assert.equal(check.remoteUser, 'deploy');
      assert.equal(check.isRoot, false);
      assert.equal(check.sudo, 'ok', 'NOPASSWD sudo needs no stored secret');
      assert.ok(
        host.server.authAttempts.some(
          (attempt) => attempt.method === 'publickey' && attempt.accepted,
        ),
      );
    });

    it('answers a login that does not work with a result, not an error', async () => {
      const host = await startHost({
        users: { deploy: { password: LOGIN } },
        user: 'deploy',
        uid: 1000,
      });
      const { server, accessId } = await provision('login-wrong', host, {
        method: 'password',
        username: 'deploy',
        secretId: wrongSecret,
      });
      const reply = await verify(owner, server.id, accessId);
      assert.equal(reply.status, 200);
      const check = AccessVerificationSchema.parse(reply.body);
      assert.equal(check.ok, false);
      assert.equal(check.error?.code, 'ssh_auth_failed');
      assert.equal(check.remoteUser, null);
      assert.equal(check.isRoot, null);
      assert.equal(check.sudo, 'unavailable');

      const view = ServerViewSchema.parse((await owner.get(`/servers/${server.id}`)).body);
      assert.equal(view.access[0]?.lastVerifyOk, false);
      assert.ok(view.access[0].lastVerifiedAt);
      const event = found(
        (await trail(instance, server.id)).find((e) => e.action === 'server.access.verified'),
        'the verification',
      );
      assert.equal(event.outcome, 'failure');
      assert.equal(event.details['error_code'], 'ssh_auth_failed');
      assert.ok(
        host.server.authAttempts.every((attempt) => !attempt.accepted),
        'only the stored secret was tried',
      );
    });

    it('answers a private key that cannot be used without touching the network', async () => {
      const host = await startHost({ users: { deploy: { publicKeys: [KEY.publicKey] } } });
      const { server, accessId } = await provision('login-bad-key', host, {
        method: 'key',
        username: 'deploy',
        secretId: badKeySecret,
      });
      const check = AccessVerificationSchema.parse((await verify(owner, server.id, accessId)).body);
      assert.equal(check.ok, false);
      assert.equal(check.error?.code, 'ssh_key_invalid');
      assert.equal(host.server.connections, 0);
    });

    it('tries the entries by priority and uses the first that logs in', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const server = await createServer(owner, 'login-priority', host.port);
      await pin(server.id, host.fingerprint);
      await addAccess(server.id, {
        method: 'password',
        username: 'root',
        secretId: wrongSecret,
        priority: 0,
      });
      const good = await addAccess(server.id, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
        priority: 1,
      });
      const refreshed = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      const event = found(
        (await trail(instance, server.id)).find((e) => e.action === 'server.facts.refreshed'),
        'the refresh',
      );
      assert.equal(event.outcome, 'success');
      assert.equal(
        event.details['access_id'],
        good.id,
        'the entry that worked is the one recorded',
      );
    });

    it('reports every entry refused as one error, and records it', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const server = await createServer(owner, 'login-all-wrong', host.port);
      await pin(server.id, host.fingerprint);
      await addAccess(server.id, { method: 'password', username: 'root', secretId: wrongSecret });
      const reply = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'ssh_auth_failed');
      const event = found(
        (await trail(instance, server.id)).find((e) => e.action === 'server.facts.refreshed'),
        'the refresh',
      );
      assert.equal(event.outcome, 'failure');
      assert.equal(event.details['error_code'], 'ssh_auth_failed');
    });
  });

  describe('sudo', () => {
    const scenario = async (
      name: string,
      options: Pick<FakeHostOptions, 'sudo'>,
      sudoSecretId?: string,
    ) => {
      const host = await startHost({
        users: { deploy: { password: LOGIN } },
        user: 'deploy',
        uid: 1000,
        ...options,
      });
      const made = await provision(name, host, {
        method: 'password',
        username: 'deploy',
        secretId: loginSecret,
        ...(sudoSecretId === undefined ? {} : { sudoSecretId }),
      });
      const check = AccessVerificationSchema.parse(
        (await verify(owner, made.server.id, made.accessId)).body,
      );
      return { host, ...made, check };
    };

    it('works with the stored password, which travels only on standard input', async () => {
      const { host, server, check } = await scenario(
        'sudo-password',
        { sudo: { password: SUDO } },
        sudoSecret,
      );
      assert.equal(check.ok, true);
      assert.equal(check.isRoot, false);
      assert.equal(check.sudo, 'ok');
      const wrapped = host.server.execLog.filter((entry) =>
        entry.command.includes('swellwright-sudo'),
      );
      assert.ok(wrapped.length >= 1);
      for (const entry of wrapped) {
        assert.ok(
          entry.stdin.toString('utf8').startsWith(`${SUDO}\n`),
          'the first line is the password',
        );
        assert.ok(!entry.command.includes(SUDO), 'never in the command line');
      }
      assert.ok(
        host.server.execLog.every((entry) => !entry.command.includes(LOGIN)),
        'the login password is not in a command line either',
      );

      const refreshed = ServerFactsRecordSchema.parse(
        (await owner.post(`/servers/${server.id}/facts/refresh`)).body,
      );
      assert.equal(refreshed.facts.collectedAs, 'sudo');
      assert.equal(host.factsRuns.at(-1)?.asRoot, true);
      assert.ok(
        host.server.execLog
          .filter((entry) => entry.command.includes('swellwright-sudo'))
          .every((entry) => !entry.command.includes(SUDO)),
      );
    });

    it('says a password is required when none is stored, and collects as the plain login', async () => {
      const { host, server, check } = await scenario('sudo-required', { sudo: { password: SUDO } });
      assert.equal(check.ok, true, 'the login works; only sudo does not');
      assert.equal(check.sudo, 'password_required');
      const refreshed = ServerFactsRecordSchema.parse(
        (await owner.post(`/servers/${server.id}/facts/refresh`)).body,
      );
      assert.equal(refreshed.facts.collectedAs, 'user');
      assert.equal(host.factsRuns.at(-1)?.asRoot, false);
    });

    it('says sudo failed when the stored password is wrong', async () => {
      const { check } = await scenario('sudo-wrong', { sudo: { password: SUDO } }, wrongSudoSecret);
      assert.equal(check.ok, true);
      assert.equal(check.sudo, 'failed');
    });

    it('says sudo is unavailable when it is not installed', async () => {
      const { check } = await scenario('sudo-missing', { sudo: 'none' }, sudoSecret);
      assert.equal(check.sudo, 'unavailable');
    });

    it('needs no stored password for NOPASSWD sudo', async () => {
      const { check } = await scenario('sudo-nopasswd', { sudo: 'passwordless' });
      assert.equal(check.sudo, 'ok');
    });
  });

  describe('what stops a connection before it starts', () => {
    it('refuses to connect while no host key is pinned, and opens no connection at all', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const server = await createServer(owner, 'pre-unpinned', host.port);
      const entry = await addAccess(server.id, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const verified = await verify(owner, server.id, entry.id);
      assert.equal(verified.status, 409);
      assert.equal(errorOf(verified).code, 'host_key_not_pinned');
      const refreshed = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(refreshed.status, 409);
      assert.equal(errorOf(refreshed).code, 'host_key_not_pinned');
      assert.equal(host.server.connections, 0);
      assert.equal(host.server.authAttempts.length, 0);
      const view = ServerViewSchema.parse((await owner.get(`/servers/${server.id}`)).body);
      assert.equal(view.access[0]?.lastVerifiedAt, null, 'nothing was tried, so nothing is kept');
    });

    it('wants an access entry to collect facts', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const server = await createServer(owner, 'pre-no-access', host.port);
      await pin(server.id, host.fingerprint);
      const reply = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(reply.status, 409);
      assert.equal(errorOf(reply).code, 'no_access_entry');
      assert.equal(host.server.connections, 0);
    });

    it('answers 404 for a server or an entry that does not exist', async () => {
      const ghost = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
      for (const path of [
        `/servers/${ghost}/host-keys/scan`,
        `/servers/${ghost}/facts/refresh`,
        `/servers/${ghost}/access/${ghost}/verify`,
      ]) {
        assert.equal((await owner.post(path)).status, 404, path);
      }
      assert.equal(
        (await owner.post(`/servers/${ghost}/host-keys/accept`, { fingerprintSha256: FP_OTHER }))
          .status,
        404,
      );
      assert.equal((await owner.get(`/servers/${ghost}/facts`)).status, 404);
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const server = await createServer(owner, 'pre-no-entry', host.port);
      await pin(server.id, host.fingerprint);
      assert.equal((await verify(owner, server.id, ghost)).status, 404);
      assert.equal(host.server.connections, 0);
    });

    it('does not connect while the vault is sealed, and says why', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const { server, accessId } = await provision('pre-sealed', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      assert.equal((await owner.post('/vault/seal')).status, 200);
      try {
        const verified = await verify(owner, server.id, accessId);
        assert.equal(verified.status, 423);
        assert.equal(errorCode(verified), 'vault_sealed');
        const refreshed = await owner.post(`/servers/${server.id}/facts/refresh`);
        assert.equal(refreshed.status, 423);
        assert.equal(errorCode(refreshed), 'vault_sealed');
        assert.equal(host.server.connections, 0, 'no connection without a secret to send');
        // A scan sends no credential, so a sealed vault does not stop it.
        assert.equal((await owner.post(`/servers/${server.id}/host-keys/scan`)).status, 200);
      } finally {
        assert.equal((await owner.post('/vault/unseal', { passphrase: PASSPHRASE })).status, 200);
      }
      assert.equal((await verify(owner, server.id, accessId)).status, 200);
    });

    it('refuses addresses the policy does not allow, however they are written', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      for (const address of [
        '169.254.169.254',
        '0.0.0.0',
        '224.0.0.1',
        'metadata.google.internal',
      ]) {
        const server = await createServer(
          owner,
          `addr-${address.replaceAll(/[^0-9a-z]/gu, '-')}`,
          host.port,
          address,
        );
        const reply = await owner.post(`/servers/${server.id}/host-keys/scan`);
        assert.equal(reply.status, 409, address);
        assert.equal(errorOf(reply).code, 'address_not_allowed', address);
      }
      assert.equal(host.server.connections, 0);
    });
  });

  // A real server has a key of every type and shows the type the client prefers (ed25519). A key of another type that
  // was pinned (it was the only one at the time of the scan, or a person pinned it) is still the server's key: it must
  // not be taken for a changed one when the server gained a key of the preferred type (found on a real Ubuntu server).
  describe('a server with host keys of several types', () => {
    let host: FakeHost;
    let server: ServerView;
    let accessId = '';
    const rsa = generateTestRsaKeyPair();
    const rsaFingerprint = publicKeyFingerprint(rsa.publicKey);

    before(async () => {
      host = await startHost({ users: { root: { password: LOGIN } }, extraHostKeys: [rsa] });
      server = await createServer(owner, 'two-key-types', host.port);
      const pinned = await owner.post(`/servers/${server.id}/host-keys`, {
        algorithm: 'ssh-rsa',
        fingerprintSha256: rsaFingerprint,
      });
      assert.equal(pinned.status, 201, JSON.stringify(pinned.body));
      accessId = (
        await addAccess(server.id, { method: 'password', username: 'root', secretId: loginSecret })
      ).id;
    });

    it('is the same server when the pinned key is of the type the client prefers less', async () => {
      const verified = await verify(owner, server.id, accessId);
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(AccessVerificationSchema.parse(verified.body).ok, true);
      const refreshed = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    });

    it('is not a changed key for a scan: the pinned key is the one it shows', async () => {
      const scan = HostKeyScanSchema.parse(
        (await owner.post(`/servers/${server.id}/host-keys/scan`)).body,
      );
      assert.equal(scan.status, 'pinned');
      assert.equal(scan.algorithm, 'ssh-rsa');
      assert.equal(scan.fingerprintSha256, rsaFingerprint);
    });

    it('is still told when the key of the pinned type changed', async () => {
      const other = await startHost({
        users: { root: { password: LOGIN } },
        extraHostKeys: [generateTestRsaKeyPair()],
      });
      const changed = await createServer(owner, 'two-key-types-changed', other.port);
      const reply = await owner.post(`/servers/${changed.id}/host-keys`, {
        algorithm: 'ssh-rsa',
        fingerprintSha256: rsaFingerprint,
      });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const entry = await addAccess(changed.id, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const verified = await verify(owner, changed.id, entry.id);
      assert.equal(verified.status, 409);
      assert.equal(errorOf(verified).code, 'host_key_mismatch');
      assert.equal(other.server.authAttempts.length, 0, 'no credential was sent');
      const scan = HostKeyScanSchema.parse(
        (await owner.post(`/servers/${changed.id}/host-keys/scan`)).body,
      );
      assert.equal(scan.status, 'differs');
      assert.equal(scan.algorithm, 'ssh-rsa');
    });
  });

  describe('a host key that is not the pinned one', () => {
    let host: FakeHost;
    let server: ServerView;
    let accessId = '';

    before(async () => {
      host = await startHost({ users: { root: { password: LOGIN } } });
      server = await createServer(owner, 'mismatch', host.port);
      await pin(server.id, FP_OTHER);
      accessId = (
        await addAccess(server.id, { method: 'password', username: 'root', secretId: loginSecret })
      ).id;
    });

    it('stops every operation before any credential is sent, with both fingerprints', async () => {
      const verified = await verify(owner, server.id, accessId);
      assert.equal(verified.status, 409);
      const error = errorOf(verified);
      assert.equal(error.code, 'host_key_mismatch');
      assert.deepEqual(error.details, { expected: [FP_OTHER], actual: host.fingerprint });
      assert.ok(error.message.includes(host.fingerprint));

      const refreshed = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(refreshed.status, 409);
      assert.equal(errorOf(refreshed).code, 'host_key_mismatch');

      assert.equal(
        host.server.authAttempts.length,
        0,
        'not a single authentication request, not even `none`',
      );
      assert.equal(host.server.execLog.length, 0);

      const view = ServerViewSchema.parse((await owner.get(`/servers/${server.id}`)).body);
      assert.equal(view.access[0]?.lastVerifyOk, false, 'the failed check is kept');
      const events = (await trail(instance, server.id)).filter(
        (event) =>
          event.action === 'server.access.verified' || event.action === 'server.facts.refreshed',
      );
      assert.equal(events.length, 2);
      for (const event of events) {
        assert.equal(event.outcome, 'failure');
        assert.equal(event.details['error_code'], 'host_key_mismatch');
      }
    });

    it('is told apart from a new key by a scan', async () => {
      const scan = HostKeyScanSchema.parse(
        (await owner.post(`/servers/${server.id}/host-keys/scan`)).body,
      );
      assert.equal(scan.status, 'differs');
      assert.equal(scan.fingerprintSha256, host.fingerprint);
      assert.deepEqual(
        scan.pinned.map((key) => key.fingerprintSha256),
        [FP_OTHER],
      );
    });

    it('is not pinned when the person confirmed another fingerprint', async () => {
      const reply = await owner.post(`/servers/${server.id}/host-keys/accept`, {
        fingerprintSha256: FP_OTHER,
        replace: true,
      });
      assert.equal(reply.status, 409);
      const error = errorOf(reply);
      assert.equal(error.code, 'host_key_mismatch');
      assert.deepEqual(error.details, { expected: [FP_OTHER], actual: host.fingerprint });
      const view = ServerViewSchema.parse((await owner.get(`/servers/${server.id}`)).body);
      assert.deepEqual(
        view.hostKeys.map((key) => key.fingerprintSha256),
        [FP_OTHER],
        'nothing changed',
      );
    });

    it('is not replaced without saying so, and nothing is stored', async () => {
      const reply = await owner.post(`/servers/${server.id}/host-keys/accept`, {
        fingerprintSha256: host.fingerprint,
      });
      assert.equal(reply.status, 409);
      const error = errorOf(reply);
      assert.equal(error.code, 'host_key_replace_required');
      assert.deepEqual(error.details, { pinned: [FP_OTHER] });
      const view = ServerViewSchema.parse((await owner.get(`/servers/${server.id}`)).body);
      assert.deepEqual(
        view.hostKeys.map((key) => key.fingerprintSha256),
        [FP_OTHER],
      );
    });

    it('is replaced when the person says the system was reinstalled, in one record each', async () => {
      const reply = await owner.post(`/servers/${server.id}/host-keys/accept`, {
        fingerprintSha256: host.fingerprint,
        replace: true,
      });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const accepted = HostKeyAcceptedSchema.parse(reply.body);
      assert.equal(accepted.replaced, 1);
      assert.equal(accepted.key.source, 'scan');
      const view = ServerViewSchema.parse((await owner.get(`/servers/${server.id}`)).body);
      assert.deepEqual(
        view.hostKeys.map((key) => key.fingerprintSha256),
        [host.fingerprint],
      );

      const events = await trail(instance, server.id);
      const revoked = found(
        events.find((event) => event.action === 'server.host_key.revoked'),
        'the revocation',
      );
      assert.deepEqual(revoked.details, {
        algorithm: 'ssh-ed25519',
        fingerprint: FP_OTHER,
        source: 'manual',
        reason: 'replaced',
      });
      const pinned = found(
        events.filter((event) => event.action === 'server.host_key.pinned').at(-1),
        'the pin',
      );
      assert.equal(pinned.details['replaced'], 1);
      assert.equal(pinned.details['source'], 'scan');
      assert.ok(
        events.findIndex((event) => event === revoked) <
          events.findIndex((event) => event === pinned),
        'the old key goes first, in the same transaction',
      );

      // And the server is trusted again.
      const check = AccessVerificationSchema.parse((await verify(owner, server.id, accessId)).body);
      assert.equal(check.ok, true);
    });
  });

  describe('a server that cannot be reached', () => {
    it('says the connection was refused: a result for a check, an error for a scan', async () => {
      const probe = createTcpServer();
      await new Promise<void>((resolve) => {
        probe.listen(0, '127.0.0.1', resolve);
      });
      const { port } = probe.address() as { port: number };
      await new Promise<void>((resolve) => {
        probe.close(() => {
          resolve();
        });
      });
      const server = await createServer(owner, 'down-refused', port);
      await pin(server.id, FP_OTHER);
      const entry = await addAccess(server.id, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const check = AccessVerificationSchema.parse((await verify(owner, server.id, entry.id)).body);
      assert.equal(check.ok, false);
      assert.equal(check.error?.code, 'ssh_connect_failed');
      const scan = await owner.post(`/servers/${server.id}/host-keys/scan`);
      assert.equal(scan.status, 502);
      const error = errorOf(scan);
      assert.equal(error.code, 'ssh_connect_failed');
      assert.deepEqual(error.details, { reason: 'refused' });
      const events = (await trail(instance, server.id)).filter(
        (e) => e.action === 'server.host_key.scanned',
      );
      assert.equal(events[0]?.outcome, 'failure');
      assert.equal(events[0].details['error_code'], 'ssh_connect_failed');
    });

    it('gives up on a server that never finishes the handshake', async () => {
      const stalling = await startStallingServer();
      stoppers.push(stalling.close);
      const server = await createServer(owner, 'down-stalled', stalling.port);
      await pin(server.id, FP_OTHER);
      const entry = await addAccess(server.id, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const check = AccessVerificationSchema.parse((await verify(owner, server.id, entry.id)).body);
      assert.equal(check.ok, false);
      assert.equal(check.error?.code, 'ssh_timeout');
      const scan = await owner.post(`/servers/${server.id}/host-keys/scan`);
      assert.equal(scan.status, 504);
      assert.equal(errorOf(scan).code, 'ssh_timeout');
    });

    it('gives up on a facts script that never answers', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } }, stallFacts: true });
      const { server } = await provision('down-script', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const reply = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(reply.status, 504);
      const error = errorOf(reply);
      assert.equal(error.code, 'ssh_timeout');
      assert.deepEqual(error.details, { phase: 'exec' });
      const event = found(
        (await trail(instance, server.id)).find((e) => e.action === 'server.facts.refreshed'),
        'the refresh',
      );
      assert.equal(event.outcome, 'failure');
    });
  });

  describe('collecting facts', () => {
    it('joins a refresh that is running instead of starting a second one', async () => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const host = await startHost({ users: { root: { password: LOGIN } }, factsGate: gate });
      const { server } = await provision('facts-join', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const first = owner.post(`/servers/${server.id}/facts/refresh`);
      await host.factsStarted;
      const second = operator.post(`/servers/${server.id}/facts/refresh`);
      // Let the second request reach the service before the script is allowed to finish.
      await new Promise((resolve) => setTimeout(resolve, 100));
      open();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.deepEqual(b.body, a.body, 'both got the same answer');
      assert.equal(host.factsRuns.length, 1, 'the script ran once');
      const refreshes = (await trail(instance, server.id)).filter(
        (e) => e.action === 'server.facts.refreshed',
      );
      assert.equal(refreshes.length, 1, 'and is recorded once, for the person who started it');
      assert.equal(refreshes[0]?.actor?.name, 'owner');

      // Afterwards a refresh runs again.
      assert.equal((await owner.post(`/servers/${server.id}/facts/refresh`)).status, 200);
      assert.equal(host.factsRuns.length, 2);
    });

    it('keeps the facts it had when the server answers with nonsense', async () => {
      let broken = false;
      const host = await startHost({
        users: { root: { password: LOGIN } },
        facts: () => (broken ? 'Welcome to the server!\nLast login: yesterday\n' : DEBIAN_12_NODE),
      });
      const { server } = await provision('facts-nonsense', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const good = ServerFactsRecordSchema.parse(
        (await owner.post(`/servers/${server.id}/facts/refresh`)).body,
      );
      broken = true;
      const reply = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(reply.status, 502);
      assert.equal(errorOf(reply).code, 'facts_unreadable');
      assert.deepEqual(
        ServerFactsRecordSchema.parse((await owner.get(`/servers/${server.id}/facts`)).body),
        good,
      );
      const failure = (await trail(instance, server.id))
        .filter((e) => e.action === 'server.facts.refreshed')
        .at(-1);
      assert.equal(failure?.outcome, 'failure');
      assert.equal(failure.details['error_code'], 'facts_unreadable');
    });

    it('stores what is there when the output is cut short, with a warning', async () => {
      const cut = DEBIAN_12_NODE.slice(0, DEBIAN_12_NODE.indexOf('@@swf begin ports'));
      const host = await startHost({ users: { root: { password: LOGIN } }, facts: () => cut });
      const { server } = await provision('facts-cut', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const reply = await owner.post(`/servers/${server.id}/facts/refresh`);
      assert.equal(reply.status, 200);
      const record = ServerFactsRecordSchema.parse(reply.body);
      assert.equal(record.facts.os?.id, 'debian');
      assert.equal(record.facts.listeningPorts, null);
      assert.ok(
        record.facts.warnings.some((warning) => warning.startsWith('The output ended before')),
      );
    });

    it('replaces the facts of the last refresh', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } } });
      const { server } = await provision('facts-replace', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      const one = ServerFactsRecordSchema.parse(
        (await owner.post(`/servers/${server.id}/facts/refresh`)).body,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const two = ServerFactsRecordSchema.parse(
        (await owner.post(`/servers/${server.id}/facts/refresh`)).body,
      );
      assert.ok(two.collectedAt >= one.collectedAt);
      assert.equal(
        await instance.isolated.database.client.serverFact.count({
          where: { serverId: server.id },
        }),
        1,
        'one row per server',
      );
    });
  });

  describe('who may do what', () => {
    let host: FakeHost;
    let server: ServerView;
    let accessId = '';

    before(async () => {
      host = await startHost({ users: { root: { password: LOGIN } } });
      const made = await provision('perm-target', host, {
        method: 'password',
        username: 'root',
        secretId: loginSecret,
      });
      server = made.server;
      accessId = made.accessId;
    });

    const writes = (): [string, string, unknown?][] => [
      ['POST', `/servers/${server.id}/host-keys/scan`],
      ['POST', `/servers/${server.id}/host-keys/accept`, { fingerprintSha256: host.fingerprint }],
      ['POST', `/servers/${server.id}/access/${accessId}/verify`],
      ['POST', `/servers/${server.id}/facts/refresh`],
    ];

    it('answers 401 to everything without a session', async () => {
      const anonymous = instance.client();
      for (const [method, path, body] of [
        ...writes(),
        ['GET', `/servers/${server.id}/facts`] as [string, string],
      ]) {
        assert.equal((await anonymous.call(method, path, body)).status, 401, `${method} ${path}`);
      }
      assert.equal(host.server.connections, 0);
    });

    it('lets an observer read the facts and start nothing', async () => {
      assert.equal((await observer.get(`/servers/${server.id}/facts`)).status, 404, 'none yet');
      for (const [method, path, body] of writes()) {
        const reply = await observer.call(method, path, body);
        assert.equal(reply.status, 403, `${method} ${path}`);
        assert.equal(errorCode(reply), 'forbidden');
      }
      assert.equal(host.server.connections, 0, 'a role that only reads never causes a connection');
      assert.equal(
        await instance.isolated.database.client.serverFact.count({
          where: { serverId: server.id },
        }),
        0,
      );

      assert.equal((await owner.post(`/servers/${server.id}/facts/refresh`)).status, 200);
      const read = await observer.get(`/servers/${server.id}/facts`);
      assert.equal(read.status, 200);
      ServerFactsRecordSchema.parse(read.body);
    });

    it('lets an operator do all of it', async () => {
      for (const [method, path, body] of writes()) {
        const reply = await operator.call(method, path, body);
        assert.ok(
          reply.status === 200 || reply.status === 201,
          `${method} ${path}: ${String(reply.status)} ${JSON.stringify(reply.body)}`,
        );
      }
      const event = found(
        (await trail(instance, server.id))
          .filter((e) => e.action === 'server.access.verified')
          .at(-1),
        'the check',
      );
      assert.equal(event.actor?.name, 'ops');
    });
  });

  describe('the vault', () => {
    it('hands a server only the kind of secret its entry needs, and records no reveal', async () => {
      const vault = instance.app.get(VaultService);
      assert.equal(await vault.readForServer(loginSecret, 'ssh_password'), LOGIN);
      assert.equal(await vault.readForServer(keySecret, 'ssh_key'), KEY.privateKey);
      await assert.rejects(vault.readForServer(loginSecret, 'ssh_key'), /not of the kind/u);
      await assert.rejects(vault.readForServer(keySecret, 'ssh_password'), /not of the kind/u);
      await assert.rejects(
        vault.readForServer('0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b', 'ssh_password'),
        /no longer exists/u,
      );
      assert.equal(
        (await auditEvents(instance)).filter((e) => e.action === 'secret.revealed').length,
        0,
      );
    });
  });
});

describe('the address policy of a default installation', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let host: FakeHost;

  before(async () => {
    instance = await start({ SW_SSH_ALLOW_PRIVATE: 'false', SW_SSH_ALLOW_HOSTNAMES: 'false' });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    host = await FakeHost.start({ users: { root: { password: LOGIN } } });
  });
  after(async () => {
    await host.close();
    await stop(instance);
  });

  it('does not connect to the machine Swellwright runs on, unless it is told to', async () => {
    const created = await owner.post('/servers', {
      name: 'local',
      address: '127.0.0.1',
      sshPort: host.port,
    });
    const id = ServerViewSchema.parse(created.body).id;
    const keyReply = await owner.post(`/servers/${id}/host-keys`, {
      algorithm: 'ssh-ed25519',
      fingerprintSha256: host.fingerprint,
    });
    assert.equal(keyReply.status, 201);
    assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
    const secret = await owner.post('/secrets', {
      name: 'login',
      type: 'ssh_password',
      value: LOGIN,
    });
    const access = await owner.post(`/servers/${id}/access`, {
      method: 'password',
      username: 'root',
      secretId: SecretViewSchema.parse(secret.body).id,
    });
    const accessId = ServerAccessSchema.parse(access.body).id;
    for (const path of [
      `/servers/${id}/host-keys/scan`,
      `/servers/${id}/facts/refresh`,
      `/servers/${id}/access/${accessId}/verify`,
    ]) {
      const reply = await owner.post(path);
      assert.equal(reply.status, 409, path);
      assert.equal(errorOf(reply).code, 'address_not_allowed', path);
    }
    const accept = await owner.post(`/servers/${id}/host-keys/accept`, {
      fingerprintSha256: host.fingerprint,
    });
    assert.equal(errorOf(accept).code, 'address_not_allowed');
    assert.equal(host.server.connections, 0, 'refused before a socket was opened');
  });

  it('refuses private addresses and host names when the installation says so', async () => {
    for (const [name, address] of [
      ['private-a', '10.1.2.3'],
      ['private-b', '192.168.0.9'],
      ['named', 'node.example.com'],
    ] as const) {
      const created = await owner.post('/servers', { name, address });
      const id = ServerViewSchema.parse(created.body).id;
      const reply = await owner.post(`/servers/${id}/host-keys/scan`);
      assert.equal(reply.status, 409, address);
      assert.equal(errorOf(reply).code, 'address_not_allowed', address);
    }
  });
});

describe('the rate limit on SSH operations', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let operator: Client;
  let host: FakeHost;
  let serverId = '';

  before(async () => {
    instance = await start({ SW_SSH_ALLOW_LOOPBACK: 'true', SW_SSH_RATE_LIMIT_PER_MINUTE: '3' });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const ops = await createUser(instance, 'ops', 'operator');
    operator = await signInAs(instance, 'ops', ops.secret);
    host = await FakeHost.start({ users: { root: { password: LOGIN } } });
    const created = await owner.post('/servers', {
      name: 'limited',
      address: '127.0.0.1',
      sshPort: host.port,
    });
    serverId = ServerViewSchema.parse(created.body).id;
  });
  after(async () => {
    await host.close();
    await stop(instance);
  });

  it('lets a user start a few a minute, then says when to come back', async () => {
    for (let n = 0; n < 3; n += 1) {
      assert.equal(
        (await owner.post(`/servers/${serverId}/host-keys/scan`)).status,
        200,
        `scan ${String(n)}`,
      );
    }
    const connections = host.server.connections;
    const refused = await owner.post(`/servers/${serverId}/host-keys/scan`);
    assert.equal(refused.status, 429);
    assert.equal(errorCode(refused), 'rate_limited');
    assert.equal(refused.headers.get('retry-after'), '60');
    // Every kind counts towards the same limit.
    assert.equal((await owner.post(`/servers/${serverId}/facts/refresh`)).status, 429);
    assert.equal(host.server.connections, connections, 'a refused call opens no connection');
  });

  it('counts per user', async () => {
    assert.equal((await operator.post(`/servers/${serverId}/host-keys/scan`)).status, 200);
  });
});
