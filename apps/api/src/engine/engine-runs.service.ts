import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  type EnginePorts,
  type RunRecord,
  type RunStore,
  planRun,
  uuidv7,
} from '@swellwright/engine';

import { CLOCK, ENGINE_CATALOGUE, ENGINE_PORTS, RUN_STORE } from '../tokens.js';
import type { EngineCatalogue } from './engine-runner.js';

/**
 * Makes runs of the workflows this build knows (ADR 0048, "The fourth slice"). It is for code inside the API: no route
 * calls it yet, because who may start which workflow, and the approvals that stand in front of it, are the next ADRs. What
 * it does not do is accept a plan: a caller names a workflow and gives parameters, and the plan is built here from steps
 * that are registered, so a run can only be one that the code of this build can finish.
 *
 * The run is written as `planned` and then queued, in two transactions. A process that dies between them leaves a `planned`
 * run that no worker takes and a person can cancel; nothing has been done on any server.
 */
@Injectable()
export class EngineRunsService {
  constructor(
    @Inject(RUN_STORE) private readonly store: RunStore | undefined,
    @Inject(CLOCK) private readonly clock: () => number,
    @Inject(ENGINE_CATALOGUE) private readonly catalogue: EngineCatalogue,
    @Inject(ENGINE_PORTS) private readonly ports: EnginePorts,
  ) {}

  /**
   * @throws UnknownWorkflowError, InvalidWorkflowParamsError, UnregisteredStepError or InvalidPlanError (of
   *   `@swellwright/engine`) when the run cannot be planned; a `ServiceUnavailableException` without a database.
   */
  async create(
    workflowKey: string,
    params: unknown,
    requestedBy: string | null,
  ): Promise<RunRecord> {
    const store = this.requireStore();
    const now = this.clock();
    const { plan, risk } = await planRun({
      workflows: this.catalogue.workflows,
      steps: this.catalogue.steps,
      workflowKey,
      params,
      // Planning only reads: the signal is one that nobody aborts, and the time is the process's.
      ctx: { ports: this.ports, signal: new AbortController().signal, now: this.clock },
    });
    const run = await store.createRun({ id: uuidv7(now), plan, risk, requestedBy, now });
    return store.applyEvent(run.id, 'queue', { now: this.clock(), actor: requestedBy });
  }

  /** A run as the loop keeps it, for the code that started it and wants to know how it went. */
  get(id: string): Promise<RunRecord | null> {
    return this.requireStore().getRun(id);
  }

  private requireStore(): RunStore {
    if (this.store === undefined) {
      throw new ServiceUnavailableException('The database is not configured.');
    }
    return this.store;
  }
}
