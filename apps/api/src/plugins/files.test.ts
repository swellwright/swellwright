import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { readBoundedFile } from './files.js';

it('refuses non-relative or ambiguous plugin paths before touching the filesystem', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'sw-plugin-path-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'plugin');
  await mkdir(root);
  const inside = join(root, 'entry.js');
  await writeFile(inside, 'fixture');

  const stats = t.mock.method(fs, 'lstat');
  const resolves = t.mock.method(fs, 'realpath');
  const opens = t.mock.method(fs, 'open');
  syncBuiltinESMExports();
  try {
    for (const path of [
      inside,
      '/entry.js',
      '../plugin-other/entry.js',
      'dist/../entry.js',
      'dist//entry.js',
      'dist\\entry.js',
      'C:entry.js',
      'entry.js:stream',
      'entry\0.js',
      '.',
      '',
    ]) {
      assert.equal((await readBoundedFile(root, path, 32)).kind, 'refused', JSON.stringify(path));
    }
    assert.equal(stats.mock.callCount(), 0);
    assert.equal(resolves.mock.callCount(), 0);
    assert.equal(opens.mock.callCount(), 0);
  } finally {
    stats.mock.restore();
    resolves.mock.restore();
    opens.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readBoundedFile(root, './entry.js', 32), {
    kind: 'data',
    data: Buffer.from('fixture'),
  });
});

it('refuses directory links without opening files, including links within the plugin', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'sw-plugin-links-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'plugin');
  const inside = join(root, 'inside');
  const sibling = join(base, 'plugin-other');
  await mkdir(inside, { recursive: true });
  await mkdir(sibling);
  await writeFile(join(inside, 'entry.js'), 'inside fixture');
  await writeFile(join(sibling, 'entry.js'), 'outside fixture');
  await symlink(inside, join(root, 'alias'), 'junction');
  await symlink(sibling, join(root, 'outside'), 'junction');

  const opens = t.mock.method(fs, 'open');
  syncBuiltinESMExports();
  try {
    for (const path of ['alias/entry.js', 'outside/entry.js']) {
      assert.equal((await readBoundedFile(root, path, 32)).kind, 'refused', path);
    }
    assert.equal(opens.mock.callCount(), 0);
  } finally {
    opens.mock.restore();
    syncBuiltinESMExports();
  }
});
