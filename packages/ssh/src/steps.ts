// Detached steps: work that runs on the server, survives the SSH connection and can be followed again later.
//
// The server needs only `sh`, coreutils (`setsid`, `base64`, `sha256sum`, `tail`, `head`, `wc`) and, for the
// sudo variant, `sudo`. Nothing is installed. The programs are in `step-scripts.ts`; the layout of a step on the
// server is described there.

import { createHash } from 'node:crypto';

import type { SshConnection } from './connection.js';
import { SshAbortError, SshInputError, SshStepError, redact } from './errors.js';
import {
  assertEnvName,
  assertNoNul,
  assertStepId,
  defaultStepBaseDir,
  remoteDirWord,
  shellQuote,
} from './shell.js';
import {
  CANCEL_SCRIPT,
  LAUNCH_SCRIPT,
  READ_SCRIPT,
  REMOVE_SCRIPT,
  STATUS_SCRIPT,
  WRAPPER_SCRIPT,
} from './step-scripts.js';
import type {
  DetachedStepSpec,
  StepOutputChunk,
  StepState,
  StepStatus,
  StepStream,
  SudoOptions,
} from './types.js';

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_UNKNOWN_GRACE_MS = 15_000;
const DEFAULT_CANCEL_GRACE_MS = 5000;
const CONTROL_EXEC_TIMEOUT_MS = 60_000;

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function stepBaseDir(connection: SshConnection, baseDir: string | undefined): string {
  return baseDir ?? defaultStepBaseDir(connection.username);
}

/**
 * The directory word for a command that runs through sudo. `~` is expanded by the remote shell from `$HOME`, and
 * sudo hands the command root's `HOME` (Debian and Ubuntu reset it): a step that lives below the login user's home
 * would be looked for in `/root`, found missing and left running or left behind. So the home of the login user is
 * asked first, as the login user, and the command gets the absolute path.
 */
async function sudoBaseWord(
  connection: SshConnection,
  base: string,
  sudo: SudoOptions | undefined,
): Promise<string> {
  if (sudo === undefined || !base.startsWith('~/')) return remoteDirWord(base);
  const result = await connection.exec('printf %s "$HOME"', { timeoutMs: CONTROL_EXEC_TIMEOUT_MS });
  const home = result.stdout;
  if (
    result.code !== 0 ||
    !home.startsWith('/') ||
    home.length > 512 ||
    // eslint-disable-next-line no-control-regex -- a control character in a path is refused on purpose
    /[\u0000-\u001f\u007f]/u.test(home)
  ) {
    throw new SshStepError(
      'ssh_step_failed',
      'The home directory of the login user could not be determined.',
    );
  }
  return remoteDirWord(`${home === '/' ? '' : home.replace(/\/+$/u, '')}${base.slice(1)}`);
}

function frame(name: string, data: Buffer | undefined): string {
  if (data === undefined) return `FRAME ${name} -\n`;
  const lines = data.toString('base64').match(/.{1,76}/gu) ?? [];
  return `FRAME ${name} ${sha256Hex(data)}\n${lines.map((line) => `${line}\n`).join('')}.\n`;
}

function sudoLine(sudo: SudoOptions | undefined): string {
  if (sudo === undefined) return '';
  const password = sudo.password ?? '';
  if (password.includes('\n') || password.includes('\0')) {
    throw new SshInputError('A sudo password must not contain a newline or a NUL character.');
  }
  return `${password}\n`;
}

function resultOf(stdout: string): string | undefined {
  const matches = [...stdout.matchAll(/^SWRESULT (\S+)$/gmu)];
  return matches.at(-1)?.[1];
}

function snippet(text: string, secrets: readonly (string | undefined)[]): string {
  const clean = redact(text.trim(), secrets).replace(/\s+/gu, ' ');
  return clean.length > 300 ? `${clean.slice(0, 300)}...` : clean;
}

/**
 * Starts a step and returns its status. Idempotent: the id names a directory on the server. If it already exists
 * with the same script the call attaches to it (nothing is started twice); with a different script it fails with
 * `SshStepError` code `ssh_step_conflict`.
 *
 * The script, its input and its environment travel on the standard input of one command, so they never appear in a
 * command line; with `sudo` the password is the first line of that input and is handled as described in
 * `sudo-wrap.ts`. The job is started under `setsid` with every descriptor redirected, so it survives the SSH
 * connection ending and never holds the channel open.
 */
export async function startDetachedStep(
  connection: SshConnection,
  spec: DetachedStepSpec,
): Promise<StepStatus> {
  assertStepId(spec.id);
  if (spec.script.length === 0) throw new SshInputError('A step script must not be empty.');
  assertNoNul(spec.script, 'A step script');
  const script = Buffer.from(spec.script, 'utf8');
  if (script.length > MAX_SCRIPT_BYTES)
    throw new SshInputError('A step script is limited to 2 MiB.');
  let stdin: Buffer | undefined;
  if (spec.stdin !== undefined) {
    assertNoNul(spec.stdin, 'A step input');
    stdin = Buffer.from(spec.stdin, 'utf8');
    if (stdin.length > MAX_STDIN_BYTES)
      throw new SshInputError('A step input is limited to 2 MiB.');
  }
  let env: Buffer | undefined;
  if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
    const lines = Object.entries(spec.env).map(([name, value]) => {
      assertEnvName(name);
      assertNoNul(value, 'An environment value');
      return `export ${name}=${shellQuote(value)}\n`;
    });
    env = Buffer.from(lines.join(''), 'utf8');
  }
  const baseDir = stepBaseDir(connection, spec.baseDir);
  const baseWord = remoteDirWord(baseDir);
  const scriptSha = sha256Hex(script);
  const password = spec.sudo?.password;

  const payload = Buffer.from(
    `${sudoLine(spec.sudo)}SWSTEP/1\n${frame('script', script)}${frame('stdin', stdin)}${frame('env', env)}${frame('run', Buffer.from(WRAPPER_SCRIPT, 'utf8'))}`,
    'utf8',
  );
  const command = `sh -c ${shellQuote(LAUNCH_SCRIPT)} swellwright-launch ${baseWord} ${shellQuote(spec.id)} ${shellQuote(scriptSha)} ${spec.sudo === undefined ? '0' : '1'}`;
  const result = await connection.exec(command, {
    stdin: payload,
    timeoutMs: CONTROL_EXEC_TIMEOUT_MS,
  });

  const outcome = resultOf(result.stdout);
  if (result.code !== 0 || outcome === undefined) {
    throw new SshStepError(
      'ssh_step_failed',
      `The step "${spec.id}" could not be started (exit ${String(result.code)}): ${snippet(result.stderr, [password])}`,
    );
  }
  if (outcome === 'conflict') {
    throw new SshStepError(
      'ssh_step_conflict',
      `A step "${spec.id}" already exists on the server with a different script.`,
    );
  }
  if (outcome === 'incomplete') {
    throw new SshStepError(
      'ssh_step_incomplete',
      `A step "${spec.id}" exists on the server but was never fully created; remove it (removeStep) or choose another id.`,
    );
  }
  return getStepStatus(connection, spec.id, baseDir);
}

/** Reports a step. Throws `SshStepError` (`ssh_step_not_found`) when no such step exists in `baseDir`. */
export async function getStepStatus(
  connection: SshConnection,
  id: string,
  baseDir?: string,
): Promise<StepStatus> {
  assertStepId(id);
  const base = stepBaseDir(connection, baseDir);
  const command = `sh -c ${shellQuote(STATUS_SCRIPT)} swellwright-status ${remoteDirWord(base)} ${shellQuote(id)}`;
  const result = await connection.exec(command, { timeoutMs: CONTROL_EXEC_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new SshStepError(
      'ssh_step_failed',
      `The status of step "${id}" could not be read: ${snippet(result.stderr, [])}`,
    );
  }
  const fields = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const state = fields.get('state');
  if (state === 'notfound')
    throw new SshStepError('ssh_step_not_found', `No step "${id}" in ${base}.`);
  if (state !== 'running' && state !== 'exited' && state !== 'lost' && state !== 'unknown') {
    throw new SshStepError('ssh_step_failed', `The status of step "${id}" was not understood.`);
  }
  const exitCode = fields.get('code') ?? '';
  const count = (key: string): number => {
    const value = Number.parseInt(fields.get(key) ?? '0', 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    id,
    state: state satisfies StepState,
    exitCode: state === 'exited' && /^\d+$/u.test(exitCode) ? Number.parseInt(exitCode, 10) : null,
    startedAt: nonEmpty(fields.get('started')),
    finishedAt: state === 'exited' ? nonEmpty(fields.get('finished')) : null,
    scriptSha256: fields.get('sha') ?? '',
    stdoutBytes: count('out'),
    stderrBytes: count('err'),
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

export interface ReadStepOutputOptions {
  stream: StepStream;
  /** Byte offset to continue from (0 for the beginning). The `nextOffset` of the previous read. */
  fromOffset: number;
  /** At most this many bytes (default 256 KiB, at most 4 MiB). */
  maxBytes?: number;
  baseDir?: string;
}

export interface ReadStepOutputResult {
  data: Buffer;
  /** Where the next read starts: `fromOffset` plus the bytes returned. */
  nextOffset: number;
  /** The step has finished and everything it wrote has been read. */
  eof: boolean;
}

/**
 * Reads a slice of a step's standard output or error by byte offset, so a reader that lost its connection continues
 * exactly where it stopped. The bytes are returned as they are (binary safe).
 */
export async function readStepOutput(
  connection: SshConnection,
  id: string,
  options: ReadStepOutputOptions,
): Promise<ReadStepOutputResult> {
  assertStepId(id);
  if (!Number.isSafeInteger(options.fromOffset) || options.fromOffset < 0) {
    throw new SshInputError('fromOffset must be a non-negative integer.');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_READ_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
    throw new SshInputError('maxBytes must be from 1 to 4 MiB.');
  }
  const base = stepBaseDir(connection, options.baseDir);
  const file = options.stream === 'stdout' ? 'out' : 'err';
  const command = `sh -c ${shellQuote(READ_SCRIPT)} swellwright-read ${remoteDirWord(base)} ${shellQuote(id)} ${file} ${String(options.fromOffset)} ${String(maxBytes)}`;
  const result = await connection.execRaw(command, {
    timeoutMs: CONTROL_EXEC_TIMEOUT_MS,
    maxOutputBytes: maxBytes + 1024,
  });
  if (result.code !== 0) {
    throw new SshStepError(
      'ssh_step_failed',
      `The output of step "${id}" could not be read: ${snippet(result.stderr.toString('utf8'), [])}`,
    );
  }
  const newline = result.stdout.indexOf(0x0a);
  const header = newline < 0 ? '' : result.stdout.toString('latin1', 0, newline);
  if (header === 'SWO notfound')
    throw new SshStepError('ssh_step_not_found', `No step "${id}" in ${base}.`);
  const match = /^SWO ([01]) (\d+) (\d+)$/u.exec(header);
  if (match === null)
    throw new SshStepError('ssh_step_failed', `The output of step "${id}" was not understood.`);
  const finished = match[1] === '1';
  const size = Number.parseInt(match[2] ?? '0', 10);
  const expected = Number.parseInt(match[3] ?? '0', 10);
  const data = result.stdout.subarray(newline + 1);
  if (data.length !== expected || result.stdoutTruncated) {
    throw new SshStepError(
      'ssh_step_failed',
      `The output of step "${id}" arrived incomplete (${String(data.length)} of ${String(expected)} bytes).`,
    );
  }
  const nextOffset = options.fromOffset + data.length;
  return { data, nextOffset, eof: finished && nextOffset >= size };
}

export interface WaitForStepOptions {
  /** Pause between polls. Default 1000. */
  pollMs?: number;
  /** Called with every chunk of output, in order per stream. Return a promise to apply backpressure. */
  onOutput?: (chunk: StepOutputChunk) => void | Promise<void>;
  signal?: AbortSignal;
  baseDir?: string;
  /**
   * Where each stream continues from. A caller that lost its connection passes the `nextOffset` of the last chunk
   * it processed and gets no duplicates. Default 0 (everything from the start).
   */
  fromOffsets?: { stdout?: number; stderr?: number };
  /** Bytes per read. Default 256 KiB. */
  chunkBytes?: number;
  /** How long a step may stay `unknown` (the wrapper has not recorded a process) before giving up. Default 15000. */
  unknownGraceMs?: number;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SshAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SshAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Follows a step until it is over: polls the status and streams new output through `onOutput`. Returns the final
 * status (`exited`, or `lost` when the process vanished without an exit marker). All output written before the
 * step was seen finished has been delivered when it returns. If the connection drops it rejects; connect again and
 * call it again with `fromOffsets` set from the last chunk to continue without repeats.
 */
export async function waitForStep(
  connection: SshConnection,
  id: string,
  options: WaitForStepOptions = {},
): Promise<StepStatus> {
  assertStepId(id);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const unknownGraceMs = options.unknownGraceMs ?? DEFAULT_UNKNOWN_GRACE_MS;
  const offsets: Record<StepStream, number> = {
    stdout: options.fromOffsets?.stdout ?? 0,
    stderr: options.fromOffsets?.stderr ?? 0,
  };
  const drain = async (stream: StepStream): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) throw new SshAbortError();
      const slice = await readStepOutput(connection, id, {
        stream,
        fromOffset: offsets[stream],
        ...(options.chunkBytes === undefined ? {} : { maxBytes: options.chunkBytes }),
        ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
      });
      if (slice.data.length === 0) return;
      const offset = offsets[stream];
      offsets[stream] = slice.nextOffset;
      await options.onOutput?.({ stream, data: slice.data, offset, nextOffset: slice.nextOffset });
    }
  };

  let unknownSince: number | undefined;
  for (;;) {
    if (options.signal?.aborted === true) throw new SshAbortError();
    // The status is read first: if the step is over, everything it wrote is already in the files.
    const status = await getStepStatus(connection, id, options.baseDir);
    await drain('stdout');
    await drain('stderr');
    if (status.state === 'exited' || status.state === 'lost') return status;
    if (status.state === 'unknown') {
      unknownSince ??= Date.now();
      if (Date.now() - unknownSince > unknownGraceMs) {
        throw new SshStepError('ssh_step_incomplete', `Step "${id}" never started a process.`);
      }
    } else {
      unknownSince = undefined;
    }
    await sleep(pollMs, options.signal);
  }
}

export interface CancelStepOptions {
  baseDir?: string;
  /** Needed to stop a step that runs as root when the SSH user is not root. */
  sudo?: SudoOptions;
  /** How long TERM gets before KILL. Default 5000. */
  graceMs?: number;
}

/**
 * Stops a step: TERM to its whole process group, KILL after the grace period, and the exit marker (143 or 137) when
 * the wrapper could not write one. A step that already finished is left alone.
 */
export async function cancelStep(
  connection: SshConnection,
  id: string,
  options: CancelStepOptions = {},
): Promise<void> {
  assertStepId(id);
  const base = stepBaseDir(connection, options.baseDir);
  const graceMs = options.graceMs ?? DEFAULT_CANCEL_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0)
    throw new SshInputError('graceMs must be a non-negative number.');
  const ticks = Math.ceil(graceMs / 200);
  const baseWord = await sudoBaseWord(connection, base, options.sudo);
  const command = `sh -c ${shellQuote(CANCEL_SCRIPT)} swellwright-cancel ${baseWord} ${shellQuote(id)} ${String(ticks)}`;
  const result = await connection.exec(command, {
    timeoutMs: graceMs + 30_000,
    ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
  });
  const outcome = resultOf(result.stdout);
  if (result.code !== 0 || outcome === undefined) {
    throw new SshStepError(
      'ssh_step_failed',
      `Step "${id}" could not be cancelled: ${snippet(result.stderr, [options.sudo?.password])}`,
    );
  }
  if (outcome === 'notfound')
    throw new SshStepError('ssh_step_not_found', `No step "${id}" in ${base}.`);
  if (outcome === 'denied') {
    throw new SshStepError(
      'ssh_step_failed',
      `Step "${id}" runs as another user; pass sudo to cancel it.`,
    );
  }
}

export interface RemoveStepOptions {
  baseDir?: string;
  sudo?: SudoOptions;
  /** Remove even if the step is still running (it is not stopped: use `cancelStep` first). */
  force?: boolean;
}

/** Deletes a step's directory from the server. A running step is refused unless `force` is set. Returns whether it was removed. */
export async function removeStep(
  connection: SshConnection,
  id: string,
  options: RemoveStepOptions = {},
): Promise<boolean> {
  assertStepId(id);
  const base = stepBaseDir(connection, options.baseDir);
  const baseWord = await sudoBaseWord(connection, base, options.sudo);
  const command = `sh -c ${shellQuote(REMOVE_SCRIPT)} swellwright-remove ${baseWord} ${shellQuote(id)} ${options.force === true ? '1' : '0'}`;
  const result = await connection.exec(command, {
    timeoutMs: CONTROL_EXEC_TIMEOUT_MS,
    ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
  });
  const outcome = resultOf(result.stdout);
  if (result.code !== 0 || outcome === undefined) {
    throw new SshStepError(
      'ssh_step_failed',
      `Step "${id}" could not be removed: ${snippet(result.stderr, [options.sudo?.password])}`,
    );
  }
  return outcome === 'removed';
}
