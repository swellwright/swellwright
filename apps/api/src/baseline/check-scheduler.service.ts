import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '@swellwright/db';

import { type AppConfig } from '../config.js';
import { CHECKS_CLOCK, CONFIG, DATABASE } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';
import { CheckRunsService } from './check-runs.service.js';

/** How often the job looks at whether a server is due: often enough that a restart does not push a check far away. */
const MAX_TICK_MS = 15 * 60_000;
/** A server that was never checked gets its first scheduled check within this long after the job began, not all at once. */
const MAX_STAGGER_MS = 60 * 60_000;

/** A stable number from a text (FNV-1a), for the stagger: the same server always gets the same offset. */
function spread(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

export interface ScheduledRound {
  /** The servers a check was queued for. */
  readonly started: readonly string[];
  /** Why nothing was done: the job is off, the vault is closed. */
  readonly skipped: 'off' | 'vault_not_open' | null;
}

/**
 * Checks every server that has a baseline on an interval (ADR 0045), `SW_CHECKS_INTERVAL_HOURS` (0, off, by default).
 * It ticks every quarter of an hour at most and asks which servers are due: a server is due when its last run is older
 * than the interval, and a server that was never checked becomes due at a point of its own within the first hour, so that
 * a fleet is not checked in one burst. It does nothing while the vault is not open (no login can happen), leaves out a
 * server whose access has no secret that is still valid, and a round that is running is not started again.
 */
@Injectable()
export class CheckScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('CheckScheduler');
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<ScheduledRound> | undefined;
  private began = 0;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(CHECKS_CLOCK) private readonly now: () => number,
    @Inject(CheckRunsService) private readonly runs: CheckRunsService,
    @Inject(VaultService) private readonly vault: VaultService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.checks.intervalMs;
    if (interval <= 0 || !this.database) {
      return;
    }
    this.began = this.now();
    this.timer = setInterval(
      () => {
        void this.runOnce();
      },
      Math.min(interval, MAX_TICK_MS),
    );
    // The job must never keep the process alive.
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** The time the job counts its first stagger from; tests that call `runOnce` without `onApplicationBootstrap` set it. */
  startAt(at: number): void {
    this.began = at;
  }

  /** One round, now. A round that is still running is not started again. */
  runOnce(): Promise<ScheduledRound> {
    this.running ??= this.round().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async round(): Promise<ScheduledRound> {
    const interval = this.config.checks.intervalMs;
    if (interval <= 0 || !this.database) {
      return { started: [], skipped: 'off' };
    }
    try {
      if ((await this.vault.status()).state !== 'unsealed') {
        return { started: [], skipped: 'vault_not_open' };
      }
      const candidates = await this.runs.scheduledCandidates();
      if (candidates.length === 0) {
        return { started: [], skipped: null };
      }
      const now = this.now();
      const last = await this.runs.lastQueued(candidates);
      const due = candidates.filter((serverId) => {
        const at = last.get(serverId);
        if (at === undefined) {
          return now >= this.began + (spread(serverId) % Math.min(interval, MAX_STAGGER_MS));
        }
        return now - at >= interval;
      });
      if (due.length === 0) {
        return { started: [], skipped: null };
      }
      const result = await this.runs.startScheduled(due);
      return { started: result.runs.map((run) => run.serverId), skipped: null };
    } catch (error) {
      this.logger.warn(
        `a scheduled round failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return { started: [], skipped: null };
    }
  }
}
