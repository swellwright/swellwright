import 'reflect-metadata';

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  ApiErrorSchema,
  ArtifactPushResultSchema,
  ArtifactVerificationSchema,
  type AuditEvent,
  SecretViewSchema,
  ServerArtifactListSchema,
  type ServerView,
  ServerViewSchema,
} from '@swellwright/contracts';

import {
  auditEvents,
  type Client,
  createOwner,
  createUser,
  databaseUrl,
  found,
  type Instance,
  type Reply,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { ArtifactHost, type ArtifactHostOptions } from './test-host.js';
import { sha256Hex, type TestCatalogue, testCatalogue } from './test-catalogue.js';

const PASSPHRASE = 'a long passphrase for the vault, used in tests';
const LOGIN = 'the-login-password-for-artifact-tests';
const SUDO = 'the-sudo-password-for-artifact-tests';
const WRONG = 'not-the-password-of-anybody-at-all';
const FP_OTHER = `SHA256:${'B'.repeat(42)}Q`;
const SCRIPT = '#!/bin/sh\necho "a demo artifact"\n';
const SHA = sha256Hex(SCRIPT);

const USER_ROOT = '/home/deploy/.swellwright/artifacts';
const USER_FILE = `${USER_ROOT}/demo/1.0.0/run.sh`;
const SYSTEM_FILE = '/var/lib/swellwright/artifacts/demo/1.0.0/run.sh';

const errorOf = (reply: Reply) => ApiErrorSchema.parse(reply.body).error;
const actions = (events: readonly AuditEvent[]): string[] => events.map((event) => event.action);

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 400; n += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('artifacts on servers', { skip: !databaseUrl }, () => {
  let catalogue: TestCatalogue;
  let instance: Instance;
  let owner: Client;
  let operator: Client;
  let observer: Client;
  let loginSecret = '';
  let sudoSecret = '';
  let wrongSudoSecret = '';
  const hosts: ArtifactHost[] = [];
  let seq = 0;

  const makeSecret = async (name: string, value: string): Promise<string> => {
    const reply = await owner.post('/secrets', { name, type: 'ssh_password', value });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body).id;
  };

  const startHost = async (options: ArtifactHostOptions): Promise<ArtifactHost> => {
    const host = await ArtifactHost.start(options);
    hosts.push(host);
    return host;
  };

  /** A host, a server that points at it with its key pinned, and one access entry for `deploy` or `root`. */
  const provision = async (
    host: ArtifactHost,
    options: { sudoSecretId?: string; username?: string; pinned?: string | false } = {},
  ): Promise<ServerView> => {
    seq += 1;
    const created = await owner.post('/servers', {
      name: `art-${String(seq)}`,
      address: '127.0.0.1',
      sshPort: host.port,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const server = ServerViewSchema.parse(created.body);
    if (options.pinned !== false) {
      const pinned = await owner.post(`/servers/${server.id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: options.pinned ?? host.fingerprint,
      });
      assert.ok(pinned.status === 200 || pinned.status === 201, JSON.stringify(pinned.body));
    }
    const access = await owner.post(`/servers/${server.id}/access`, {
      method: 'password',
      username: options.username ?? 'deploy',
      secretId: loginSecret,
      ...(options.sudoSecretId === undefined ? {} : { sudoSecretId: options.sudoSecretId }),
    });
    assert.equal(access.status, 201, JSON.stringify(access.body));
    return server;
  };

  const push = (
    client: Client,
    serverId: string,
    body: Record<string, unknown> = { name: 'demo' },
  ) => client.post(`/servers/${serverId}/artifacts`, body);
  const verify = (client: Client, serverId: string, query = '') =>
    client.post(`/servers/${serverId}/artifacts/demo/verify${query}`);
  const remove = (client: Client, serverId: string, version = '1.0.0') =>
    client.call('DELETE', `/servers/${serverId}/artifacts/demo/${version}`);
  const copies = async (serverId: string) =>
    ServerArtifactListSchema.parse((await owner.get(`/servers/${serverId}/artifacts`)).body)
      .artifacts;

  /** Every audit event about artifacts on one server, oldest first. */
  const trail = async (serverId: string): Promise<AuditEvent[]> =>
    (await auditEvents(instance)).filter(
      (event) =>
        event.action.startsWith('artifact.') &&
        event.object?.type === 'server' &&
        event.object.id === serverId,
    );

  before(async () => {
    catalogue = testCatalogue();
    catalogue.add('demo', SCRIPT);
    // The catalogue is read when the server starts, so every artifact a test needs is there before it.
    catalogue.add('victim', '#!/bin/sh\necho original\n');
    catalogue.add('short-lived', SCRIPT);
    catalogue.add('notes', 'plain notes\n', { interpreter: 'none', file: 'notes.txt' });
    instance = await start({
      SW_SSH_ALLOW_LOOPBACK: 'true',
      SW_SSH_CONNECT_TIMEOUT_SECONDS: '2',
      SW_SSH_COMMAND_TIMEOUT_SECONDS: '5',
      SW_SSH_RATE_LIMIT_PER_MINUTE: '600',
      SW_ARTIFACTS_DIR: catalogue.directory,
      SW_ARTIFACT_RATE_LIMIT_PER_MINUTE: '600',
    });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const ops = await createUser(instance, 'ops', 'operator');
    operator = await signInAs(instance, 'ops', ops.secret);
    const viewer = await createUser(instance, 'viewer', 'observer');
    observer = await signInAs(instance, 'viewer', viewer.secret);
    assert.equal((await owner.post('/vault/initialize', { passphrase: PASSPHRASE })).status, 201);
    loginSecret = await makeSecret('artifact login', LOGIN);
    sudoSecret = await makeSecret('artifact sudo', SUDO);
    wrongSudoSecret = await makeSecret('artifact wrong sudo', WRONG);
  });

  after(async () => {
    for (const host of hosts) {
      await host.close();
    }
    await stop(instance);
    catalogue.cleanup();
  });

  describe('a push to the home of the login', () => {
    it('hashes before and after, puts the file in place with the mode of a script, and records it', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);

      const reply = await push(owner, server.id);
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const pushed = ArtifactPushResultSchema.parse(reply.body);
      assert.equal(pushed.result, 'pushed');
      assert.equal(pushed.artifact.destination, 'user');
      assert.equal(pushed.artifact.remotePath, USER_FILE);
      assert.equal(pushed.artifact.sha256, SHA);
      assert.equal(pushed.artifact.pushedBy, 'owner');
      assert.equal(pushed.artifact.catalogue, 'ok');

      assert.deepEqual(host.read(USER_FILE), Buffer.from(SCRIPT));
      assert.equal(host.modes.get(USER_FILE), 0o755, 'a script is executable');
      assert.equal((host.modes.get(USER_FILE) ?? 0) & 0o022, 0, 'and nobody else may write it');

      // Who am I, sweep, the hash of the temporary file, the mode, the hash of the file in its place.
      assert.deepEqual(
        host.commands.map((seen) => seen.command.split(' ')[0]),
        ['id', 'rm', 'sha256sum', 'chmod', 'sha256sum'],
      );
      const [, , beforeRename, , inPlace] = host.commands;
      assert.match(beforeRename?.command ?? '', /\.swellwright-[0-9a-f]+\.part'$/u);
      assert.equal(inPlace?.command, `sha256sum -- '${USER_FILE}'`);
      assert.ok(
        host.commands.every((seen) => !seen.root),
        'nothing ran as root',
      );

      // Nothing else is left in the directory.
      assert.deepEqual(host.tree(`${USER_ROOT}/demo`), [
        '/home/deploy/.swellwright/artifacts/demo/1.0.0/',
        USER_FILE,
      ]);

      const [row, ...rest] = await copies(server.id);
      assert.equal(rest.length, 0);
      assert.equal(row?.verify?.state, 'ok');
      assert.equal(row.verify.remoteSha256, SHA);
      assert.equal(row.version, '1.0.0');

      const events = await trail(server.id);
      assert.deepEqual(actions(events), ['artifact.pushed']);
      const event = found(events[0], 'the record');
      assert.equal(event.outcome, 'success');
      assert.equal(event.actor?.name, 'owner');
      assert.deepEqual(event.details, {
        artifact: 'demo',
        version: '1.0.0',
        server_name: server.name,
        sha256_prefix: SHA.slice(0, 12),
        destination: 'user',
        result: 'pushed',
        remote_path: USER_FILE,
      });
    });

    it('does not upload again when the same file is already there, and says so', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);
      host.commands.length = 0;

      const again = await push(owner, server.id);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(ArtifactPushResultSchema.parse(again.body).result, 'unchanged');
      assert.deepEqual(
        host.commands.map((seen) => seen.command.split(' ')[0]),
        ['id', 'sha256sum'],
        'it only looked: who am I, and the hash of the file',
      );
      assert.equal((await copies(server.id)).length, 1, 'one record, not two');
      const events = await trail(server.id);
      assert.deepEqual(
        events.map((event) => event.details['result']),
        ['pushed', 'unchanged'],
      );
    });

    it('puts a file back that somebody changed, and says it was pushed', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);
      host.write(USER_FILE, 'something else entirely');

      const reply = await push(owner, server.id);
      assert.equal(reply.status, 201);
      assert.deepEqual(host.read(USER_FILE), Buffer.from(SCRIPT));
      assert.equal((await copies(server.id)).length, 1);
    });

    it('records a path longer than an audit detail may be, cut short, and keeps the whole path on the copy', async () => {
      const home = `/home/${'a-long-directory-name-'.repeat(8)}deploy`;
      const host = await startHost({ users: { deploy: { password: LOGIN } }, home });
      const server = await provision(host);
      const reply = await push(owner, server.id);
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const path = `${home}/.swellwright/artifacts/demo/1.0.0/run.sh`;
      assert.ok(path.length > 200);
      assert.equal(ArtifactPushResultSchema.parse(reply.body).artifact.remotePath, path);
      assert.deepEqual(host.read(path), Buffer.from(SCRIPT));
      const event = found((await trail(server.id))[0], 'the record');
      assert.equal(event.details['remote_path'], path.slice(0, 200));
    });

    it('takes the latest version when none is named, and refuses a version that does not exist', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      const missing = await push(owner, server.id, { name: 'demo', version: '9.9.9' });
      assert.equal(missing.status, 404);
      const unknown = await push(owner, server.id, { name: 'nothing-like-it' });
      assert.equal(unknown.status, 404);
      assert.equal(host.server.connections, 0, 'a refused request opens no connection');
    });
  });

  describe('a copy that does not arrive intact', () => {
    it('throws away an upload that arrived damaged, and leaves nothing behind', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      host.corruptUploads = true;

      const reply = await push(owner, server.id);
      assert.equal(reply.status, 502, JSON.stringify(reply.body));
      const error = errorOf(reply);
      assert.equal(error.code, 'artifact_hash_mismatch');
      const details = error.details as { expected: string; actual: string; stage: string };
      assert.equal(details.expected, SHA);
      assert.notEqual(details.actual, SHA);
      assert.equal(details.stage, 'upload');

      assert.equal(host.exists(USER_FILE), false, 'no file at the place of the file');
      assert.deepEqual(
        host.tree(`${USER_ROOT}/demo`).filter((path) => !path.endsWith('/')),
        [],
        'and no temporary file next to it',
      );
      assert.deepEqual(await copies(server.id), [], 'nothing was recorded');

      const event = found((await trail(server.id))[0], 'the record');
      assert.equal(event.outcome, 'failure');
      assert.equal(event.details['error_code'], 'artifact_hash_mismatch');
    });

    it('removes a file that is wrong in its place, and says so', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      host.corruptFinalOnce = true;

      const reply = await push(owner, server.id);
      assert.equal(reply.status, 502);
      assert.equal((errorOf(reply).details as { stage: string }).stage, 'final');
      assert.equal(host.exists(USER_FILE), false);
      assert.deepEqual(await copies(server.id), []);
    });

    it('leaves nothing at the place of the file when the connection is cut mid-upload, and cleans up next time', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      host.flags.sftpStallWrites = true;

      const inflight = push(owner, server.id);
      await waitFor(
        () => host.tree(`${USER_ROOT}/demo`).some((path) => path.endsWith('.part')),
        'the upload to start',
      );
      // A second push to the same server while one runs: refused, and the other server is not affected.
      const busy = await push(owner, server.id);
      assert.equal(busy.status, 409);
      assert.equal(errorOf(busy).code, 'artifact_busy');
      host.server.dropConnections();

      const cut = await inflight;
      assert.equal(cut.status, 502, JSON.stringify(cut.body));
      assert.equal(errorOf(cut).code, 'ssh_failed');
      assert.equal(host.exists(USER_FILE), false, 'the file in its place never appeared');
      assert.deepEqual(await copies(server.id), []);
      assert.ok(
        host.tree(`${USER_ROOT}/demo`).some((path) => path.endsWith('.part')),
        'the cut connection could not delete its temporary file',
      );

      // The next push sweeps what the cut one left, and succeeds.
      host.flags.sftpStallWrites = false;
      const retry = await push(owner, server.id);
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.deepEqual(
        host.tree(`${USER_ROOT}/demo`).filter((path) => !path.endsWith('/')),
        [USER_FILE],
      );
      const events = await trail(server.id);
      assert.deepEqual(
        events.map((event) => event.outcome),
        ['failure', 'success'],
      );
    });
  });

  describe('what stops a push before it starts', () => {
    it('refuses a host key that is not the pinned one, before any credential is sent', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host, { pinned: FP_OTHER });
      const reply = await push(owner, server.id);
      assert.equal(reply.status, 409);
      assert.equal(errorOf(reply).code, 'host_key_mismatch');
      assert.equal(host.server.authAttempts.length, 0, 'not one login was tried');
      assert.deepEqual(host.tree('/home/deploy'), []);
      const event = found((await trail(server.id))[0], 'the record');
      assert.equal(event.outcome, 'failure');
      assert.equal(event.details['error_code'], 'host_key_mismatch');
    });

    it('refuses to connect while no host key is pinned, and records nothing', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host, { pinned: false });
      const reply = await push(owner, server.id);
      assert.equal(reply.status, 409);
      assert.equal(errorOf(reply).code, 'host_key_not_pinned');
      assert.equal(host.server.connections, 0);
      assert.deepEqual(await trail(server.id), []);
    });

    it('wants an access entry', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      seq += 1;
      const created = await owner.post('/servers', {
        name: `art-${String(seq)}`,
        address: '127.0.0.1',
        sshPort: host.port,
      });
      const server = ServerViewSchema.parse(created.body);
      await owner.post(`/servers/${server.id}/host-keys`, {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: host.fingerprint,
      });
      const reply = await push(owner, server.id);
      assert.equal(reply.status, 409);
      assert.equal(errorOf(reply).code, 'no_access_entry');
    });

    it('answers 404 for a server that does not exist', async () => {
      const id = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
      assert.equal((await push(owner, id)).status, 404);
      assert.equal((await owner.get(`/servers/${id}/artifacts`)).status, 404);
      assert.equal((await verify(owner, id)).status, 404);
      assert.equal((await remove(owner, id)).status, 404);
    });

    it('refuses an artifact that is not what its manifest says, without connecting', async () => {
      const path = join(catalogue.directory, 'victim');
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      // Spoiled after the server started: the check on use finds it.
      // The same size as the original, so that only the hash can tell.
      writeFileSync(join(path, 'run.sh'), '#!/bin/sh\necho SPOILED!\n');

      const reply = await push(owner, server.id, { name: 'victim' });
      assert.equal(reply.status, 409, JSON.stringify(reply.body));
      assert.equal(errorOf(reply).code, 'artifact_broken');
      assert.equal(host.server.connections, 0, 'the spoiled file never went near a server');
      assert.deepEqual(await copies(server.id), []);

      const listed = await owner.get('/artifacts/victim');
      assert.equal(listed.status, 200);
      const view = listed.body as { versions: { state: string; problem: string }[] };
      assert.equal(view.versions[0]?.state, 'broken');
      assert.match(view.versions[0].problem, /SHA-256/u);

      const noted = (await auditEvents(instance)).filter(
        (event) => event.action === 'artifact.broken' && event.details['artifact'] === 'victim',
      );
      assert.equal(noted.length, 1, 'once, not once per request');
      assert.equal(noted[0]?.outcome, 'failure');
      assert.equal(noted[0].actor?.name, 'owner');

      // Put the original bytes back and it is whole again.
      writeFileSync(join(path, 'run.sh'), '#!/bin/sh\necho original\n');
      assert.equal((await push(owner, server.id, { name: 'victim' })).status, 201);
    });
  });

  describe('checking the copies', () => {
    it('finds a file that is ok, one that was changed, and one that is gone', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);

      const fine = await verify(owner, server.id);
      assert.equal(fine.status, 200, JSON.stringify(fine.body));
      const ok = ArtifactVerificationSchema.parse(fine.body);
      assert.equal(ok.ok, true);
      assert.deepEqual(ok.results, [
        {
          version: '1.0.0',
          state: 'ok',
          expectedSha256: SHA,
          actualSha256: SHA,
          catalogue: 'ok',
        },
      ]);

      host.write(USER_FILE, 'changed behind our back');
      const changed = ArtifactVerificationSchema.parse((await verify(owner, server.id)).body);
      assert.equal(changed.ok, false);
      assert.equal(changed.results[0]?.state, 'differs');
      assert.equal(changed.results[0].actualSha256, sha256Hex('changed behind our back'));
      assert.equal(changed.results[0].expectedSha256, SHA);
      const [afterChange] = await copies(server.id);
      assert.equal(afterChange?.verify?.state, 'differs');
      assert.equal(afterChange.verify.remoteSha256, sha256Hex('changed behind our back'));

      host.remove(USER_FILE);
      const gone = ArtifactVerificationSchema.parse((await verify(owner, server.id)).body);
      assert.equal(gone.ok, false);
      assert.equal(gone.results[0]?.state, 'missing');
      assert.equal(gone.results[0].actualSha256, null);
      const [afterLoss] = await copies(server.id);
      assert.equal(afterLoss?.verify?.state, 'missing');
      assert.equal(afterLoss.verify.remoteSha256, null);

      const events = await trail(server.id);
      assert.deepEqual(
        events.map((event) => [event.action, event.outcome, event.details['state'] ?? null]),
        [
          ['artifact.pushed', 'success', null],
          ['artifact.verified', 'success', 'ok'],
          ['artifact.verified', 'failure', 'differs'],
          ['artifact.verified', 'failure', 'missing'],
        ],
      );
    });

    it('checks only the version asked for, and says 404 for one that was never pushed', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);
      const one = ArtifactVerificationSchema.parse(
        (await verify(owner, server.id, '?version=1.0.0')).body,
      );
      assert.equal(one.results.length, 1);
      assert.equal((await verify(owner, server.id, '?version=2.0.0')).status, 404);
      assert.equal((await owner.post(`/servers/${server.id}/artifacts/other/verify`)).status, 404);
    });

    it('compares a copy of a version the catalogue lost with what was pushed', async () => {
      const path = join(catalogue.directory, 'short-lived');
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id, { name: 'short-lived' })).status, 201);
      writeFileSync(join(path, 'run.sh'), 'spoiled');
      assert.equal((await push(owner, server.id, { name: 'short-lived' })).status, 409);
      const result = ArtifactVerificationSchema.parse(
        (await owner.post(`/servers/${server.id}/artifacts/short-lived/verify`)).body,
      );
      // The catalogue's file is broken, so it cannot say what the copy must be: the pushed hash does.
      assert.equal(result.results[0]?.state, 'ok');
      assert.equal(result.results[0].catalogue, 'broken');
      assert.equal(result.results[0].expectedSha256, SHA);
    });
  });

  describe('removing a copy', () => {
    it('deletes the file and the directories it made, and forgets it', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);

      const reply = await remove(owner, server.id);
      assert.equal(reply.status, 204, JSON.stringify(reply.body));
      assert.equal(host.exists(USER_FILE), false);
      assert.equal(host.exists(`${USER_ROOT}/demo`), false, 'the empty directories went too');
      assert.deepEqual(await copies(server.id), []);
      assert.equal((await remove(owner, server.id)).status, 404, 'there is nothing left to remove');

      const events = await trail(server.id);
      assert.deepEqual(actions(events), ['artifact.pushed', 'artifact.removed']);
      assert.equal(events[1]?.details['remote_path'], USER_FILE);
    });

    it('does not mind a file that is gone already, and keeps a directory that holds something else', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);
      host.remove(USER_FILE);
      host.write(`${USER_ROOT}/demo/1.0.0/notes.txt`, 'a file of the person');
      assert.equal((await remove(owner, server.id)).status, 204);
      assert.equal(
        host.exists(`${USER_ROOT}/demo/1.0.0/notes.txt`),
        true,
        'what is not ours stays',
      );
    });

    it('refuses to delete a path that does not have the shape of a push', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);
      host.write('/home/deploy/precious', 'do not touch');
      // The record is edited: it now points outside the artifact directory.
      await instance.isolated.database.client.serverArtifact.updateMany({
        where: { serverId: server.id },
        data: { remotePath: '/home/deploy/precious' },
      });
      host.commands.length = 0;
      const reply = await remove(owner, server.id);
      assert.equal(reply.status, 409, JSON.stringify(reply.body));
      assert.equal(host.exists('/home/deploy/precious'), true);
      assert.equal(host.commands.length, 0, 'not one command was run');
      assert.equal((await verify(owner, server.id)).status, 409);
    });

    it('goes with the server when the server is deleted', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id)).status, 201);
      assert.equal((await owner.call('DELETE', `/servers/${server.id}`)).status, 204);
      assert.equal(
        await instance.isolated.database.client.serverArtifact.count({
          where: { serverId: server.id },
        }),
        0,
      );
    });
  });

  describe('the system directory', () => {
    it('is written as root through sudo, never by the login, and is owned by root', async () => {
      const host = await startHost({
        users: { deploy: { password: LOGIN } },
        sudo: { password: SUDO },
      });
      const server = await provision(host, { sudoSecretId: sudoSecret });

      const reply = await push(owner, server.id, { name: 'demo', destination: 'system' });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const pushed = ArtifactPushResultSchema.parse(reply.body);
      assert.equal(pushed.artifact.destination, 'system');
      assert.equal(pushed.artifact.remotePath, SYSTEM_FILE);

      assert.deepEqual(host.read(SYSTEM_FILE), Buffer.from(SCRIPT));
      assert.equal(host.modes.get(SYSTEM_FILE), 0o755);
      assert.equal(host.owners.get(SYSTEM_FILE), 'root');
      assert.equal(host.modes.get('/var/lib/swellwright/artifacts/demo/1.0.0'), 0o755);
      for (const path of host.tree('/var/lib/swellwright').filter((p) => !p.endsWith('/'))) {
        assert.equal(
          host.owners.get(path),
          'root',
          `${path} was put there by root, not by the login`,
        );
      }
      assert.ok(
        host.commands.some(
          (seen) =>
            seen.root && seen.command.startsWith('umask 022 && install -d -m 0755 -o root -g root'),
        ),
        'the directory is made by root with a mode nobody can write',
      );
      assert.deepEqual(
        host.tree('/home/deploy/.swellwright/incoming'),
        [],
        'the staged copy was removed',
      );

      // A copy cannot be at both destinations.
      const conflict = await push(owner, server.id, { name: 'demo', destination: 'user' });
      assert.equal(conflict.status, 409);
      assert.equal(errorOf(conflict).code, 'artifact_destination_conflict');
      const again = await push(owner, server.id, { name: 'demo', destination: 'system' });
      assert.equal(again.status, 200);
      assert.equal(ArtifactPushResultSchema.parse(again.body).result, 'unchanged');

      const checked = ArtifactVerificationSchema.parse((await verify(owner, server.id)).body);
      assert.equal(checked.ok, true);

      assert.equal((await remove(owner, server.id)).status, 204);
      assert.equal(host.exists(SYSTEM_FILE), false);
      assert.equal(host.exists('/var/lib/swellwright/artifacts/demo'), false);
      assert.deepEqual(await copies(server.id), []);

      const everything = JSON.stringify(await auditEvents(instance));
      for (const secret of [LOGIN, SUDO, WRONG]) {
        assert.ok(!everything.includes(secret), 'no password is in the audit log');
      }
    });

    // The step layer creates /var/lib/swellwright as 0700 when it runs as root, so a login that is not root cannot even
    // look at the system artifact directory over SFTP. Found on a real server: the push failed with "stat failed:
    // Permission denied" before one byte was sent. Everything about a system copy is asked as root now, and the
    // directory is opened for everybody, as the decision says.
    it('works when only root can enter the parent directory, and opens it for everybody', async () => {
      const host = await startHost({
        users: { deploy: { password: LOGIN } },
        sudo: { password: SUDO },
      });
      host.write('/var/lib/swellwright/steps/earlier-step/out', 'left by the step layer');
      host.modes.set('/var/lib/swellwright', 0o700);
      host.flags.systemDirPrivate = true;
      const server = await provision(host, { sudoSecretId: sudoSecret });

      const reply = await push(owner, server.id, { name: 'demo', destination: 'system' });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.equal(ArtifactPushResultSchema.parse(reply.body).result, 'pushed');
      assert.deepEqual(host.read(SYSTEM_FILE), Buffer.from(SCRIPT));
      assert.equal(host.modes.get('/var/lib/swellwright'), 0o755, 'the parent is opened');
      assert.equal(host.owners.get('/var/lib/swellwright'), 'root');
      assert.equal(
        host.exists('/var/lib/swellwright/steps/earlier-step/out'),
        true,
        'nothing else',
      );

      const again = await push(owner, server.id, { name: 'demo', destination: 'system' });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(ArtifactPushResultSchema.parse(again.body).result, 'unchanged');
      assert.equal(
        ArtifactVerificationSchema.parse((await verify(owner, server.id)).body).ok,
        true,
      );

      // Behind our back the file is changed, and the check says so (as root: the login could not look).
      host.write(SYSTEM_FILE, 'something else');
      const drifted = ArtifactVerificationSchema.parse((await verify(owner, server.id)).body);
      assert.equal(drifted.ok, false);
      assert.equal(drifted.results[0]?.state, 'differs');
      host.remove(SYSTEM_FILE);
      assert.equal(
        ArtifactVerificationSchema.parse((await verify(owner, server.id)).body).results[0]?.state,
        'missing',
      );
      assert.equal(
        (await push(owner, server.id, { name: 'demo', destination: 'system' })).status,
        201,
      );
      assert.equal((await remove(owner, server.id)).status, 204);
      assert.equal(host.exists(SYSTEM_FILE), false);
    });

    it('checks a copy as the login when sudo does not work, as it did before', async () => {
      const host = await startHost({
        users: { deploy: { password: LOGIN } },
        sudo: { password: SUDO },
      });
      const server = await provision(host, { sudoSecretId: sudoSecret });
      assert.equal(
        (await push(owner, server.id, { name: 'demo', destination: 'system' })).status,
        201,
      );
      // The stored sudo password stops being right: a push needs root, a check can still look.
      await instance.isolated.database.client.serverAccess.updateMany({
        where: { serverId: server.id },
        data: { sudoSecretId: wrongSudoSecret },
      });
      const checked = ArtifactVerificationSchema.parse((await verify(owner, server.id)).body);
      assert.equal(checked.ok, true);
      assert.equal(checked.results[0]?.state, 'ok');
    });

    it('says sudo is not available, and touches nothing, when the login cannot become root', async () => {
      const none = await startHost({ users: { deploy: { password: LOGIN } }, sudo: 'none' });
      const server = await provision(none, { sudoSecretId: sudoSecret });
      const reply = await push(owner, server.id, { name: 'demo', destination: 'system' });
      assert.equal(reply.status, 409, JSON.stringify(reply.body));
      assert.equal(errorOf(reply).code, 'sudo_unavailable');
      assert.deepEqual(none.tree('/var/lib'), []);
      assert.deepEqual(none.tree('/home/deploy'), [], 'not even a staged copy');
      const event = found((await trail(server.id))[0], 'the record');
      assert.equal(event.outcome, 'failure');
      assert.equal(event.details['error_code'], 'sudo_unavailable');

      const wrong = await startHost({
        users: { deploy: { password: LOGIN } },
        sudo: { password: SUDO },
      });
      const other = await provision(wrong, { sudoSecretId: wrongSudoSecret });
      const refused = await push(owner, other.id, { name: 'demo', destination: 'system' });
      assert.equal(refused.status, 409);
      assert.equal(errorOf(refused).code, 'sudo_unavailable');
      assert.deepEqual(wrong.tree('/var/lib'), []);
    });

    it('needs no sudo for root, which writes the system directory directly', async () => {
      const host = await startHost({ users: { root: { password: LOGIN } }, uid: 0 });
      const server = await provision(host, { username: 'root' });
      const reply = await push(owner, server.id, { name: 'demo', destination: 'system' });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.equal(host.owners.get(SYSTEM_FILE), 'root');
      assert.equal(host.modes.get(SYSTEM_FILE), 0o755);
      assert.ok(host.commands.every((seen) => seen.root));
    });
  });

  describe('a file that is not a script', () => {
    it('is not made executable', async () => {
      const host = await startHost({ users: { deploy: { password: LOGIN } } });
      const server = await provision(host);
      assert.equal((await push(owner, server.id, { name: 'notes' })).status, 201);
      assert.equal(host.modes.get(`${USER_ROOT}/notes/1.0.0/notes.txt`), 0o644);
    });
  });

  describe('who may do what', () => {
    let host: ArtifactHost;
    let server: ServerView;

    before(async () => {
      host = await startHost({ users: { deploy: { password: LOGIN } } });
      server = await provision(host);
    });

    const writes = (): [string, string, unknown?][] => [
      ['POST', `/servers/${server.id}/artifacts`, { name: 'demo' }],
      ['POST', `/servers/${server.id}/artifacts/demo/verify`],
      ['DELETE', `/servers/${server.id}/artifacts/demo/1.0.0`],
    ];
    const reads = (): [string, string][] => [
      ['GET', '/artifacts'],
      ['GET', '/artifacts/demo'],
      ['GET', '/artifacts/demo/versions/1.0.0'],
      ['GET', `/servers/${server.id}/artifacts`],
    ];

    it('answers 401 to everything without a session, and connects to nothing', async () => {
      const anonymous = instance.client();
      for (const [method, path, body] of [...writes(), ...reads()]) {
        assert.equal((await anonymous.call(method, path, body)).status, 401, `${method} ${path}`);
      }
      assert.equal(host.server.connections, 0);
    });

    it('lets an observer read the catalogue and the copies, and change nothing', async () => {
      for (const [method, path] of reads()) {
        assert.equal((await observer.call(method, path)).status, 200, `${method} ${path}`);
      }
      for (const [method, path, body] of writes()) {
        const reply = await observer.call(method, path, body);
        assert.equal(reply.status, 403, `${method} ${path}`);
        assert.equal(errorOf(reply).code, 'forbidden');
      }
      assert.equal(host.server.connections, 0, 'a role that only reads never causes a connection');
    });

    it('lets an operator push, check and remove', async () => {
      assert.equal((await push(operator, server.id)).status, 201);
      assert.equal((await verify(operator, server.id)).status, 200);
      assert.equal((await remove(operator, server.id)).status, 204);
      const events = await trail(server.id);
      assert.deepEqual(
        events.map((event) => event.actor?.name),
        ['ops', 'ops', 'ops'],
      );
    });

    it('asks an operator for a fresh code to push or remove, and connects to nothing without it', async () => {
      // The sign-in elevated the session; let that lapse as if the five minutes had run out.
      await instance.isolated.database.client.session.updateMany({
        data: { elevatedUntil: new Date(Date.now() - 1000) },
      });
      const before = host.server.connections;
      for (const reply of [await push(operator, server.id), await remove(operator, server.id)]) {
        assert.equal(reply.status, 403);
        assert.equal(errorOf(reply).code, 'step_up_required');
      }
      // Checking a copy only reads: it needs no code.
      assert.notEqual((await verify(operator, server.id)).status, 403);
      assert.equal(host.server.connections, before, 'a refused push or removal never connects');
    });
  });
});

describe('the rate limit on artifact operations', { skip: !databaseUrl }, () => {
  let catalogue: TestCatalogue;
  let instance: Instance;
  let owner: Client;
  let operator: Client;
  let serverId = '';

  before(async () => {
    catalogue = testCatalogue();
    catalogue.add('demo', SCRIPT);
    instance = await start({
      SW_ARTIFACTS_DIR: catalogue.directory,
      SW_ARTIFACT_RATE_LIMIT_PER_MINUTE: '2',
    });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
    const ops = await createUser(instance, 'ops', 'operator');
    operator = await signInAs(instance, 'ops', ops.secret);
    const created = await owner.post('/servers', { name: 'limited', address: '127.0.0.1' });
    serverId = ServerViewSchema.parse(created.body).id;
  });
  after(async () => {
    await stop(instance);
    catalogue.cleanup();
  });

  it('lets a user start a few a minute, then says when to come back', async () => {
    for (let n = 0; n < 2; n += 1) {
      assert.equal(
        (await owner.post(`/servers/${serverId}/artifacts/demo/verify`)).status,
        404,
        `call ${String(n)} got as far as looking for the copy`,
      );
    }
    const refused = await owner.post(`/servers/${serverId}/artifacts`, { name: 'demo' });
    assert.equal(refused.status, 429);
    assert.equal(errorOf(refused).code, 'rate_limited');
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.equal(
      (await owner.call('DELETE', `/servers/${serverId}/artifacts/demo/1.0.0`)).status,
      429,
    );
  });

  it('counts per user', async () => {
    assert.equal((await operator.post(`/servers/${serverId}/artifacts/demo/verify`)).status, 404);
  });
});
