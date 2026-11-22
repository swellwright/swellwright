import { Injectable } from '@nestjs/common';
import type { ConventionSummary, PackRef } from '@swellwright/contracts';

/** What the last convention run found: kept so that a dashboard can show it without running the checks again. */
export interface LastRun {
  readonly connectionId: string;
  readonly ranAt: string;
  readonly pack: PackRef;
  readonly summary: ConventionSummary;
}

/**
 * The memory of the checks, in this process only: the counts of the last run. A new pack, a new connection or a restart
 * empties it. Nothing in it is a secret (counts and a pack reference), and nothing in it is needed to be correct: an
 * empty memory only means "not checked yet".
 */
@Injectable()
export class ChecksMemory {
  private current: LastRun | null = null;

  remember(run: LastRun): void {
    this.current = run;
  }

  last(connectionId: string | null): LastRun | null {
    return this.current !== null && this.current.connectionId === connectionId
      ? this.current
      : null;
  }

  forgetLast(): void {
    this.current = null;
  }
}
