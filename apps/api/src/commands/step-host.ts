import { type ExecHandler, TestSshServer, type TestUser } from '@swellwright/ssh/test-support';

import { wrappedCommand } from '../servers/ssh-test-support.js';

/**
 * For tests of the runner: an SSH server that answers the commands of the detached-step layer (`swellwright-launch`,
 * `-status`, `-read`, `-cancel`, `-remove`) from memory, with the scripts replaced by programs the test writes in
 * TypeScript. It needs no shell, so the whole runner (offsets, reconnects, cancel, restart) is tested on any machine;
 * the real shell scripts are tested against a real shell in `commands-shell.test.ts`.
 *
 * A program is chosen by a line `# fake:NAME` of the script text. It receives the environment the step was given, can
 * write to both streams, wait on gates the test controls, and is stopped by `cancelStep` through its `signal`.
 */

export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

export function createGate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export interface ProgramContext {
  readonly env: Readonly<Record<string, string>>;
  readonly script: string;
  readonly stepId: string;
  /** Aborted by `cancelStep`. */
  readonly signal: AbortSignal;
  write(stream: 'stdout' | 'stderr', data: string | Buffer): void;
  /** Resolves after the time, or at once when the step is cancelled. */
  sleep(ms: number): Promise<void>;
  /** The bytes of a secret file of the step, or undefined when there is none (it was never delivered, or it is gone). */
  readSecret(name: string): Buffer | undefined;
}

export type Program = (context: ProgramContext) => Promise<number> | number;

interface EmulatedStep {
  readonly key: string;
  readonly sha: string;
  readonly script: string;
  readonly env: Record<string, string>;
  /** The files of `<step dir>/secrets`: delivered with the launch, gone when the program ends by any route. */
  readonly secrets: Map<string, Buffer>;
  readonly abort: AbortController;
  stdout: Buffer;
  stderr: Buffer;
  exit: number | undefined;
  readonly started: string;
  finished: string | undefined;
}

const MARKERS = [
  'swellwright-launch',
  'swellwright-status',
  'swellwright-read',
  'swellwright-cancel',
  'swellwright-remove',
] as const;

/** The words of a command line as the remote `sh` would see them: single and double quotes, and `\'` between them. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? '';
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      current += line.slice(index + 1, end);
      inWord = true;
      index = end + 1;
    } else if (char === '"') {
      const end = line.indexOf('"', index + 1);
      current += line.slice(index + 1, end);
      inWord = true;
      index = end + 1;
    } else if (char === '\\') {
      current += line[index + 1] ?? '';
      inWord = true;
      index += 2;
    } else if (/\s/u.test(char)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      index += 1;
    } else {
      current += char;
      inWord = true;
      index += 1;
    }
  }
  if (inWord) {
    words.push(current);
  }
  return words;
}

/** The home of the login of this stand-in server. */
const LOGIN_HOME = '/home/deploy';

const iso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');

export interface StepHostOptions {
  readonly users: Readonly<Record<string, TestUser>>;
  readonly programs: Readonly<Record<string, Program>>;
  /** The launch waits for this before it answers (a start that is in flight when something else happens). */
  readonly launchGate?: Promise<void>;
  /** The launch fails with this message on its standard error and status 69, as when `sudo` or `setsid` is missing. */
  readonly launchFailure?: string;
}

export class StepHost {
  /** Steps by `<base>/<id>`. */
  readonly steps = new Map<string, EmulatedStep>();
  /** Ids of the steps that were removed, in order. */
  readonly removed: string[] = [];
  /** How many launches created a step, and how many found it there. */
  readonly launches = { created: 0, attached: 0 };
  /** Every command line that arrived, in order: a value of a secret must never be in one. */
  readonly commands: string[] = [];
  /** The highest number of programs that ran at the same moment. */
  maxRunning = 0;
  /** Launches that have arrived and wait for the gate. */
  launchesWaiting = 0;
  private running = 0;

  private constructor(readonly server: TestSshServer) {}

  static async start(options: StepHostOptions): Promise<StepHost> {
    const created: { host?: StepHost } = {};
    const exec: ExecHandler = (channel, request) => {
      const chunks: Buffer[] = [];
      channel.on('data', (chunk: Buffer) => chunks.push(chunk));
      channel.on('end', () => {
        const stdin = Buffer.concat(chunks);
        const reply = (text: string | Buffer, code = 0, toStderr = false): void => {
          (toStderr ? channel.stderr : channel).write(text);
          channel.exit(code);
          channel.end();
        };
        void created.host?.handle(request.command, stdin, options, reply);
      });
    };
    const server = await TestSshServer.start({ users: options.users, exec });
    created.host = new StepHost(server);
    return created.host;
  }

  get port(): number {
    return this.server.port;
  }

  get fingerprint(): string {
    return this.server.hostKeyFingerprint;
  }

  /** The steps that exist now and have not ended. */
  runningSteps(): EmulatedStep[] {
    return [...this.steps.values()].filter((step) => step.exit === undefined);
  }

  async close(): Promise<void> {
    for (const step of this.steps.values()) {
      step.abort.abort();
    }
    await this.server.close();
  }

  private async handle(
    command: string,
    stdin: Buffer,
    options: StepHostOptions,
    reply: (text: string | Buffer, code?: number, toStderr?: boolean) => void,
  ): Promise<void> {
    this.commands.push(command);
    let inner = command;
    let input = stdin;
    if (command.includes('swellwright-sudo')) {
      // The wrapper of the SSH layer: the password is the first line of the input when there is one.
      inner = wrappedCommand(command);
      if (command.includes('IFS= read -r SWPW')) {
        const newline = stdin.indexOf(0x0a);
        input = stdin.subarray(newline + 1);
      }
    }
    if (command === 'printf %s "$HOME"') {
      // The SSH layer asks for the home of the login before it cancels or removes a step through sudo (sudo resets `HOME`).
      reply(LOGIN_HOME, 0);
      return;
    }
    // The remote shell expands `$HOME`: a step started with `"$HOME"/...` and looked at with the absolute path is one step.
    const words = shellWords(inner).map((word) => word.replaceAll('$HOME', LOGIN_HOME));
    const marker = words.findIndex((word) => (MARKERS as readonly string[]).includes(word));
    if (marker < 0) {
      reply(`sh: 1: ${words[0] ?? ''}: not found\n`, 127);
      return;
    }
    const args = words.slice(marker + 1);
    switch (words[marker]) {
      case 'swellwright-launch':
        await this.launch(args, input, options, reply);
        return;
      case 'swellwright-status':
        this.status(args, reply);
        return;
      case 'swellwright-read':
        this.read(args, reply);
        return;
      case 'swellwright-cancel':
        await this.cancel(args, reply);
        return;
      default:
        this.remove(args, reply);
    }
  }

  private static frames(
    text: string,
    withSudoLine: boolean,
  ): { frames: Map<string, Buffer | undefined>; secrets: Map<string, Buffer> } {
    const lines = text.split('\n');
    let index = withSudoLine ? 1 : 0;
    if (lines[index] !== 'SWSTEP/1') {
      throw new Error('bad header');
    }
    index += 1;
    const frames = new Map<string, Buffer | undefined>();
    const secrets = new Map<string, Buffer>();
    while (index < lines.length) {
      const [tag, name, sha] = (lines[index] ?? '').split(' ');
      index += 1;
      if ((tag !== 'FRAME' && tag !== 'SECRET') || name === undefined) {
        break;
      }
      if (sha === '-') {
        frames.set(name, undefined);
        continue;
      }
      const body: string[] = [];
      while (index < lines.length && lines[index] !== '.') {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      const data = Buffer.from(body.join(''), 'base64');
      if (tag === 'SECRET') {
        secrets.set(name, data);
      } else {
        frames.set(name, data);
      }
    }
    return { frames, secrets };
  }

  private async launch(
    args: string[],
    input: Buffer,
    options: StepHostOptions,
    reply: (text: string | Buffer, code?: number, toStderr?: boolean) => void,
  ): Promise<void> {
    const [base = '', id = '', sha = '', useSudo = '0'] = args;
    const key = `${base}/${id}`;
    if (options.launchGate) {
      this.launchesWaiting += 1;
      await options.launchGate;
      this.launchesWaiting -= 1;
    }
    if (options.launchFailure !== undefined) {
      reply(`swellwright: ${options.launchFailure}\n`, 69, true);
      return;
    }
    const existing = this.steps.get(key);
    if (existing) {
      this.launches.attached += 1;
      reply(`SWRESULT ${existing.sha === sha ? 'attached' : 'conflict'}\n`);
      return;
    }
    // With sudo the first line of the input is the password; the frames follow.
    const { frames, secrets } = StepHost.frames(input.toString('utf8'), useSudo === '1');
    const script = (frames.get('script') ?? Buffer.alloc(0)).toString('utf8');
    const envText = (frames.get('env') ?? Buffer.alloc(0)).toString('utf8');
    const env: Record<string, string> = {};
    for (const [name, value] of StepHost.exports(envText)) {
      env[name] = value.replaceAll('$SWELLWRIGHT_STEP_DIR', key);
    }
    const step: EmulatedStep = {
      key,
      sha,
      script,
      env,
      secrets,
      abort: new AbortController(),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exit: undefined,
      started: iso(),
      finished: undefined,
    };
    this.steps.set(key, step);
    this.launches.created += 1;
    void this.run(step, id, options);
    reply('SWRESULT started\n');
  }

  /** The `export NAME='value'` lines of an environment frame, with values that may hold newlines. */
  private static exports(text: string): [string, string][] {
    const found: [string, string][] = [];
    let index = 0;
    while (index < text.length) {
      const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=/u.exec(text.slice(index));
      if (!match) {
        break;
      }
      index += match[0].length;
      let value = '';
      while (index < text.length && text[index] !== '\n') {
        if (text[index] === "'") {
          const end = text.indexOf("'", index + 1);
          value += text.slice(index + 1, end);
          index = end + 1;
        } else if (text[index] === '"') {
          const end = text.indexOf('"', index + 1);
          value += text.slice(index + 1, end);
          index = end + 1;
        } else if (text[index] === '\\') {
          value += text[index + 1] ?? '';
          index += 2;
        } else {
          value += text[index] ?? '';
          index += 1;
        }
      }
      index += 1;
      found.push([match[1] ?? '', value]);
    }
    return found;
  }

  private async run(step: EmulatedStep, id: string, options: StepHostOptions): Promise<void> {
    const name = /^# fake:(\S+)/mu.exec(step.script)?.[1] ?? '';
    const program = options.programs[name];
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    let code = 127;
    try {
      if (program) {
        code = await program({
          env: step.env,
          script: step.script,
          stepId: id,
          signal: step.abort.signal,
          readSecret: (name) => step.secrets.get(name),
          write: (stream, data) => {
            const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            if (stream === 'stdout') {
              step.stdout = Buffer.concat([step.stdout, bytes]);
            } else {
              step.stderr = Buffer.concat([step.stderr, bytes]);
            }
          },
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, ms);
              step.abort.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            }),
        });
      } else {
        step.stderr = Buffer.from(`no program "${name}" in this test\n`);
      }
    } finally {
      this.running -= 1;
      // The wrapper removes the secrets the moment the script ends, whatever the way (exit, kill, timeout, cancel).
      step.secrets.clear();
    }
    if (step.exit === undefined) {
      step.exit = step.abort.signal.aborted && code === 0 ? 143 : code;
      step.finished = iso();
    }
  }

  private status(args: string[], reply: (text: string) => void): void {
    const [base = '', id = ''] = args;
    const step = this.steps.get(`${base}/${id}`);
    if (!step) {
      reply('state=notfound\n');
      return;
    }
    reply(
      `state=${step.exit === undefined ? 'running' : 'exited'}\ncode=${step.exit === undefined ? '' : String(step.exit)}\nstarted=${step.started}\nfinished=${step.finished ?? ''}\nsha=${step.sha}\nout=${String(step.stdout.length)}\nerr=${String(step.stderr.length)}\n`,
    );
  }

  private read(args: string[], reply: (text: string | Buffer) => void): void {
    const [base = '', id = '', file = 'out', from = '0', max = '0'] = args;
    const step = this.steps.get(`${base}/${id}`);
    if (!step) {
      reply('SWO notfound\n');
      return;
    }
    const data = file === 'out' ? step.stdout : step.stderr;
    const fin = step.exit === undefined ? 0 : 1;
    const start = Number(from);
    const slice = data.subarray(
      start,
      start + Math.min(Number(max), Math.max(0, data.length - start)),
    );
    reply(
      Buffer.concat([
        Buffer.from(`SWO ${String(fin)} ${String(data.length)} ${String(slice.length)}\n`),
        slice,
      ]),
    );
  }

  private async cancel(args: string[], reply: (text: string) => void): Promise<void> {
    const [base = '', id = ''] = args;
    const step = this.steps.get(`${base}/${id}`);
    if (!step) {
      reply('SWRESULT notfound\n');
      return;
    }
    if (step.exit !== undefined) {
      reply('SWRESULT finished\n');
      return;
    }
    step.abort.abort();
    const ended = (): boolean => step.exit !== undefined;
    for (let tick = 0; tick < 50 && !ended(); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (!ended()) {
      step.exit = 137;
      step.finished = iso();
    }
    reply('SWRESULT cancelled\n');
  }

  private remove(args: string[], reply: (text: string) => void): void {
    const [base = '', id = '', force = '0'] = args;
    const key = `${base}/${id}`;
    const step = this.steps.get(key);
    if (!step) {
      reply('SWRESULT notfound\n');
      return;
    }
    if (step.exit === undefined && force !== '1') {
      reply('SWRESULT running\n');
      return;
    }
    step.secrets.clear();
    this.steps.delete(key);
    this.removed.push(id);
    reply('SWRESULT removed\n');
  }

  /** Makes a step vanish, as when the server was rebuilt (a rebuilt server runs nothing of the old one any more). */
  forget(id: string): void {
    for (const key of [...this.steps.keys()]) {
      if (key.endsWith(`/${id}`)) {
        // The emulated program is told to stop: a program that nobody can reach any more would keep the test process alive.
        this.steps.get(key)?.abort.abort();
        this.steps.get(key)?.secrets.clear();
        this.steps.delete(key);
      }
    }
  }
}
