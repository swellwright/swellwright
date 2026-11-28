import 'reflect-metadata';

import assert from 'node:assert/strict';
import fs, {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PluginListSchema, PluginViewSchema } from '@swellwright/contracts';
import type { Database, PluginApproval } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
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
import { digestPlugin } from './digest.js';
import { PluginsService } from './plugins.service.js';
import { PluginRuntime } from './runtime.js';

interface Fixture {
  readonly version?: string;
  readonly permissions?: Record<string, unknown>;
  readonly entry?: string;
}

/** Writes a plugin that the discovery accepts: a manifest and the one module it names. */
async function writePlugin(root: string, id: string, fixture: Fixture = {}): Promise<string> {
  const directory = join(root, id);
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(
    join(directory, 'swellwright.plugin.json'),
    JSON.stringify({
      id,
      version: fixture.version ?? '1.0.0',
      name: `The ${id} plugin`,
      description: 'A plugin for the tests.',
      engines: { swellwright: '>=0.0.0-0 <1' },
      provides: [{ kind: 'DnsProvider', entry: './dist/entry.js' }],
      permissions: fixture.permissions ?? { network: ['api.example.com:443'] },
      license: 'AGPL-3.0-only',
    }),
  );
  await writeFile(join(directory, 'dist', 'entry.js'), fixture.entry ?? 'export default {};\n');
  return directory;
}

/** The digest of a plugin that is expected to be sound. */
async function digestOf(directory: string): Promise<string> {
  const result = await digestPlugin(directory);
  assert.ok(result.ok, 'the plugin has a digest');
  return result.digest;
}

it('spaces transient strikes across listing and runtime checks of the same approval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sw-plugin-strikes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'unstable-example';
  const directory = await writePlugin(root, id);
  const now = new Date('2026-01-01T00:00:00Z');
  const approval: PluginApproval = {
    pluginId: id,
    enabled: true,
    version: '1.0.0',
    trust: 'local',
    digest: await digestOf(directory),
    permissions: '{"network":[],"secrets":[],"panel":[],"ssh":false}',
    approvedAt: now,
    approvedBy: 'operator',
    updatedAt: now,
  };
  const db = {
    client: {
      pluginApproval: {
        findUnique: () => Promise.resolve(approval),
        findMany: () => Promise.resolve([approval]),
      },
    },
  } as unknown as Database;
  const runtime = new PluginRuntime();
  const stops: string[] = [];
  runtime.onStop((stopped) => stops.push(stopped));
  const audit = new AuditService(undefined);
  const notes = t.mock.method(audit, 'note', () => Promise.resolve());
  const service = new PluginsService(
    db,
    audit,
    { version: '0.0.0-test', pluginRoots: [{ directory: root, trust: 'local' }] },
    runtime,
  );
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const original = fs.lstat.bind(fs);
  const entry = join(directory, 'dist', 'entry.js');
  const statFailure = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) =>
    args[0] === entry
      ? Promise.reject(Object.assign(new Error('synthetic read failure'), { code: 'EIO' }))
      : original(...args),
  );
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await service.list()).plugins[0]?.status, 'unavailable');
      assert.equal((await service.runnable(id)).kind, 'not_enabled');
    }
    assert.deepEqual(stops, [], 'a burst of checks is only one strike');
    t.mock.timers.tick(999);
    await service.runnable(id);
    t.mock.timers.tick(1);
    await service.list();
    assert.deepEqual(stops, []);
    t.mock.timers.tick(1000);
    await service.runnable(id);
    await service.list();
    assert.deepEqual(stops, [id]);
    assert.deepEqual(
      notes.mock.calls.map(({ arguments: [event] }) => found(event, 'audit note').action),
      ['plugin.unverifiable'],
    );
  } finally {
    statFailure.mock.restore();
    syncBuiltinESMExports();
  }
});

describe('the digest of a plugin', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'sw-digest-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is the same for the same files, and another for any change to them', async () => {
    const directory = await writePlugin(root, 'one');
    const first = await digestOf(directory);
    assert.match(first, /^[0-9a-f]{64}$/u);
    assert.equal(await digestOf(directory), first);

    await writeFile(join(directory, 'dist', 'entry.js'), 'export default { changed: true };\n');
    const changed = await digestOf(directory);
    assert.notEqual(changed, first);

    await writeFile(join(directory, 'extra.txt'), 'a file that was added');
    assert.notEqual(await digestOf(directory), changed);
  });

  it('does not depend on where the plugin is', async () => {
    const one = await writePlugin(root, 'same-a');
    const two = join(root, 'same-b');
    await mkdir(join(two, 'dist'), { recursive: true });
    for (const file of ['swellwright.plugin.json', 'dist/entry.js']) {
      await writeFile(join(two, file), await readFile(join(one, file)));
    }
    assert.equal(await digestOf(one), await digestOf(two));
  });

  it('includes all regular plugin files, including files under .git, in the approval digest', async () => {
    const directory = await writePlugin(root, 'git-content');
    const metadata = join(directory, '.git', 'HEAD');
    await mkdir(join(directory, '.git'));
    await writeFile(metadata, 'ref: refs/heads/main');
    const first = await digestOf(directory);
    await writeFile(metadata, 'ref: refs/heads/next');
    assert.notEqual(await digestOf(directory), first);
  });

  it('refuses a link anywhere inside a plugin', async () => {
    const directory = await writePlugin(root, 'linked');
    try {
      await symlink(join(root, 'one'), join(directory, 'dist', 'elsewhere'), 'dir');
    } catch {
      return; // creating links needs a privilege on some systems; nothing to check there
    }
    const result = await digestPlugin(directory);
    assert.ok(!result.ok);
    assert.match(result.problem, /link/u);
  });

  it('refuses a .git that is a link, or a link inside .git, since the process can read the whole directory', async () => {
    const outside = join(root, 'outside-of-plugins');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'host-file.txt'), 'a file of the host');
    // A directory link (a junction on Windows, which needs no privilege) as the .git of the plugin.
    const top = await writePlugin(root, 'git-link');
    await symlink(outside, join(top, '.git'), 'junction');
    const linked = await digestPlugin(top);
    assert.ok(!linked.ok);
    assert.match(linked.problem, /"\.git" is a link/u);
    // A regular .git with a link somewhere inside it.
    const nested = await writePlugin(root, 'git-nested-link');
    await mkdir(join(nested, '.git', 'refs'), { recursive: true });
    await symlink(outside, join(nested, '.git', 'refs', 'way-out'), 'junction');
    const inside = await digestPlugin(nested);
    assert.ok(!inside.ok);
    assert.match(inside.problem, /"\.git\/refs\/way-out" is a link/u);
  });

  it('rejects files with more than one hard link, even when their bytes are unchanged', async () => {
    const directory = await writePlugin(root, 'hard-linked');
    await digestOf(directory);
    await link(join(directory, 'dist', 'entry.js'), join(root, 'another-entry.js'));
    const result = await digestPlugin(directory);
    assert.equal(result.ok, false);
  });

  it('hashes a file again when its content changed, even with the same size and modification time', async () => {
    const directory = await writePlugin(root, 'same-stamp', { entry: 'export default 1;\n' });
    const entry = join(directory, 'dist', 'entry.js');
    const fixed = new Date('2026-01-01T00:00:00Z');
    await utimes(entry, fixed, fixed);
    const first = await digestOf(directory);
    const before = await stat(entry);
    await writeFile(entry, 'export default 2;\n');
    // Whoever writes the file can put the modification time back; the change time cannot be.
    await utimes(entry, fixed, fixed);
    assert.equal((await stat(entry)).mtimeMs, before.mtimeMs);
    assert.notEqual(await digestOf(directory), first);
  });
});

describe('plugins of an instance', { skip: !databaseUrl }, () => {
  let instance: Instance;
  let local: string;
  let owner: Client;
  let ownerSecret: string;
  let observerSecret: string;
  let operatorSecret: string;

  const db = () => instance.isolated.database.client;
  const list = async (as: Client = owner) =>
    PluginListSchema.parse((await as.get('/plugins')).body).plugins;
  const view = async (id: string) =>
    found(
      (await list()).find((p) => p.id === id),
      id,
    );
  const elevate = async () => {
    await forgetLastStep(instance);
    assert.equal((await owner.post('/auth/step-up', { code: codeFor(ownerSecret) })).status, 200);
  };
  const enable = (id: string, digest: string) => owner.post(`/plugins/${id}/enable`, { digest });
  const events = async (action: string) =>
    (await auditEvents(instance)).filter((e) => e.action === action);

  before(async () => {
    local = await mkdtemp(join(tmpdir(), 'sw-plugins-'));
    instance = await start({ SW_PLUGINS_LOCAL_DIR: local });
    ({ secret: ownerSecret } = await createOwner(instance));
    ({ secret: observerSecret } = await createUser(instance, 'observer', 'observer'));
    ({ secret: operatorSecret } = await createUser(instance, 'operator', 'operator'));
    owner = await signInAs(instance, 'owner', ownerSecret);
  });
  after(async () => {
    await stop(instance);
    await rm(local, { recursive: true, force: true });
  });

  it('shows nothing, and says so, while no plugin is there', async () => {
    const reply = await owner.get('/plugins');
    assert.equal(reply.status, 200);
    assert.deepEqual(PluginListSchema.parse(reply.body), {
      plugins: [],
      directories: { official: false, local: true, community: false },
    });
  });

  it('lists a plugin with what its files ask for and the digest an approval is tied to', async () => {
    await writePlugin(local, 'dns-example', {
      permissions: {
        network: ['api.example.com:443', 'dns.example.com:443'],
        secrets: ['dns-oauth'],
      },
    });
    const plugin = await view('dns-example');
    assert.equal(plugin.status, 'not_enabled');
    assert.equal(plugin.discovery, 'available');
    assert.equal(plugin.trust, 'local');
    assert.equal(plugin.version, '1.0.0');
    assert.deepEqual(plugin.provides, [{ kind: 'DnsProvider', mode: 'code' }]);
    assert.deepEqual(plugin.permissions, {
      network: ['api.example.com:443', 'dns.example.com:443'],
      secrets: ['dns-oauth'],
      panel: [],
      ssh: false,
    });
    assert.match(plugin.digest ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(plugin.signed, false);
    assert.equal(plugin.approval, null);
    assert.equal(plugin.change, null);
  });

  it('shows an unusable plugin with every reason, and cannot enable it', async () => {
    await mkdir(join(local, 'no-manifest'));
    await writePlugin(local, 'wrong-engine');
    await writeFile(
      join(local, 'wrong-engine', 'swellwright.plugin.json'),
      JSON.stringify({
        id: 'wrong-engine',
        version: '1.0.0',
        name: 'x',
        engines: { swellwright: '>=9.0.0' },
        provides: [{ kind: 'DnsProvider', entry: './dist/entry.js' }],
        license: 'AGPL-3.0-only',
      }),
    );
    const bare = await view('no-manifest');
    assert.equal(bare.status, 'unavailable');
    assert.equal(bare.discovery, 'invalid');
    assert.match(bare.problems.join(' '), /no swellwright\.plugin\.json/u);
    const old = await view('wrong-engine');
    assert.equal(old.discovery, 'incompatible');
    assert.equal(old.status, 'unavailable');
    const refused = await enable('wrong-engine', old.digest ?? '0'.repeat(64));
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(refused.body), /cannot be enabled/u);
  });

  it('is for people with the permission: reading for the read-only roles, managing for the owner', async () => {
    assert.equal((await instance.client().get('/plugins')).status, 401);
    const observer = await signInAs(instance, 'observer', observerSecret);
    assert.equal((await observer.get('/plugins')).status, 200);
    const digest = (await view('dns-example')).digest ?? '';
    for (const [name, secret] of [
      ['observer', observerSecret],
      ['operator', operatorSecret],
    ] as const) {
      await forgetLastStep(instance);
      const person = await signInAs(instance, name, secret);
      const denied = await person.post('/plugins/dns-example/enable', { digest });
      assert.equal(denied.status, 403, name);
      assert.equal(errorCode(denied), 'forbidden');
      assert.equal((await person.post('/plugins/dns-example/disable')).status, 403, name);
    }
    assert.equal((await view('dns-example')).status, 'not_enabled');
  });

  it('needs a fresh second factor to enable or disable', async () => {
    const digest = (await view('dns-example')).digest ?? '';
    await db().session.updateMany({ data: { elevatedUntil: new Date(Date.now() - 1000) } });
    const needsCode = await enable('dns-example', digest);
    assert.equal(needsCode.status, 403);
    assert.equal(errorCode(needsCode), 'step_up_required');
    assert.equal((await owner.post('/plugins/dns-example/disable')).status, 403);
    assert.equal((await view('dns-example')).status, 'not_enabled');
    await elevate();
  });

  it('refuses to approve files other than the ones that were shown', async () => {
    const stale = await enable('dns-example', 'a'.repeat(64));
    assert.equal(stale.status, 409);
    assert.match(JSON.stringify(stale.body), /changed since you looked/u);
    assert.equal(
      (await owner.post('/plugins/dns-example/enable', { digest: 'nonsense' })).status,
      400,
    );
    assert.equal((await enable('not-there', 'a'.repeat(64))).status, 404);
    assert.equal((await view('dns-example')).status, 'not_enabled');
  });

  it('enables a plugin, ties the approval to its digest and records who approved what', async () => {
    const shown = await view('dns-example');
    const reply = await enable('dns-example', shown.digest ?? '');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const plugin = PluginViewSchema.parse(reply.body);
    assert.equal(plugin.status, 'enabled');
    const { approval } = plugin;
    assert.ok(approval, 'the approval is on record');
    assert.equal(approval.digest, shown.digest);
    assert.equal(approval.approvedBy, 'owner');
    assert.equal(approval.version, '1.0.0');
    assert.deepEqual(approval.permissions, shown.permissions);
    assert.equal((await view('dns-example')).status, 'enabled');

    const record = found((await events('plugin.enabled')).at(-1), 'the record of the approval');
    assert.equal(record.actor?.name, 'owner');
    assert.deepEqual(record.object, { type: 'plugin', id: 'dns-example' });
    assert.deepEqual(record.details, {
      version: '1.0.0',
      trust: 'local',
      digest: shown.digest,
      network: 2,
      secrets: 1,
      panel: 0,
      ssh: false,
    });
  });

  it('does not revoke approval while a file has an unsafe link count', async () => {
    const entry = join(local, 'dns-example', 'dist', 'entry.js');
    const alias = join(local, 'another-entry.js');
    await link(entry, alias);
    try {
      assert.equal((await view('dns-example')).status, 'unavailable');
      const { pluginApproval } = db();
      assert.equal(
        (await pluginApproval.findUniqueOrThrow({ where: { pluginId: 'dns-example' } })).enabled,
        true,
      );
    } finally {
      await rm(alias);
    }
    assert.equal((await view('dns-example')).status, 'enabled');
  });

  it('retries when only file metadata changes between the digest walk and read', async (t) => {
    const entry = join(local, 'dns-example', 'dist', 'entry.js');
    const first = new Date('2026-01-01T00:00:00Z');
    const second = new Date('2026-01-02T00:00:00Z');
    await utimes(entry, first, first);
    const original = fs.lstat.bind(fs);
    let inspections = 0;
    const stat = t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      const result = await original(...args);
      if (args[0] === entry && ++inspections === 2) {
        await utimes(entry, second, second);
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      assert.equal((await view('dns-example')).status, 'enabled');
      assert.ok(inspections >= 4, 'the changed file was checked again');
    } finally {
      stat.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('switches off a plugin whose files changed, shows what it asks for now, and needs a new approval', async () => {
    const before = await view('dns-example');
    await writePlugin(local, 'dns-example', {
      version: '1.1.0',
      permissions: {
        network: ['api.example.com:443', 'dns.example.com:443', 'extra.example.org:443'],
        secrets: ['dns-oauth'],
        ssh: true,
      },
      entry: 'export default { changed: true };\n',
    });
    const changed = await view('dns-example');
    assert.equal(changed.status, 'changed');
    assert.notEqual(changed.digest, before.digest);
    assert.equal(changed.approval?.digest, before.digest, 'the old approval is still on record');
    assert.deepEqual(changed.change, {
      network: { added: ['extra.example.org:443'], removed: [] },
      secrets: { added: [], removed: [] },
      panel: { added: [], removed: [] },
      ssh: 'granted',
      widens: true,
    });
    const off = found(
      (await events('plugin.disabled')).at(-1),
      'the record of the automatic switch-off',
    );
    assert.equal(off.actor, null);
    assert.deepEqual(off.details, { reason: 'changed', version: '1.0.0' });
    // Reading again does not record it again.
    await list();
    assert.equal((await events('plugin.disabled')).length, 1);

    // The old digest no longer approves anything.
    assert.equal((await enable('dns-example', before.digest ?? '')).status, 409);
    const approved = await enable('dns-example', changed.digest ?? '');
    assert.equal(approved.status, 200);
    const now = await view('dns-example');
    assert.equal(now.status, 'enabled');
    assert.equal(now.approval?.version, '1.1.0');
    assert.equal(now.change, null);
  });

  it('switches a plugin off when Swellwright starts and finds it changed, and when it is gone', async () => {
    const service = instance.app.get(PluginsService);
    await writeFile(
      join(local, 'dns-example', 'dist', 'entry.js'),
      'export default { sneaky: 1 };\n',
    );
    await service.onApplicationBootstrap();
    assert.equal(
      (await db().pluginApproval.findUniqueOrThrow({ where: { pluginId: 'dns-example' } })).enabled,
      false,
    );
    assert.equal((await events('plugin.disabled')).length, 2);

    const digest = (await view('dns-example')).digest ?? '';
    assert.equal((await enable('dns-example', digest)).status, 200);
    await rm(join(local, 'dns-example'), { recursive: true, force: true });
    const gone = await view('dns-example');
    assert.equal(gone.status, 'missing');
    assert.equal(gone.folder, null);
    assert.equal(gone.approval?.version, '1.1.0');
    const last = found((await events('plugin.disabled')).at(-1), 'the record');
    assert.deepEqual(last.details, { reason: 'missing', version: '1.1.0' });
  });

  it('disables a plugin on request, leaves the approval on record and does it only once', async () => {
    await writePlugin(local, 'notify-example', { permissions: {} });
    const shown = await view('notify-example');
    assert.equal((await enable('notify-example', shown.digest ?? '')).status, 200);
    const before = (await events('plugin.disabled')).length;

    const reply = await owner.post('/plugins/notify-example/disable');
    assert.equal(reply.status, 200);
    const plugin = PluginViewSchema.parse(reply.body);
    assert.equal(plugin.status, 'disabled');
    assert.equal(plugin.approval?.digest, shown.digest);
    const record = found((await events('plugin.disabled')).at(-1), 'the record');
    assert.equal(record.actor?.name, 'owner');
    assert.deepEqual(record.details, { reason: 'administrator', version: '1.0.0' });

    assert.equal((await owner.post('/plugins/notify-example/disable')).status, 200);
    assert.equal((await events('plugin.disabled')).length, before + 1, 'nothing more was recorded');
    assert.equal((await owner.post('/plugins/dns-nothing/disable')).status, 404);

    // Enabling again is a new approval of what the files are then.
    assert.equal((await enable('notify-example', shown.digest ?? '')).status, 200);
    assert.equal((await view('notify-example')).status, 'enabled');
  });

  it('never lets a plugin that is not what was approved stay switched on', async () => {
    const enabled = await db().pluginApproval.findMany({ where: { enabled: true } });
    const listed = await list();
    for (const record of enabled) {
      const plugin = found(
        listed.find((p) => p.id === record.pluginId),
        record.pluginId,
      );
      assert.equal(plugin.status, 'enabled');
      assert.equal(plugin.digest, record.digest);
    }
  });
});
