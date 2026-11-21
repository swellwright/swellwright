import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ErrorCode, SSH_FAILURE_CODES } from '@swellwright/contracts';
import {
  fetchHostKey,
  HostKeyMismatchError,
  hostKeyAlgorithmsPreferring,
  resolveTargetAddress,
  type ServerHostKey,
  SshAuthError,
  SshConnectError,
  type SshConnection,
  SshError,
  SshInputError,
  SshPool,
  SshTimeoutError,
  type SshTarget,
  validateTargetAddress,
} from '@swellwright/ssh';

import { type AppConfig } from '../config.js';
import { CodedHttpException } from '../http.js';
import { CONFIG } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';

/** The part of an access entry a connection needs: names of secrets, never their values. */
export interface SshAccessRef {
  readonly method: 'password' | 'key';
  readonly username: string;
  readonly secretId: string;
  readonly sudoSecretId: string | null;
}

/** What a connection gives to the operation that runs on it. */
export interface SshSession {
  readonly connection: SshConnection;
  /** The stored sudo password, for the calls that need `sudo`; undefined when there is none. */
  readonly sudoPassword: string | undefined;
}

type FailureCode = (typeof SSH_FAILURE_CODES)[number];

/** A failure of the SSH layer, as the API reports it. */
export interface SshProblem {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/** True for the codes a check reports as a result instead of an HTTP error (the login did not work). */
export function isLoginFailure(code: ErrorCode): code is FailureCode {
  return (
    code === 'ssh_connect_failed' ||
    code === 'ssh_auth_failed' ||
    code === 'ssh_key_invalid' ||
    code === 'ssh_timeout' ||
    code === 'ssh_failed'
  );
}

/**
 * Says what an error of the SSH layer means for the API (ADR 0037). Returns null for anything that is not a failure
 * of the SSH layer: that is a defect, and it stays a 500. The messages come from the layer, which never puts a secret
 * in one. A host key that is not the pinned one is its own, prominent error and carries both fingerprints.
 */
export function sshProblem(error: unknown): SshProblem | null {
  if (error instanceof HostKeyMismatchError) {
    return {
      status: 409,
      code: 'host_key_mismatch',
      message: `The server shows the host key ${error.actual}, which is not the pinned one. If the operating system of the server was reinstalled, scan the key and replace the pinned one; otherwise somebody may be answering in its place. No credential was sent.`,
      details: { expected: [...error.expected], actual: error.actual },
    };
  }
  if (error instanceof SshAuthError) {
    return error.code === 'ssh_key_invalid'
      ? { status: 409, code: 'ssh_key_invalid', message: error.message }
      : { status: 502, code: 'ssh_auth_failed', message: error.message };
  }
  if (error instanceof SshTimeoutError) {
    return {
      status: 504,
      code: 'ssh_timeout',
      message: error.message,
      details: { phase: error.phase },
    };
  }
  if (error instanceof SshConnectError) {
    return {
      status: 502,
      code: 'ssh_connect_failed',
      message: error.message,
      details: { reason: error.reason },
    };
  }
  if (error instanceof SshError) {
    return { status: 502, code: 'ssh_failed', message: error.message };
  }
  return null;
}

export function sshException(problem: SshProblem): CodedHttpException {
  return new CodedHttpException(problem.status, problem.code, problem.message, problem.details);
}

/**
 * Everything that opens a connection to a server (ADR 0037): the address policy is applied first, the pinned host key
 * is required and checked before a credential leaves, the secrets are read from the vault for the length of the call,
 * and one pool per process shares and bounds the connections. It knows nothing about the inventory: callers say where
 * to connect and which keys are pinned.
 */
@Injectable()
export class SshService implements OnApplicationShutdown {
  private readonly pool = new SshPool({ maxPerHost: 2, idleMs: 10_000, acquireTimeoutMs: 30_000 });

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(VaultService) private readonly vault: VaultService,
  ) {}

  onApplicationShutdown(): void {
    this.pool.closeAll();
  }

  /** Drops every pooled connection: after a host key was revoked nothing may keep using the old trust. */
  closeConnections(): void {
    this.pool.closeAll();
  }

  /**
   * The address to connect to, or a 409 when the policy refuses it. A host name is resolved and every answer is
   * checked; the connection then goes to the checked address, and the pinned host key proves who answers.
   */
  private async resolve(address: string): Promise<string> {
    const policy = this.config.ssh.policy;
    const check = validateTargetAddress(address, policy);
    if (!check.allowed) {
      throw new CodedHttpException(
        409,
        'address_not_allowed',
        `${check.reason} Change the address of the server, or the SW_SSH_ALLOW_* settings of this installation.`,
        { kind: check.kind },
      );
    }
    try {
      return (await resolveTargetAddress(address, policy)).address;
    } catch (error) {
      if (error instanceof SshInputError) {
        // Past the check above, so either the name does not resolve or it resolves to an address the policy refuses.
        if (error.message.startsWith('The host name')) {
          throw new CodedHttpException(502, 'ssh_connect_failed', error.message, { reason: 'dns' });
        }
        throw new CodedHttpException(409, 'address_not_allowed', error.message);
      }
      throw error;
    }
  }

  /**
   * Reads the host key the server shows, with no credential involved. A server has keys of several types and shows
   * the one the client prefers: `keyTypes` (the types of the keys pinned for it) make the pinned types the preferred
   * ones, so that a key the server gained later is not taken for a changed one.
   */
  async scanHostKey(
    address: string,
    port: number,
    keyTypes: readonly string[],
  ): Promise<ServerHostKey> {
    const host = await this.resolve(address);
    try {
      return await fetchHostKey(host, port, {
        timeoutMs: this.config.ssh.connectTimeoutMs,
        ...(keyTypes.length === 0
          ? {}
          : { algorithms: { serverHostKey: hostKeyAlgorithmsPreferring(keyTypes) } }),
      });
    } catch (error) {
      const problem = sshProblem(error);
      throw problem ? sshException(problem) : error;
    }
  }

  /**
   * Logs in with an access entry and runs `operation`. Refuses (409) when no host key is pinned: the key is what makes
   * the connection trustworthy, and a connection that is not trusted never carries a credential. Failures of the SSH
   * layer come out as `CodedHttpException`; the caller decides which of them are results.
   */
  async withAccess<T>(
    server: {
      readonly address: string;
      readonly port: number;
      /** The key types of the pinned keys (see `scanHostKey`). */
      readonly hostKeyTypes: readonly string[];
    },
    fingerprints: readonly string[],
    access: SshAccessRef,
    operation: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    if (fingerprints.length === 0) {
      throw new CodedHttpException(
        409,
        'host_key_not_pinned',
        'No host key is pinned for this server. Scan its host key and confirm the fingerprint first.',
      );
    }
    const host = await this.resolve(server.address);
    // The secrets stay in these variables for the length of the call: nothing logs them, no error carries them.
    const secret = await this.vault.readForServer(
      access.secretId,
      access.method === 'key' ? 'ssh_key' : 'ssh_password',
    );
    const sudoPassword =
      access.sudoSecretId === null
        ? undefined
        : await this.vault.readForServer(access.sudoSecretId, 'ssh_password');
    const target: SshTarget = {
      host,
      port: server.port,
      username: access.username,
      auth:
        access.method === 'key'
          ? { kind: 'key', privateKey: secret }
          : { kind: 'password', password: secret },
      hostKey: { mode: 'pinned', fingerprints, keyTypes: server.hostKeyTypes },
      connectTimeoutMs: this.config.ssh.connectTimeoutMs,
    };
    try {
      return await this.pool.withConnection(target, (connection) =>
        operation({ connection, sudoPassword }),
      );
    } catch (error) {
      const problem = sshProblem(error);
      throw problem ? sshException(problem) : error;
    }
  }
}
