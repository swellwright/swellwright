import 'reflect-metadata';

import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PluginListSchema, PluginViewSchema } from '@swellwright/contracts';

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
  signInAs,
  start,
  stop,
} from '../test-support.js';
import { AuditService } from '../audit/audit.service.js';
import { CONFIG, PLUGIN_NETWORK } from '../tokens.js';
import { PluginBroker } from './broker.js';
import { writeFixture } from './host/fixtures.js';
import { PluginNetwork } from './host/network.js';
import { PluginHostService } from './host/plugin-host.service.js';
import { PluginCallError, PluginProcess } from './host/process.js';
import { PluginsService } from './plugins.service.js';
import { PluginRuntime } from './runtime.js';

const PUBLIC = [{ address: [93, 184, 216, 34].join('.'), family: 4 as const }];

async function eventually<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${what} did not happen`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('running approved plugins', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let local: string;
  let owner: Client;
  let ownerSecret: string;
  let observerSecret: string;

  const db = () => instance.isolated.database.client;
  const host = () => instance.app.get(PluginHostService);
  const view = async (id: string) =>
    found(
      PluginListSchema.parse((await owner.get('/plugins')).body).plugins.find((p) => p.id === id),
      id,
    );
  const enable = async (id: string) => {
    const reply = await owner.post(`/plugins/${id}/enable`, { digest: (await view(id)).digest });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
  };
  const check = (id: string) => owner.post(`/plugins/${id}/check`);
  const events = async (action: string) =>
    (await auditEvents(instance)).filter((e) => e.action === action);
  const call = (id: string, method: string, params: unknown = null) =>
    host().call(id, 'DnsProvider', method, params);

  before(async () => {
    local = await mkdtemp(join(tmpdir(), 'sw-run-'));
    instance = await start(
      {
        SW_PLUGINS_LOCAL_DIR: local,
        SW_PLUGIN_CALL_TIMEOUT_SECONDS: '1',
        SW_PLUGIN_MEMORY_MIB: '64',
      },
      {
        pluginNetwork: new PluginNetwork({
          resolve: () => Promise.resolve(PUBLIC),
          transport: (r) =>
            Promise.resolve({ status: 200, headers: {}, body: `answered ${r.host}${r.path}` }),
        }),
      },
    );
    ({ secret: ownerSecret } = await createOwner(instance));
    ({ secret: observerSecret } = await createUser(instance, 'observer', 'observer'));
    owner = await signInAs(instance, 'owner', ownerSecret);
    await writeFixture(local, 'dns-example');
    await writeFixture(local, 'flaky-example');
    // A plugin that only describes a driver in data has no code, so no process.
    const declarative = join(local, 'webhook-example');
    await mkdir(declarative, { recursive: true });
    await writeFile(
      join(declarative, 'swellwright.plugin.json'),
      JSON.stringify({
        id: 'webhook-example',
        version: '1.0.0',
        name: 'Declarative webhook',
        engines: { swellwright: '>=0.0.0-0 <1' },
        provides: [{ kind: 'NotificationChannel', driver: 'driver.yaml' }],
        permissions: { network: ['hooks.example.com:443'] },
        license: 'AGPL-3.0-only',
      }),
    );
    await writeFile(
      join(declarative, 'driver.yaml'),
      [
        'version: 1',
        'kind: NotificationChannel',
        'operations:',
        '  ping:',
        '    steps:',
        '      - id: call',
        '        request:',
        '          url: https://hooks.example.com/ping',
        '',
      ].join('\n'),
    );
  });
  after(async () => {
    await stop(instance);
    await rm(local, { recursive: true, force: true });
  });

  it('does not run a plugin that was never enabled, and says so', async () => {
    await assert.rejects(call('dns-example', 'echo', 1), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'not_running');
      assert.match(error.message, /never enabled/u);
      return true;
    });
    assert.equal((await view('dns-example')).runtime.state, 'stopped');
  });

  it('is checked by the people who may manage plugins, with a fresh second factor', async () => {
    await enable('dns-example');
    const observer = await signInAs(instance, 'observer', observerSecret);
    const denied = await observer.post('/plugins/dns-example/check');
    assert.equal(denied.status, 403);
    assert.equal(errorCode(denied), 'forbidden');

    await db().session.updateMany({ data: { elevatedUntil: new Date(Date.now() - 1000) } });
    const needsCode = await check('dns-example');
    assert.equal(needsCode.status, 403);
    assert.equal(errorCode(needsCode), 'step_up_required');
    assert.equal((await view('dns-example')).runtime.state, 'stopped', 'nothing started');
    await forgetLastStep(instance);
    assert.equal((await owner.post('/auth/step-up', { code: codeFor(ownerSecret) })).status, 200);

    assert.equal((await owner.post('/plugins/not-there/check')).status, 404);
    assert.equal((await check('flaky-example')).status, 409, 'not enabled');
  });

  it('loads an enabled plugin in its own process and shows what it offers', async () => {
    const reply = await check('dns-example');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const plugin = PluginViewSchema.parse(reply.body);
    assert.equal(plugin.runtime.state, 'running');
    assert.equal(plugin.runtime.lastError, null);
    const [loaded] = plugin.runtime.modules;
    assert.equal(plugin.runtime.modules.length, 1);
    assert.ok(loaded);
    assert.equal(loaded.kind, 'DnsProvider');
    assert.ok(loaded.methods.includes('echo'));
    assert.ok(plugin.runtime.startedAt);
    assert.equal((await view('dns-example')).runtime.state, 'running');

    const record = found((await events('plugin.checked')).at(-1), 'the record of the check');
    assert.equal(record.outcome, 'success');
    assert.equal(record.actor?.name, 'owner');
    assert.deepEqual(record.object, { type: 'plugin', id: 'dns-example' });
    assert.equal(record.details['modules'], 1);
    assert.equal(record.details['methods'], loaded.methods.length);
  });

  it('calls a method, and lets it reach only the hosts that were approved', async () => {
    assert.deepEqual(await call('dns-example', 'echo', { a: 1 }), { a: 1 });
    assert.deepEqual(
      await call('dns-example', 'viaCore', { url: 'https://api.example.com/zones' }),
      { status: 200, ok: true, body: 'answered api.example.com/zones' },
    );
    const refused = await call('dns-example', 'refused', { url: 'https://evil.example.org/x' });
    assert.match(String(refused), /not among the hosts this plugin was approved to call/u);
    const note = await eventually(
      async () => (await events('plugin.network.denied')).at(-1),
      'the record of the refused request',
    );
    assert.equal(note.outcome, 'denied');
    assert.equal(note.actor, null);
    assert.deepEqual(note.object, { type: 'plugin', id: 'dns-example' });
    assert.deepEqual(note.details, { host: 'evil.example.org', reason: 'not_allowed' });
    assert.ok((await view('dns-example')).runtime.calls >= 3);
  });

  it('has no process for a plugin that is only data, and says that is fine', async () => {
    await enable('webhook-example');
    const reply = await check('webhook-example');
    assert.equal(reply.status, 200);
    const plugin = PluginViewSchema.parse(reply.body);
    assert.equal(plugin.runtime.state, 'stopped');
    assert.deepEqual(plugin.runtime.modules, [{ kind: 'NotificationChannel', methods: ['ping'] }]);
    const record = found((await events('plugin.checked')).at(-1), 'the record');
    assert.deepEqual([record.details['modules'], record.details['methods']], [1, 1]);
    // There is no code for the kind that has none, and an operation the driver does not have is refused.
    await assert.rejects(call('webhook-example', 'echo'), /no code to run/u);
    await assert.rejects(
      host().call('webhook-example', 'NotificationChannel', 'echo', null),
      /no operation "echo"/u,
    );
  });

  it('ends a plugin that takes too long, records it, and runs it again on the next call', async () => {
    const previous = found(host().pidOf('dns-example'), 'the running process');
    await assert.rejects(call('dns-example', 'loop'), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.equal(error.reason, 'timeout');
      return true;
    });
    const failed = await view('dns-example');
    assert.equal(failed.runtime.state, 'failed');
    assert.match(failed.runtime.lastError ?? '', /took longer than/u);
    const note = await eventually(
      async () => (await events('plugin.failed')).at(-1),
      'the record of the failure',
    );
    assert.equal(note.outcome, 'failure');
    assert.deepEqual(note.details, { reason: 'timeout', method: 'loop' });
    await eventually(
      () => Promise.resolve(alive(previous) ? undefined : true),
      'the process to end',
    );

    assert.deepEqual(await call('dns-example', 'echo', 'again'), 'again');
    const current = found(host().pidOf('dns-example'), 'the new process');
    assert.notEqual(current, previous);
    assert.equal((await view('dns-example')).runtime.state, 'running');
  });

  it('switches off a plugin whose files changed, and ends its process', async () => {
    const pid = found(host().pidOf('dns-example'), 'the running process');
    await writeFile(
      join(local, 'dns-example', 'dist', 'entry.js'),
      "export default { methods: { echo: () => 'tampered' } };\n",
    );
    await assert.rejects(call('dns-example', 'echo', 1), (error: unknown) => {
      assert.ok(error instanceof PluginCallError);
      assert.match(error.message, /not what was approved/u);
      return true;
    });
    const off = found((await events('plugin.disabled')).at(-1), 'the record of the switch-off');
    assert.equal(off.actor, null);
    assert.equal(off.details['reason'], 'changed');
    await eventually(() => Promise.resolve(alive(pid) ? undefined : true), 'the process to end');
    assert.equal(host().pidOf('dns-example'), undefined);
    const plugin = await view('dns-example');
    assert.equal(plugin.status, 'changed');
    assert.equal(plugin.runtime.state, 'stopped');
  });

  it('is stopped at once when the administrator disables it, and not started again until it is enabled', async () => {
    await writeFixture(local, 'dns-example');
    await enable('dns-example');
    assert.equal((await check('dns-example')).status, 200);
    const pid = found(host().pidOf('dns-example'), 'the running process');
    const reply = await owner.post('/plugins/dns-example/disable');
    assert.equal(reply.status, 200);
    assert.equal(PluginViewSchema.parse(reply.body).runtime.state, 'stopped');
    await eventually(() => Promise.resolve(alive(pid) ? undefined : true), 'the process to end');
    assert.equal(host().pidOf('dns-example'), undefined);
    assert.equal((await check('dns-example')).status, 409);
    await assert.rejects(call('dns-example', 'echo', 1), /it is disabled/u);
  });

  it('ends a process started under an earlier approval when the plugin is approved again', async () => {
    await enable('dns-example');
    assert.equal(await call('dns-example', 'echo', 1), 1);
    const first = found(host().pidOf('dns-example'), 'the first process');
    await enable('dns-example');
    await eventually(
      () => Promise.resolve(alive(first) ? undefined : true),
      'the old process to end',
    );
    assert.equal(await call('dns-example', 'echo', 2), 2);
    assert.notEqual(found(host().pidOf('dns-example'), 'the new process'), first);
  });

  it('does not clear a replacement runtime snapshot when an older process finishes stopping', async (t) => {
    const runtime = instance.app.get(PluginRuntime);
    const stopProcess = Object.getOwnPropertyDescriptor(PluginProcess.prototype, 'stop')?.value as (
      this: PluginProcess,
    ) => Promise<void>;
    let finish = (): void => undefined;
    const stopping = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const delay = t.mock.method(
      PluginProcess.prototype,
      'stop',
      async function (this: PluginProcess) {
        await stopProcess.call(this);
        await stopping;
      },
    );
    const stopped = host().stop('dns-example');
    try {
      delay.mock.restore();
      assert.equal(await call('dns-example', 'echo', 'replacement'), 'replacement');
      assert.equal(runtime.snapshotOf('dns-example').state, 'running');
    } finally {
      finish();
      await stopped;
    }
    assert.equal(runtime.snapshotOf('dns-example').state, 'running');
  });

  it('runs a plugin that was enabled before the host started, as after a restart of the API', async () => {
    const app = instance.app;
    const fresh = new PluginHostService(
      app.get(PluginsService),
      new PluginRuntime(),
      app.get(PluginBroker),
      app.get(AuditService),
      app.get(CONFIG),
      app.get(PLUGIN_NETWORK),
    );
    try {
      assert.equal(await fresh.call('dns-example', 'DnsProvider', 'echo', 'fresh'), 'fresh');
    } finally {
      await fresh.onApplicationShutdown();
    }
  });

  it('starts nothing when the plugin is stopped after its approval was read', async () => {
    await host().stop('dns-example');
    const plugins = instance.app.get(PluginsService);
    const original = plugins.runnable.bind(plugins);
    plugins.runnable = async (id: string) => {
      const read = await original(id);
      // Disabled (or approved again) right after this reading: what a disable does on this instance.
      instance.app.get(PluginRuntime).requestStop(id);
      return read;
    };
    try {
      await assert.rejects(call('dns-example', 'echo', 1), (error: unknown) => {
        assert.ok(error instanceof PluginCallError);
        assert.equal(error.reason, 'not_running');
        return true;
      });
      assert.equal(host().pidOf('dns-example'), undefined);
    } finally {
      plugins.runnable = original;
    }
    assert.equal(await call('dns-example', 'echo', 2), 2);
  });

  it('does not keep a process that was starting when the plugin was disabled', async () => {
    await writeFixture(
      local,
      'slow-example',
      'await new Promise((resolve) => setTimeout(resolve, 1500));\nexport default { methods: { echo: (p) => p } };\n',
    );
    await enable('slow-example');
    const pending = call('slow-example', 'echo', 1).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await owner.post('/plugins/slow-example/disable')).status, 200);
    const error = await pending;
    assert.ok(error instanceof PluginCallError);
    assert.equal(error.reason, 'not_running');
    // Long after it would have been ready, there is still nothing running for it.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(host().pidOf('slow-example'), undefined);
    assert.equal((await view('slow-example')).runtime.state, 'stopped');
  });

  it('does not publish an obsolete check after the plugin was stopped', async (t) => {
    const plugins = instance.app.get(PluginsService);
    const runtime = instance.app.get(PluginRuntime);
    const original = plugins.runnable.bind(plugins);
    t.mock.method(plugins, 'runnable', async (id: string) => {
      const read = await original(id);
      await host().stop(id);
      return read;
    });
    await check('dns-example');
    assert.equal(runtime.snapshotOf('dns-example').state, 'stopped');
    assert.equal(runtime.snapshotOf('dns-example').lastError, null);
  });

  it('reports a plugin that cannot load, and leaves the record of it', async () => {
    await writeFixture(local, 'flaky-example', 'throw new Error("cannot start");\n');
    await enable('flaky-example');
    const reply = await check('flaky-example');
    assert.equal(reply.status, 200);
    const plugin = PluginViewSchema.parse(reply.body);
    assert.equal(plugin.runtime.state, 'failed');
    assert.equal(plugin.runtime.lastError, 'The plugin could not load its modules.');
    const record = found((await events('plugin.checked')).at(-1), 'the record');
    assert.equal(record.outcome, 'failure');
    assert.equal(record.details['reason'], 'The plugin could not load its modules.');
  });

  it('stops a running plugin after repeated unsafe hard links without revoking its approval', async () => {
    const id = 'hardlink-example';
    const directory = await writeFixture(local, id);
    await enable(id);
    assert.equal(await call(id, 'echo', 7), 7);
    assert.ok(host().pidOf(id));
    const alias = join(local, 'hardlink-alias.js');
    await link(join(directory, 'dist', 'entry.js'), alias);
    try {
      const reasons: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        await assert.rejects(call(id, 'echo', 7), (error: unknown) => {
          assert.ok(error instanceof PluginCallError);
          reasons.push(error.message);
          return error.reason === 'not_running';
        });
      }
      assert.equal(new Set(reasons).size, 1);
      assert.match(reasons[0] ?? '', /exactly one hard link/u);
      assert.equal(host().pidOf(id), undefined);
      const notes = (await events('plugin.unverifiable')).filter(
        (event) => event.object?.id === id,
      );
      assert.equal(notes.length, 1);
      assert.equal(
        (await db().pluginApproval.findUniqueOrThrow({ where: { pluginId: id } })).enabled,
        true,
      );
      assert.match((await view(id)).problems.join(), /exactly one hard link/u);
    } finally {
      await rm(alias);
    }
    assert.equal(await call(id, 'echo', 8), 8);
  });

  it('leaves a plugin that keeps failing alone for a while', async () => {
    await writeFixture(local, 'flaky-example');
    await enable('flaky-example');
    assert.equal((await check('flaky-example')).status, 200);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(call('flaky-example', 'loop'), (error: unknown) => {
        assert.ok(error instanceof PluginCallError);
        return true;
      });
    }
    await assert.rejects(call('flaky-example', 'echo', 1), /keeps failing/u);
    // The administrator can still look at it: a check is a deliberate act.
    assert.equal((await check('flaky-example')).status, 200);
    assert.equal((await view('flaky-example')).runtime.state, 'running');
  });
});
