import { type ChildProcess, fork, type Serializable } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PluginGatewayRequestSchema, type PluginGatewayRequest } from '@swellwright/contracts';
import { type ConfigValues, PLUGIN_LIMITS, type PluginFetchInit } from '@swellwright/plugin-api';

import { type NetworkResponse } from './network.js';

export type ProcessState = 'running' | 'failed' | 'stopped';

/** A module of the plugin to load: the extension kind it provides and the file, relative to the plugin. */
export interface ModuleSpec {
  readonly kind: string;
  readonly entry: string;
}

/**
 * What the core does for a plugin when it asks (ADR 0028, 0029): the network, the secret bound to one of its
 * settings, its storage, and the settings that go with every call. Each is already limited to this plugin and to
 * what was approved; a refusal is an error that reaches the plugin.
 */
export interface CoreServices {
  /** The settings for a call. Throws when the plugin is not configured. */
  settings(): Promise<ConfigValues>;
  /** `signal` ends the request when the call it belongs to is over. */
  fetch(url: string, init: PluginFetchInit, signal?: AbortSignal): Promise<NetworkResponse>;
  secret(field: string): Promise<string>;
  storage: {
    get(key: unknown): Promise<unknown>;
    set(key: unknown, value: unknown): Promise<void>;
    delete(key: unknown): Promise<void>;
    keys(): Promise<string[]>;
  };
}

export interface StartOptions {
  readonly pluginId: string;
  readonly directory: string;
  readonly modules: readonly ModuleSpec[];
  readonly services: CoreServices;
  readonly runnerPath: string;
  readonly memoryMiB: number;
  readonly startTimeoutMs: number;
  /** Called whenever the state of the process changes (it ended, it was ended, a call timed out). */
  readonly onChange?: (snapshot: RuntimeSnapshot) => void;
  readonly execPath?: string;
  /** Ends a start that is still going: the process is killed and the start fails. */
  readonly signal?: AbortSignal;
}

export interface RuntimeSnapshot {
  readonly state: ProcessState;
  readonly startedAt: Date | null;
  readonly calls: number;
  readonly lastError: string | null;
  readonly modules: readonly { readonly kind: string; readonly methods: readonly string[] }[];
}

/** An error the plugin or its process caused, with a message that is safe to show to an administrator. */
export class PluginCallError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'timeout'
      | 'crashed'
      | 'busy'
      | 'refused'
      | 'failed'
      | 'not_running'
      | 'not_configured'
      | 'secret_expired',
  ) {
    super(message);
    this.name = 'PluginCallError';
  }
}

/** A call that is under way, and what the plugin asked of the core while it was. */
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  /** Ends the requests to the core that belong to this call when it is over. */
  readonly controller: AbortController;
  /** How many requests to the core this call made. */
  requests: number;
  /** The vault refused an expired secret to this call: a failure of the call is then that (ADR 0042). */
  expired: boolean;
}

type CoreMessage = { type: 'core'; id: number; call: number } & PluginGatewayRequest;

type FromPlugin =
  | { type: 'ready'; modules: Record<string, string[]> }
  | { type: 'failed' }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
  | CoreMessage;

/** The most modules and methods a plugin may list, and how long a name or a message it sends may be. */
const MAX_MODULES = 32;
const MAX_METHODS = 256;
const MAX_NAME_CHARS = 128;
const MAX_TEXT_CHARS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

/** Inspect decoded JSON before schema validation or forwarding. The Node IPC channel decodes the frame first. */
function fitsPayload(value: unknown, budget: { bytes: number; nodes: number }, depth = 0): boolean {
  if (depth > 32 || --budget.nodes < 0) {
    return false;
  }
  const debit = (text: string): boolean => {
    if (text.length > budget.bytes) {
      return false;
    }
    budget.bytes -= Buffer.byteLength(text);
    return budget.bytes >= 0;
  };
  if (typeof value === 'string') {
    return debit(value);
  }
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  for (const key in value) {
    if (
      Object.hasOwn(value, key) &&
      (!debit(key) || !fitsPayload((value as Record<string, unknown>)[key], budget, depth + 1))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * What a message from the plugin's process is, checked: the process is the plugin's, so nothing it sends is trusted
 * to have the shape the runner gives it. Undefined for anything else.
 */
export function parseFromPlugin(message: unknown): FromPlugin | undefined {
  if (
    !isRecord(message) ||
    !fitsPayload(message, { bytes: PLUGIN_LIMITS.responseBytes, nodes: 100_000 })
  ) {
    return undefined;
  }
  switch (message['type']) {
    case 'ready': {
      const modules = message['modules'];
      if (!isRecord(modules) || Object.keys(modules).length > MAX_MODULES) {
        return undefined;
      }
      const listing = Object.create(null) as Record<string, string[]>;
      for (const [kind, methods] of Object.entries(modules)) {
        if (
          !isText(kind, MAX_NAME_CHARS) ||
          !Array.isArray(methods) ||
          methods.length > MAX_METHODS ||
          !methods.every((m) => isText(m, MAX_NAME_CHARS))
        ) {
          return undefined;
        }
        listing[kind] = [...methods];
      }
      return { type: 'ready', modules: listing };
    }
    case 'failed':
      return Object.hasOwn(message, 'message') ? undefined : { type: 'failed' };
    case 'result':
      return isId(message['id']) && Object.hasOwn(message, 'value')
        ? { type: 'result', id: message['id'], value: message['value'] }
        : undefined;
    case 'error':
      return isId(message['id']) && isText(message['message'], MAX_TEXT_CHARS)
        ? { type: 'error', id: message['id'], message: message['message'] }
        : undefined;
    case 'core': {
      const id = message['id'];
      const call = message['call'];
      if (!isId(id) || !isId(call)) {
        return undefined;
      }
      const request = PluginGatewayRequestSchema.safeParse(message);
      return request.success ? { type: 'core', id, call, ...request.data } : undefined;
    }
    default:
      return undefined;
  }
}

/** True for the refusal of an expired secret, whichever layer raised it (it carries the stable code). */
function isExpiredRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'secret_expired'
  );
}

/**
 * One plugin's process (ADR 0028). It is started with the Node permission model on: it may read its own
 * directory and the runner and nothing else; there is no network, no child process, no worker, no native
 * addon, no code generation from strings, and its environment holds nothing of the core's. It has a heap
 * limit, and a call that takes too long ends the process. Its only way out is the core, and only while a call
 * the core made is under way (ADR 0050).
 *
 * What the process prints is not kept: it may print anything it was given, a secret included, and what is kept is
 * shown to everyone who may list plugins. The state and the last error are the core's own words.
 */
export class PluginProcess {
  private state: ProcessState = 'running';
  private lastError: string | null = null;
  private calls = 0;
  private modules: RuntimeSnapshot['modules'] = [];
  private startedAt = new Date();
  private nextId = 1;
  /** Calls admitted and not yet sent, so that two callers cannot both pass the limit while settings are read. */
  private admitting = 0;
  /** Requests to the core being answered now. */
  private relaying = 0;
  private ready = false;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private readonly stopping = { value: false };

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: StartOptions,
  ) {
    this.exited = new Promise((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });
  }

  /**
   * Starts the process and waits until every module is loaded. A module that cannot be loaded (it does not
   * exist, it throws, it tries something the restrictions forbid) fails the start.
   */
  static async start(options: StartOptions): Promise<PluginProcess> {
    const directory = await realpath(options.directory);
    const runner = await realpath(options.runnerPath);
    if (options.signal?.aborted === true) {
      throw new PluginCallError('The plugin was stopped while it started.', 'not_running');
    }
    const specs = options.modules.map(
      (m) => `${m.kind}=${pathToFileURL(join(directory, m.entry)).href}`,
    );
    const child = fork(runner, [options.pluginId, ...specs], {
      execPath: options.execPath ?? process.execPath,
      // Never started without the permission model: if the flag is not understood, the start fails.
      execArgv: [
        '--permission',
        `--allow-fs-read=${directory}`,
        `--allow-fs-read=${runner}`,
        `--max-old-space-size=${String(options.memoryMiB)}`,
        '--disallow-code-generation-from-strings',
      ],
      cwd: directory,
      // Nothing of the core's environment: no keys, no database address.
      env:
        process.platform === 'win32'
          ? { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows' }
          : {},
      // What the plugin prints goes nowhere (see the class).
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    const instance = new PluginProcess(child, { ...options, directory });
    try {
      await instance.handshake();
    } catch (error) {
      // Handshake rejection can precede child exit. Wait for the child to release its working directory.
      await instance.waitForClose();
      throw error;
    }
    return instance;
  }

  private handshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.options.signal?.removeEventListener('abort', aborted);
        if (error) {
          reject(error);
        } else {
          this.ready = true;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.fail(`did not start within ${String(this.options.startTimeoutMs / 1000)} seconds`);
        finish(new PluginCallError(this.lastError ?? 'did not start', 'failed'));
      }, this.options.startTimeoutMs);
      const aborted = (): void => {
        this.stopping.value = true;
        this.state = 'stopped';
        this.child.kill('SIGKILL');
        finish(new PluginCallError('The plugin was stopped while it started.', 'not_running'));
      };
      this.options.signal?.addEventListener('abort', aborted, { once: true });
      this.child.on('message', (raw: unknown) => {
        // Whatever the plugin sends, the core does not go down with it.
        try {
          const message = parseFromPlugin(raw);
          if (message === undefined) {
            this.protocolError();
            finish(new PluginCallError(this.lastError ?? 'failed', 'failed'));
          } else if (message.type === 'ready' || message.type === 'failed') {
            if (this.ready || settled) {
              // Said once, at the start; said again it is not the runner talking.
              this.protocolError();
            } else if (message.type === 'ready') {
              this.modules = Object.entries(message.modules).map(([kind, methods]) => ({
                kind,
                methods,
              }));
              finish();
            } else {
              this.fail('The plugin could not load its modules.');
              finish(new PluginCallError(this.lastError ?? 'failed', 'failed'));
            }
          } else {
            this.onMessage(message);
          }
        } catch {
          this.protocolError();
          finish(new PluginCallError(this.lastError ?? 'failed', 'failed'));
        }
      });
      this.child.on('error', () => {
        if (this.state === 'running') {
          this.fail('The core could not communicate with the plugin process.');
        }
        finish(
          new PluginCallError(this.lastError ?? 'The plugin process could not start.', 'failed'),
        );
      });
      this.child.on('exit', (code, signal) => {
        this.onExit(code, signal);
        finish(new PluginCallError(this.lastError ?? 'The plugin process ended.', 'crashed'));
      });
    });
  }

  private protocolError(): void {
    if (this.state === 'running') {
      this.fail('The plugin process sent a message the core does not accept, so it was ended.');
    }
  }

  private onMessage(message: Exclude<FromPlugin, { type: 'ready' | 'failed' }>): void {
    if (message.type === 'result' || message.type === 'error') {
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) {
        return;
      }
      this.settle(message.id, waiting);
      if (message.type === 'result') {
        waiting.resolve(message.value);
      } else {
        waiting.reject(
          new PluginCallError(
            message.message.slice(0, 500),
            waiting.expired ? 'secret_expired' : 'failed',
          ),
        );
      }
    } else {
      void this.relay(message);
    }
  }

  /** A call is over: its timer stops and whatever it still had asked of the core is ended. */
  private settle(id: number, waiting: Pending): void {
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.controller.abort();
  }

  /**
   * The plugin asked the core for something. The core decides; the plugin gets an answer or an error. A request
   * belongs to a call that is under way, and there are limits on how many are answered at once and per call.
   */
  private async relay(message: CoreMessage): Promise<void> {
    const call = this.pending.get(message.call);
    if (call === undefined) {
      this.reply({
        type: 'reply',
        id: message.id,
        ok: false,
        message: 'The core answers a plugin only while a call to it is under way.',
      });
      return;
    }
    if (call.requests >= PLUGIN_LIMITS.coreRequestsPerCall) {
      this.reply({
        type: 'reply',
        id: message.id,
        ok: false,
        message: `A call may ask the core at most ${String(PLUGIN_LIMITS.coreRequestsPerCall)} times.`,
      });
      return;
    }
    call.requests += 1;
    if (this.relaying >= PLUGIN_LIMITS.concurrentCoreRequests) {
      this.reply({
        type: 'reply',
        id: message.id,
        ok: false,
        message: 'Too many requests at once.',
      });
      return;
    }
    this.relaying += 1;
    const { services } = this.options;
    const { signal } = call.controller;
    try {
      let value: unknown = null;
      if (message.op === 'fetch') {
        const { method, headers, body } = message.init ?? {};
        value = await services.fetch(
          message.url,
          {
            ...(method === undefined ? {} : { method }),
            ...(headers === undefined ? {} : { headers }),
            ...(body === undefined ? {} : { body }),
          },
          signal,
        );
      } else if (message.op === 'secret') {
        value = await services.secret(message.field);
      } else if (message.action === 'get') {
        value = await services.storage.get(message.key);
      } else if (message.action === 'set') {
        await services.storage.set(message.key, message.value);
      } else if (message.action === 'delete') {
        await services.storage.delete(message.key);
      } else {
        value = await services.storage.keys();
      }
      if (signal.aborted) {
        // The call ended meanwhile: what was asked for it is not handed over any more.
        throw new Error('The call this request belongs to is over.');
      }
      this.reply({ type: 'reply', id: message.id, ok: true, value: value as Serializable });
    } catch (error) {
      if (isExpiredRefusal(error)) {
        call.expired = true;
      }
      this.reply({
        type: 'reply',
        id: message.id,
        ok: false,
        message: (error instanceof Error ? error.message : 'The request failed.').slice(0, 300),
      });
    } finally {
      this.relaying -= 1;
    }
  }

  private reply(message: Serializable): void {
    if (this.child.connected) {
      try {
        this.child.send(message);
      } catch {
        // The channel closed between the check and the send: the process is going.
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping.value) {
      this.state = 'stopped';
    } else if (this.state === 'failed' && this.lastError !== null) {
      // The core ended it for a reason it already recorded (a call took too long, a module did not load).
    } else {
      this.state = 'failed';
      const how = signal === null ? `with code ${String(code)}` : `by ${signal}`;
      this.lastError = `The plugin process ended ${how}.`;
    }
    this.rejectAll(new PluginCallError(this.lastError ?? 'The plugin was stopped.', 'crashed'));
    this.options.onChange?.(this.snapshot());
  }

  private rejectAll(error: Error): void {
    for (const [id, waiting] of this.pending) {
      this.settle(id, waiting);
      waiting.reject(error);
    }
  }

  private fail(reason: string): void {
    this.state = 'failed';
    this.lastError = reason.slice(0, 300);
    this.child.kill('SIGKILL');
    this.options.onChange?.(this.snapshot());
  }

  /** Calls a method of the plugin. The call has a deadline: when it passes, the process is ended. */
  async call(kind: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.state !== 'running') {
      throw new PluginCallError(this.lastError ?? 'The plugin is not running.', 'not_running');
    }
    // The place is taken before anything is awaited, so that callers at the same moment cannot all pass.
    if (this.pending.size + this.admitting >= PLUGIN_LIMITS.concurrentCalls) {
      throw new PluginCallError('The plugin is busy.', 'busy');
    }
    this.admitting += 1;
    let config: ConfigValues;
    try {
      config = await this.options.services.settings();
    } catch (error) {
      this.admitting -= 1;
      throw new PluginCallError(
        error instanceof Error ? error.message : 'The plugin is not configured.',
        'not_configured',
      );
    }
    this.admitting -= 1;
    // The settings were fetched while the process could have ended.
    if (!this.running) {
      throw new PluginCallError(this.lastError ?? 'The plugin is not running.', 'not_running');
    }
    const id = this.nextId++;
    this.calls += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiting = this.pending.get(id);
        if (waiting !== undefined) {
          this.settle(id, waiting);
        }
        this.fail(`a call took longer than ${String(timeoutMs / 1000)} seconds`);
        reject(new PluginCallError(this.lastError ?? 'timed out', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        controller: new AbortController(),
        requests: 0,
        expired: false,
      });
      try {
        this.child.send({ type: 'call', id, kind, method, params: params as Serializable, config });
      } catch {
        const waiting = this.pending.get(id);
        if (waiting !== undefined) {
          this.settle(id, waiting);
        }
        reject(new PluginCallError('The plugin process is gone.', 'crashed'));
      }
    });
  }

  /** Ends the process on purpose and waits for it to be gone. */
  async stop(): Promise<void> {
    this.stopping.value = true;
    if (this.state === 'running') {
      this.state = 'stopped';
    }
    this.child.kill('SIGKILL');
    this.rejectAll(new PluginCallError('The plugin was stopped.', 'not_running'));
    await this.waitForClose();
  }

  private async waitForClose(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  get running(): boolean {
    return this.state === 'running';
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      startedAt: this.startedAt,
      calls: this.calls,
      lastError: this.lastError,
      modules: this.modules,
    };
  }
}
