import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

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

/**
 * Reads an ordinary file of at most `limit` bytes inside `root`, with no links in the path below the root.
 * The type and size are checked before reading. A file that changes during the bounded read is refused.
 */
export async function readBoundedFile(
  root: string,
  path: string,
  limit: number,
  expectedStamp?: string,
  metadataOnly = false,
): Promise<BoundedRead> {
  const local = relative(root, path);
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    return { kind: 'refused', reason: 'leads outside the plugin directory' };
  }
  let info;
  let real: string;
  let realRoot: string;
  try {
    info = await lstat(path, { bigint: true });
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
    realRoot = await realpath(root);
    real = await realpath(path);
  } catch (error) {
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
  if (relative(join(realRoot, local), real) !== '') {
    return { kind: 'refused', reason: 'is reached through a link' };
  }
  const stamp = fileStamp(info);
  if (metadataOnly) {
    return { kind: 'data', data: Buffer.alloc(0) };
  }
  let handle;
  try {
    handle = await open(real, OPEN_FLAGS);
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
