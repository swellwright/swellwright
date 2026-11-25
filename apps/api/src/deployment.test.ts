// What the files of the deployment (the image, the Compose file) must keep in step with the code. A container that cannot start
// is found by a person running it; these tests find it earlier, from the files themselves.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { STOP_DRAIN_MS } from '@swellwright/engine';
import { parse } from 'yaml';

import { loadConfig } from './config.js';

/** `apps/api/src` and `apps/api/dist` are at the same depth: the root of the repository is three levels up. */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
}

/** Every workspace package by name, with the directory it is in. */
function workspace(): Map<string, { readonly dir: string; readonly manifest: Manifest }> {
  const found = new Map<string, { readonly dir: string; readonly manifest: Manifest }>();
  for (const parent of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const manifest = JSON.parse(read(`${parent}/${entry.name}/package.json`)) as Manifest;
        if (manifest.name !== undefined) {
          found.set(manifest.name, { dir: `${parent}/${entry.name}`, manifest });
        }
      } catch {
        // A directory without a manifest is not a package.
      }
    }
  }
  return found;
}

/** The workspace packages that the API needs at run time: its `dependencies`, and theirs, as far as they go. */
function runtimePackages(): string[] {
  const packages = workspace();
  const needed = new Set<string>();
  const queue = ['@swellwright/api'];
  while (queue.length > 0) {
    const name = queue.pop() ?? '';
    for (const [dependency, range] of Object.entries(
      packages.get(name)?.manifest.dependencies ?? {},
    )) {
      if (range.startsWith('workspace:') && !needed.has(dependency)) {
        needed.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...needed]
    .map((name) => packages.get(name)?.dir ?? '')
    .filter((dir) => dir.startsWith('packages/'))
    .sort();
}

describe('the container image', () => {
  const dockerfile = read('Dockerfile');
  const copied = new Set(
    [
      ...dockerfile.matchAll(
        /^COPY --from=build \/app\/(packages\/[^/\s]+)\/dist \.\/\1\/dist$/gmu,
      ),
    ].map((match) => match[1] ?? ''),
  );

  it('carries the built code of every workspace package the server depends on, or the server does not start', () => {
    const needed = runtimePackages();
    // The check has something to hold: the packages that the server certainly needs are among them.
    for (const dir of ['packages/contracts', 'packages/db', 'packages/engine', 'packages/ssh']) {
      assert.ok(needed.includes(dir), `${dir} is a dependency of the API`);
    }
    const missing = needed.filter((dir) => !copied.has(dir));
    assert.deepEqual(missing, [], `the image does not copy the dist of: ${missing.join(', ')}`);
  });

  it('carries nothing that the server does not depend on', () => {
    const needed = new Set(runtimePackages());
    const extra = [...copied].filter((dir) => !needed.has(dir));
    assert.deepEqual(
      extra,
      [],
      `the image copies packages that the server does not use: ${extra.join(', ')}`,
    );
  });
});

/** A Compose duration (`30s`, `1m30s`) in milliseconds. */
function durationMs(text: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u.exec(text);
  assert.ok(match && text !== '', `"${text}" is a duration in the form 1m30s`);
  return (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
}

describe('the Compose file', () => {
  const compose = parse(read('deploy/compose/docker-compose.yml')) as {
    services: Record<string, { stop_grace_period?: string } | undefined>;
  };

  it('gives the server time to stop its run engine before the container is killed', () => {
    const grace = compose.services['swellwright']?.stop_grace_period;
    assert.ok(
      grace,
      'the server has a stop_grace_period (Docker gives 10 seconds when there is none)',
    );
    // The loop waits for the step in hand for the timeout, then for the writes on their way for a few seconds more; the rest
    // of the server closes after it (the database, the vault, the connections), and needs some seconds too.
    const { stopTimeoutMs } = loadConfig({}, 'v').engine;
    const needed = stopTimeoutMs + STOP_DRAIN_MS + 10_000;
    assert.ok(
      durationMs(grace) >= needed,
      `stop_grace_period ${grace} is shorter than ${String(needed / 1000)} s: the default stop timeout, the drain and ten seconds for the rest`,
    );
  });
});
