import { Injectable } from '@nestjs/common';
import type { ConventionSummary, PackRef, PanelNodeState } from '@swellwright/contracts';

/** What the last convention run found: kept so that a dashboard can show it without running the checks again. */
export interface LastRun {
  readonly connectionId: string;
  readonly ranAt: string;
  readonly pack: PackRef;
  readonly summary: ConventionSummary;
}

/** A server of the inventory and the node of the panel that the reconciliation matched it with. */
export interface MatchedNode {
  readonly name: string;
  readonly state: PanelNodeState;
}

/**
 * What the last reconciliation found, in counts, and which node answers for which server (ADR 0047): kept so that the
 * dashboard can show the drift and the node of a server without comparing the panel and the inventory again.
 */
export interface LastReconciliation {
  readonly connectionId: string;
  readonly ranAt: string;
  /** Rows that are not `ok`, by status. */
  readonly drift: number;
  readonly missing: number;
  readonly extra: number;
  readonly unknown: number;
  /** The inventory was compared (the person who ran it may read servers); without it the counts leave servers out. */
  readonly inventoryCompared: boolean;
  /** By the id of the server. Empty without the inventory. */
  readonly nodes: ReadonlyMap<string, MatchedNode>;
}

/**
 * The memory of the checks, in this process only: the counts of the last run. A new pack, a new connection or a restart
 * empties it. Nothing in it is a secret (counts, a pack reference, the name and state of a node), and nothing in it is
 * needed to be correct: an empty memory only means "not checked yet".
 */
@Injectable()
export class ChecksMemory {
  private current: LastRun | null = null;
  private reconciled: LastReconciliation | null = null;

  remember(run: LastRun): void {
    this.current = run;
  }

  last(connectionId: string | null): LastRun | null {
    return this.current !== null && this.current.connectionId === connectionId
      ? this.current
      : null;
  }

  /**
   * Keeps the result of a reconciliation. A run made without the inventory does not replace one that had it for the
   * same connection: it knows less, and the dashboard would lose the nodes of the servers.
   */
  rememberReconciliation(result: LastReconciliation): void {
    const kept = this.reconciled;
    if (
      kept !== null &&
      kept.connectionId === result.connectionId &&
      kept.inventoryCompared &&
      !result.inventoryCompared
    ) {
      return;
    }
    this.reconciled = result;
  }

  lastReconciliation(connectionId: string | null): LastReconciliation | null {
    return this.reconciled !== null && this.reconciled.connectionId === connectionId
      ? this.reconciled
      : null;
  }

  forgetLast(): void {
    this.current = null;
    this.reconciled = null;
  }
}
