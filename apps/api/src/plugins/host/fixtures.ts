import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConfigValues } from '@swellwright/plugin-api';

import { NetworkRefused, type PluginNetwork } from './network.js';
import type { CoreServices } from './process.js';

/** Shared by the tests of the plugin host: a plugin written to a temporary directory. Not part of the application. */

/** A plugin's module as text: every method a test needs, written the way a plugin author would. */
export const FIXTURE_MODULE = `
export default {
  methods: {
    echo: (params) => params,
    config: (params, context) => context.config,
    secret: (params, context) => context.secret(params.field),
    secretRefused: async (params, context) => {
      try { return await context.secret(params.field); } catch (error) { return 'refused: ' + error.message; }
    },
    store: async (params, context) => {
      await context.storage.set(params.key, params.value);
      return context.storage.get(params.key);
    },
    storedKeys: (params, context) => context.storage.keys(),
    forget: async (params, context) => { await context.storage.delete(params.key); return context.storage.keys(); },
    pid: () => process.pid,
    keep: (params, context) => { globalThis.kept = context; return 'kept'; },
    later: async (params) => {
      try { return await globalThis.kept.secret(params.field); } catch (error) { return 'refused: ' + error.message; }
    },
    printAndDie: async (params, context) => {
      const value = await context.secret(params.field);
      console.log('diagnostics: ' + value);
      console.error('diagnostics: ' + value);
      process.exit(3);
    },
    flood: async (params, context) => {
      let refused = '';
      for (let i = 0; i < params.times; i++) {
        try { await context.storage.keys(); } catch (error) { refused = error.message; }
      }
      return refused;
    },
    burst: (params, context) => Promise.all(
      Array.from({ length: params.times }, () => context.storage.keys())
    ),
    rogue: (params) => { process.send(params.message); return new Promise(() => {}); },
    slow: () => new Promise((resolve) => setTimeout(() => resolve('slow'), 300)),
    throws: () => { throw new Error('nope'); },
    loop: () => { for (;;) { /* never returns */ } },
    hog: () => { const keep = []; for (;;) keep.push({ n: keep.length, text: 'x'.repeat(100) }); },
    viaCore: async (params, context) => {
      const response = await context.fetch(params.url, params.init);
      return { status: response.status, ok: response.ok, body: await response.text() };
    },
    refused: async (params, context) => {
      try { await context.fetch(params.url); return 'allowed'; } catch (error) { return error.message; }
    },
    probe: async (params) => {
      const results = {};
      const attempt = async (name, fn) => {
        try { results[name] = { ok: true, value: String(await fn()).slice(0, 60) }; }
        catch (error) { results[name] = { ok: false, code: error.code ?? (error.cause && error.cause.code) ?? error.name }; }
      };
      const fs = await import('node:fs');
      const cp = await import('node:child_process');
      const wt = await import('node:worker_threads');
      await attempt('readOwn', () => fs.readFileSync(new URL(import.meta.url)).length);
      await attempt('readOutside', () => fs.readFileSync(params.outside, 'utf8'));
      await attempt('writeOwn', () => fs.writeFileSync(new URL('./written.txt', import.meta.url), 'x'));
      await attempt('spawn', () => cp.spawnSync(process.execPath, ['-v']));
      await attempt('worker', () => new wt.Worker(new URL(import.meta.url)));
      await attempt('fetch', async () => (await fetch('http://127.0.0.1:' + params.port + '/')).status);
      await attempt('eval', () => eval('1 + 1'));
      await attempt('newFunction', () => new Function('return 1')());
      await attempt('binding', () => process.binding('fs'));
      results.envKeys = Object.keys(process.env);
      return results;
    },
  },
};
`;

export const FIXTURE_MANIFEST = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  version: '1.0.0',
  name: `The ${id} plugin`,
  engines: { swellwright: '>=0.0.0-0 <1' },
  provides: [{ kind: 'DnsProvider', entry: './dist/entry.js' }],
  permissions: { network: ['api.example.com:443'] },
  license: 'AGPL-3.0-only',
  ...extra,
});

export async function writeFixture(
  root: string,
  id: string,
  module: string = FIXTURE_MODULE,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const directory = join(root, id);
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(
    join(directory, 'swellwright.plugin.json'),
    JSON.stringify(FIXTURE_MANIFEST(id, extra)),
  );
  await writeFile(join(directory, 'dist', 'entry.js'), module);
  return directory;
}

/** The core's services for a plugin in the tests that run a process without the application: all in memory. */
export function servicesFor(options: {
  readonly gateway: PluginNetwork;
  readonly network?: readonly string[];
  readonly settings?: ConfigValues;
  readonly secrets?: Readonly<Record<string, string>>;
  /** Fields whose secret the vault refuses as expired. */
  readonly expired?: readonly string[];
  readonly onRefused?: (host: string, reason: string) => void;
}): CoreServices {
  const store = new Map<string, unknown>();
  return {
    settings: () => Promise.resolve(options.settings ?? {}),
    fetch: async (url, init, signal) => {
      try {
        return await options.gateway.fetch(
          'dns-example',
          options.network ?? ['api.example.com:443'],
          url,
          init,
          signal,
        );
      } catch (error) {
        if (error instanceof NetworkRefused) {
          options.onRefused?.(new URL(url).host, error.reason);
        }
        throw error;
      }
    },
    secret: (field) => {
      if (options.expired?.includes(field) === true) {
        // What the broker raises for an expired secret: the text, and the stable code beside it.
        return Promise.reject(
          Object.assign(new Error(`secret_expired: the secret for ${field} has expired`), {
            code: 'secret_expired',
          }),
        );
      }
      const value = options.secrets?.[field];
      return value === undefined
        ? Promise.reject(new Error(`no secret is chosen for ${field}`))
        : Promise.resolve(value);
    },
    storage: {
      get: (key) => Promise.resolve(store.get(String(key)) ?? null),
      set: (key, value) => {
        store.set(String(key), value);
        return Promise.resolve();
      },
      delete: (key) => {
        store.delete(String(key));
        return Promise.resolve();
      },
      keys: () => Promise.resolve([...store.keys()].sort()),
    },
  };
}
