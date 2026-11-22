import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '@swellwright/db';

import { type AppConfig } from '../config.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { PanelService } from './panel.service.js';

/**
 * Looks at the connected panel from time to time (ADR 0041): is it there, does the token still work, can the token
 * still read what it could, has the version changed. It changes the state of the connection and says so in the audit
 * chain only when the state changed. It does nothing while no panel is connected or the vault is sealed.
 * `SW_PANEL_CHECK_INTERVAL_MINUTES=0` switches it off.
 */
@Injectable()
export class PanelMonitorService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(PanelService) private readonly panel: PanelService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.panel.checkIntervalMs;
    if (interval <= 0 || !this.database) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, interval);
    // The check must never keep the process alive.
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One round, now. A round that is still running is not started again. */
  runOnce(): Promise<void> {
    this.running ??= this.panel.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
