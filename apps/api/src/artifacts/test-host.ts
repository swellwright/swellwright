import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { type ExecHandler, TestSshServer, type TestUser } from '@swellwright/ssh/test-support';

import { wrappedCommand } from '../servers/ssh-test-support.js';

/**
 * A stand-in for a server that artifacts are pushed to, for the tests of the API (no real server, runs on any OS).
 * SFTP is served from a temporary directory that is the whole "file system" of the server; commands are answered by a
 * very small shell that knows exactly the commands the distribution service sends (`id`, `printf`, `sha256sum`,
 * `chmod`, `rm`, `rmdir`, `install`, `mv`, `umask`, `true`) with single-quoted arguments, chained with `&&`. Anything
 * else is "not found", so a command the service starts sending without the test knowing fails loudly. The sudo
 * wrapper of the SSH layer is understood: commands run through it are root's.
 */

export interface ArtifactHostOptions {
  /** Who may log in (the in-process SSH server's table). */
  readonly users: Readonly<Record<string, TestUser>>;
  /** The login's uid: 0 is root. Default 1000. */
  readonly uid?: number;
  /** Where the login's home is (default `/home/deploy`, or `/root` for uid 0). */
  readonly home?: string;
  /** `none`: sudo is not installed. `passwordless`: NOPASSWD. Otherwise sudo wants this password. */
  readonly sudo?: 'none' | 'passwordless' | { readonly password: string };
}

/** What a command was, as the server saw it (after the sudo wrapper was taken off). */
export interface SeenCommand {
  readonly command: string;
  /** It ran as root: the login is root or it came through the sudo wrapper. */
  readonly root: boolean;
}

const SYSTEM_DIR = '/var/lib/swellwright';

/** Splits a command into words the way the services quote them: single quotes, `'\''`, double-quoted `$HOME`, bare words. */
export function words(line: string, home: string): string[] {
  const out: string[] = [];
  let current: string | undefined;
  let index = 0;
  const push = (text: string): void => {
    current = (current ?? '') + text;
  };
  while (index < line.length) {
    const char = line[index] ?? '';
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      push(line.slice(index + 1, end));
      index = end + 1;
    } else if (char === '"') {
      const end = line.indexOf('"', index + 1);
      push(line.slice(index + 1, end).replaceAll('$HOME', home));
      index = end + 1;
    } else if (char === '\\' && line[index + 1] !== undefined) {
      push(line[index + 1] ?? '');
      index += 2;
    } else if (char === ' ') {
      if (current !== undefined) {
        out.push(current);
        current = undefined;
      }
      index += 1;
    } else {
      push(char);
      index += 1;
    }
  }
  if (current !== undefined) {
    out.push(current);
  }
  return out;
}

const sha256OfFile = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export class ArtifactHost {
  /** The whole "file system" of the server: remote `/a/b` is `<root>/a/b`. */
  readonly root: string;
  readonly home: string;
  readonly uid: number;
  /** Every command that arrived, in order. */
  readonly commands: SeenCommand[] = [];
  /** The modes `chmod` and `install` set, by remote path. */
  readonly modes = new Map<string, number>();
  /** Who owns what `install` made, by remote path. */
  readonly owners = new Map<string, string>();
  /** The next hash of a temporary upload is taken after one byte was added to the file: it arrived damaged. */
  corruptUploads = false;
  /** The next hash of the file in its place is taken after one byte was added to it. */
  corruptFinalOnce = false;
  /**
   * `sftpStallWrites`: SFTP writes are never answered. `systemDirPrivate`: `/var/lib/swellwright` is a directory only
   * root can enter (the step layer makes it 0700 when it runs as root), so a login that is not root cannot look at the
   * system artifact directory over SFTP or by commands that do not go through sudo. Both are read when a session opens.
   */
  readonly flags: { sftpStallWrites: boolean; systemDirPrivate: boolean } = {
    sftpStallWrites: false,
    systemDirPrivate: false,
  };

  private constructor(
    readonly server: TestSshServer,
    root: string,
    uid: number,
    home: string,
  ) {
    this.root = root;
    this.uid = uid;
    this.home = home;
  }

  static async start(options: ArtifactHostOptions): Promise<ArtifactHost> {
    const uid = options.uid ?? 1000;
    const home = options.home ?? (uid === 0 ? '/root' : '/home/deploy');
    const root = mkdtempSync(join(tmpdir(), 'sw-art-host-'));
    mkdirSync(join(root, home), { recursive: true });
    mkdirSync(join(root, 'var', 'lib'), { recursive: true });
    const created: { host?: ArtifactHost } = {};
    const exec: ExecHandler = (channel, request) => {
      const chunks: Buffer[] = [];
      channel.on('data', (chunk: Buffer) => chunks.push(chunk));
      channel.on('end', () => {
        const stdin = Buffer.concat(chunks).toString('utf8');
        const finish = (out: string, err: string, code: number): void => {
          if (out !== '') {
            channel.write(out);
          }
          if (err !== '') {
            channel.stderr.write(err);
          }
          channel.exit(code);
          channel.end();
        };
        const host = created.host;
        if (!host) {
          finish('', 'not ready\n', 1);
          return;
        }
        if (!request.command.includes('swellwright-sudo')) {
          const result = host.run(request.command, uid === 0);
          finish(result.out, result.err, result.code);
          return;
        }
        // The wrapper of the SSH layer: `sh -c '<wrapper>' swellwright-sudo '<command>'`.
        const inner = wrappedCommand(request.command);
        const withPassword = request.command.includes('IFS= read -r SWPW');
        const given = withPassword ? stdin.split('\n')[0] : undefined;
        const sudo = options.sudo ?? 'none';
        const run = (): void => {
          const result = host.run(inner, true);
          finish(result.out, result.err, result.code);
        };
        if (uid === 0 || sudo === 'passwordless') {
          run();
        } else if (sudo === 'none') {
          finish('', 'sh: 1: exec: sudo: not found\n', 127);
        } else if (given === undefined) {
          finish('', 'sudo: a password is required\n', 1);
        } else if (given === sudo.password) {
          run();
        } else {
          finish('', 'Sorry, try again.\nsudo: 1 incorrect password attempt\n', 1);
        }
      });
    };
    const server = await TestSshServer.start({
      users: options.users,
      exec,
      sftpRoot: root,
      // Read when an SFTP session opens, so a test can switch it on and off between connections.
      get sftpStallWrites() {
        return created.host?.flags.sftpStallWrites ?? false;
      },
      get sftpDenied() {
        return created.host?.flags.systemDirPrivate === true && uid !== 0 ? [SYSTEM_DIR] : [];
      },
    });
    created.host = new ArtifactHost(server, root, uid, home);
    return created.host;
  }

  get port(): number {
    return this.server.port;
  }

  get fingerprint(): string {
    return this.server.hostKeyFingerprint;
  }

  /** The local path of a remote path. */
  local(remote: string): string {
    return join(this.root, ...remote.split('/').filter((part) => part !== ''));
  }

  exists(remote: string): boolean {
    return existsSync(this.local(remote));
  }

  read(remote: string): Buffer {
    return readFileSync(this.local(remote));
  }

  /** Every file below a remote directory, as remote paths, sorted. Empty when it does not exist. */
  tree(remote: string): string[] {
    const out: string[] = [];
    const visit = (directory: string): void => {
      if (!existsSync(this.local(directory))) {
        return;
      }
      for (const name of readdirSync(this.local(directory)).sort()) {
        const path = `${directory === '/' ? '' : directory}/${name}`;
        if (statSync(this.local(path)).isDirectory()) {
          out.push(`${path}/`);
          visit(path);
        } else {
          out.push(path);
        }
      }
    };
    visit(remote);
    return out;
  }

  /** What somebody does to a file on the server behind Swellwright's back. */
  write(remote: string, data: string | Buffer): void {
    mkdirSync(dirname(this.local(remote)), { recursive: true });
    rmSync(this.local(remote), { force: true });
    appendFileSync(this.local(remote), data);
  }

  remove(remote: string): void {
    rmSync(this.local(remote), { force: true });
  }

  async close(): Promise<void> {
    await this.server.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  // --- the shell ------------------------------------------------------------------------------------------------

  /** Runs `a && b && c`: stops at the first that fails, like the shell. */
  run(line: string, root: boolean): { out: string; err: string; code: number } {
    this.commands.push({ command: line, root });
    // The one command that is not a chain of simple ones: what is at a path, asked as root (`inspectAsRootCommand`).
    const inspect =
      /^if \[ ! -e (.+) \]; then echo missing; elif \[ -f .+ \]; then sha256sum -- .+; else echo other; fi$/u.exec(
        line,
      );
    if (inspect) {
      const path = words(inspect[1] ?? '', this.home)[0] ?? '';
      if (
        this.deny(path, root) ||
        (this.flags.systemDirPrivate && !root && path.startsWith(SYSTEM_DIR))
      ) {
        return { out: '', err: `sh: 1: cannot open ${path}: Permission denied\n`, code: 1 };
      }
      if (!this.exists(path)) {
        return { out: 'missing\n', err: '', code: 0 };
      }
      if (statSync(this.local(path)).isDirectory()) {
        return { out: 'other\n', err: '', code: 0 };
      }
      return this.simple(['sha256sum', '--', path], root);
    }
    let out = '';
    for (const part of line.split(' && ')) {
      const result = this.simple(words(part, this.home), root);
      out += result.out;
      if (result.code !== 0) {
        return { out, err: result.err, code: result.code };
      }
    }
    return { out, err: '', code: 0 };
  }

  private deny(path: string, root: boolean): boolean {
    return !root && (path === SYSTEM_DIR || path.startsWith(`${SYSTEM_DIR}/`));
  }

  /** Expands one word that may hold `*` against the files of its directory. */
  private expand(word: string): string[] {
    if (!word.includes('*')) {
      return [word];
    }
    const slash = word.lastIndexOf('/');
    const directory = word.slice(0, slash);
    const pattern = new RegExp(
      `^${word
        .slice(slash + 1)
        .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
        .replaceAll('*', '.*')}$`,
      'u',
    );
    if (!existsSync(this.local(directory))) {
      return [];
    }
    return readdirSync(this.local(directory))
      .filter((name) => pattern.test(name))
      .map((name) => `${directory}/${name}`);
  }

  private simple(argv: string[], root: boolean): { out: string; err: string; code: number } {
    const ok = { out: '', err: '', code: 0 };
    const fail = (err: string, code = 1) => ({ out: '', err: `${err}\n`, code });
    const [program = '', ...args] = argv;
    const flags = args.filter((arg) => arg.startsWith('-') && arg !== '--');
    const paths = args.slice(args.indexOf('--') + 1);
    switch (program) {
      case 'id':
        return { out: `${String(root ? 0 : this.uid)}\n`, err: '', code: 0 };
      case 'printf':
        return { out: `${this.home}\n`, err: '', code: 0 };
      case 'true':
      case 'umask':
        return ok;
      case 'sha256sum': {
        const path = paths[0] ?? '';
        if (!this.exists(path)) {
          return fail(`sha256sum: ${path}: No such file or directory`);
        }
        if (this.corruptUploads && path.includes('.swellwright-') && path.endsWith('.part')) {
          appendFileSync(this.local(path), 'X');
          this.corruptUploads = false;
        } else if (this.corruptFinalOnce && !path.endsWith('.part')) {
          appendFileSync(this.local(path), 'X');
          this.corruptFinalOnce = false;
        }
        return { out: `${sha256OfFile(this.local(path))}  ${path}\n`, err: '', code: 0 };
      }
      case 'chmod': {
        const path = paths[0] ?? '';
        if (!this.exists(path)) {
          return fail(`chmod: cannot access '${path}': No such file or directory`);
        }
        if (this.deny(path, root)) {
          return fail(`chmod: changing permissions of '${path}': Operation not permitted`);
        }
        this.modes.set(path, Number.parseInt(args[0] ?? '0', 8));
        return ok;
      }
      case 'rm': {
        const targets = paths.flatMap((word) => this.expand(word));
        for (const path of targets) {
          if (this.deny(path, root)) {
            return fail(`rm: cannot remove '${path}': Permission denied`);
          }
          if (this.exists(path)) {
            unlinkSync(this.local(path));
          } else if (!flags.includes('-f')) {
            return fail(`rm: cannot remove '${path}': No such file or directory`);
          }
        }
        return ok;
      }
      case 'rmdir': {
        const path = paths[0] ?? '';
        if (this.deny(path, root)) {
          return fail(`rmdir: failed to remove '${path}': Permission denied`);
        }
        try {
          rmdirSync(this.local(path));
        } catch {
          return fail(`rmdir: failed to remove '${path}': Directory not empty`);
        }
        return ok;
      }
      case 'install': {
        if (!root) {
          return fail('install: cannot create: Permission denied');
        }
        const mode = Number.parseInt(args[args.indexOf('-m') + 1] ?? '0', 8);
        if (flags.includes('-d')) {
          // Every named directory is made (with its parents) and gets the mode and the owner.
          for (const path of paths) {
            mkdirSync(this.local(path), { recursive: true });
            this.modes.set(path, mode);
            this.owners.set(path, 'root');
          }
          return ok;
        }
        const [from = '', to = ''] = paths;
        if (!this.exists(from)) {
          return fail(`install: cannot stat '${from}': No such file or directory`);
        }
        copyFileSync(this.local(from), this.local(to));
        this.modes.set(to, mode);
        this.owners.set(to, 'root');
        return ok;
      }
      case 'mv': {
        const [from = '', to = ''] = paths;
        if (this.deny(to, root) || !this.exists(from)) {
          return fail(`mv: cannot move '${from}' to '${to}'`);
        }
        rmSync(this.local(to), { force: true });
        renameSync(this.local(from), this.local(to));
        const mode = this.modes.get(from);
        if (mode !== undefined) {
          this.modes.set(to, mode);
          this.modes.delete(from);
        }
        const owner = this.owners.get(from);
        if (owner !== undefined) {
          this.owners.set(to, owner);
          this.owners.delete(from);
        }
        return ok;
      }
      default:
        return fail(`sh: 1: ${program}: not found`, 127);
    }
  }
}
