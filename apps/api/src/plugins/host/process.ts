import { type ChildProcess, fork, type Serializable } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  fetch(url: string, init: PluginFetchInit): Promise<NetworkResponse>;
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

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

type FromPlugin =
  | { type: 'ready'; modules: Record<string, string[]> }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
  | { type: 'core'; id: number; op: 'fetch'; url: string; init: PluginFetchInit }
  | { type: 'core'; id: number; op: 'secret'; field: string }
  | {
      type: 'core';
      id: number;
      op: 'storage';
      action: 'get' | 'set' | 'delete' | 'keys';
      key?: unknown;
      value?: unknown;
    };

const TAIL_BYTES = 2048;

/**
 * One plugin's process (ADR 0028). It is started with the Node permission model on: it may read its own
 * directory and the runner and nothing else; there is no network, no child process, no worker, no native
 * addon, no code generation from strings, and its environment holds nothing of the core's. It has a heap
 * limit, and a call that takes too long ends the process. Its only way out is the core's `fetch`.
 */
export class PluginProcess {
  private state: ProcessState = 'running';
  private lastError: string | null = null;
  private calls = 0;
  private modules: RuntimeSnapshot['modules'] = [];
  private startedAt = new Date();
  private nextId = 1;
  private tail = '';
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private readonly stopping = { value: false };

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: StartOptions,
  ) {
    this.exited = new Promise((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
    const keep = (chunk: Buffer): void => {
      this.tail = (this.tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
  }

  /**
   * Starts the process and waits until every module is loaded. A module that cannot be loaded (it does not
   * exist, it throws, it tries something the restrictions forbid) fails the start with the reason.
   */
  static async start(options: StartOptions): Promise<PluginProcess> {
    const directory = await realpath(options.directory);
    const runner = await realpath(options.runnerPath);
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
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    const instance = new PluginProcess(child, { ...options, directory });
    await instance.handshake();
    return instance;
  }

  private handshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(`did not start within ${String(this.options.startTimeoutMs / 1000)} seconds`);
        reject(new PluginCallError(this.lastError ?? 'did not start', 'failed'));
      }, this.options.startTimeoutMs);
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      this.child.on('message', (message: FromPlugin) => {
        if (message.type === 'ready') {
          this.modules = Object.entries(message.modules).map(([kind, methods]) => ({
            kind,
            methods,
          }));
          finish();
        } else if (message.type === 'failed') {
          this.fail(message.message);
          finish(new PluginCallError(message.message, 'failed'));
        } else {
          this.onMessage(message);
        }
      });
      this.child.on('error', (error) => {
        this.fail(error.message);
        finish(new PluginCallError(error.message, 'failed'));
      });
      this.child.on('exit', (code, signal) => {
        this.onExit(code, signal);
        finish(new PluginCallError(this.lastError ?? 'The plugin process ended.', 'crashed'));
      });
    });
  }

  private onMessage(message: FromPlugin): void {
    if (message.type === 'result' || message.type === 'error') {
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.type === 'result') {
        waiting.resolve(message.value);
      } else {
        waiting.reject(new PluginCallError(message.message, 'failed'));
      }
    } else if (message.type === 'core') {
      void this.relay(message);
    }
  }

  /** The plugin asked the core for something. The core decides; the plugin gets an answer or an error. */
  private async relay(message: Extract<FromPlugin, { type: 'core' }>): Promise<void> {
    const { services } = this.options;
    try {
      let value: unknown = null;
      if (message.op === 'fetch') {
        value = await services.fetch(message.url, message.init);
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
      this.reply({ type: 'reply', id: message.id, ok: true, value: value as Serializable });
    } catch (error) {
      this.reply({
        type: 'reply',
        id: message.id,
        ok: false,
        message: (error instanceof Error ? error.message : 'The request failed.').slice(0, 300),
      });
    }
  }

  private reply(message: Serializable): void {
    if (this.child.connected) {
      this.child.send(message);
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
      const detail = this.tail.trim().split('\n').at(-1)?.slice(0, 160);
      this.lastError = `The plugin process ended ${how}${detail ? `: ${detail}` : ''}`;
    }
    this.rejectAll(new PluginCallError(this.lastError ?? 'The plugin was stopped.', 'crashed'));
    this.options.onChange?.(this.snapshot());
  }

  private rejectAll(error: Error): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
      this.pending.delete(id);
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
    if (this.pending.size >= PLUGIN_LIMITS.concurrentCalls) {
      throw new PluginCallError('The plugin is busy.', 'busy');
    }
    let config: ConfigValues;
    try {
      config = await this.options.services.settings();
    } catch (error) {
      throw new PluginCallError(
        error instanceof Error ? error.message : 'The plugin is not configured.',
        'not_configured',
      );
    }
    // The settings were fetched while the process could have ended.
    if (!this.running) {
      throw new PluginCallError(this.lastError ?? 'The plugin is not running.', 'not_running');
    }
    const id = this.nextId++;
    this.calls += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail(`a call took longer than ${String(timeoutMs / 1000)} seconds`);
        reject(new PluginCallError(this.lastError ?? 'timed out', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.send({ type: 'call', id, kind, method, params: params as Serializable, config });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
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
    await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
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
