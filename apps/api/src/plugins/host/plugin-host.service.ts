import { fileURLToPath } from 'node:url';

import {
  ConflictException,
  ForbiddenException,
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
import { auditAddressPrefix } from '../../auth/cidr.js';
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
  hasSidecarToken,
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

/** Keep part of the approval-check budget inaccessible to unmatched tokens. */
const GATEWAY_INITIAL_CHECKS = 12;
const GATEWAY_MATCHED_CHECKS = 4;
const GATEWAY_INITIAL_WAITERS = 128;
/** Requests of one sidecar answered at once. */
const GATEWAY_BUSY_PER_PLUGIN = 8;
const GATEWAY_CACHE_MS = 1000;
const GATEWAY_CACHE_SIZE = 128;
const GATEWAY_AUDIT_CAP = 128;

interface Runnable {
  readonly plugin: DiscoveredPlugin;
  readonly network: readonly string[];
  readonly secretKinds: readonly string[];
  readonly revision: string;
  readonly approvedAt: Date;
}

/** A process that is starting: what it is started for, and how to end the start. */
interface Starting {
  readonly promise: Promise<PluginProcess>;
  readonly revision: string;
  readonly controller: AbortController;
}

/** A call to a sidecar under way: the gateway marks it when the vault refuses the sidecar an expired secret. */
interface SidecarCall {
  expired: boolean;
}

type GatewayApproval = Awaited<ReturnType<PluginsService['enabledApproval']>>;

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
  /** The approval each running process was started under. */
  private readonly revisions = new Map<string, string>();
  private readonly starting = new Map<string, Starting>();
  /** Changes every time a plugin is stopped: a start that began before is not kept. */
  private readonly generations = new Map<string, number>();
  private readonly sidecarCalls = new Map<string, Set<SidecarCall>>();
  private gatewayInitialChecking = 0;
  private gatewayInitialWaiting = 0;
  private gatewayMatchedChecking = 0;
  private readonly gatewayInitial = new Map<string, Promise<GatewayApproval>>();
  private readonly failures = new Map<string, number[]>();
  private readonly notes = new Map<string, number[]>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  /** Wrong tokens at the gateway, per address: it is open to the network, so it is slowed down for guessing. */
  private readonly gatewayGuesses = new WindowLimiter(20, 5 * 60_000, Date.now, 1024);
  private readonly gatewayRate = new WindowLimiter(120, 60_000);
  private readonly gatewayBusy = new Map<string, number>();
  private readonly gatewayCache = new Map<
    string,
    { epoch: number; expires: number; runnable: Runnable }
  >();
  private gatewayDenials = 0;
  private gatewayUntracked = 0;
  private readonly gatewayPrefixes = new Map<string, number>();
  private readonly gatewayPairs = new Set<string>();
  private gatewayAuditTimer: NodeJS.Timeout | undefined;

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
    await this.flushGatewayDenials();
    const ids = new Set([...this.processes.keys(), ...this.starting.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  /** Whether the audit chain may take another note about this plugin now. */
  private mayNote(id: string): boolean {
    const now = Date.now();
    if (this.notes.size > 1000) {
      // Keys whose window is over are dropped, so the map does not grow with every plugin that ever failed.
      for (const [key, times] of this.notes) {
        if (times.every((at) => now - at >= NOTE_WINDOW_MS)) {
          this.notes.delete(key);
        }
      }
    }
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
  private servicesFor(id: string, runnable: Runnable, auditSecretDelivery = false): CoreServices {
    const context: BrokerContext = {
      id,
      schema: runnable.plugin.configSchema,
      secretKinds: runnable.secretKinds,
    };
    return {
      settings: () => this.broker.settings(context),
      fetch: async (url, init, signal) => {
        try {
          return await this.gateway.fetch(id, runnable.network, url, init, signal);
        } catch (error) {
          if (error instanceof NetworkRefused) {
            this.noteDenied(id, url, error.reason);
          }
          throw error;
        }
      },
      secret: (field) => this.broker.secret(context, field, auditSecretDelivery),
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

  /** How many times the plugin was stopped on this instance: what a start checks it was not stopped meanwhile. */
  private generationOf(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  /**
   * The running process of a plugin, started if there is none. A plugin with only declarative parts has none.
   * `observed` is the generation of the plugin taken before its approval was read: if it was stopped since, that
   * reading is out of date and nothing starts.
   */
  private async ensure(
    id: string,
    approved: Runnable,
    options: { readonly ignoreFailures: boolean },
    observed: number,
  ): Promise<PluginProcess | undefined> {
    const modulesOf = (r: Runnable) =>
      (r.plugin.manifest?.provides ?? []).flatMap((p) =>
        p.entry === undefined ? [] : [{ kind: p.kind, entry: p.entry.replace(/^\.\//u, '') }],
      );
    if (modulesOf(approved).length === 0) {
      return undefined;
    }
    let runnable = approved;
    let generation = observed;
    for (let replaced = 0; ; replaced++) {
      // Stopped since the approval was read (disabled, approved again, changed): that reading is out of date.
      if (this.generationOf(id) !== generation) {
        throw new PluginCallError('The plugin was stopped meanwhile. Try again.', 'not_running');
      }
      const known = this.processes.get(id);
      const pending = this.starting.get(id);
      const outdated =
        (known?.running === true && this.revisions.get(id) !== runnable.revision) ||
        (pending !== undefined && pending.revision !== runnable.revision);
      if (!outdated) {
        break;
      }
      if (replaced > 0) {
        throw new PluginCallError('The plugin changed meanwhile. Try again.', 'not_running');
      }
      // Started under another approval (the plugin was approved again meanwhile, here or on another instance): it
      // holds the permissions of that one, so it ends, and the approval is read again before anything starts.
      await this.stop(id);
      generation = this.generationOf(id);
      const fresh = await this.plugins.runnable(id);
      if (fresh.kind !== 'ok') {
        throw new PluginCallError(
          fresh.kind === 'unknown'
            ? 'There is no such plugin.'
            : `The plugin does not run: ${fresh.why}.`,
          'not_running',
        );
      }
      runnable = fresh;
    }
    // From here to the registration of the start nothing is awaited, so two callers cannot both start one.
    const known = this.processes.get(id);
    if (known?.running === true) {
      this.touch(id);
      return known;
    }
    const pending = this.starting.get(id);
    if (pending) {
      return pending.promise;
    }
    if (!options.ignoreFailures && this.failing(id)) {
      throw new PluginCallError(
        'The plugin keeps failing and is left alone for a minute.',
        'failed',
      );
    }
    const modules = modulesOf(runnable);
    if (modules.length === 0) {
      return undefined;
    }
    const controller = new AbortController();
    const spawned = PluginProcess.start({
      pluginId: id,
      directory: runnable.plugin.directory,
      modules,
      services: this.servicesFor(id, runnable),
      runnerPath: RUNNER,
      memoryMiB: this.config.pluginLimits.memoryMiB,
      startTimeoutMs: START_TIMEOUT_MS,
      signal: controller.signal,
      onChange: (snapshot) => {
        // A process that was replaced or stopped does not speak for the plugin any more.
        if (this.generationOf(id) === generation) {
          this.runtime.report(id, snapshot);
        }
      },
    });
    const start = async (): Promise<PluginProcess> => {
      try {
        const started = await spawned;
        if (this.generationOf(id) !== generation) {
          // The plugin was stopped (switched off, approved again) while this process started: it is not kept.
          await started.stop();
          throw new PluginCallError('The plugin was stopped while it started.', 'not_running');
        }
        this.processes.set(id, started);
        this.revisions.set(id, runnable.revision);
        this.runtime.report(id, started.snapshot());
        this.touch(id);
        return started;
      } catch (error) {
        if (this.generationOf(id) === generation) {
          this.recordFailure(id);
          this.runtime.report(id, {
            state: 'failed',
            startedAt: null,
            calls: 0,
            lastError: error instanceof Error ? error.message.slice(0, 300) : 'It did not start.',
            modules: [],
          });
        }
        throw error;
      } finally {
        if (this.starting.get(id)?.controller === controller) {
          this.starting.delete(id);
        }
      }
    };
    const promise = start();
    this.starting.set(id, { promise, revision: runnable.revision, controller });
    return promise;
  }

  /**
   * Calls a method of an enabled plugin. The files are verified against the approval first; a call that takes
   * longer than the deadline ends the process and fails.
   */
  async call(id: string, kind: string, method: string, params: unknown): Promise<unknown> {
    // Taken before the approval is read, so that a stop that comes after the reading is seen.
    const observed = this.generationOf(id);
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
    const running = await this.ensure(id, runnable, { ignoreFailures: false }, observed);
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
      if (this.processes.get(id) === running) {
        this.runtime.report(id, running.snapshot());
      }
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
    // When the deadline passes the operation is ended, not only no longer waited for: no further step is sent, a
    // request under way is closed, no secret is read for it any more.
    const controller = new AbortController();
    const { signal } = controller;
    const services = this.servicesFor(id, runnable);
    const bounded = {
      settings: () => services.settings(),
      fetch: (
        url: string,
        init: { method: string; headers: Record<string, string>; body?: string },
      ) => services.fetch(url, init, signal),
      secret: (field: string) => {
        signal.throwIfAborted();
        return services.secret(field);
      },
    };
    try {
      return await Promise.race([
        runOperation(driver, operation, params, bounded, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
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
      controller.abort();
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
      token: sidecarToken(this.config.authKey, manifest.id, digest, runnable.approvedAt),
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
    const mark: SidecarCall = { expired: false };
    const marks = this.sidecarCalls.get(id) ?? new Set<SidecarCall>();
    marks.add(mark);
    this.sidecarCalls.set(id, marks);
    try {
      const answer = await callSidecar(
        target.base,
        target.token,
        { kind, method, params, config },
        this.config.pluginLimits.callTimeoutMs,
      );
      if (!answer.ok) {
        // The core's own record says whether the vault refused the sidecar an expired secret during the call; what
        // the sidecar says is not taken for it.
        throw new PluginCallError(answer.message, mark.expired ? 'secret_expired' : 'failed');
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
    } finally {
      marks.delete(mark);
      if (marks.size === 0) {
        this.sidecarCalls.delete(id);
      }
    }
  }

  /**
   * The compose fragment that runs a plugin's container. It holds the token of the plugin as it is now, so it is
   * recorded when it is handed out; the core starts nothing.
   */
  async fragment(
    actor: Actor,
    id: string,
    meta: RequestMeta,
    canReveal: boolean,
  ): Promise<PluginSidecarFragment> {
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
    const approved = await this.plugins.runnable(id);
    if (approved.kind !== 'ok' || approved.plugin.digest !== plugin.digest) {
      throw new ConflictException('Enable the sidecar before exporting its fragment.');
    }
    if (approved.secretKinds.length > 0 && !canReveal) {
      throw new ForbiddenException('Exporting this sidecar token requires vault:reveal.');
    }
    const compose = composeFragment({
      id,
      version: plugin.manifest.version,
      digest: plugin.digest,
      sidecar,
      token: sidecarToken(this.config.authKey, id, plugin.digest, approved.approvedAt),
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

  private noteGatewayDenial(prefix: string, id: string): void {
    this.gatewayDenials += 1;
    const count = this.gatewayPrefixes.get(prefix) ?? 0;
    if (count === 0 && this.gatewayPrefixes.size >= GATEWAY_AUDIT_CAP) {
      // Age all candidates on an overflow miss. A scan is charged to earlier increments,
      // so unrelated prefixes cannot permanently hide a later, frequently seen source.
      this.gatewayUntracked += 1;
      for (const [key, occurrences] of this.gatewayPrefixes) {
        if (occurrences === 1) {
          this.gatewayPrefixes.delete(key);
        } else {
          this.gatewayPrefixes.set(key, occurrences - 1);
        }
      }
    }
    if (count > 0 || this.gatewayPrefixes.size < GATEWAY_AUDIT_CAP) {
      this.gatewayPrefixes.delete(prefix);
      this.gatewayPrefixes.set(prefix, count + 1);
    }
    const pair = `${prefix}\0${id}`;
    if (!this.gatewayPairs.has(pair) && this.gatewayPairs.size < GATEWAY_AUDIT_CAP) {
      this.gatewayPairs.add(pair);
      void this.audit.note({
        action: 'plugin.gateway.denied',
        outcome: 'denied',
        actor: null,
        object: { type: 'plugin', id },
        details: { prefix },
        meta: { ip: undefined, requestId: undefined },
      });
    }
    if (this.gatewayAuditTimer === undefined) {
      this.gatewayAuditTimer = setTimeout(() => {
        void this.flushGatewayDenials();
      }, NOTE_WINDOW_MS);
      this.gatewayAuditTimer.unref();
    }
  }

  private async flushGatewayDenials(): Promise<void> {
    clearTimeout(this.gatewayAuditTimer);
    this.gatewayAuditTimer = undefined;
    if (this.gatewayDenials === 0) {
      return;
    }
    const top = [...this.gatewayPrefixes]
      .reverse()
      .sort(([, x], [, y]) => y - x)
      .slice(0, 5)
      .map(([prefix, count]) => `${prefix}=${String(count)}`)
      .join(',');
    const details = {
      count: this.gatewayDenials,
      top: top.slice(0, 200),
      untracked: this.gatewayUntracked,
    };
    this.gatewayDenials = 0;
    this.gatewayUntracked = 0;
    this.gatewayPrefixes.clear();
    this.gatewayPairs.clear();
    await this.audit.note({
      action: 'plugin.gateway.denials',
      outcome: 'denied',
      actor: null,
      details,
      meta: { ip: undefined, requestId: undefined },
    });
  }

  private async initialGatewayApproval(id: string, busy: () => never): Promise<GatewayApproval> {
    const pending = this.gatewayInitial.get(id);
    if (pending !== undefined) {
      // A joined request still retains its body; bound the process-wide backlog.
      if (this.gatewayInitialWaiting >= GATEWAY_INITIAL_WAITERS) {
        return busy();
      }
      this.gatewayInitialWaiting += 1;
      try {
        return await pending;
      } finally {
        this.gatewayInitialWaiting -= 1;
      }
    }
    if (this.gatewayInitialChecking >= GATEWAY_INITIAL_CHECKS) {
      return busy();
    }
    this.gatewayInitialChecking += 1;
    try {
      const check = this.plugins.enabledApproval(id);
      this.gatewayInitial.set(id, check);
      try {
        return await check;
      } finally {
        if (this.gatewayInitial.get(id) === check) {
          this.gatewayInitial.delete(id);
        }
      }
    } finally {
      this.gatewayInitialChecking -= 1;
    }
  }

  private async matchedGatewayApproval(id: string, busy: () => never): Promise<GatewayApproval> {
    if (this.gatewayMatchedChecking >= GATEWAY_MATCHED_CHECKS) {
      return busy();
    }
    this.gatewayMatchedChecking += 1;
    try {
      return await this.plugins.enabledApproval(id);
    } finally {
      this.gatewayMatchedChecking -= 1;
    }
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
    const from = auditAddressPrefix(address);
    const refuse = (badToken: boolean): never => {
      this.noteGatewayDenial(from, id);
      if (badToken && !this.gatewayGuesses.hit(from)) {
        throw new RateLimitedException(
          300,
          'Too many wrong tokens from this address. Try again later.',
        );
      }
      throw new UnauthorizedException();
    };
    if (!hasSidecarToken(authorization)) {
      return refuse(true);
    }
    const busy = (): never => {
      this.noteGatewayDenial(from, id);
      throw new RateLimitedException(5, 'The gateway is busy. Try again shortly.');
    };
    const matches = (digest: string | undefined, approvedAt: Date): boolean =>
      digest !== undefined &&
      tokenMatches(sidecarToken(this.config.authKey, id, digest, approvedAt), authorization);
    const started = this.generationOf(id);
    const hint = this.gatewayCache.get(id);
    // Even an expired file-cache entry can identify a previously matched token for admission.
    // It never authorizes a request: every match is rechecked against the current approval.
    const previouslyMatched =
      hint !== undefined && matches(hint.runnable.plugin.digest, hint.runnable.approvedAt);
    if (!previouslyMatched) {
      const initial = await this.initialGatewayApproval(id, busy);
      if (this.generationOf(id) !== started) {
        return refuse(false);
      }
      if (initial === undefined || !matches(initial.digest, initial.approvedAt)) {
        return refuse(true);
      }
    }
    const approved = await this.matchedGatewayApproval(id, busy);
    if (this.generationOf(id) !== started) {
      return refuse(false);
    }
    if (approved === undefined || !matches(approved.digest, approved.approvedAt)) {
      if (previouslyMatched && this.gatewayCache.get(id) === hint) {
        this.gatewayCache.delete(id);
      }
      return refuse(true);
    }
    if (!this.gatewayRate.hit(id)) {
      throw new RateLimitedException(60, 'Too many requests from this sidecar.');
    }
    const active = this.gatewayBusy.get(id) ?? 0;
    if (active >= GATEWAY_BUSY_PER_PLUGIN) {
      return { ok: false, message: 'Too many requests at once.' };
    }
    this.gatewayBusy.set(id, active + 1);
    try {
      // Then the plugin as it is now: enabled, its files what was approved, and a sidecar.
      const epoch = approved.approvedAt.getTime();
      const cached = this.gatewayCache.get(id);
      let runnable: Runnable;
      if (
        cached?.epoch === epoch &&
        cached.expires > Date.now() &&
        cached.runnable.plugin.digest === approved.digest
      ) {
        runnable = cached.runnable;
      } else {
        const fresh = await this.plugins.runnable(id);
        if (
          fresh.kind !== 'ok' ||
          fresh.approvedAt.getTime() !== epoch ||
          fresh.plugin.digest !== approved.digest ||
          this.generationOf(id) !== started
        ) {
          return refuse(false);
        }
        runnable = fresh;
        this.gatewayCache.delete(id);
        if (this.gatewayCache.size >= GATEWAY_CACHE_SIZE) {
          const oldest = this.gatewayCache.keys().next().value;
          if (oldest !== undefined) {
            this.gatewayCache.delete(oldest);
          }
        }
        this.gatewayCache.set(id, { epoch, expires: Date.now() + GATEWAY_CACHE_MS, runnable });
      }
      if (this.sidecarOf(runnable) === undefined) {
        return refuse(false);
      }
      const services = this.servicesFor(id, runnable, true);
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
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (error instanceof PluginBrokerError && error.code === 'secret_expired') {
        // The call to this sidecar that is under way fails as what it is (ADR 0042), whatever the sidecar answers.
        // A request at the gateway does not say which call it serves, so this is decided only when there is one
        // call under way; with several, none is marked rather than the wrong one.
        const marks = this.sidecarCalls.get(id);
        if (marks?.size === 1) {
          for (const mark of marks) {
            mark.expired = true;
          }
        }
      }
      return {
        ok: false,
        message:
          error instanceof PluginBrokerError || error instanceof NetworkRefused
            ? error.message.slice(0, 300)
            : 'The request failed.',
      };
    } finally {
      const left = (this.gatewayBusy.get(id) ?? 1) - 1;
      if (left <= 0) {
        this.gatewayBusy.delete(id);
      } else {
        this.gatewayBusy.set(id, left);
      }
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
    const observed = this.generationOf(id);
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
      const running = await this.ensure(id, runnable, { ignoreFailures: true }, observed);
      const sidecar = await this.describeOwnSidecar(runnable);
      const own = running?.snapshot();
      const modules = [
        ...(own?.modules ?? []),
        ...this.driverModules(runnable),
        ...sidecar.modules,
      ];
      // A plugin that is only data has no process, but what it offers is shown all the same.
      if (this.generationOf(id) === observed) {
        this.runtime.report(id, {
          state: own?.state ?? sidecar.state,
          startedAt: own?.startedAt ?? sidecar.startedAt,
          calls: own?.calls ?? 0,
          lastError: own?.lastError ?? null,
          modules,
        });
      }
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
      if (this.generationOf(id) === observed) {
        this.runtime.report(id, {
          state: 'failed',
          startedAt: null,
          calls: 0,
          lastError: String(details['reason']),
          modules: [],
        });
        this.logger.warn(`check of ${id} failed: ${String(details['reason'])}`);
      }
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
    // Whatever is starting for the plugin now is ended too, and not kept if it gets as far as being ready.
    this.generations.set(id, this.generationOf(id) + 1);
    this.gatewayCache.delete(id);
    this.gatewayInitial.delete(id);
    const starting = this.starting.get(id);
    if (starting) {
      this.starting.delete(id);
      starting.controller.abort();
    }
    const timer = this.idle.get(id);
    if (timer) {
      clearTimeout(timer);
      this.idle.delete(id);
    }
    const running = this.processes.get(id);
    this.processes.delete(id);
    this.revisions.delete(id);
    this.runtime.forget(id);
    if (running) {
      await running.stop();
    }
  }

  /** The process id of a plugin, for the tests that check a stopped plugin is really gone. */
  pidOf(id: string): number | undefined {
    return this.processes.get(id)?.pid;
  }
}
