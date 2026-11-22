// Host key handling: fingerprints, the pinned/discover policy and `fetchHostKey`.

import { createHash, timingSafeEqual } from 'node:crypto';
import { Socket } from 'node:net';
import { Client } from './ssh2.js';

import { SshConnectError, SshInputError, SshTimeoutError, messageOf } from './errors.js';
import { checkedHost, checkedPort, normalizeFingerprint, trimTrailing } from './shell.js';
import { mapHandshakeError, type Ssh2ErrorLike } from './ssh2-errors.js';
import type { HostKeyPolicy, ServerHostKey, SshAlgorithms } from './types.js';

/** `SHA256:` plus the unpadded base64 SHA-256 of a host key blob, the format `ssh-keygen -l` prints. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${trimTrailing(createHash('sha256').update(blob).digest('base64'), '=')}`;
}

/** The key type: the first SSH string of the key blob. */
export function algorithmOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || blob.length < 4 + length) return 'unknown';
  return blob.toString('latin1', 4, 4 + length);
}

export function describeHostKey(blob: Buffer): ServerHostKey {
  return { algorithm: algorithmOf(blob), fingerprintSha256: fingerprintOf(blob) };
}

/** Constant-time check of a fingerprint against the pinned ones. */
export function matchesPinned(actual: string, pinned: readonly string[]): boolean {
  const a = Buffer.from(actual);
  let found = false;
  for (const candidate of pinned) {
    const b = Buffer.from(candidate);
    // Every candidate is compared, so the time does not tell which one (if any) matched.
    if (a.length === b.length && timingSafeEqual(a, b)) found = true;
  }
  return found;
}

const KEY_TYPE = /^[a-z0-9][a-z0-9@.-]{1,63}$/u;

/** Validates a policy and returns it with normalised fingerprints. */
export function normalizePolicy(policy: HostKeyPolicy): HostKeyPolicy {
  if (policy.mode === 'discover') return { mode: 'discover' };
  if (policy.fingerprints.length === 0) {
    throw new SshInputError('A pinned host key policy needs at least one fingerprint.');
  }
  const keyTypes = policy.keyTypes;
  if (
    keyTypes !== undefined &&
    (keyTypes.length > 16 || keyTypes.some((type) => !KEY_TYPE.test(type)))
  ) {
    throw new SshInputError(
      'The key types of a pinned host key policy are names like ssh-ed25519.',
    );
  }
  return {
    mode: 'pinned',
    fingerprints: policy.fingerprints.map((fingerprint) => normalizeFingerprint(fingerprint)),
    ...(keyTypes === undefined ? {} : { keyTypes: [...keyTypes] }),
  };
}

/**
 * The host key algorithms ssh2 offers by default, most preferred first. Kept here (and not read from ssh2) because
 * the order below puts the pinned types first and must still offer all the others.
 */
const HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
] as const;

const RSA_FAMILY = new Set(['ssh-rsa', 'rsa-sha2-512', 'rsa-sha2-256']);

/**
 * The `serverHostKey` list for a connection to a server whose pinned keys have these types: the algorithms that
 * produce the pinned types first, then every other one. A server with several host keys shows the first algorithm of
 * the list that it has a key for, so it shows the pinned key when it still has it, and another key (which the
 * fingerprint check refuses) only when the pinned one is gone.
 */
export function hostKeyAlgorithmsPreferring(keyTypes: readonly string[]): string[] {
  const first: string[] = [];
  for (const type of keyTypes) {
    const names = RSA_FAMILY.has(type) ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type];
    for (const name of names) {
      if ((HOST_KEY_ALGORITHMS as readonly string[]).includes(name) && !first.includes(name)) {
        first.push(name);
      }
    }
  }
  return [...first, ...HOST_KEY_ALGORITHMS.filter((name) => !first.includes(name))];
}

/** The `algorithms` option for a policy: the caller's own `serverHostKey` list wins, else the pinned types lead. */
export function withPinnedKeyTypes(
  algorithms: SshAlgorithms | undefined,
  policy: HostKeyPolicy,
): SshAlgorithms | undefined {
  if (policy.mode !== 'pinned' || policy.keyTypes === undefined || policy.keyTypes.length === 0) {
    return algorithms;
  }
  if (algorithms?.serverHostKey !== undefined) return algorithms;
  return { ...algorithms, serverHostKey: hostKeyAlgorithmsPreferring(policy.keyTypes) };
}

/** Maps our allow-lists onto the `algorithms` option of ssh2 (exact lists only). */
export function toSsh2Algorithms(
  algorithms: SshAlgorithms | undefined,
): Record<string, string[]> | undefined {
  if (algorithms === undefined) return undefined;
  const out: Record<string, string[]> = {};
  for (const key of ['kex', 'cipher', 'hmac', 'serverHostKey'] as const) {
    const list = algorithms[key];
    if (list !== undefined) {
      if (list.length === 0)
        throw new SshInputError(`The ${key} algorithm list must not be empty.`);
      out[key] = [...list];
    }
  }
  return out;
}

export interface FetchHostKeyOptions {
  /** Deadline for TCP connect plus key exchange. Default 10000. */
  timeoutMs?: number;
  algorithms?: SshAlgorithms;
}

/**
 * Opens a TCP connection, runs the SSH key exchange up to the point where the server presents its host key,
 * records the key and disconnects. The handshake is aborted in the host key check, which happens before the client
 * asks for the `ssh-userauth` service, so no username, password or key is ever sent. Use it to show a fingerprint
 * for confirmation before pinning it.
 */
export async function fetchHostKey(
  host: string,
  port = 22,
  options: FetchHostKeyOptions = {},
): Promise<ServerHostKey> {
  const checked = checkedHost(host);
  checkedPort(port);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const algorithms = toSsh2Algorithms(options.algorithms);

  return new Promise<ServerHostKey>((resolve, reject) => {
    const client = new Client();
    const socket = new Socket();
    let captured: ServerHostKey | undefined;
    let settled = false;

    const finish = (outcome: { key: ServerHostKey } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      client.removeAllListeners();
      client.on('error', () => undefined);
      socket.destroy();
      if ('key' in outcome) resolve(outcome.key);
      else reject(outcome.error);
    };

    const backstop = setTimeout(() => {
      finish({ error: new SshTimeoutError('connect', timeoutMs) });
    }, timeoutMs + 1000);

    client.on('error', (error: Ssh2ErrorLike) => {
      // The deliberate refusal below also ends in an error event; the key has been captured by then.
      if (captured !== undefined) {
        finish({ key: captured });
        return;
      }
      finish({ error: mapHandshakeError(error, timeoutMs, []) });
    });
    client.on('close', () => {
      finish(
        captured === undefined
          ? {
              error: new SshConnectError(
                'The connection closed before a host key was presented.',
                'closed',
              ),
            }
          : { key: captured },
      );
    });

    socket.on('error', (error: Ssh2ErrorLike) => {
      finish({
        error: mapHandshakeError(Object.assign(error, { level: 'client-socket' }), timeoutMs, []),
      });
    });
    socket.connect({ host: checked, port });

    try {
      client.connect({
        sock: socket,
        // The handshake never reaches authentication; ssh2 only insists on a string here.
        username: 'swellwright-hostkey-probe',
        readyTimeout: timeoutMs,
        ...(algorithms === undefined ? {} : { algorithms }),
        hostVerifier: (blob: Buffer): boolean => {
          captured = describeHostKey(blob);
          // Refuse: the client disconnects here, before it asks for the user authentication service.
          return false;
        },
      });
    } catch (error) {
      finish({ error: new SshInputError(`Invalid connection settings: ${messageOf(error)}`) });
    }
  });
}
