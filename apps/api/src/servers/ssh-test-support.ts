import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

import {
  type ExecHandler,
  type TestKeyPair,
  TestSshServer,
  type TestUser,
} from '@swellwright/ssh/test-support';

import { DEBIAN_12_NODE, UBUNTU_2404_AS_USER } from './facts/samples.js';

/**
 * A server that answers the commands Swellwright sends over SSH without a shell of its own, so that the tests of the
 * API run on any machine: `id -un`, `id -u`, the sudo wrapper of the SSH layer (it reads the password from the first
 * line of the standard input, as the real wrapper does) and the facts script (it answers with a captured output).
 * Every authentication attempt and every command is logged by the in-process server underneath.
 */

export interface FakeHostOptions {
  /** Who may log in. */
  readonly users: Readonly<Record<string, TestUser>>;
  /** What `id -un` says. */
  readonly user?: string;
  /** What `id -u` says; 0 is root and needs no sudo. */
  readonly uid?: number;
  /** `none`: sudo is not installed. `passwordless`: NOPASSWD. Otherwise sudo wants this password. */
  readonly sudo?: 'none' | 'passwordless' | { readonly password: string };
  /** What the facts script prints (default: a captured output that fits who runs it). */
  readonly facts?: string | ((asRoot: boolean) => string);
  /** More host keys of other types: a real server has one of every type (see `TestServerOptions.extraHostKeys`). */
  readonly extraHostKeys?: readonly TestKeyPair[];
  /** The facts script never answers. */
  readonly stallFacts?: boolean;
  /** The facts script waits for this before it answers. */
  readonly factsGate?: Promise<void>;
}

/** The command the SSH layer wrapped for sudo: the quoted word after `swellwright-sudo`, unquoted. */
export function wrappedCommand(line: string): string {
  const marker = ' swellwright-sudo ';
  const text = line.slice(line.indexOf(marker) + marker.length);
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      out += text.slice(index + 1, end);
      index = end + 1;
    } else if (char === '\\' && text[index + 1] === "'") {
      out += "'";
      index += 2;
    } else {
      index += 1;
    }
  }
  return out;
}

export class FakeHost {
  /** How many times the facts script ran, and with which rights. */
  readonly factsRuns: { asRoot: boolean }[] = [];
  /** Resolves when the facts script has been asked for the first time. */
  readonly factsStarted: Promise<void>;
  private started: () => void = () => undefined;

  private constructor(readonly server: TestSshServer) {
    this.factsStarted = new Promise<void>((resolve) => {
      this.started = resolve;
    });
  }

  /** Called by the handler when the facts script arrives. */
  noteFactsRun(asRoot: boolean): void {
    this.factsRuns.push({ asRoot });
    this.started();
  }

  static async start(options: FakeHostOptions): Promise<FakeHost> {
    const created: { host?: FakeHost } = {};
    const exec: ExecHandler = (channel, request) => {
      const chunks: Buffer[] = [];
      channel.on('data', (chunk: Buffer) => chunks.push(chunk));
      channel.on('end', () => {
        const stdin = Buffer.concat(chunks).toString('utf8');
        const say = (text: string, code: number, toStderr = false): void => {
          (toStderr ? channel.stderr : channel).write(text);
          channel.exit(code);
          channel.end();
        };
        const uid = options.uid ?? 0;
        const run = (command: string, asRoot: boolean): void => {
          if (command === 'id -un') {
            say(`${options.user ?? 'root'}\n`, 0);
          } else if (command === 'id -u') {
            say(`${String(uid)}\n`, 0);
          } else if (command === 'true') {
            say('', 0);
          } else if (command.includes('# swellwright-facts')) {
            created.host?.noteFactsRun(asRoot);
            if (options.stallFacts === true) {
              return;
            }
            const answer = (): void => {
              const facts =
                typeof options.facts === 'function'
                  ? options.facts(asRoot)
                  : (options.facts ?? (asRoot ? DEBIAN_12_NODE : UBUNTU_2404_AS_USER));
              say(facts, 0);
            };
            if (options.factsGate) {
              void options.factsGate.then(answer);
            } else {
              answer();
            }
          } else {
            say(`sh: 1: ${command.split(' ')[0] ?? ''}: not found\n`, 127, true);
          }
        };

        if (!request.command.includes('swellwright-sudo')) {
          run(request.command, uid === 0);
          return;
        }
        // The wrapper of the SSH layer: `sh -c '<wrapper>' swellwright-sudo '<command>'`.
        const inner = wrappedCommand(request.command);
        const withPassword = request.command.includes('IFS= read -r SWPW');
        const given = withPassword ? stdin.split('\n')[0] : undefined;
        const sudo = options.sudo ?? 'none';
        if (uid === 0 || sudo === 'passwordless') {
          run(inner, true);
        } else if (sudo === 'none') {
          say('sh: 1: exec: sudo: not found\n', 127, true);
        } else if (given === undefined) {
          say('sudo: a password is required\n', 1, true);
        } else if (given === sudo.password) {
          run(inner, true);
        } else {
          say('Sorry, try again.\nsudo: 1 incorrect password attempt\n', 1, true);
        }
      });
    };
    const server = await TestSshServer.start({
      users: options.users,
      exec,
      ...(options.extraHostKeys === undefined ? {} : { extraHostKeys: options.extraHostKeys }),
    });
    created.host = new FakeHost(server);
    return created.host;
  }

  get port(): number {
    return this.server.port;
  }

  get fingerprint(): string {
    return this.server.hostKeyFingerprint;
  }

  close(): Promise<void> {
    return this.server.close();
  }
}

/**
 * A POSIX shell to run commands in, for the tests that need the real thing: `/bin/sh` where there is one, and the `sh`
 * that comes with Git for Windows on a Windows machine of a developer. Undefined when there is none: those tests skip.
 */
export function findShell(): { shell: string; extraPath: string[] } | undefined {
  if (process.platform !== 'win32') {
    return existsSync('/bin/sh') ? { shell: '/bin/sh', extraPath: [] } : undefined;
  }
  const git = 'C:\\Program Files\\Git\\usr\\bin';
  return existsSync(`${git}\\sh.exe`) ? { shell: `${git}\\sh.exe`, extraPath: [git] } : undefined;
}

/** Runs every command in a real shell, like sshd does for an exec request (the SSH layer's own handler, with a shell of your choice). */
export function shellHandler(options: {
  shell: string;
  home: string;
  path: readonly string[];
}): ExecHandler {
  return (channel, request) => {
    const child = spawn(options.shell, ['-c', request.command], {
      cwd: options.home,
      env: {
        PATH: [...options.path, process.env['PATH'] ?? ''].join(delimiter),
        HOME: options.home,
        LANG: 'C',
        ...(process.env['SystemRoot'] === undefined
          ? {}
          : { SystemRoot: process.env['SystemRoot'] }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => channel.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => channel.stderr.write(chunk));
    channel.on('data', (chunk: Buffer) => {
      if (!child.stdin.destroyed) {
        child.stdin.write(chunk);
      }
    });
    channel.on('end', () => {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    });
    child.stdin.on('error', () => undefined);
    channel.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
    child.on('close', (code, signal) => {
      if (code !== null) {
        channel.exit(code);
      } else {
        channel.exit(signal === null ? 'TERM' : signal.replace(/^SIG/u, ''));
      }
      channel.end();
    });
  };
}
