import { randomUUID } from 'node:crypto';

import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type EnginePorts,
  type RunOutcome,
  type RunStore,
  type StepRegistry,
  Worker,
  type WorkflowRegistry,
} from '@swellwright/engine';

import type { AppConfig } from '../config.js';
import { VAULT_SEALED } from './engine-ports.js';
import {
  CLOCK,
  CONFIG,
  ENGINE_CATALOGUE,
  ENGINE_PORTS,
  ENGINE_TUNING,
  RUN_STORE,
} from '../tokens.js';

/** The steps and the workflows this build knows (`ENGINE_CATALOGUE`). */
export interface EngineCatalogue {
  readonly steps: StepRegistry<EnginePorts>;
  readonly workflows: WorkflowRegistry<EnginePorts>;
}

/** What a test may change about the loop; the production values come from the configuration. */
export interface EngineTuning {
  /** Start the loop when the application starts. Default `true`; a test that drives the worker by hand turns it off. */
  readonly autostart?: boolean;
  /** Renew the lease on a timer while a step runs. Default `true`. */
  readonly heartbeat?: boolean;
  /** Replaces the random part of the worker ids, so a test can tell its workers apart. */
  readonly incarnation?: string;
}

/** The longest a message of the loop's error goes to the log, and how often the same trouble is repeated there. */
const LOG_MESSAGE_CHARS = 300;
const LOG_REPEAT_MS = 60_000;

/**
 * The loop of the run engine inside the process of the API (ADR 0048, "Where the code lives"): the key of the vault lives
 * here and nowhere else, so the code that opens a secret for a step runs here. It starts with the application and, when
 * the application closes, stops before the database, the vault and the SSH connections are torn down (Nest calls
 * `beforeApplicationShutdown` of every provider before any `onApplicationShutdown`).
 *
 * One worker per slot, each a loop of its own that does one run at a time. Two processes on one database work too: the
 * store hands a run to one of them (ADR 0048, "The third slice"). Without a database there is no loop, and nothing is
 * swapped in for it: a run in memory would be lost at the first restart.
 */
@Injectable()
export class EngineRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('EngineRunner');
  private workers: Worker<EnginePorts>[] = [];
  private lastLogged: { message: string; at: number } | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(RUN_STORE) private readonly store: RunStore | undefined,
    @Inject(CLOCK) private readonly clock: () => number,
    @Inject(ENGINE_CATALOGUE) private readonly catalogue: EngineCatalogue,
    @Inject(ENGINE_PORTS) private readonly ports: EnginePorts,
    @Inject(ENGINE_TUNING) private readonly tuning: EngineTuning,
  ) {}

  onApplicationBootstrap(): void {
    if (this.tuning.autostart ?? true) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** The loops are running (or are about to: they start at once). */
  get running(): boolean {
    return this.workers.length > 0;
  }

  /** Starts the loops. Does nothing when the engine is switched off, there is no database, or they are already running. */
  start(): void {
    if (this.workers.length > 0 || !this.config.engine.enabled || this.store === undefined) {
      return;
    }
    // A name that is new at every start: a worker that was restarted with the same id is not the one that stalled.
    const incarnation = this.tuning.incarnation ?? randomUUID();
    for (let slot = 0; slot < this.config.engine.concurrency; slot += 1) {
      this.workers.push(this.makeWorker(this.store, `${incarnation}.${String(slot)}`));
    }
    for (const worker of this.workers) {
      worker.start();
    }
  }

  /** Stops claiming, asks the steps in hand to give up, and waits for them for a while; the lease runs out for the rest. */
  async stop(): Promise<void> {
    const workers = this.workers;
    this.workers = [];
    await Promise.all(
      workers.map((worker) => worker.stop({ timeoutMs: this.config.engine.stopTimeoutMs })),
    );
  }

  /**
   * Makes a worker that is not started: a test takes a run with `runOnce` and nothing else moves. Its id is the one given.
   */
  makeWorker(store: RunStore, workerId: string): Worker<EnginePorts> {
    const { engine } = this.config;
    return new Worker<EnginePorts>({
      store,
      registry: this.catalogue.steps,
      ports: this.ports,
      workerId,
      now: this.clock,
      renewIntervalMs: engine.renewMs,
      waitBackoffMs: engine.waitBackoffMs,
      pollMs: engine.pollMs,
      heartbeat: this.tuning.heartbeat ?? true,
      // The key of the vault lives in this process only: while it is sealed here, a run that waits for the vault is left to a
      // process whose vault is open, instead of being taken just to be put back with a later time.
      skipWaiting: () => (this.ports.vault.isOpen() ? [] : [VAULT_SEALED]),
      onError: (error) => {
        this.report(error);
      },
    });
  }

  /** Takes one run if there is one, on a worker made for the purpose: for tests that move the loop by hand. */
  async runOnce(workerId: string): Promise<RunOutcome | null> {
    if (this.store === undefined) {
      return null;
    }
    return this.makeWorker(this.store, workerId).runOnce();
  }

  /**
   * What the loop could not handle (the database is down, a row is not what the code expects). The run is not failed: its
   * lease runs out and a worker takes it over. The message is cut short and the stack is not logged, because an error of a
   * driver can carry the text of a statement; the same trouble is said once a minute, not at every poll.
   */
  private report(error: unknown): void {
    const message = (
      error instanceof Error ? `${error.name}: ${error.message}` : 'an error that is not an Error'
    ).slice(0, LOG_MESSAGE_CHARS);
    const now = this.clock();
    if (
      this.lastLogged !== null &&
      this.lastLogged.message === message &&
      now - this.lastLogged.at < LOG_REPEAT_MS
    ) {
      return;
    }
    this.lastLogged = { message, at: now };
    this.logger.error(`The loop of the run engine met an error and goes on: ${message}`);
  }
}
