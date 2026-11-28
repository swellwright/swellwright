import 'reflect-metadata';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { PluginListSchema, SecretViewSchema, PluginViewSchema } from '@swellwright/contracts';

import {
  auditEvents,
  type Client,
  createOwner,
  databaseUrl,
  found,
  type Instance,
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { discoverPlugins } from './discovery.js';
import { readDriver } from './driver-file.js';
import { PluginNetwork, type TransportRequest } from './host/network.js';
import { PluginHostService } from './host/plugin-host.service.js';
import { PluginCallError } from './host/process.js';

const OFFICIAL = fileURLToPath(new URL('../../../../plugins/official', import.meta.url));
const PUBLIC = [{ address: [93, 184, 216, 34].join('.'), family: 4 as const }];

const GOOD = `
version: 1
kind: NotificationChannel
operations:
  send:
    params:
      text: { type: string, required: true }
    steps:
      - id: call
        request:
          method: POST
          url: https://hooks.example.com/{{ config.path }}
          body: { text: "{{ params.text }}" }
`;

describe('reading a driver file', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'sw-driver-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const read = async (text: string) => {
    const name = `d-${String(Math.random()).slice(2)}.yaml`;
    await writeFile(join(root, name), text);
    return readDriver(root, name, 'driver.yaml');
  };

  it('reads a sound driver', async () => {
    const { driver, problems } = await read(GOOD);
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(driver?.operations ?? {}), ['send']);
  });

  it('refuses YAML that is broken, uses aliases or repeats a key, and says so', async () => {
    assert.match((await read('version: [1')).problems.join(), /not valid YAML/u);
    const aliased = await read(
      'version: 1\nkind: &k NotificationChannel\nalso: *k\noperations: {}\n',
    );
    assert.match(aliased.problems.join(), /not valid YAML/u);
    const bomb = await read(
      'a: &a [x, x]\nb: &b [*a, *a]\nc: &c [*b, *b]\nd: &d [*c, *c]\noperations: {}\n',
    );
    assert.equal(bomb.driver, undefined, 'an alias bomb is not expanded');
    const twice = await read('version: 1\nversion: 1\nkind: NotificationChannel\noperations: {}\n');
    assert.match(twice.problems.join(), /not valid YAML/u);
    const merged = await read('base: &b { a: 1 }\nthing:\n  <<: *b\n');
    assert.equal(merged.driver, undefined);
  });

  it('gives its values only the types of the core schema, not dates or custom tags', async () => {
    const tagged = await read(
      'version: !!js/function "x"\nkind: NotificationChannel\noperations: {}\n',
    );
    assert.equal(tagged.driver, undefined);
    const dated = await read(`${GOOD}\n# 2026-11-19 stays text\n`);
    assert.deepEqual(dated.problems, []);
  });

  it('reports a missing file, a file that is too large and a driver that does not fit the schema', async () => {
    assert.match(
      (await readDriver(root, 'nowhere.yaml', 'driver.yaml')).problems.join(),
      /cannot be read/u,
    );
    assert.match(
      (await read(`# ${'x'.repeat(130 * 1024)}\n${GOOD}`)).problems.join(),
      /larger than 128 KiB/u,
    );
    const bad = await read('version: 1\nkind: NodeFlavor\noperations: {}\n');
    assert.match(bad.problems.join(), /driver.yaml: kind/u);
  });

  it('does not follow a link out of the plugin, and decides on a large file before reading it', async () => {
    const plugin = join(root, 'linked-plugin');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(plugin, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'driver.yaml'), GOOD);
    // A directory link (a junction on Windows) inside the plugin that leads outside it.
    await symlink(elsewhere, join(plugin, 'drivers'), 'junction');
    const through = await readDriver(plugin, 'drivers/driver.yaml', 'driver.yaml');
    assert.equal(through.driver, undefined);
    assert.match(through.problems.join(), /leads outside the plugin directory/u);
    // A directory where a file should be is refused as not a regular file, without trying to read it.
    await mkdir(join(plugin, 'folder.yaml'));
    assert.match(
      (await readDriver(plugin, 'folder.yaml', 'driver.yaml')).problems.join(),
      /not a regular file/u,
    );
  });

  it('does not read a driver through a linked directory even if the target is inside the plugin', async () => {
    const directory = join(root, 'linked-inside');
    await mkdir(join(directory, 'drivers'), { recursive: true });
    await writeFile(join(directory, 'drivers', 'driver.yaml'), GOOD);
    await symlink(join(directory, 'drivers'), join(directory, 'alias'), 'junction');
    const result = await readDriver(directory, 'alias/driver.yaml', 'driver.yaml');
    assert.equal(result.driver, undefined);
    assert.match(result.problems.join(), /link/u);
  });
});

describe('finding a plugin with a driver', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'sw-found-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function declarative(
    id: string,
    options: {
      driver?: string;
      network?: string[];
      config?: unknown;
      permissions?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const directory = join(root, id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'swellwright.plugin.json'),
      JSON.stringify({
        id,
        version: '1.0.0',
        name: id,
        engines: { swellwright: '>=0.0.0-0 <1' },
        provides: [{ kind: 'NotificationChannel', driver: 'driver.yaml' }],
        permissions: {
          network: options.network ?? ['hooks.example.com:443'],
          ...options.permissions,
        },
        config: { schema: 'config.schema.json' },
        license: 'AGPL-3.0-only',
      }),
    );
    await writeFile(join(directory, 'driver.yaml'), options.driver ?? GOOD);
    await writeFile(
      join(directory, 'config.schema.json'),
      JSON.stringify(
        options.config ?? { type: 'object', properties: { path: { type: 'string' } } },
      ),
    );
  }
  const state = async (id: string) =>
    found(
      (await discoverPlugins([{ directory: root, trust: 'local' }], '0.0.0-test')).find(
        (p) => p.folder === id,
      ),
      id,
    );

  it('accepts a driver that calls only what the manifest asks for and reads only declared settings', async () => {
    await declarative('good-driver');
    const plugin = await state('good-driver');
    assert.equal(plugin.state, 'available', plugin.problems.join());
    assert.deepEqual(Object.keys(plugin.drivers), ['NotificationChannel']);
  });

  it('makes the plugin invalid, with the reason, when the driver calls a host the manifest does not ask for', async () => {
    await declarative('wrong-host', { network: ['other.example.com:443'] });
    const plugin = await state('wrong-host');
    assert.equal(plugin.state, 'invalid');
    assert.match(
      plugin.problems.join(),
      /calls hooks.example.com:443, which the manifest does not ask for/u,
    );
    assert.deepEqual(plugin.drivers, {});
  });

  it('makes it invalid when the driver reads a setting that is not declared, or a secret from a field that holds none', async () => {
    await declarative('no-setting', { config: { type: 'object', properties: {} } });
    assert.match((await state('no-setting')).problems.join(), /"config.path" is not a setting/u);
    const secret = GOOD.replace('{{ config.path }}', '{{ secret.path }}');
    await declarative('no-secret', { driver: secret });
    assert.match(
      (await state('no-secret')).problems.join(),
      /"secret.path" is not a setting of the plugin that holds a secret/u,
    );
  });

  it('makes it invalid when the driver is for another kind than the manifest gives it as, or is not sound', async () => {
    await declarative('other-kind', { driver: GOOD.replace('NotificationChannel', 'DnsProvider') });
    assert.match((await state('other-kind')).problems.join(), /is a driver for DnsProvider/u);
    await declarative('broken-yaml', { driver: 'version: [' });
    assert.equal((await state('broken-yaml')).state, 'invalid');
    await declarative('later-step', {
      driver: GOOD.replace('{{ config.path }}', '{{ steps.nope.json.x }}'),
    });
    assert.match((await state('later-step')).problems.join(), /is not an earlier step/u);
  });

  it('changes the digest when the driver changes, so it must be approved again', async () => {
    await declarative('digested');
    const first = (await state('digested')).digest;
    await writeFile(join(root, 'digested', 'driver.yaml'), `${GOOD}# changed\n`);
    assert.notEqual((await state('digested')).digest, first);
  });
});

describe('the Telegram plugin that ships with Swellwright', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let owner: Client;
  let ownerSecret: string;
  const sent: TransportRequest[] = [];
  let answer: { status: number; body: unknown } = {
    status: 200,
    body: { ok: true, result: { message_id: 9 } },
  };

  const view = async () =>
    found(
      PluginListSchema.parse((await owner.get('/plugins')).body).plugins.find(
        (p) => p.id === 'notify-telegram',
      ),
      'notify-telegram',
    );
  const call = (method: string, params: unknown = null) =>
    instance.app
      .get(PluginHostService)
      .call('notify-telegram', 'NotificationChannel', method, params);
  const events = async (action: string) =>
    (await auditEvents(instance)).filter((e) => e.action === action);
  /** A note is written in the background, so it may land a moment after the call that caused it. */
  const settled = async (action: string, count = 1) => {
    for (let i = 0; i < 60; i++) {
      const found = await events(action);
      if (found.length >= count) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return events(action);
  };

  before(async () => {
    instance = await start(
      { SW_PLUGINS_OFFICIAL_DIR: OFFICIAL },
      {
        pluginNetwork: new PluginNetwork({
          resolve: () => Promise.resolve(PUBLIC),
          transport: (request) => {
            sent.push(request);
            return Promise.resolve({
              status: answer.status,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(answer.body),
            });
          },
        }),
      },
    );
    ({ secret: ownerSecret } = await createOwner(instance));
    owner = await signInAs(instance, 'owner', ownerSecret);
    assert.equal(
      (await owner.post('/vault/initialize', { passphrase: 'a long passphrase for the tests' }))
        .status,
      201,
    );
  });
  after(async () => {
    await stop(instance);
  });

  it('is found, sound, and asks for exactly one host and one kind of secret', async () => {
    const plugin = await view();
    assert.equal(plugin.discovery, 'available', plugin.problems.join());
    assert.equal(plugin.trust, 'official');
    assert.deepEqual(plugin.provides, [{ kind: 'NotificationChannel', mode: 'declarative' }]);
    assert.deepEqual(plugin.permissions, {
      network: ['api.telegram.org:443'],
      secrets: ['telegram'],
      panel: [],
      ssh: false,
    });
    assert.equal(plugin.hasConfig, true);
  });

  it('is configured with a bot token chosen from the vault and a chat, then enabled', async () => {
    const token = await owner.post('/secrets', {
      name: 'telegram bot',
      type: 'telegram',
      value: '123456:ABC-def_GHI',
    });
    const secretId = SecretViewSchema.parse(token.body).id;
    const reply = await owner.call('PUT', '/plugins/notify-telegram/config', {
      values: { botToken: secretId, chatId: '-100123' },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const enabled = await owner.post('/plugins/notify-telegram/enable', {
      digest: (await view()).digest,
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  });

  it('sends a message: the request goes to Telegram with the token in the path and the text in a JSON body', async () => {
    const result = await call('send', { text: 'Plugin check <b>passed</b>', silent: true });
    assert.deepEqual(result, { messageId: 9 });
    const request = found(sent.at(-1), 'the request');
    assert.equal(request.host, 'api.telegram.org');
    assert.equal(request.port, 443);
    assert.equal(request.path, '/bot123456:ABC-def_GHI/sendMessage');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body ?? ''), {
      chat_id: '-100123',
      text: 'Plugin check <b>passed</b>',
      disable_notification: true,
    });
    const used = await settled('plugin.secret.used');
    assert.equal(used.length, 1);
    assert.equal(JSON.stringify(await auditEvents(instance)).includes('ABC-def'), false);
  });

  it('checks the token: asks who the bot is', async () => {
    answer = { status: 200, body: { ok: true, result: { username: 'swellwright_bot' } } };
    assert.deepEqual(await call('check'), { bot: 'swellwright_bot' });
    assert.equal(found(sent.at(-1), 'the request').path, '/bot123456:ABC-def_GHI/getMe');
    assert.equal(found(sent.at(-1), 'the request').method, 'GET');
  });

  it('says what Telegram said when it refuses, without the token', async () => {
    answer = { status: 401, body: { ok: false, description: 'Unauthorized' } };
    await assert.rejects(call('send', { text: 'x' }), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'failed');
      assert.equal(error.message, 'The service answered 401: Unauthorized');
      return true;
    });
  });

  it('checks its parameters before anything is sent', async () => {
    const before = sent.length;
    await assert.rejects(call('send', {}), /the parameter "text" is required/u);
    await assert.rejects(call('send', { text: 'x'.repeat(4097) }), /at most 4096 characters/u);
    await assert.rejects(call('send', { text: 'x', chat: 1 }), /not a parameter/u);
    await assert.rejects(call('nothing'), /no operation "nothing"/u);
    assert.equal(sent.length, before, 'nothing went out');
  });

  it('is checked without a process, and shows what it offers', async () => {
    const reply = await owner.post('/plugins/notify-telegram/check');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const plugin = PluginViewSchema.parse(reply.body);
    assert.equal(plugin.runtime.state, 'stopped', 'there is no process: the plugin runs no code');
    assert.deepEqual(plugin.runtime.modules, [
      { kind: 'NotificationChannel', methods: ['check', 'send'] },
    ]);
    const record = found((await events('plugin.checked')).at(-1), 'the record');
    assert.equal(record.outcome, 'success');
    assert.deepEqual([record.details['modules'], record.details['methods']], [1, 2]);
  });

  it('stops working at once when the vault is sealed, and when it is switched off', async () => {
    answer = { status: 200, body: { ok: true, result: { username: 'swellwright_bot' } } };
    assert.equal((await owner.post('/vault/seal')).status, 200);
    await assert.rejects(call('check'), /sealed/iu);
    assert.equal(
      (await owner.post('/vault/unseal', { passphrase: 'a long passphrase for the tests' })).status,
      200,
    );
    assert.deepEqual(await call('check'), { bot: 'swellwright_bot' });
    assert.equal((await owner.post('/plugins/notify-telegram/disable')).status, 200);
    await assert.rejects(call('check'), /it is disabled/u);
  });
});
