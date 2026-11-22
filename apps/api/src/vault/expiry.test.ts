import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import {
  ApiErrorSchema,
  RevealedSecretSchema,
  SecretListSchema,
  SecretViewSchema,
  ServerAccessSchema,
  ServerViewSchema,
  type SecretView,
} from '@swellwright/contracts';
import { ConfigSchemaFileSchema } from '@swellwright/plugin-api';

import { ArtifactHost } from '../artifacts/test-host.js';
import { testCatalogue, type TestCatalogue } from '../artifacts/test-catalogue.js';
import {
  createGate,
  Harness,
  LOGIN,
  PASSPHRASE,
  standardPrograms,
  targetOf,
} from '../commands/commands-test-support.js';
import { PluginBroker, PluginBrokerError } from '../plugins/broker.js';
import { FakeHost } from '../servers/ssh-test-support.js';
import { SshService } from '../servers/ssh.service.js';
import { auditEvents, databaseUrl, errorCode, type Reply } from '../test-support.js';
import { expiryView, isExpired } from './expiry.js';
import { VaultService } from './vault.service.js';

const DAY = 86_400_000;
const T0 = Date.parse('2031-03-01T12:00:00.000Z');
const at = (ms: number): string => new Date(ms).toISOString();

describe('the rule of expiry', () => {
  it('counts the moment of the expiry itself as expired, and nothing before it', () => {
    const now = T0;
    assert.equal(isExpired(null, now), false, 'no expiry never expires');
    assert.equal(isExpired(new Date(now + 1), now), false);
    assert.equal(isExpired(new Date(now), now), true, 'exactly now is expired');
    assert.equal(isExpired(new Date(now - 1), now), true);
  });

  it('says the whole days that are left, rounded up, and 0 or less once it has passed', () => {
    const view = (offsetMs: number | null) =>
      expiryView(offsetMs === null ? null : new Date(T0 + offsetMs), T0);
    assert.deepEqual(view(null), { expired: false, expiresInDays: null });
    assert.deepEqual(view(1), { expired: false, expiresInDays: 1 });
    assert.deepEqual(view(DAY), { expired: false, expiresInDays: 1 });
    assert.deepEqual(view(DAY + 1), { expired: false, expiresInDays: 2 });
    assert.deepEqual(view(13 * DAY + 5000), { expired: false, expiresInDays: 14 });
    assert.deepEqual(view(0), { expired: true, expiresInDays: 0 });
    assert.deepEqual(view(-1), { expired: true, expiresInDays: 0 });
    assert.deepEqual(view(-2 * DAY), { expired: true, expiresInDays: -2 });
    assert.ok(!Object.is(view(-1).expiresInDays, -0), 'not minus zero');
  });
});

/** What a logger that is handed to the application collects, so that the test can search it. */
class CapturingLogger {
  readonly lines: string[] = [];
  log(...parts: unknown[]): void {
    this.lines.push(parts.map(String).join(' '));
  }
  error(...parts: unknown[]): void {
    this.lines.push(parts.map(String).join(' '));
  }
  warn(...parts: unknown[]): void {
    this.lines.push(parts.map(String).join(' '));
  }
  debug(...parts: unknown[]): void {
    this.lines.push(parts.map(String).join(' '));
  }
  verbose(...parts: unknown[]): void {
    this.lines.push(parts.map(String).join(' '));
  }
}

const errorOf = (reply: Reply) => ApiErrorSchema.parse(reply.body).error;

describe('an expired secret is refused by everything that uses it', { skip: !databaseUrl }, () => {
  let nowMs = T0;
  const h = new Harness();
  const logger = new CapturingLogger();
  /** Everything a test said to the API or heard from it, to be searched for values at the end. */
  const heard: string[] = [];
  const catalogue: TestCatalogue = testCatalogue();
  const VALUES = {
    login: LOGIN,
    artifact: 'the-login-password-for-expiry-artifact-tests',
    plugin: 'the-oauth-secret-value-for-expiry-tests-77aa',
    throttle: 'the-throttle-secret-value-for-expiry-tests',
    sshLogin: 'the-login-password-for-expiry-ssh-tests',
  };

  const owner = () => h.owner;
  const setClock = (ms: number): void => {
    nowMs = ms;
  };

  const make = async (
    name: string,
    type: string,
    value: string,
    expiresAt?: string,
  ): Promise<SecretView> => {
    const reply = await owner().post('/secrets', {
      name,
      type,
      value,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    heard.push(JSON.stringify(reply.body));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body);
  };

  const renew = async (id: string, expiresAt: string | null): Promise<SecretView> => {
    const reply = await owner().call('PATCH', `/secrets/${id}`, { expiresAt });
    heard.push(JSON.stringify(reply.body));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return SecretViewSchema.parse(reply.body);
  };

  /** A server in the inventory that points at an in-process host, with its key pinned and one login. */
  const provision = async (
    name: string,
    where: { port: number; fingerprint: string },
    username: string,
    secretId: string,
  ): Promise<{ serverId: string; accessId: string }> => {
    const created = await owner().post('/servers', {
      name,
      address: '127.0.0.1',
      sshPort: where.port,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const serverId = ServerViewSchema.parse(created.body).id;
    const pinned = await owner().post(`/servers/${serverId}/host-keys`, {
      algorithm: 'ssh-ed25519',
      fingerprintSha256: where.fingerprint,
    });
    assert.ok(pinned.status === 200 || pinned.status === 201, JSON.stringify(pinned.body));
    const access = await addAccess(serverId, username, secretId);
    return { serverId, accessId: access };
  };

  const addAccess = async (
    serverId: string,
    username: string,
    secretId: string,
    priority?: number,
  ): Promise<string> => {
    const reply = await owner().post(`/servers/${serverId}/access`, {
      method: 'password',
      username,
      secretId,
      ...(priority === undefined ? {} : { priority }),
    });
    heard.push(JSON.stringify(reply.body));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return ServerAccessSchema.parse(reply.body).id;
  };

  const refusals = async (secretId: string) =>
    (await auditEvents(h.instance)).filter(
      (event) => event.action === 'secret.use_refused' && event.object?.id === secretId,
    );

  before(async () => {
    catalogue.add('demo', '#!/bin/sh\necho "a demo artifact"\n');
    await h.open(
      {
        SW_ARTIFACTS_DIR: catalogue.directory,
        SW_ARTIFACT_RATE_LIMIT_PER_MINUTE: '600',
      },
      { clock: () => nowMs },
    );
    Logger.overrideLogger(logger);
  });
  after(async () => {
    await h.close();
    catalogue.cleanup();
  });

  describe('what people see', () => {
    it('shows `expired` and the days left on every secret, by the server clock', async () => {
      const none = await make('view none', 'generic', 'view-value-none');
      const later = await make('view later', 'generic', 'view-value-later', at(T0 + 3 * DAY));
      const edge = await make('view edge', 'generic', 'view-value-edge', at(T0));
      const past = await make('view past', 'generic', 'view-value-past', at(T0 - 2 * DAY));
      assert.deepEqual(
        [none, later, edge, past].map((s) => [s.expired, s.expiresInDays]),
        [
          [false, null],
          [false, 3],
          [true, 0],
          [true, -2],
        ],
      );
      const list = SecretListSchema.parse((await owner().get('/secrets')).body).secrets;
      const byName = (name: string) => list.find((s) => s.name === name);
      assert.equal(byName('view edge')?.expired, true);
      assert.equal(byName('view later')?.expiresInDays, 3);

      // Time passes: the same secret, a minute before and at its expiry.
      setClock(T0 + 3 * DAY - 1);
      const before = SecretListSchema.parse((await owner().get('/secrets')).body).secrets;
      assert.equal(before.find((s) => s.name === 'view later')?.expired, false);
      setClock(T0 + 3 * DAY);
      const exact = SecretListSchema.parse((await owner().get('/secrets')).body).secrets;
      assert.equal(exact.find((s) => s.name === 'view later')?.expired, true);
      setClock(T0);
    });

    it('shows the state of the secrets an access entry names, with the entry', async () => {
      const host = await FakeHost.start({ users: { root: { password: VALUES.sshLogin } } });
      try {
        const soon = await make('entry soon', 'ssh_password', VALUES.sshLogin, at(T0 + 5 * DAY));
        const gone = await make('entry gone', 'ssh_password', 'x-entry-gone', at(T0 - DAY));
        const { serverId } = await provision('view-entries', host, 'root', soon.id);
        await addAccess(serverId, 'root', gone.id, 7);
        const reply = await owner().get(`/servers/${serverId}`);
        heard.push(JSON.stringify(reply.body));
        const server = ServerViewSchema.parse(reply.body);
        const [first, second] = server.access;
        assert.equal(first?.secret.expired, false);
        assert.equal(first.secret.expiresInDays, 5);
        assert.equal(second?.secret.expired, true);
        assert.equal(second.secret.expiresInDays, -1);
        assert.equal(second.secret.expiresAt, at(T0 - DAY));
      } finally {
        await host.close();
      }
    });
  });

  describe('a person may still read an expired secret, and renew it', () => {
    it('reveals it with `expired: true`, and the value of one that has not expired with `false`', async () => {
      const gone = await make('reveal gone', 'generic', 'reveal-gone-value', at(T0 - DAY));
      const live = await make('reveal live', 'generic', 'reveal-live-value', at(T0 + DAY));
      const a = await owner().post(`/secrets/${gone.id}/reveal`);
      const b = await owner().post(`/secrets/${live.id}/reveal`);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.deepEqual(
        [RevealedSecretSchema.parse(a.body).expired, RevealedSecretSchema.parse(a.body).value],
        [true, 'reveal-gone-value'],
      );
      assert.equal(RevealedSecretSchema.parse(b.body).expired, false);
    });

    it('renews by moving the expiry, replaces the value, and keeps the secret', async () => {
      const gone = await make('renew gone', 'generic', 'renew-old-value', at(T0 - DAY));
      assert.equal(gone.expired, true);
      const renewed = await renew(gone.id, at(T0 + 30 * DAY));
      assert.deepEqual([renewed.expired, renewed.expiresInDays], [false, 30]);
      const dropped = await renew(gone.id, null);
      assert.deepEqual([dropped.expired, dropped.expiresInDays], [false, null]);
      const replaced = await owner().call('PATCH', `/secrets/${gone.id}`, {
        value: 'renew-new-value',
        expiresAt: at(T0 + DAY),
      });
      assert.equal(SecretViewSchema.parse(replaced.body).version, 2);
    });
  });

  describe('servers', () => {
    it('refuses the check of an access entry whose secret expired, before a credential is sent, and works again once renewed', async () => {
      const host = await FakeHost.start({ users: { root: { password: VALUES.sshLogin } } });
      try {
        const expiresAt = T0 + 60 * 60_000;
        const secret = await make('verify login', 'ssh_password', VALUES.sshLogin, at(expiresAt));
        const { serverId, accessId } = await provision('verify-1', host, 'root', secret.id);
        const verify = () => owner().post(`/servers/${serverId}/access/${accessId}/verify`);

        const ok = await verify();
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((ok.body as { ok: boolean }).ok, true);
        const attempts = host.server.authAttempts.length;
        assert.ok(attempts > 0);

        setClock(expiresAt - 1);
        assert.equal((await verify()).status, 200, 'a millisecond before the expiry it works');

        // The pool may keep the connection of the checks above; the refusal must not need it, so end it first.
        h.instance.app.get(SshService).closeConnections();
        const seen = host.server.authAttempts.length;
        setClock(expiresAt);
        const refused = await verify();
        heard.push(JSON.stringify(refused.body));
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(errorCode(refused), 'secret_expired');
        assert.deepEqual(errorOf(refused).details, {
          secretId: secret.id,
          secretName: 'verify login',
          expiresAt: at(expiresAt),
        });
        assert.match(errorOf(refused).message, /Renew its expiry or replace the secret/u);
        assert.equal(
          host.server.authAttempts.length,
          seen,
          'the server saw no attempt at all: nothing was sent with the expired secret',
        );

        // The vault being sealed is the first answer: nothing is decided about a secret that cannot be read.
        assert.equal((await owner().post('/vault/seal')).status, 200);
        const sealed = await verify();
        assert.equal(sealed.status, 423);
        assert.equal(errorCode(sealed), 'vault_sealed');
        const unsealed = await owner().post('/vault/unseal', { passphrase: PASSPHRASE });
        assert.equal(unsealed.status, 200);
        assert.equal(errorCode(await verify()), 'secret_expired');

        await renew(secret.id, at(expiresAt + DAY));
        const again = await verify();
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal((again.body as { ok: boolean }).ok, true);

        setClock(expiresAt + DAY);
        assert.equal(errorCode(await verify()), 'secret_expired', 'and it can expire again');
      } finally {
        setClock(T0);
        await host.close();
      }
    });

    it('collects facts with the next entry when the first one is expired, and refuses when all are', async () => {
      const host = await FakeHost.start({ users: { root: { password: VALUES.sshLogin } } });
      try {
        const old = await make('facts old', 'ssh_password', 'a-password-that-is-old', at(T0 - DAY));
        const good = await make('facts good', 'ssh_password', VALUES.sshLogin, at(T0 + DAY));
        const { serverId } = await provision('facts-1', host, 'root', old.id);
        await addAccess(serverId, 'root', good.id, 9);
        const refresh = () => owner().post(`/servers/${serverId}/facts/refresh`);

        const worked = await refresh();
        assert.equal(worked.status, 200, JSON.stringify(worked.body));
        assert.equal(host.factsRuns.length, 1);

        const doomed = await provision('facts-2', host, 'root', old.id);
        const refused = await owner().post(`/servers/${doomed.serverId}/facts/refresh`);
        heard.push(JSON.stringify(refused.body));
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(errorCode(refused), 'secret_expired');
        assert.equal(host.factsRuns.length, 1, 'the script did not run');
        // Nothing was attempted, so the refresh is not recorded as a failure of the server.
        const failed = (await auditEvents(h.instance)).filter(
          (e) =>
            e.action === 'server.facts.refreshed' &&
            e.outcome === 'failure' &&
            e.object?.id === doomed.serverId,
        );
        assert.equal(failed.length, 0);
      } finally {
        await host.close();
      }
    });

    it('refuses to push an artifact, and pushes it once the secret is renewed', async () => {
      const host = await ArtifactHost.start({ users: { deploy: { password: VALUES.artifact } } });
      try {
        const secret = await make('artifact login', 'ssh_password', VALUES.artifact, at(T0 - 1));
        const { serverId } = await provision('artifact-1', host, 'deploy', secret.id);
        const push = () => owner().post(`/servers/${serverId}/artifacts`, { name: 'demo' });
        const refused = await push();
        heard.push(JSON.stringify(refused.body));
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(errorCode(refused), 'secret_expired');
        assert.equal(host.server.authAttempts.length, 0, 'nothing reached the server');
        assert.equal(host.commands.length, 0);

        await renew(secret.id, at(T0 + DAY));
        const pushed = await push();
        assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
      } finally {
        await host.close();
      }
    });
  });

  describe('runs', () => {
    it('ends the target of a server whose secret expired with `secret_expired`, and runs the others', async () => {
      const host = await h.host(standardPrograms());
      const good = await h.server(host);
      const expired = await make('run login', 'ssh_password', LOGIN, at(T0 - DAY));
      const bad = await h.server(host, { password: expired.id });
      const run = await h.createRun(h.operator, h.inline([good, bad], '# fake:hello\n'));
      const done = await h.finished(run.id);
      assert.equal(done.state, 'partial');
      assert.equal(targetOf(done, 0).state, 'succeeded');
      const refused = targetOf(done, 1);
      assert.equal(refused.state, 'failed');
      assert.equal(refused.errorCode, 'secret_expired');
      assert.match(refused.errorMessage ?? '', /"run login"/u);
      assert.equal(refused.stdout.storedBytes, 0);
      assert.equal(host.launches.created, 1, 'nothing was started on the server of the refused one');
      heard.push(JSON.stringify(done));
    });

    it('uses the next access entry of a server when the first one is expired', async () => {
      const host = await h.host(standardPrograms());
      const id = await h.server(host, { access: false });
      const old = await make('run old', 'ssh_password', 'not-the-password', at(T0 - DAY));
      await addAccess(id, 'runner', old.id, 1);
      await addAccess(id, 'runner', h.secrets.login, 2);
      const run = await h.createRun(h.operator, h.inline([id], '# fake:hello\n'));
      const done = await h.finished(run.id);
      assert.equal(done.state, 'succeeded');
      assert.equal(targetOf(done).stdout.tail, 'hello\n');
    });

    it('does not stop a script that has started when the secret expires while it runs', async () => {
      const gate = createGate();
      const host = await h.host(standardPrograms({ gate }));
      const soon = await make('run soon', 'ssh_password', LOGIN, at(T0 + 10 * 60_000));
      const id = await h.server(host, { password: soon.id });
      const run = await h.createRun(h.operator, h.inline([id], '# fake:gate\n'));
      await h.waitFor(run.id, 'the first output', (r) => targetOf(r).stdout.storedBytes > 0);

      setClock(T0 + 11 * 60_000);
      gate.open();
      const done = await h.finished(run.id);
      assert.equal(done.state, 'succeeded', JSON.stringify(done.targets));
      assert.equal(targetOf(done).stdout.tail, 'waiting\nreleased\n', 'the output is complete');
      assert.equal(targetOf(done).errorCode, null);
      assert.equal(host.removed.length, 1, 'and its record was tidied away');
      setClock(T0);
    });
  });

  describe('plugins', () => {
    it('refuses an expired secret with its own code, and gives it again once renewed', async () => {
      const schema = ConfigSchemaFileSchema.parse({
        type: 'object',
        properties: { credentials: { type: 'string', 'x-sw-secret': 'dns-oauth' } },
        required: ['credentials'],
        additionalProperties: false,
      });
      const secret = await make('plugin oauth', 'dns_oauth', VALUES.plugin, at(T0 - 1));
      await h.instance.isolated.database.client.pluginConfig.create({
        data: {
          pluginId: 'expiry-plugin',
          settings: JSON.stringify({ credentials: secret.id }),
          updatedBy: 'owner',
        },
      });
      const broker = h.instance.app.get(PluginBroker);
      const context = { id: 'expiry-plugin', schema, secretKinds: ['dns-oauth'] };
      await assert.rejects(broker.secret(context, 'credentials'), (error: unknown) => {
        assert.ok(error instanceof PluginBrokerError);
        assert.equal(error.code, 'secret_expired');
        assert.match(error.message, /^secret_expired: /u);
        assert.ok(!error.message.includes(VALUES.plugin));
        return true;
      });
      await renew(secret.id, at(T0 + DAY));
      assert.equal(await broker.secret(context, 'credentials'), VALUES.plugin);
    });
  });

  describe('the record of a refusal', () => {
    it('is written once per secret in ten minutes, however often it is refused, and says who asked', async () => {
      const vault = h.instance.app.get(VaultService);
      const secret = await make('throttled', 'ssh_password', VALUES.throttle, at(T0 - DAY));
      const consumer = { kind: 'server_access', id: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c' } as const;
      const refuse = () =>
        assert.rejects(vault.readForServer(secret.id, 'ssh_password', consumer), /expired/u);

      for (let n = 0; n < 5; n += 1) {
        await refuse();
      }
      assert.equal((await refusals(secret.id)).length, 1, 'five refusals, one record');
      setClock(T0 + 9 * 60_000);
      await refuse();
      assert.equal((await refusals(secret.id)).length, 1, 'nine minutes later: still one');
      setClock(T0 + 10 * 60_000);
      await refuse();
      const records = await refusals(secret.id);
      assert.equal(records.length, 2, 'ten minutes later: a second one');
      const [first] = records;
      assert.equal(first?.outcome, 'denied');
      assert.equal(first.actor, null);
      assert.deepEqual(first.details, {
        reason: 'expired',
        secret_type: 'ssh_password',
        consumer: 'server_access',
        consumer_id: consumer.id,
      });
      setClock(T0);
    });
  });

  it('never puts a value in a response, in the audit log or in a log line', async () => {
    const everything = [
      ...heard,
      JSON.stringify(await auditEvents(h.instance)),
      logger.lines.join('\n'),
    ].join('\n');
    for (const [name, value] of Object.entries(VALUES)) {
      assert.ok(!everything.includes(value), `the value of "${name}" is somewhere it must not be`);
    }
    for (const value of ['renew-old-value', 'renew-new-value', 'a-password-that-is-old']) {
      assert.ok(!everything.includes(value), `${value} is somewhere it must not be`);
    }
  });
});
