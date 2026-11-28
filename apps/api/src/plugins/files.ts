import { constants, type BigIntStats, type Dir, type Dirent, type Stats } from 'node:fs';
import { lstat, open, opendir, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** What reading a file of a plugin gave: its bytes, nothing because it is not there, or why it was refused. */
export type BoundedRead =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string };

/** File verification failed without establishing that the approved bytes changed. */
export class PluginFilesUnavailable extends Error {
  constructor(
    message: string,
    readonly issue: 'hard_link' | 'unstable' = 'unstable',
  ) {
    super(message);
  }
}

export function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = fileErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function fileStamp(info: BigIntStats): string {
  return [info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev, info.nlink].join('\0');
}

/** Reject a final-component link and avoid blocking on a substituted FIFO where the OS supports these flags. */
const flags = constants as Record<string, number | undefined>;
const OPEN_FLAGS = constants.O_RDONLY | (flags['O_NONBLOCK'] ?? 0) | (flags['O_NOFOLLOW'] ?? 0);

export class PluginPathRefused extends Error {
  constructor() {
    super('must be a relative path inside the plugin directory');
  }
}

interface PluginPathOperations {
  lstat: Promise<Stats>;
  lstatBig: Promise<BigIntStats>;
  open: Promise<FileHandle>;
  opendir: Promise<Dir>;
  readdir: Promise<Dirent[]>;
  realpath: Promise<string>;
}

/**
 * The lexical boundary for plugin paths, including names from a directory listing.
 * `undefined` explicitly names the caller's root for directory/realpath operations.
 * Keep the filesystem calls beside the normalized, separator-delimited containment check.
 */
export function resolveInsidePlugin(root: string, name: string): string;
export function resolveInsidePlugin<Operation extends keyof PluginPathOperations>(
  root: string,
  name: Operation extends 'opendir' | 'readdir' | 'realpath' ? string | undefined : string,
  operation: Operation,
): PluginPathOperations[Operation];
export function resolveInsidePlugin(
  root: string,
  name: string | undefined,
  operation?: keyof PluginPathOperations,
): string | PluginPathOperations[keyof PluginPathOperations] {
  if (
    name !== undefined &&
    (isAbsolute(name) ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.includes(':') ||
      name
        .replace(/^\.\//u, '')
        .split('/')
        .some(
          (part) =>
            part === '' ||
            part === '.' ||
            part === '..' ||
            (process.platform === 'win32' && /[. ]$/u.test(part)),
        ))
  ) {
    throw new PluginPathRefused();
  }
  const base = resolve(root);
  const anchor = base.endsWith(sep) ? base.slice(0, -1) : base;
  const path = name === undefined ? anchor + sep : resolve(base, name);
  if (!path.startsWith(anchor + sep)) {
    throw new PluginPathRefused();
  }
  switch (operation) {
    case 'lstat':
      return lstat(path);
    case 'lstatBig':
      return lstat(path, { bigint: true });
    case 'open':
      return open(path, OPEN_FLAGS);
    case 'opendir':
      return opendir(path);
    case 'readdir':
      return readdir(path, { withFileTypes: true });
    case 'realpath':
      return realpath(path);
    case undefined:
      return path;
  }
}

/**
 * Reads an ordinary relative file of at most `limit` bytes, with no links below `root`.
 * A file that changes during the bounded read is refused.
 */
export async function readBoundedFile(
  root: string,
  name: string,
  limit: number,
  expectedStamp?: string,
  metadataOnly = false,
): Promise<BoundedRead> {
  let info;
  let real: string;
  let realRoot: string;
  try {
    info = await resolveInsidePlugin(root, name, 'lstatBig');
    if (!info.isFile()) {
      return { kind: 'refused', reason: 'is not a regular file (links are not followed)' };
    }
    if (info.nlink !== 1n) {
      throw new PluginFilesUnavailable(
        'A plugin file must have exactly one hard link; install an independent copy.',
        'hard_link',
      );
    }
    if (expectedStamp !== undefined && fileStamp(info) !== expectedStamp) {
      throw new PluginFilesUnavailable('Plugin files changed while being checked.');
    }
    if (info.size > limit) {
      return { kind: 'refused', reason: `is larger than ${String(Math.floor(limit / 1024))} KiB` };
    }
    realRoot = await resolveInsidePlugin(root, undefined, 'realpath');
    real = await resolveInsidePlugin(root, name, 'realpath');
  } catch (error) {
    if (error instanceof PluginPathRefused) {
      return { kind: 'refused', reason: error.message };
    }
    if (isMissing(error)) {
      return { kind: 'missing' };
    }
    if (fileErrorCode(error) === 'ELOOP') {
      return { kind: 'refused', reason: 'is reached through a link' };
    }
    throw error;
  }
  const withinRoot = relative(realRoot, real);
  if (
    withinRoot === '' ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    return { kind: 'refused', reason: 'leads outside the plugin directory' };
  }
  if (relative(resolveInsidePlugin(realRoot, name), real) !== '') {
    return { kind: 'refused', reason: 'is reached through a link' };
  }
  const stamp = fileStamp(info);
  if (metadataOnly) {
    return { kind: 'data', data: Buffer.alloc(0) };
  }
  let handle;
  try {
    handle = await resolveInsidePlugin(realRoot, name, 'open');
  } catch (error) {
    if (isMissing(error)) {
      return { kind: 'missing' };
    }
    if (fileErrorCode(error) === 'ELOOP') {
      return { kind: 'refused', reason: 'is reached through a link' };
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    // The file that was opened must be the one that was looked at: not swapped for another between the two.
    if (!opened.isFile() || fileStamp(opened) !== stamp) {
      throw new PluginFilesUnavailable('Plugin files changed while being checked.');
    }
    const size = Number(opened.size);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length !== size || fileStamp(await handle.stat({ bigint: true })) !== stamp) {
      throw new PluginFilesUnavailable('Plugin files changed while being checked.');
    }
    return { kind: 'data', data: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}
