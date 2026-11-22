// Quoting and validation for everything that reaches a remote POSIX shell. Nothing a caller supplies is ever put into
// a command line unquoted: strings go through `shellQuote`, ids and paths are validated first.

import { SshInputError } from './errors.js';

// Control characters (including NUL and newline) have no business in a path, an id or a variable name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * Quotes a string for a POSIX shell: single quotes around it, every single quote inside replaced by `'\''`.
 * The result is one word whatever the value holds. A NUL cannot be passed to a process at all and is refused.
 */
export function shellQuote(value: string): string {
  if (value.includes('\0'))
    throw new SshInputError('A NUL character cannot be passed to a remote shell.');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Removes trailing copies of one character, in a loop: no regular expression runs on caller input. */
export function trimTrailing(text: string, character: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === character) end -= 1;
  return text.slice(0, end);
}

/** A host name or address: no whitespace or control characters, at most 255 characters. Returns it trimmed. */
export function checkedHost(host: string): string {
  const trimmed = host.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 255 ||
    /\s/u.test(trimmed) ||
    CONTROL.test(trimmed)
  ) {
    throw new SshInputError('The host is empty, too long or contains whitespace.');
  }
  return trimmed;
}

/** A TCP port. */
export function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new SshInputError('The port must be an integer from 1 to 65535.');
  return port;
}

/** A login name: 1 to 255 characters, no control characters. */
export function checkedUsername(username: string): string {
  if (username.length === 0 || username.length > 255 || CONTROL.test(username)) {
    throw new SshInputError('The username is empty, too long or contains control characters.');
  }
  return username;
}

const STEP_ID = /^[a-z0-9-]{1,64}$/u;

/** Step ids are chosen by the caller and used as directory names on the server: lowercase letters, digits, hyphen. */
export function assertStepId(id: string): void {
  if (!STEP_ID.test(id)) {
    throw new SshInputError('A step id is 1 to 64 characters from a-z, 0-9 and hyphen.');
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Names of environment variables: letters, digits and underscore, not starting with a digit. */
export function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name) || name.length > 128) {
    throw new SshInputError(
      'An environment variable name uses letters, digits and underscore and does not start with a digit.',
    );
  }
}

/** The names a secret of a step may have; also the name of its file and of the `<NAME>_FILE` variable. */
export const STEP_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** At most this many secrets and this many bytes per secret go to one step. */
export const MAX_STEP_SECRETS = 16;
export const MAX_STEP_SECRET_BYTES = 64 * 1024;

export function assertStepSecretName(name: string): void {
  if (!STEP_SECRET_NAME.test(name)) {
    throw new SshInputError(
      'A secret of a step is named with capital letters, digits and underscore, starting with a letter (64 characters at most).',
    );
  }
}

/** Values of environment variables and other payload text must not contain NUL. */
export function assertNoNul(value: string, what: string): void {
  if (value.includes('\0')) throw new SshInputError(`${what} must not contain a NUL character.`);
}

/**
 * A shell word (already quoted) for a directory on the server, from `/absolute/path` or `~/path/below/home`.
 * `~` is expanded by the remote shell from `$HOME`, so it works for every user without asking the server first.
 */
export function remoteDirWord(path: string): string {
  if (path.length === 0 || path.length > 1024)
    throw new SshInputError('A remote directory is 1 to 1024 characters.');
  if (CONTROL.test(path))
    throw new SshInputError('A remote directory must not contain control characters.');
  const relativeToHome = path.startsWith('~/');
  if (!relativeToHome && !path.startsWith('/')) {
    throw new SshInputError('A remote directory is an absolute path or starts with "~/".');
  }
  const rest = relativeToHome ? path.slice(1) : path;
  if (rest.split('/').includes('..'))
    throw new SshInputError('A remote directory must not contain ".." segments.');
  const cleaned = trimTrailing(rest, '/');
  if (relativeToHome) {
    if (cleaned.length === 0)
      throw new SshInputError('A remote directory below "~/" needs a name.');
    return `"$HOME"${shellQuote(cleaned)}`;
  }
  return shellQuote(cleaned.length === 0 ? '/' : cleaned);
}

/** The directory steps live in when the caller does not name one: per user, so that status polling finds it again. */
export function defaultStepBaseDir(username: string): string {
  return username === 'root' ? '/var/lib/swellwright/steps' : '~/.swellwright/steps';
}

/** An absolute remote path used by SFTP (no `~`: SFTP does not expand it). */
export function assertRemotePath(path: string): void {
  if (path.length === 0 || path.length > 4096)
    throw new SshInputError('A remote path is 1 to 4096 characters.');
  if (path.includes('\0'))
    throw new SshInputError('A remote path must not contain a NUL character.');
}

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;

/** Normalises an OpenSSH style fingerprint (`SHA256:` plus unpadded base64) and refuses anything else. */
export function normalizeFingerprint(value: string): string {
  const trimmed = trimTrailing(value.trim(), '=');
  if (!FINGERPRINT.test(trimmed)) {
    throw new SshInputError('A fingerprint looks like "SHA256:" followed by 43 base64 characters.');
  }
  return trimmed;
}
