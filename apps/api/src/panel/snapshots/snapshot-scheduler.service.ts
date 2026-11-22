import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '@swellwright/db';

import { type AppConfig } from '../../config.js';
import { CONFIG, DATABASE } from '../../tokens.js';
import { PanelSnapshotsService, type SnapshotRun } from './snapshots.service.js';

/** How often the job looks at whether a snapshot is due: often enough that a restart does not push it a day away. */
const MAX_TICK_MS = 15 * 60_000;

/**
 * Takes a snapshot of the connected panel on an interval (ADR 0043), `SW_PANEL_SNAPSHOT_INTERVAL_HOURS` (24 by default,
 * 0 switches it off). The job ticks every quarter of an hour at most and asks the service whether one is due, so that
 * what counts is the time since the last snapshot and not the time since this process started. It does nothing while
 * no panel is connected or the vault is sealed, a panel that is the same as the last snapshot is only noted as checked,
 * and a round that is still running is not started again.
 */
@Injectable()
export class PanelSnapshotScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SnapshotRun> | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(PanelSnapshotsService) private readonly snapshots: PanelSnapshotsService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.panel.snapshotIntervalMs;
    if (interval <= 0 || !this.database) {
      return;
    }
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

  /** One round, now. A round that is still running is not started again. */
  runOnce(): Promise<SnapshotRun> {
    this.running ??= this.snapshots.runDue().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
