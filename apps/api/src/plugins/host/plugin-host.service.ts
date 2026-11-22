import { fileURLToPath } from 'node:url';

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  PluginGatewayReply,
  PluginGatewayRequest,
  PluginSidecarFragment,
  PluginView,
} from '@swellwright/contracts';
import { type Driver, runOperation } from '@swellwright/plugin-api';

import { AuditService } from '../../audit/audit.service.js';
import { WindowLimiter } from '../../auth/rate-limit.js';
import { RateLimitedException } from '../../http.js';
import { type RequestMeta } from '../../auth/context.js';
import { type AppConfig } from '../../config.js';
import { CONFIG, PLUGIN_NETWORK } from '../../tokens.js';
import { type Actor } from '../../users/users.service.js';
import { type DiscoveredPlugin } from '../discovery.js';
import { PluginBroker, PluginBrokerError, type BrokerContext } from '../broker.js';
import { PluginsService } from '../plugins.service.js';
import { PluginRuntime } from '../runtime.js';
import {
  callSidecar,
  composeFragment,
  describeSidecar,
  SidecarError,
  sidecarToken,
  sidecarUrl,
  tokenMatches,
} from './sidecar.js';
import { NetworkRefused, PluginNetwork } from './network.js';
import { type CoreServices, PluginCallError, PluginProcess } from './process.js';

const RUNNER = fileURLToPath(new URL('./runner.js', import.meta.url));
const START_TIMEOUT_MS = 10_000;
/** A plugin that fails this many times within the window is left alone for the window. */
const FAILURES_ALLOWED = 3;
const FAILURE_WINDOW_MS = 60_000;
/** The audit chain takes at most this many notes about one plugin in a window, whatever it does. */
const NOTES_PER_WINDOW = 5;
const NOTE_WINDOW_MS = 10 * 60_000;

interface Runnable {
  readonly plugin: DiscoveredPlugin;
  readonly network: readonly string[];
  readonly secretKinds: readonly string[];
}

/**
 * Runs approved plugins, each in a process of its own under the Node permission model (ADR 0028), and is the
 * one place the core talks to them. A plugin runs only while it is enabled and its files are what was
 * approved: that is checked before every start and every call, and a plugin that is switched off is stopped
 * at once, without restarting anything else.
 */
@Injectable()
export class PluginHostService implements OnApplicationShutdown {
  private readonly logger = new Logger('PluginHost');
  private readonly processes = new Map<string, PluginProcess>();
  private readonly starting = new Map<string, Promise<PluginProcess>>();
  private readonly failures = new Map<string, number[]>();
  private readonly notes = new Map<string, number[]>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  /** Wrong tokens at the gateway, per address: it is open to the network, so it is slowed down for guessing. */
  private readonly gatewayGuesses = new WindowLimiter(20, 5 * 60_000);
  private readonly gatewayBusy = new Map<string, number>();

  constructor(
    @Inject(PluginsService) private readonly plugins: PluginsService,
    @Inject(PluginRuntime) private readonly runtime: PluginRuntime,
    @Inject(PluginBroker) private readonly broker: PluginBroker,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG)
    private readonly config: Pick<AppConfig, 'pluginLimits' | 'pluginSidecar' | 'authKey'>,
    @Inject(PLUGIN_NETWORK) private readonly gateway: PluginNetwork,
  ) {
    runtime.onStop((id) => {
      void this.stop(id);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }

  /** Whether the audit chain may take another note about this plugin now. */
  private mayNote(id: string): boolean {
    const now = Date.now();
    const recent = (this.notes.get(id) ?? []).filter((at) => now - at < NOTE_WINDOW_MS);
    if (recent.length >= NOTES_PER_WINDOW) {
      this.notes.set(id, recent);
      return false;
    }
    this.notes.set(id, [...recent, now]);
    return true;
  }

  private recordFailure(id: string): void {
    const now = Date.now();
    this.failures.set(id, [
      ...(this.failures.get(id) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS),
      now,
    ]);
  }

  private failing(id: string): boolean {
    const now = Date.now();
    return (
      (this.failures.get(id) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS).length >=
      FAILURES_ALLOWED
    );
  }

  private touch(id: string): void {
    const known = this.idle.get(id);
    if (known) {
      clearTimeout(known);
    }
    const timer = setTimeout(() => {
      void this.stop(id);
    }, this.config.pluginLimits.idleMs);
    timer.unref();
    this.idle.set(id, timer);
  }

  /** What the plugin may ask of the core: each limited to this plugin and to what was approved. */
  private servicesFor(id: string, runnable: Runnable): CoreServices {
    const context: BrokerContext = {
      id,
      schema: runnable.plugin.configSchema,
      secretKinds: runnable.secretKinds,
    };
    return {
      settings: () => this.broker.settings(context),
      fetch: async (url, init) => {
        try {
          return await this.gateway.fetch(id, runnable.network, url, init);
        } catch (error) {
          if (error instanceof NetworkRefused) {
            this.noteDenied(id, url, error.reason);
          }
          throw error;
        }
      },
      secret: (field) => this.broker.secret(context, field),
      storage: {
        get: (key) => this.broker.storageGet(id, key),
        set: (key, value) => this.broker.storageSet(id, key, value),
        delete: (key) => this.broker.storageDelete(id, key),
        keys: () => this.broker.storageKeys(id),
      },
    };
  }

  private noteDenied(id: string, url: string, reason: string): void {
    if (!this.mayNote(id)) {
      return;
    }
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = '(not a URL)';
    }
    void this.audit.note({
      action: 'plugin.network.denied',
      outcome: 'denied',
      actor: null,
      object: { type: 'plugin', id },
      details: { host: host.slice(0, 200), reason },
      meta: { ip: undefined, requestId: undefined },
    });
  }

  /** The running process of a plugin, started if there is none. A plugin with only declarative parts has none. */
  private async ensure(
    id: string,
    runnable: Runnable,
    options: { readonly ignoreFailures: boolean },
  ): Promise<PluginProcess | undefined> {
    const manifest = runnable.plugin.manifest;
    const modules = (manifest?.provides ?? []).flatMap((p) =>
      p.entry === undefined ? [] : [{ kind: p.kind, entry: p.entry.replace(/^\.\//u, '') }],
    );
    if (modules.length === 0) {
      return undefined;
    }
    const known = this.processes.get(id);
    if (known?.running === true) {
      this.touch(id);
      return known;
    }
    const pending = this.starting.get(id);
    if (pending) {
      return pending;
    }
    if (!options.ignoreFailures && this.failing(id)) {
      throw new PluginCallError(
        'The plugin keeps failing and is left alone for a minute.',
        'failed',
      );
    }
    const start = PluginProcess.start({
      pluginId: id,
      directory: runnable.plugin.directory,
      modules,
      services: this.servicesFor(id, runnable),
      runnerPath: RUNNER,
      memoryMiB: this.config.pluginLimits.memoryMiB,
      startTimeoutMs: START_TIMEOUT_MS,
      onChange: (snapshot) => {
        this.runtime.report(id, snapshot);
      },
    });
    this.starting.set(id, start);
    try {
      const started = await start;
      this.processes.set(id, started);
      this.runtime.report(id, started.snapshot());
      this.touch(id);
      return started;
    } catch (error) {
      this.recordFailure(id);
      this.runtime.report(id, {
        state: 'failed',
        startedAt: null,
        calls: 0,
        lastError: error instanceof Error ? error.message.slice(0, 300) : 'It did not start.',
        modules: [],
      });
      throw error;
    } finally {
      this.starting.delete(id);
    }
  }

  /**
   * Calls a method of an enabled plugin. The files are verified against the approval first; a call that takes
   * longer than the deadline ends the process and fails.
   */
  async call(id: string, kind: string, method: string, params: unknown): Promise<unknown> {
    const runnable = await this.plugins.runnable(id);
    if (runnable.kind !== 'ok') {
      throw new PluginCallError(
        runnable.kind === 'unknown'
          ? 'There is no such plugin.'
          : `The plugin does not run: ${runnable.why}.`,
        'not_running',
      );
    }
    if (this.isSidecar(runnable, kind)) {
      return this.callOnSidecar(id, runnable, kind, method, params);
    }
    const driver = runnable.plugin.drivers[kind];
    if (driver !== undefined) {
      return this.callDriver(id, runnable, driver, method, params);
    }
    const running = await this.ensure(id, runnable, { ignoreFailures: false });
    if (running === undefined) {
      throw new PluginCallError('The plugin has no code to run.', 'not_running');
    }
    try {
      return await running.call(kind, method, params, this.config.pluginLimits.callTimeoutMs);
    } catch (error) {
      if (
        error instanceof PluginCallError &&
        (error.reason === 'timeout' || error.reason === 'crashed')
      ) {
        this.recordFailure(id);
        if (this.mayNote(id)) {
          void this.audit.note({
            action: 'plugin.failed',
            outcome: 'failure',
            actor: null,
            object: { type: 'plugin', id },
            details: { reason: error.reason, method: method.slice(0, 64) },
            meta: { ip: undefined, requestId: undefined },
          });
        }
      }
      throw error;
    } finally {
      this.runtime.report(id, running.snapshot());
    }
  }

  /**
   * An operation of a declarative driver (ADR 0030): the core makes the requests itself, through the same services
   * and under the same approval as a plugin's code would have. The whole operation has the deadline of a call.
   */
  private async callDriver(
    id: string,
    runnable: Runnable,
    driver: Driver,
    operation: string,
    params: unknown,
  ): Promise<unknown> {
    const deadline = this.config.pluginLimits.callTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        runOperation(driver, operation, params, this.servicesFor(id, runnable)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new PluginCallError(
                `a call took longer than ${String(deadline / 1000)} seconds`,
                'timeout',
              ),
            );
          }, deadline);
        }),
      ]);
    } catch (error) {
      if (error instanceof PluginCallError) {
        throw error;
      }
      const message = (error instanceof Error ? error.message : 'The operation failed.').slice(
        0,
        300,
      );
      if (
        error instanceof PluginBrokerError &&
        message.startsWith('The plugin is not configured')
      ) {
        throw new PluginCallError(message, 'not_configured');
      }
      if (error instanceof PluginBrokerError && error.code === 'secret_expired') {
        throw new PluginCallError(message, 'secret_expired');
      }
      throw new PluginCallError(message, error instanceof NetworkRefused ? 'refused' : 'failed');
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  // ----------------------------------------------------------------- sidecars (ADR 0031)

  private isSidecar(runnable: Runnable, kind: string): boolean {
    return (
      runnable.plugin.manifest?.provides.some((p) => p.kind === kind && p.sidecar === true) === true
    );
  }

  private sidecarOf(runnable: Runnable): { base: string; token: string } | undefined {
    const { manifest, digest } = runnable.plugin;
    if (manifest?.sidecar === undefined || digest === undefined) {
      return undefined;
    }
    return {
      base: sidecarUrl(this.config.pluginSidecar.urlTemplate, manifest.id, manifest.sidecar.port),
      token: sidecarToken(this.config.authKey, manifest.id, digest),
    };
  }

  /** A check of a plugin that has a sidecar: ask it what it offers. A container that is not up is an answer. */
  private async describeOwnSidecar(runnable: Runnable): Promise<{
    state: 'running' | 'stopped';
    startedAt: Date | null;
    modules: { kind: string; methods: string[] }[];
  }> {
    const target = this.sidecarOf(runnable);
    if (target === undefined) {
      return { state: 'stopped', startedAt: null, modules: [] };
    }
    try {
      const described = await describeSidecar(target.base, target.token, 5000);
      return {
        state: 'running',
        startedAt: new Date(),
        modules: described.modules.map((m) => ({ kind: m.kind, methods: [...m.methods].sort() })),
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'The sidecar did not answer.', {
        cause: error,
      });
    }
  }

  private async callOnSidecar(
    id: string,
    runnable: Runnable,
    kind: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const target = this.sidecarOf(runnable);
    if (target === undefined) {
      throw new PluginCallError('The plugin has no sidecar.', 'not_running');
    }
    if (this.failing(id)) {
      throw new PluginCallError(
        'The sidecar keeps failing and is left alone for a minute.',
        'failed',
      );
    }
    let config: Record<string, string | number | boolean | null>;
    try {
      config = await this.broker.settings({
        id,
        schema: runnable.plugin.configSchema,
        secretKinds: runnable.secretKinds,
      });
    } catch (error) {
      throw new PluginCallError(
        error instanceof Error ? error.message : 'The plugin is not configured.',
        'not_configured',
      );
    }
    try {
      const answer = await callSidecar(
        target.base,
        target.token,
        { kind, method, params, config },
        this.config.pluginLimits.callTimeoutMs,
      );
      if (!answer.ok) {
        throw new PluginCallError(answer.message, 'failed');
      }
      return answer.value;
    } catch (error) {
      if (error instanceof PluginCallError) {
        throw error;
      }
      if (error instanceof SidecarError) {
        this.recordFailure(id);
        this.runtime.report(id, {
          state: 'failed',
          startedAt: null,
          calls: 0,
          lastError: error.message,
          modules: [],
        });
        throw new PluginCallError(
          error.message,
          error.reason === 'timeout' ? 'timeout' : 'crashed',
        );
      }
      throw error;
    }
  }

  /**
   * The compose fragment that runs a plugin's container. It holds the token of the plugin as it is now, so it is
   * recorded when it is handed out; the core starts nothing.
   */
  async fragment(actor: Actor, id: string, meta: RequestMeta): Promise<PluginSidecarFragment> {
    const plugin = await this.plugins.find(id);
    const sidecar = plugin?.manifest?.sidecar;
    if (plugin?.manifest === undefined || sidecar === undefined) {
      throw new NotFoundException('This plugin has no sidecar.');
    }
    if (plugin.state !== 'available' || plugin.digest === undefined) {
      throw new ConflictException(
        `This plugin cannot be run: ${plugin.problems[0] ?? 'it is not usable'}.`,
      );
    }
    const compose = composeFragment({
      id,
      version: plugin.manifest.version,
      digest: plugin.digest,
      sidecar,
      token: sidecarToken(this.config.authKey, id, plugin.digest),
      coreUrl: this.config.pluginSidecar.coreUrl,
      network: this.config.pluginSidecar.network,
      coreService: this.config.pluginSidecar.coreService,
    });
    await this.audit.record({
      action: 'plugin.sidecar.exported',
      outcome: 'success',
      actor,
      object: { type: 'plugin', id },
      details: { service: `plugin-${id}`, digest: plugin.digest },
      meta,
    });
    return { service: `plugin-${id}`, compose, coreUrl: this.config.pluginSidecar.coreUrl };
  }

  /**
   * What a sidecar asks of the core, over HTTP. It is open to the network, so it proves nothing by being asked:
   * the token must be the one of this plugin as it was approved, the plugin enabled, its files unchanged. Anything
   * else is a 401 that says nothing about why. What it may do is what a plugin process may: the approved hosts,
   * the secret bound to a setting, its own storage.
   */
  async sidecarGateway(
    id: string,
    authorization: string | undefined,
    request: PluginGatewayRequest,
    address: string | undefined,
  ): Promise<PluginGatewayReply> {
    const from = address ?? 'unknown';
    if (this.gatewayGuesses.blocked(from)) {
      throw new RateLimitedException(
        300,
        'Too many wrong tokens from this address. Try again later.',
      );
    }
    const runnable = await this.plugins.runnable(id);
    const target = runnable.kind === 'ok' ? this.sidecarOf(runnable) : undefined;
    if (
      runnable.kind !== 'ok' ||
      target === undefined ||
      !tokenMatches(target.token, authorization)
    ) {
      this.gatewayGuesses.hit(from);
      if (this.mayNote(`gateway:${from}`)) {
        void this.audit.note({
          action: 'plugin.gateway.denied',
          outcome: 'denied',
          actor: null,
          object: { type: 'plugin', id: id.slice(0, 48) },
          details: { ip: from.slice(0, 64) },
          meta: { ip: address, requestId: undefined },
        });
      }
      throw new UnauthorizedException();
    }
    const active = this.gatewayBusy.get(id) ?? 0;
    if (active >= 8) {
      return { ok: false, message: 'Too many requests at once.' };
    }
    this.gatewayBusy.set(id, active + 1);
    try {
      const services = this.servicesFor(id, runnable);
      let value: unknown = null;
      if (request.op === 'fetch') {
        const { method, headers, body } = request.init ?? {};
        value = await services.fetch(request.url, {
          ...(method === undefined ? {} : { method }),
          ...(headers === undefined ? {} : { headers }),
          ...(body === undefined ? {} : { body }),
        });
      } else if (request.op === 'secret') {
        value = await services.secret(request.field);
      } else if (request.action === 'get') {
        value = await services.storage.get(request.key);
      } else if (request.action === 'set') {
        await services.storage.set(request.key, request.value);
      } else if (request.action === 'delete') {
        await services.storage.delete(request.key);
      } else {
        value = await services.storage.keys();
      }
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        message: (error instanceof Error ? error.message : 'The request failed.').slice(0, 300),
      };
    } finally {
      this.gatewayBusy.set(id, (this.gatewayBusy.get(id) ?? 1) - 1);
    }
  }

  /** What the drivers of a plugin offer, in the shape the runtime shows for a module. */
  private driverModules(runnable: Runnable): { kind: string; methods: string[] }[] {
    return Object.entries(runnable.plugin.drivers).map(([kind, driver]) => ({
      kind,
      methods: Object.keys(driver.operations).sort(),
    }));
  }

  /** Loads the plugin in its restricted process and records the result; the answer is the plugin as it is then. */
  async check(actor: Actor, id: string, meta: RequestMeta): Promise<PluginView> {
    const runnable = await this.plugins.runnable(id);
    if (runnable.kind === 'unknown') {
      throw new NotFoundException('There is no such plugin.');
    }
    if (runnable.kind === 'not_enabled') {
      throw new ConflictException(`Enable the plugin before checking it: ${runnable.why}.`);
    }
    let outcome: 'success' | 'failure' = 'success';
    let details: Record<string, string | number>;
    try {
      const running = await this.ensure(id, runnable, { ignoreFailures: true });
      const own = running?.snapshot();
      const sidecar = await this.describeOwnSidecar(runnable);
      const modules = [
        ...(own?.modules ?? []),
        ...this.driverModules(runnable),
        ...sidecar.modules,
      ];
      // A plugin that is only data has no process, but what it offers is shown all the same.
      this.runtime.report(id, {
        state: own?.state ?? sidecar.state,
        startedAt: own?.startedAt ?? sidecar.startedAt,
        calls: own?.calls ?? 0,
        lastError: own?.lastError ?? null,
        modules,
      });
      details = {
        modules: modules.length,
        methods: modules.reduce((sum, m) => sum + m.methods.length, 0),
      };
    } catch (error) {
      outcome = 'failure';
      details = {
        reason: (error instanceof Error ? error.message : 'The plugin did not load.').slice(0, 200),
      };
      // What the page shows must be what was found now, not what the last good check said.
      this.runtime.report(id, {
        state: 'failed',
        startedAt: null,
        calls: 0,
        lastError: String(details['reason']),
        modules: [],
      });
      this.logger.warn(`check of ${id} failed: ${String(details['reason'])}`);
    }
    await this.audit.record({
      action: 'plugin.checked',
      outcome,
      actor,
      object: { type: 'plugin', id },
      details,
      meta,
    });
    return this.plugins.viewById(id);
  }

  /** Ends the plugin's process, if it has one. Called when a plugin is switched off or changes. */
  async stop(id: string): Promise<void> {
    const timer = this.idle.get(id);
    if (timer) {
      clearTimeout(timer);
      this.idle.delete(id);
    }
    const running = this.processes.get(id);
    this.processes.delete(id);
    if (running) {
      await running.stop();
    }
    this.runtime.forget(id);
  }

  /** The process id of a plugin, for the tests that check a stopped plugin is really gone. */
  pidOf(id: string): number | undefined {
    return this.processes.get(id)?.pid;
  }
}
