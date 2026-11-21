import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';

import {
  ARTIFACT_FILE_PATTERN,
  ARTIFACT_NAME_PATTERN,
  ARTIFACT_SYSTEM_DIR,
  ARTIFACT_USER_DIR,
  ARTIFACT_VERSION_PATTERN,
  type ArtifactDestination,
} from '@swellwright/contracts';
import { type SftpClient, type SshConnection, shellQuote } from '@swellwright/ssh';

import { CodedHttpException } from '../http.js';

// What Swellwright says to a server when it moves an artifact. Every command is one fixed shape with quoted
// arguments, so the tests of the API can stand in for a server that answers exactly these (ssh-test-support.ts).

/** `/var/lib/swellwright`: the directory the system destination lives in (steps live there too). */
const ARTIFACT_SYSTEM_PARENT = ARTIFACT_SYSTEM_DIR.slice(0, ARTIFACT_SYSTEM_DIR.lastIndexOf('/'));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

export interface RemoteLayout {
  /** `<root>/<name>/<version>`: where the file lives. */
  readonly dir: string;
  /** `<root>/<name>`: removed too when it is left empty. */
  readonly nameDir: string;
  /** The file itself. */
  readonly path: string;
}

/** The directory every copy of this destination lives under, for a login whose home is `home`. */
export function remoteRoot(destination: ArtifactDestination, home: string): string {
  if (destination === 'system') {
    return ARTIFACT_SYSTEM_DIR;
  }
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  return `${base}/${ARTIFACT_USER_DIR}`;
}

/** Where the file of `name` `version` goes. The pieces are validated: a name, a version and a file are one segment each. */
export function remoteLayout(
  destination: ArtifactDestination,
  home: string,
  name: string,
  version: string,
  file: string,
): RemoteLayout {
  if (
    !ARTIFACT_NAME_PATTERN.test(name) ||
    !ARTIFACT_VERSION_PATTERN.test(version) ||
    !ARTIFACT_FILE_PATTERN.test(file) ||
    file.includes('..')
  ) {
    throw new Error('An artifact path is made of a plain name, version and file name.');
  }
  const root = remoteRoot(destination, home);
  return {
    nameDir: `${root}/${name}`,
    dir: `${root}/${name}/${version}`,
    path: `${root}/${name}/${version}/${file}`,
  };
}

/**
 * A path that was recorded when an artifact was pushed, accepted again only if it has exactly the shape a push makes:
 * the artifact directory of its destination, then the name, the version and one plain file name. Anything else (a
 * record that was edited, a path with `..` or a control character) is refused before a delete or a hash is run on it.
 */
export function checkedRemotePath(
  path: string,
  destination: ArtifactDestination,
  name: string,
  version: string,
): RemoteLayout | undefined {
  if (!path.startsWith('/') || path.length > 1024 || CONTROL.test(path)) {
    return undefined;
  }
  const marker = `/${name}/${version}/`;
  const at = path.lastIndexOf(marker);
  if (at < 0) {
    return undefined;
  }
  const root = path.slice(0, at);
  const file = path.slice(at + marker.length);
  if (!ARTIFACT_FILE_PATTERN.test(file) || file.includes('..')) {
    return undefined;
  }
  const rootOk =
    destination === 'system'
      ? root === ARTIFACT_SYSTEM_DIR
      : root.endsWith(`/${ARTIFACT_USER_DIR}`) &&
        root.length > ARTIFACT_USER_DIR.length + 1 &&
        !root.split('/').includes('..') &&
        !root.includes('//');
  if (!rootOk) {
    return undefined;
  }
  return { nameDir: `${root}/${name}`, dir: `${root}/${name}/${version}`, path };
}

// --- commands -------------------------------------------------------------------------------------------------

/** Who the login is and where its home is, in one round trip. */
export const IDENTIFY_COMMAND = `id -u && printf '%s\\n' "$HOME"`;
export const sha256Command = (path: string): string => `sha256sum -- ${shellQuote(path)}`;
export const chmodCommand = (mode: number, path: string): string =>
  `chmod ${mode.toString(8).padStart(4, '0')} -- ${shellQuote(path)}`;
export const removeFileCommand = (path: string): string => `rm -f -- ${shellQuote(path)}`;
export const removeDirCommand = (path: string): string => `rmdir -- ${shellQuote(path)}`;
/**
 * What is at a path, asked as root: `missing`, `other` (not a file) or the `sha256sum` line. The system directory
 * can be closed to the login (a root-only parent made by something else), and then SFTP cannot even look.
 */
export const inspectAsRootCommand = (path: string): string => {
  const quoted = shellQuote(path);
  return `if [ ! -e ${quoted} ]; then echo missing; elif [ -f ${quoted} ]; then sha256sum -- ${quoted}; else echo other; fi`;
};

/**
 * Puts a staged file in the system directory as root: the directory is made root-owned and readable by all, the file
 * is installed next to its final place under a temporary name (with the mode and the owner set by `install`, whatever
 * the umask) and renamed over it, which is atomic. Run as root, through the sudo wrapper of the SSH layer.
 */
export function installCommand(options: {
  readonly staged: string;
  readonly dir: string;
  readonly temporary: string;
  readonly final: string;
  readonly mode: number;
}): string {
  const mode = options.mode.toString(8).padStart(4, '0');
  // Every directory of the chain is named, so that each one is root-owned, 0755 and readable by all: the step layer
  // creates `/var/lib/swellwright` as 0700 when it runs as root, and a copy nobody else can reach is not "readable by
  // everybody" (the verify of a login that is not root could not look at it).
  const chain = [ARTIFACT_SYSTEM_PARENT, ARTIFACT_SYSTEM_DIR, options.dir];
  const unique = [...new Set(chain)];
  return [
    'umask 022',
    `install -d -m 0755 -o root -g root -- ${unique.map((directory) => shellQuote(directory)).join(' ')}`,
    `install -m ${mode} -o root -g root -- ${shellQuote(options.staged)} ${shellQuote(options.temporary)}`,
    `mv -f -- ${shellQuote(options.temporary)} ${shellQuote(options.final)}`,
  ].join(' && ');
}

// --- what a login can be asked ---------------------------------------------------------------------------------

export interface Identity {
  readonly uid: number;
  readonly home: string;
}

const failure = (message: string): CodedHttpException =>
  new CodedHttpException(502, 'ssh_failed', message);

/** The last line of a command's complaint, cut short: enough to say what went wrong, never a secret. */
function complaint(stderr: string): string {
  const line =
    stderr
      .trim()
      .split('\n')
      .filter((candidate) => candidate.trim() !== '')
      .at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160);
}

export async function identify(connection: SshConnection, timeoutMs: number): Promise<Identity> {
  const result = await connection.exec(IDENTIFY_COMMAND, { timeoutMs });
  const [uidText = '', home = ''] = result.stdout.split('\n');
  if (result.code !== 0 || !/^[0-9]{1,10}$/u.test(uidText.trim())) {
    throw failure(
      'The login works, but the server did not say who it is. A restricted shell or a forced command can cause this.',
    );
  }
  const trimmed = home.trim();
  if (!trimmed.startsWith('/') || trimmed.length > 512 || CONTROL.test(trimmed)) {
    throw failure('The login has no usable home directory, so there is nowhere to put the file.');
  }
  return { uid: Number(uidText.trim()), home: trimmed };
}

/** A sink that only hashes: reading a file back over SFTP when the server has no `sha256sum`. */
function hashingSink(): { sink: Writable; digest: () => string } {
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done();
    },
  });
  return { sink, digest: () => hash.digest('hex') };
}

/** What is at the place of a file on a server. */
export type RemoteFile =
  | { readonly state: 'missing' }
  /** A directory, a socket or the like where the file should be. */
  | { readonly state: 'other' }
  | { readonly state: 'file'; readonly sha256: string };

/**
 * What is at `path` on the server and, for a file, its SHA-256. The server hashes it (`sha256sum`); a server without
 * that program is asked for the bytes instead.
 */
export async function inspectRemote(
  connection: SshConnection,
  sftp: SftpClient,
  path: string,
  timeoutMs: number,
  root?: { readonly sudo: { password?: string } },
): Promise<RemoteFile> {
  if (root !== undefined) {
    // As root, in one command: a login that is not root may not be able to look at the directory at all.
    const asked = await connection.exec(inspectAsRootCommand(path), { ...root, timeoutMs });
    const line = asked.stdout.trim();
    if (asked.code === 0 && line === 'missing') {
      return { state: 'missing' };
    }
    if (asked.code === 0 && line === 'other') {
      return { state: 'other' };
    }
    const found = /^([0-9a-f]{64})\s/u.exec(line)?.[1];
    if (asked.code === 0 && found !== undefined) {
      return { state: 'file', sha256: found };
    }
    throw failure(
      `The server could not hash the file (${complaint(asked.stderr) || `exit status ${String(asked.code)}`}).`,
    );
  }
  const info = await sftp.stat(path);
  if (info === null) {
    return { state: 'missing' };
  }
  if (!info.isFile) {
    return { state: 'other' };
  }
  const result = await connection.exec(sha256Command(path), { timeoutMs });
  const hash = /^([0-9a-f]{64})\s/u.exec(result.stdout)?.[1];
  if (result.code === 0 && hash !== undefined) {
    return { state: 'file', sha256: hash };
  }
  if (result.code === 127) {
    const { sink, digest } = hashingSink();
    await sftp.get(path, sink);
    return { state: 'file', sha256: digest() };
  }
  throw failure(
    `The server could not hash the file (${complaint(result.stderr) || `exit status ${String(result.code)}`}).`,
  );
}
