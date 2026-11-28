import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { type AuditInput, AuditService } from '../audit/audit.service.js';
import { addressBucket } from './cidr.js';
import { WindowLimiter } from './rate-limit.js';

const MINUTE_MS = 60_000;
type Lane = 'unverified' | 'account' | 'setup';
const TOTAL: Readonly<Record<Lane, number>> = { unverified: 20, account: 30, setup: 10 };

/**
 * Samples authentication failures without letting unverified traffic spend the audit budget for known accounts.
 * A single summary per process and minute records how many eligible notes were suppressed in each lane, without
 * including addresses, identities or submitted input. Neither limit is used for state transitions.
 */
@Injectable()
export class AuthFailureNotes implements OnModuleInit, OnModuleDestroy {
  private readonly budgets = {
    unverified: new WindowLimiter(TOTAL.unverified, MINUTE_MS),
    account: new WindowLimiter(TOTAL.account, MINUTE_MS),
    setup: new WindowLimiter(TOTAL.setup, MINUTE_MS),
  };
  private readonly sources = {
    unverified: new WindowLimiter(10, 15 * MINUTE_MS),
    account: new WindowLimiter(10, MINUTE_MS),
    setup: new WindowLimiter(5, MINUTE_MS),
  };
  private readonly accounts = new WindowLimiter(10, MINUTE_MS);
  private suppressed: Record<Lane, number> = { unverified: 0, account: 0, setup: 0 };
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flushSuppressed();
    }, MINUTE_MS).unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flushSuppressed();
  }

  async note(input: AuditInput, trust: 'unverified' | 'account' = 'account'): Promise<void> {
    const lane: Lane = input.action === 'setup.owner.refused' ? 'setup' : trust;
    if (
      this.sources[lane].hit(addressBucket(input.meta.ip)) &&
      (lane !== 'account' || !input.actor || this.accounts.hit(input.actor.id)) &&
      this.budgets[lane].hit('all')
    ) {
      await this.audit.note(input);
    } else {
      this.suppress(lane);
    }
  }

  suppress(lane: Lane): void {
    this.suppressed[lane] = Math.min(Number.MAX_SAFE_INTEGER, this.suppressed[lane] + 1);
  }

  /** The periodic aggregate bypasses the sampling budgets and never competes with individual notes for a slot. */
  async flushSuppressed(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    const { unverified, account, setup } = this.suppressed;
    if (unverified === 0 && account === 0 && setup === 0) {
      return;
    }
    this.suppressed = { unverified: 0, account: 0, setup: 0 };
    this.flushing = this.audit
      .note({
        action: 'auth.failures.summarized',
        outcome: 'failure',
        details: { unverified, account, setup },
        meta: { ip: undefined, requestId: undefined },
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
  }
}
