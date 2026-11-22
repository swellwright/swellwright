// One authenticated SSH connection: connect with host key verification, run commands, open SFTP.

import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { inspect } from 'node:util';

import {
  HostKeyMismatchError,
  SshAbortError,
  SshAuthError,
  SshConnectionLostError,
  SshConnectError,
  SshError,
  SshExecError,
  SshInputError,
  SshTimeoutError,
  messageOf,
  redact,
} from './errors.js';
import {
  describeHostKey,
  matchesPinned,
  normalizePolicy,
  toSsh2Algorithms,
  withPinnedKeyTypes,
} from './host-key.js';
import { SftpClient } from './sftp.js';
import { assertEnvName, assertNoNul, checkedHost, checkedPort, checkedUsername } from './shell.js';
import { mapHandshakeError, mapRuntimeError, type Ssh2ErrorLike } from './ssh2-errors.js';
import { Client, utils, type ClientChannel, type SFTPWrapper } from './ssh2.js';
import { sudoCommandLine } from './sudo-wrap.js';
import type { ExecOptions, ExecRawResult, ExecResult, ServerHostKey, SshTarget } from './types.js';

const DEFAULT_PORT = 22;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SFTP_OPEN_TIMEOUT_MS = 15_000;

interface PreparedTarget {
  host: string;
  port: number;
  username: string;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  secrets: string[];
}

function positiveInt(
  value: number | undefined,
  fallback: number,
  what: string,
  allowZero = false,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 2 ** 31 - 1) {
    throw new SshInputError(
      `${what} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`,
    );
  }
  return value;
}

function prepare(target: SshTarget): PreparedTarget {
  const host = checkedHost(target.host);
  const port = checkedPort(target.port ?? DEFAULT_PORT);
  const username = checkedUsername(target.username);
  const secrets: string[] = [];
  if (target.auth.kind === 'password') {
    if (target.auth.password.length === 0) throw new SshInputError('The password is empty.');
    secrets.push(target.auth.password);
  } else {
    if (target.auth.privateKey.length === 0) throw new SshInputError('The private key is empty.');
    if (target.auth.passphrase !== undefined) secrets.push(target.auth.passphrase);
  }
  return {
    host,
    port,
    username,
    connectTimeoutMs: positiveInt(
      target.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      'The connect timeout',
    ),
    keepaliveIntervalMs: positiveInt(
      target.keepaliveIntervalMs,
      DEFAULT_KEEPALIVE_INTERVAL_MS,
      'The keepalive interval',
      true,
    ),
    keepaliveCountMax: positiveInt(
      target.keepaliveCountMax,
      DEFAULT_KEEPALIVE_COUNT_MAX,
      'The keepalive count',
      true,
    ),
    secrets,
  };
}

/** Collects what a stream delivers up to a cap and hands every chunk to an optional callback as decoded text. */
class Collector {
  readonly #chunks: Buffer[] = [];
  readonly #decoder = new StringDecoder('utf8');
  readonly #cap: number;
  readonly #callback: ((chunk: string) => void) | undefined;
  #size = 0;
  truncated = false;

  constructor(cap: number, callback: ((chunk: string) => void) | undefined) {
    this.#cap = cap;
    this.#callback = callback;
  }

  push(chunk: Buffer): void {
    const room = this.#cap - this.#size;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.#chunks.push(kept);
      this.#size += kept.length;
    }
    if (chunk.length > room) this.truncated = true;
    if (this.#callback !== undefined) {
      const text = this.#decoder.write(chunk);
      if (text.length > 0) this.#notify(text);
    }
  }

  end(): void {
    if (this.#callback !== undefined) {
      const text = this.#decoder.end();
      if (text.length > 0) this.#notify(text);
    }
  }

  buffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  #notify(text: string): void {
    try {
      this.#callback?.(text);
    } catch {
      // A callback that throws must not break the command it observes.
    }
  }
}

export interface SshConnectionEvents {
  close: [];
  error: [error: SshError];
}

/**
 * One authenticated connection. Obtain it with `SshConnection.connect`. Operations on it never throw a raw ssh2
 * error: they reject with the typed errors of this package. When the connection dies every operation in flight
 * rejects with `SshConnectionLostError` and `close` is emitted; `error` is emitted too, but only when somebody
 * listens, so an unobserved dead connection cannot crash the process.
 */
export class SshConnection extends EventEmitter<SshConnectionEvents> {
  /** The host key the server presented (already checked against the policy). */
  readonly hostKey: ServerHostKey;
  readonly host: string;
  readonly port: number;
  readonly username: string;

  readonly #client: Client;
  readonly #socket: Socket;
  readonly #keepaliveMs: number;
  readonly #failers = new Set<(error: SshError) => void>();
  readonly #sftps = new Set<SftpClient>();
  #closed = false;
  #explicitClose = false;
  #deathCause: SshError | undefined;

  private constructor(
    client: Client,
    socket: Socket,
    prepared: PreparedTarget,
    hostKey: ServerHostKey,
  ) {
    super();
    this.#client = client;
    this.#socket = socket;
    this.#keepaliveMs = prepared.keepaliveIntervalMs * (prepared.keepaliveCountMax + 1);
    this.hostKey = hostKey;
    this.host = prepared.host;
    this.port = prepared.port;
    this.username = prepared.username;

    client.on('error', (error: Ssh2ErrorLike) => {
      this.#deathCause ??= mapRuntimeError(error, this.#keepaliveMs);
      if (this.listenerCount('error') > 0) this.emit('error', this.#deathCause);
    });
    client.on('close', () => {
      this.#markClosed();
    });
  }

  /**
   * Connects and authenticates. The host key is checked against `target.hostKey` before any credential is sent;
   * a key that is not pinned raises `HostKeyMismatchError` and nothing else leaves this machine but the handshake.
   */
  static async connect(target: SshTarget): Promise<SshConnection> {
    const prepared = prepare(target);
    const policy = normalizePolicy(target.hostKey);
    const algorithms = toSsh2Algorithms(withPinnedKeyTypes(target.algorithms, policy));

    if (target.auth.kind === 'key') {
      const parsed = utils.parseKey(target.auth.privateKey, target.auth.passphrase);
      if (parsed instanceof Error) {
        throw new SshAuthError(
          `The private key cannot be used: ${redact(parsed.message, prepared.secrets)}`,
          'ssh_key_invalid',
        );
      }
    }

    return new Promise<SshConnection>((resolve, reject) => {
      const client = new Client();
      const socket = new Socket();
      let settled = false;
      let seenKey: ServerHostKey | undefined;
      let mismatch: HostKeyMismatchError | undefined;

      const onReady = (): void => {
        if (seenKey === undefined) {
          settle({
            error: new SshConnectError('The server did not present a host key.', 'handshake'),
          });
          return;
        }
        settle({ key: seenKey });
      };
      const onClientError = (error: Ssh2ErrorLike): void => {
        settle({
          error: mismatch ?? mapHandshakeError(error, prepared.connectTimeoutMs, prepared.secrets),
        });
      };
      const onClientClose = (): void => {
        settle({
          error:
            mismatch ?? new SshConnectError('The connection closed before it was ready.', 'closed'),
        });
      };
      const onSocketError = (error: Ssh2ErrorLike): void => {
        settle({
          error: mapHandshakeError(
            Object.assign(error, { level: 'client-socket' }),
            prepared.connectTimeoutMs,
            prepared.secrets,
          ),
        });
      };

      const settle = (outcome: { key: ServerHostKey } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        client.off('ready', onReady);
        client.off('error', onClientError);
        client.off('close', onClientClose);
        socket.off('error', onSocketError);
        if ('key' in outcome) {
          resolve(new SshConnection(client, socket, prepared, outcome.key));
          return;
        }
        client.removeAllListeners();
        client.on('error', () => undefined);
        socket.destroy();
        reject(outcome.error);
      };

      // ssh2 times out the whole handshake itself; this is the backstop for a stall it does not see.
      const backstop = setTimeout(() => {
        settle({ error: new SshTimeoutError('connect', prepared.connectTimeoutMs) });
      }, prepared.connectTimeoutMs + 1000);

      client.on('ready', onReady);
      client.on('error', onClientError);
      client.on('close', onClientClose);
      socket.on('error', onSocketError);
      socket.setNoDelay(true);
      socket.connect({ host: prepared.host, port: prepared.port });

      try {
        client.connect({
          sock: socket,
          username: prepared.username,
          ...(target.auth.kind === 'password'
            ? { password: target.auth.password }
            : {
                privateKey: target.auth.privateKey,
                ...(target.auth.passphrase === undefined
                  ? {}
                  : { passphrase: target.auth.passphrase }),
              }),
          readyTimeout: prepared.connectTimeoutMs,
          keepaliveInterval: prepared.keepaliveIntervalMs,
          keepaliveCountMax: prepared.keepaliveCountMax,
          tryKeyboard: false,
          ...(algorithms === undefined ? {} : { algorithms }),
          hostVerifier: (blob: Buffer): boolean => {
            seenKey = describeHostKey(blob);
            if (
              policy.mode === 'pinned' &&
              !matchesPinned(seenKey.fingerprintSha256, policy.fingerprints)
            ) {
              // Returning false aborts the handshake here: no authentication request has been sent.
              mismatch = new HostKeyMismatchError(policy.fingerprints, seenKey.fingerprintSha256);
              return false;
            }
            return true;
          },
        });
      } catch (error) {
        settle({
          error: new SshInputError(
            `Invalid connection settings: ${redact(messageOf(error), prepared.secrets)}`,
          ),
        });
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Never shows credentials, whoever prints the object. */
  override toString(): string {
    return `ssh://${this.username}@${this.host}:${String(this.port)}`;
  }

  [inspect.custom](): string {
    return `SshConnection(${this.toString()}${this.#closed ? ', closed' : ''})`;
  }

  toJSON(): { host: string; port: number; username: string; closed: boolean } {
    return { host: this.host, port: this.port, username: this.username, closed: this.#closed };
  }

  /** Ends the connection. Idempotent; operations in flight reject with `SshConnectionLostError`. */
  close(): void {
    if (this.#closed) return;
    this.#explicitClose = true;
    this.closeSessions();
    try {
      this.#client.end();
    } catch {
      // Already gone.
    }
    // `end()` asks politely; a peer that never answers must not keep the socket (and the process) alive. The socket
    // is destroyed itself: `Client.destroy()` of ssh2 does nothing once the socket is no longer writable, which is
    // exactly the state `end()` leaves it in.
    setTimeout(() => {
      this.#socket.destroy();
    }, 1000).unref();
  }

  /** Closes the SFTP sessions this connection opened (the pool calls it when a lease ends). */
  closeSessions(): void {
    for (const sftp of [...this.#sftps]) sftp.close();
    this.#sftps.clear();
  }

  /**
   * Runs a command and returns its output decoded as UTF-8. A non-zero exit status is a result, not an error:
   * errors are for what prevents a result (the connection is gone, a deadline passed, the server refused the
   * request).
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const raw = await this.execRaw(command, options);
    return { ...raw, stdout: raw.stdout.toString('utf8'), stderr: raw.stderr.toString('utf8') };
  }

  /** Like `exec` but the output is returned as bytes. */
  async execRaw(command: string, options: ExecOptions = {}): Promise<ExecRawResult> {
    this.#assertOpen();
    if (command.length === 0) throw new SshInputError('The command is empty.');
    assertNoNul(command, 'The command');
    const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 'The exec timeout');
    const maxBytes = positiveInt(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'The output cap',
      true,
    );
    for (const [name, value] of Object.entries(options.env ?? {})) {
      assertEnvName(name);
      assertNoNul(value, 'An environment value');
    }

    const sudo = options.sudo;
    const password = sudo?.password;
    if (password !== undefined && (password.includes('\n') || password.includes('\0'))) {
      throw new SshInputError('A sudo password must not contain a newline or a NUL character.');
    }
    const commandLine =
      sudo === undefined ? command : sudoCommandLine(command, password !== undefined);
    const stdinParts: Buffer[] = [];
    if (password !== undefined) stdinParts.push(Buffer.from(`${password}\n`, 'utf8'));
    if (options.stdin !== undefined) {
      stdinParts.push(
        typeof options.stdin === 'string' ? Buffer.from(options.stdin, 'utf8') : options.stdin,
      );
    }
    const stdin = Buffer.concat(stdinParts);
    const secrets = [password];

    return new Promise<ExecRawResult>((resolve, reject) => {
      const startedAt = performance.now();
      const out = new Collector(maxBytes, options.onStdout);
      const err = new Collector(maxBytes, options.onStderr);
      const exit: { code: number | null | undefined; signal: string | null } = {
        code: undefined,
        signal: null,
      };
      let stream: ClientChannel | undefined;
      let settled = false;
      let channelClosed = false;
      let stderrClosed = false;
      let flushTimer: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        fail(new SshAbortError());
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        clearTimeout(flushTimer);
        unregister();
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: SshError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          stream?.close();
        } catch {
          // The channel is already gone.
        }
        reject(error);
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        out.end();
        err.end();
        resolve({
          code: exit.code ?? null,
          signal: exit.signal,
          stdout: out.buffer(),
          stderr: err.buffer(),
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          durationMs: Math.round(performance.now() - startedAt),
        });
      };
      const maybeFinish = (): void => {
        if (channelClosed && stderrClosed) finish();
      };

      const unregister = this.#register(fail);
      const timer = setTimeout(() => {
        try {
          stream?.signal('TERM');
        } catch {
          // Best effort: the server may ignore signals.
        }
        fail(new SshTimeoutError('exec', timeoutMs));
      }, timeoutMs);

      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          fail(new SshAbortError());
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        this.#client.exec(commandLine, { env: { ...options.env } }, (error, channel) => {
          if (error !== undefined) {
            fail(
              this.#closed
                ? new SshConnectionLostError()
                : new SshExecError(
                    `The server refused to run the command: ${redact(messageOf(error), secrets)}`,
                    { cause: error },
                  ),
            );
            return;
          }
          if (settled) {
            channel.close();
            return;
          }
          stream = channel;
          channel.on('data', (chunk: Buffer) => {
            out.push(chunk);
          });
          channel.stderr.on('data', (chunk: Buffer) => {
            err.push(chunk);
          });
          channel.on('exit', (code: number | null, signal?: string) => {
            exit.code = code;
            exit.signal = signal ?? null;
          });
          channel.on('close', () => {
            channelClosed = true;
            // stderr normally closes at the same time; do not wait for it forever.
            flushTimer = setTimeout(finish, 2000);
            flushTimer.unref();
            maybeFinish();
          });
          channel.stderr.on('close', () => {
            stderrClosed = true;
            maybeFinish();
          });
          channel.on('error', (streamError: Error) => {
            fail(
              new SshExecError(
                `The command channel failed: ${redact(messageOf(streamError), secrets)}`,
                { cause: streamError },
              ),
            );
          });
          // The channel is half-open: ending the writable side sends EOF, the command can still answer.
          channel.end(stdin.length > 0 ? stdin : undefined);
        });
      } catch (error) {
        fail(
          new SshConnectionLostError(
            `The SSH connection is not usable: ${redact(messageOf(error), secrets)}`,
            { cause: error },
          ),
        );
      }
    });
  }

  /** Opens an SFTP session on this connection. */
  async sftp(): Promise<SftpClient> {
    this.#assertOpen();
    const raw = await new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const done = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregister();
        action();
      };
      const unregister = this.#register((error) => {
        done(() => {
          reject(error);
        });
      });
      const timer = setTimeout(() => {
        done(() => {
          reject(new SshTimeoutError('sftp', SFTP_OPEN_TIMEOUT_MS));
        });
      }, SFTP_OPEN_TIMEOUT_MS);
      try {
        this.#client.sftp((error, sftp) => {
          if (error !== undefined) {
            done(() => {
              reject(
                new SshExecError(`The server did not start an SFTP session: ${messageOf(error)}`, {
                  cause: error,
                }),
              );
            });
            return;
          }
          if (settled) {
            sftp.end();
            return;
          }
          done(() => {
            resolve(sftp);
          });
        });
      } catch (error) {
        done(() => {
          reject(
            new SshConnectionLostError(`The SSH connection is not usable: ${messageOf(error)}`, {
              cause: error,
            }),
          );
        });
      }
    });
    const client = new SftpClient(this, raw, (sftpClient) => {
      this.#sftps.delete(sftpClient);
    });
    this.#sftps.add(client);
    return client;
  }

  /** Registers a function that rejects an operation in flight when the connection dies; returns the unregister. */
  #register(fail: (error: SshError) => void): () => void {
    this.#failers.add(fail);
    return () => {
      this.#failers.delete(fail);
    };
  }

  /** @internal For SFTP: the same registration, exposed to the transfer code. */
  watch(fail: (error: SshError) => void): () => void {
    return this.#register(fail);
  }

  #assertOpen(): void {
    if (this.#closed) throw new SshConnectionLostError('The SSH connection is closed.');
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    const cause = this.#explicitClose
      ? new SshConnectionLostError('The SSH connection was closed.')
      : (this.#deathCause ?? new SshConnectionLostError());
    for (const fail of [...this.#failers]) fail(cause);
    this.#failers.clear();
    this.closeSessions();
    this.emit('close');
  }
}
