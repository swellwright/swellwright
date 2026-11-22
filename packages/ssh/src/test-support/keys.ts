// Throwaway key material for tests. Keys are generated at run time; nothing here is a real credential and no key is
// stored in the repository.

import { createHash } from 'node:crypto';
import { utils } from '../ssh2.js';

export interface TestKeyPair {
  /** OpenSSH private key text. */
  privateKey: string;
  /** One line in the format of `authorized_keys`. */
  publicKey: string;
  passphrase?: string;
}

export function generateTestKeyPair(passphrase?: string): TestKeyPair {
  // About one ed25519 key in 300 comes out of the ssh2 generator malformed (a public key starting with a zero byte
  // loses it). Such a key cannot be parsed, so generate again until it can.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pair =
      passphrase === undefined
        ? utils.generateKeyPairSync('ed25519')
        : utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 16 });
    const privateOk = !(utils.parseKey(pair.private, passphrase) instanceof Error);
    const publicOk = !(utils.parseKey(pair.public) instanceof Error);
    if (privateOk && publicOk) {
      return {
        privateKey: pair.private,
        publicKey: pair.public.trim(),
        ...(passphrase === undefined ? {} : { passphrase }),
      };
    }
  }
  throw new Error('Could not generate a usable test key.');
}

/** An RSA key (the second type a real server has besides ed25519). 2048 bits keeps the generator fast. */
export function generateTestRsaKeyPair(): TestKeyPair {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pair = utils.generateKeyPairSync('rsa', { bits: 2048 });
    if (
      !(utils.parseKey(pair.private) instanceof Error) &&
      !(utils.parseKey(pair.public) instanceof Error)
    ) {
      return { privateKey: pair.private, publicKey: pair.public.trim() };
    }
  }
  throw new Error('Could not generate a usable RSA test key.');
}

/** `SHA256:` fingerprint of the public half of an OpenSSH key, as `ssh-keygen -l` prints it. */
export function publicKeyFingerprint(publicKeyLine: string): string {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/u)[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`;
}
