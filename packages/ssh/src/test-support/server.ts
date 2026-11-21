// An SSH server that lives inside the test process, built on the server half of ssh2. It exists so that every
// security property of the client can be tested without a real sshd: it records what the client sends (above all
// whether any authentication request arrived), it can present a wrong or changed host key, stall, freeze, drop
// connections, run commands in a real POSIX shell and serve a small SFTP subsystem backed by a directory.
//
// It is a test double, never a production server: it listens on loopback only.

import { spawn } from 'node:child_process';
import {
  close as fsClose,
  existsSync,
  fstat,
  mkdir,
  open as fsOpen,
  opendir,
  read as fsRead,
  readdirSync,
  rename as fsRename,
  rmdir,
  stat as fsStat,
  unlink,
  write as fsWrite,
} from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { join, normalize, posix, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  Server,
  utils,
  type AuthContext,
  type Connection,
  type SFTPWrapper,
  type ServerChannel,
} from '../ssh2.js';

import { generateTestKeyPair, publicKeyFingerprint, type TestKeyPair } from './keys.js';

export interface TestUser {
  password?: string;
  /** Lines in the format of `authorized_keys`. */
  publicKeys?: readonly string[];
}

export interface AuthAttempt {
  method: string;
  username: string;
  accepted: boolean;
}

export interface ExecRequest {
  command: string;
  /** Environment variables the client asked for and the server accepted. */
  env: Readonly<Record<string, string>>;
}

export interface LoggedExec extends ExecRequest {
  /** Everything the client wrote to the command's standard input, so far. */
  stdin: Buffer;
}

export type ExecHandler = (
  channel: ServerChannel,
  request: ExecRequest,
  server: TestSshServer,
) => void;

export interface TestServerOptions {
  users?: Readonly<Record<string, TestUser>>;
  /** Present this key as the host key (default: a fresh ed25519 key). */
  hostKey?: TestKeyPair;
  /**
   * More host keys, of other types: a real server has one of every type and shows the type the client prefers.
   * `hostKey` stays the one `hostKeyFingerprint` reports.
   */
  extraHostKeys?: readonly TestKeyPair[];
  /** How exec requests are answered. Without it they are refused. */
  exec?: ExecHandler;
  /** Serve SFTP from this directory (remote path `/a/b` is `<root>/a/b`). */
  sftpRoot?: string;
  /** Environment variable names the server accepts in `env` requests (like `AcceptEnv`). Default none. */
  acceptEnv?: readonly string[];
  /** SFTP writes are never answered: a transfer that stops moving. */
  sftpStallWrites?: boolean;
  /**
   * Remote path prefixes the SFTP user may not touch: every request for them is answered "permission denied", as for
   * a directory that only root can enter. Read when an SFTP session opens.
   */
  sftpDenied?: readonly string[];
  /** Exact algorithm lists the server offers (to test what a client accepts, e.g. a legacy key exchange). */
  algorithms?: {
    kex?: readonly string[];
    cipher?: readonly string[];
    hmac?: readonly string[];
    serverHostKey?: readonly string[];
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Runs each command in a real `/bin/sh -c` (POSIX systems only), like sshd does for an exec request. */
export function shExecHandler(options: { home: string; extraPath?: string }): ExecHandler {
  return (channel, request) => {
    const path = [options.extraPath, process.env['PATH']]
      .filter((part): part is string => part !== undefined)
      .join(':');
    const child = spawn('/bin/sh', ['-c', request.command], {
      cwd: options.home,
      env: { PATH: path, HOME: options.home, LANG: 'C', ...request.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => channel.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => channel.stderr.write(chunk));
    channel.on('data', (chunk: Buffer) => {
      if (!child.stdin.destroyed) child.stdin.write(chunk);
    });
    channel.on('end', () => {
      if (!child.stdin.destroyed) child.stdin.end();
    });
    child.stdin.on('error', () => undefined);
    channel.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    child.on('close', (code, signal) => {
      if (code !== null) channel.exit(code);
      else channel.exit(signal === null ? 'TERM' : signal.replace(/^SIG/u, ''));
      channel.end();
    });
  };
}

export class TestSshServer {
  readonly host = '127.0.0.1';
  readonly port: number;
  /** The fingerprint a client should pin to trust this server. */
  readonly hostKeyFingerprint: string;
  /** Every authentication request that arrived, in order. */
  readonly authAttempts: AuthAttempt[] = [];
  /** Every exec request, with its standard input as far as it has arrived. */
  readonly execLog: LoggedExec[] = [];
  /** How many TCP connections were accepted. */
  connections = 0;

  private readonly net: NetServer;
  private readonly sockets: Set<Socket>;

  private constructor(net: NetServer, sockets: Set<Socket>, port: number, fingerprint: string) {
    this.net = net;
    this.sockets = sockets;
    this.port = port;
    this.hostKeyFingerprint = fingerprint;
  }

  static async start(options: TestServerOptions = {}): Promise<TestSshServer> {
    const hostKey = options.hostKey ?? generateTestKeyPair();
    const users = options.users ?? {};
    const acceptEnv = new Set(options.acceptEnv ?? []);
    const ssh = new Server({
      hostKeys: [hostKey.privateKey, ...(options.extraHostKeys ?? []).map((key) => key.privateKey)],
      // The ssh2 types name every algorithm; the lists here are plain strings chosen by the test.
      ...(options.algorithms === undefined ? {} : { algorithms: options.algorithms as never }),
    });
    const sockets = new Set<Socket>();
    // Filled in as soon as the net server listens; the handlers below only run for connections made after that.
    const created: { server?: TestSshServer } = {};

    ssh.on('connection', (client: Connection) => {
      created.server?.handleClient(client, users, options, acceptEnv);
    });
    ssh.on('error', () => undefined);

    const net = createServer((socket) => {
      sockets.add(socket);
      if (created.server !== undefined) created.server.connections += 1;
      socket.on('close', () => {
        sockets.delete(socket);
      });
      socket.on('error', () => undefined);
      ssh.injectSocket(socket);
    });
    await new Promise<void>((resolve) => {
      net.listen(0, '127.0.0.1', resolve);
    });
    const address = net.address();
    if (address === null || typeof address === 'string')
      throw new Error('The test server has no address.');
    created.server = new TestSshServer(
      net,
      sockets,
      address.port,
      publicKeyFingerprint(hostKey.publicKey),
    );
    return created.server;
  }

  /** Destroys every open connection at once, like a network failure. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  /** Stops reading from every open connection: the peer sees a link that went silent. */
  freeze(): void {
    for (const socket of this.sockets) socket.pause();
  }

  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => {
      this.net.close(() => {
        resolve();
      });
    });
  }

  private handleClient(
    client: Connection,
    users: Readonly<Record<string, TestUser>>,
    options: TestServerOptions,
    acceptEnv: ReadonlySet<string>,
  ): void {
    client.on('error', () => undefined);
    client.on('authentication', (context: AuthContext) => {
      const user = users[context.username];
      let accepted = false;
      if (user !== undefined) {
        if (context.method === 'password' && user.password !== undefined) {
          accepted = constantTimeEqual(context.password, user.password);
        } else if (context.method === 'publickey') {
          accepted = (user.publicKeys ?? []).some((line) => {
            const parsed = utils.parseKey(line);
            if (parsed instanceof Error) return false;
            // A public key line parses to one key (private keys in the OpenSSH format parse to a list).
            const key = parsed;
            if (context.key.algo !== key.type) return false;
            if (!context.key.data.equals(key.getPublicSSH())) return false;
            // Without a signature the client only asks whether the key would be acceptable.
            return (
              context.signature === undefined ||
              (context.blob !== undefined &&
                key.verify(context.blob, context.signature, context.hashAlgo))
            );
          });
        }
      }
      this.authAttempts.push({ method: context.method, username: context.username, accepted });
      if (accepted) context.accept();
      else context.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        const env: Record<string, string> = {};
        session.on('env', (accept, reject, info) => {
          // ssh2 passes `undefined` for both when the client asked for no reply, which an `env` request from
          // ssh2's own client does not (the types say they are always functions).
          /* eslint-disable @typescript-eslint/no-unnecessary-condition */
          if (acceptEnv.has(info.key)) {
            env[info.key] = info.val;
            accept?.();
          } else {
            reject?.();
          }
          /* eslint-enable @typescript-eslint/no-unnecessary-condition */
        });
        session.on('exec', (accept, reject, info) => {
          if (options.exec === undefined) {
            reject();
            return;
          }
          const channel = accept();
          const entry: LoggedExec = {
            command: info.command,
            env: { ...env },
            stdin: Buffer.alloc(0),
          };
          this.execLog.push(entry);
          channel.on('data', (chunk: Buffer) => {
            entry.stdin = Buffer.concat([entry.stdin, chunk]);
          });
          options.exec(channel, { command: info.command, env: { ...env } }, this);
        });
        session.on('sftp', (accept, reject) => {
          if (options.sftpRoot === undefined) {
            reject();
            return;
          }
          attachSftp(accept(), options.sftpRoot, options.sftpStallWrites === true, [
            ...(options.sftpDenied ?? []),
          ]);
        });
      });
    });
  }
}

/** A TCP server that accepts connections and never says a word: a peer that does not speak SSH. */
export async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const net = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    net.listen(0, '127.0.0.1', resolve);
  });
  const address = net.address();
  if (address === null || typeof address === 'string')
    throw new Error('The silent server has no address.');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        net.close(() => {
          resolve();
        });
      });
    },
  };
}

/** A TCP server that greets like an SSH server and then stalls: the handshake never completes. */
export async function startStallingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const net = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    socket.write('SSH-2.0-stalling\r\n');
  });
  await new Promise<void>((resolve) => {
    net.listen(0, '127.0.0.1', resolve);
  });
  const address = net.address();
  if (address === null || typeof address === 'string')
    throw new Error('The stalling server has no address.');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        net.close(() => {
          resolve();
        });
      });
    },
  };
}

// --- SFTP -----------------------------------------------------------------------------------------------------

const STATUS = utils.sftp.STATUS_CODE;
const NO_ATTRS = { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };

function statusFor(error: NodeJS.ErrnoException | null): number {
  if (error === null) return STATUS.OK;
  if (error.code === 'ENOENT') return STATUS.NO_SUCH_FILE;
  if (error.code === 'EACCES' || error.code === 'EPERM') return STATUS.PERMISSION_DENIED;
  return STATUS.FAILURE;
}

function attachSftp(
  sftp: SFTPWrapper,
  root: string,
  stallWrites: boolean,
  denied: readonly string[],
): void {
  const files = new Map<number, number>();
  const directories = new Map<number, { path: string; sent: boolean }>();
  let next = 1;
  const local = (remote: string): string => join(root, normalize(`${sep}${remote}`));
  const isDenied = (remote: string): boolean => {
    // Remote paths are POSIX paths whatever machine the test runs on (on Windows `normalize` would turn `//a` into a UNC path).
    const clean = posix.normalize(`/${remote}`);
    return denied.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
  };
  const handleOf = (id: number): Buffer => {
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id, 0);
    return handle;
  };
  const attrsOf = (stats: {
    mode: number;
    size: number;
    atimeMs: number;
    mtimeMs: number;
  }): { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number } => ({
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  });

  sftp.on('REALPATH', (id, path) => {
    const resolved = normalize(`/${path}`).replaceAll('\\', '/');
    sftp.name(id, [{ filename: resolved, longname: resolved, attrs: NO_ATTRS }]);
  });
  const statPath = (id: number, path: string): void => {
    if (isDenied(path)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    fsStat(local(path), (error, stats) => {
      if (error === null) sftp.attrs(id, attrsOf(stats));
      else sftp.status(id, statusFor(error));
    });
  };
  sftp.on('STAT', statPath);
  sftp.on('LSTAT', statPath);
  sftp.on('FSTAT', (id, handle) => {
    const fd = files.get(handle.readUInt32BE(0));
    if (fd === undefined) {
      sftp.status(id, STATUS.FAILURE);
      return;
    }
    fstat(fd, (error, stats) => {
      if (error === null) sftp.attrs(id, attrsOf(stats));
      else sftp.status(id, statusFor(error));
    });
  });
  sftp.on('OPEN', (id, filename, flags, attrs) => {
    if (isDenied(filename)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    const mode = utils.sftp.flagsToString(flags);
    fsOpen(local(filename), mode ?? 'r', attrs.mode, (error, fd) => {
      if (error !== null) {
        sftp.status(id, statusFor(error));
        return;
      }
      const key = next++;
      files.set(key, fd);
      sftp.handle(id, handleOf(key));
    });
  });
  sftp.on('READ', (id, handle, offset, length) => {
    const fd = files.get(handle.readUInt32BE(0));
    if (fd === undefined) {
      sftp.status(id, STATUS.FAILURE);
      return;
    }
    const buffer = Buffer.alloc(length);
    fsRead(fd, buffer, 0, length, offset, (error, bytes) => {
      if (error !== null) sftp.status(id, statusFor(error));
      else if (bytes === 0) sftp.status(id, STATUS.EOF);
      else sftp.data(id, buffer.subarray(0, bytes));
    });
  });
  sftp.on('WRITE', (id, handle, offset, data) => {
    if (stallWrites) return;
    const fd = files.get(handle.readUInt32BE(0));
    if (fd === undefined) {
      sftp.status(id, STATUS.FAILURE);
      return;
    }
    fsWrite(fd, data, 0, data.length, offset, (error) => {
      sftp.status(id, statusFor(error));
    });
  });
  sftp.on('CLOSE', (id, handle) => {
    const key = handle.readUInt32BE(0);
    const fd = files.get(key);
    if (fd === undefined) {
      directories.delete(key);
      sftp.status(id, STATUS.OK);
      return;
    }
    files.delete(key);
    fsClose(fd, (error) => {
      sftp.status(id, statusFor(error));
    });
  });
  sftp.on('MKDIR', (id, path) => {
    if (isDenied(path)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    mkdir(local(path), (error) => {
      sftp.status(id, statusFor(error));
    });
  });
  sftp.on('RMDIR', (id, path) => {
    if (isDenied(path)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    rmdir(local(path), (error) => {
      sftp.status(id, statusFor(error));
    });
  });
  sftp.on('REMOVE', (id, path) => {
    if (isDenied(path)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    unlink(local(path), (error) => {
      sftp.status(id, statusFor(error));
    });
  });
  sftp.on('RENAME', (id, from, to) => {
    if (isDenied(from) || isDenied(to)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    // SFTP version 3 says it is an error when the destination exists (OpenSSH's server behaves so).
    if (existsSync(local(to))) {
      sftp.status(id, STATUS.FAILURE);
      return;
    }
    fsRename(local(from), local(to), (error) => {
      sftp.status(id, statusFor(error));
    });
  });
  sftp.on('SETSTAT', (id) => {
    sftp.status(id, STATUS.OK);
  });
  sftp.on('FSETSTAT', (id) => {
    sftp.status(id, STATUS.OK);
  });
  sftp.on('OPENDIR', (id, path) => {
    if (isDenied(path)) {
      sftp.status(id, STATUS.PERMISSION_DENIED);
      return;
    }
    opendir(local(path), (error, directory) => {
      if (error !== null) {
        sftp.status(id, statusFor(error));
        return;
      }
      void directory.close();
      const key = next++;
      directories.set(key, { path: local(path), sent: false });
      sftp.handle(id, handleOf(key));
    });
  });
  sftp.on('READDIR', (id, handle) => {
    const entry = directories.get(handle.readUInt32BE(0));
    if (entry === undefined || entry.sent) {
      sftp.status(id, STATUS.EOF);
      return;
    }
    entry.sent = true;
    const names = readdirSync(entry.path).map((filename) => ({
      filename,
      longname: filename,
      attrs: NO_ATTRS,
    }));
    sftp.name(id, names);
  });
}
