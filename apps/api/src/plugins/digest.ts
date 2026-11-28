import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { fileErrorCode, fileStamp, PluginFilesUnavailable, readBoundedFile } from './files.js';

/** What a plugin may weigh. A plugin is a few files; more than this is not one (and hashing it is not free). */
export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 12;

export type DigestResult =
  | { readonly ok: true; readonly digest: string; readonly files: number; readonly bytes: number }
  | {
      readonly ok: false;
      readonly problem: string;
      readonly transient?: true;
      readonly hardLink?: true;
    };

/** Directories count too, so even a tree of empty directories has a bounded walk. */
const MAX_PLUGIN_ENTRIES = 4_000;

interface Entry {
  readonly path: string;
  readonly size: number;
  /** What the file system says about the file, for the cache: a change of any of these hashes it again. */
  readonly stamp: string;
}

type Walk =
  | { readonly ok: true; readonly entries: readonly Entry[] }
  | { readonly ok: false; readonly problem: string };

async function walk(root: string): Promise<Walk> {
  const entries: Entry[] = [];
  let bytes = 0;
  let seen = 0;
  const visit = async (relative: string, depth: number): Promise<string | undefined> => {
    if (depth > MAX_DEPTH) {
      return `"${relative}" is nested more than ${String(MAX_DEPTH)} directories deep`;
    }
    const found = await opendir(join(root, relative));
    for await (const entry of found) {
      if (++seen > MAX_PLUGIN_ENTRIES) {
        return `has more than ${String(MAX_PLUGIN_ENTRIES)} directory entries`;
      }
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // A link is refused before anything else, `.git` included: the process of the plugin may read its whole
      // directory, and the permission model follows a link inside it to wherever it leads.
      if (entry.isSymbolicLink()) {
        return `"${path}" is a link; a plugin may not contain links`;
      }
      if (entry.isDirectory()) {
        const problem = await visit(path, depth + 1);
        if (problem !== undefined) {
          return problem;
        }
        continue;
      }
      if (!entry.isFile()) {
        return `"${path}" is neither a file nor a directory`;
      }
      const info = await lstat(join(root, path), { bigint: true });
      if (!info.isFile()) {
        return `"${path}" is not a regular file with one link`;
      }
      if (info.nlink !== 1n) {
        throw new PluginFilesUnavailable(
          `"${path}" must have exactly one hard link; install an independent copy.`,
          'hard_link',
        );
      }
      const size = Number(info.size);
      bytes += size;
      if (entries.length >= MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) {
        return `is larger than a plugin may be (${String(MAX_PLUGIN_FILES)} files, ${String(MAX_PLUGIN_BYTES / 1024 / 1024)} MiB)`;
      }
      // The modification time can be set to anything by whoever writes the file; the change time and the inode
      // cannot, so a file replaced with the same size and an old modification time is still hashed again.
      entries.push({
        path,
        size,
        stamp: fileStamp(info),
      });
    }
    return undefined;
  };
  const problem = await visit('', 0);
  if (problem !== undefined) {
    return { ok: false, problem };
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, entries };
}

/**
 * What was hashed last, per directory, so that an unchanged plugin is not read again each time the list is
 * asked for. The key is what the file system says (names, sizes, modification and change times, inodes); the value
 * is the digest.
 */
const cache = new Map<string, { readonly signature: string; readonly result: DigestResult }>();

/**
 * A SHA-256 over every file of the plugin: the path, the size and the hash of the content of each, in order of
 * path. This is what an administrator approves (ADR 0027), so a changed, added or removed file is a different
 * plugin. This includes `.git`: an import or read from approved code can reach it. Links are refused anywhere
 * inside: a link could lead a plugin's reads outside its directory.
 */
export async function digestPlugin(directory: string): Promise<DigestResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await digestOnce(directory);
    } catch (error) {
      if (!(error instanceof PluginFilesUnavailable) && fileErrorCode(error) === undefined) {
        throw error;
      }
      const hardLink = error instanceof PluginFilesUnavailable && error.issue === 'hard_link';
      if (attempt > 0 || hardLink) {
        return {
          ok: false,
          transient: true,
          ...(hardLink ? { hardLink: true } : {}),
          problem:
            error instanceof PluginFilesUnavailable
              ? error.message
              : 'Plugin files could not be read.',
        };
      }
    }
  }
}

async function digestOnce(directory: string): Promise<DigestResult> {
  const found = await walk(directory);
  if (!found.ok) {
    return found;
  }
  const signature = createHash('sha256')
    .update(found.entries.map((e) => `${e.path}\0${String(e.size)}\0${e.stamp}`).join('\n'))
    .digest('hex');
  const cached = cache.get(directory);
  if (cached?.signature === signature) {
    return cached.result;
  }
  const outer = createHash('sha256');
  let bytes = 0;
  for (const entry of found.entries) {
    // Read as it was listed: an ordinary file inside the plugin, at most the size that was counted.
    const read = await readBoundedFile(
      directory,
      join(directory, entry.path),
      entry.size,
      entry.stamp,
    );
    if (read.kind === 'missing') {
      throw new PluginFilesUnavailable('A plugin file disappeared while being checked.');
    }
    if (read.kind !== 'data') {
      return {
        ok: false,
        problem: `"${entry.path}" ${read.reason}`,
      };
    }
    const content = read.data;
    bytes += content.length;
    const inner = createHash('sha256').update(content).digest('hex');
    outer.update(`${entry.path}\0${String(content.length)}\0${inner}\n`);
  }
  const result: DigestResult = {
    ok: true,
    digest: outer.digest('hex'),
    files: found.entries.length,
    bytes,
  };
  cache.set(directory, { signature, result });
  return result;
}
