import { Body, Controller, Inject, Req } from '@nestjs/common';
import {
  type BaselineFleet,
  BaselineIdParamsSchema,
  type BaselineList,
  type BaselineSummary,
  BaselineViewQuerySchema,
  type BaselineView,
  type CheckRunDiff,
  CheckRunDiffQuerySchema,
  CheckRunIdParamsSchema,
  type CheckRunList,
  CheckRunListQuerySchema,
  type CheckRunSummary,
  type CheckRunView,
  createBaselineRoute,
  type CreateBaselineRequest,
  deleteBaselineRoute,
  diffBaselineRunRoute,
  getBaselineCatalogueRoute,
  getBaselineFleetRoute,
  getBaselineRoute,
  getBaselineRunRoute,
  listBaselinesRoute,
  listServerBaselineRunsRoute,
  type ObservationCatalogue,
  observationCatalogue,
  ServerIdParamsSchema,
  setBaselineAssignmentsRoute,
  type SetBaselineAssignmentsRequest,
  startBaselineRunsRoute,
  type StartBaselineRunsRequest,
  type StartBaselineRunsResult,
  startServerBaselineRunRoute,
  type StartServerBaselineRunRequest,
  updateBaselineRoute,
  type UpdateBaselineRequest,
  validateBaselineRoute,
  type ValidateBaselineRequest,
  type ValidateBaselineResult,
} from '@swellwright/contracts';
import type { Request } from 'express';

import { type AuthedRequest, requestMeta, requireAuth } from '../auth/context.js';
import { ContractRoute } from '../contract-route.js';
import { BaselinesService } from './baselines.service.js';
import { CheckRunsService } from './check-runs.service.js';

const actorOf = (req: AuthedRequest): { id: string; name: string } => {
  const { user } = requireAuth(req);
  return { id: user.id, name: user.username };
};

/**
 * Baselines and baseline checks (ADR 0045). The permissions and the step-up of every route are in the contract:
 * reading is `servers:read`, editing a baseline is `servers:write` with a fresh code, starting a run is `servers:exec`
 * with a fresh code.
 */
@Controller()
export class BaselineController {
  constructor(
    @Inject(BaselinesService) private readonly baselines: BaselinesService,
    @Inject(CheckRunsService) private readonly runs: CheckRunsService,
  ) {}

  @ContractRoute(getBaselineCatalogueRoute)
  catalogue(): ObservationCatalogue {
    return observationCatalogue();
  }

  @ContractRoute(listBaselinesRoute)
  list(): Promise<BaselineList> {
    return this.baselines.list();
  }

  @ContractRoute(validateBaselineRoute)
  validate(@Body() body: ValidateBaselineRequest): ValidateBaselineResult {
    return this.baselines.validate(body.source);
  }

  @ContractRoute(createBaselineRoute)
  create(@Body() body: CreateBaselineRequest, @Req() req: AuthedRequest): Promise<BaselineView> {
    return this.baselines.create(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(getBaselineRoute)
  get(@Req() req: Request): Promise<BaselineView> {
    const { id } = BaselineIdParamsSchema.parse(req.params);
    return this.baselines.get(id, BaselineViewQuerySchema.parse(req.query).version);
  }

  @ContractRoute(updateBaselineRoute)
  update(@Body() body: UpdateBaselineRequest, @Req() req: AuthedRequest): Promise<BaselineView> {
    const { id } = BaselineIdParamsSchema.parse(req.params);
    return this.baselines.update(actorOf(req), id, body, requestMeta(req));
  }

  @ContractRoute(deleteBaselineRoute)
  async remove(@Req() req: AuthedRequest): Promise<void> {
    const { id } = BaselineIdParamsSchema.parse(req.params);
    await this.baselines.remove(actorOf(req), id, requestMeta(req));
  }

  @ContractRoute(setBaselineAssignmentsRoute)
  assign(
    @Body() body: SetBaselineAssignmentsRequest,
    @Req() req: AuthedRequest,
  ): Promise<BaselineSummary> {
    const { id } = BaselineIdParamsSchema.parse(req.params);
    return this.baselines.setAssignments(actorOf(req), id, body, requestMeta(req));
  }

  @ContractRoute(startServerBaselineRunRoute)
  startForServer(
    @Body() body: StartServerBaselineRunRequest,
    @Req() req: AuthedRequest,
  ): Promise<CheckRunSummary> {
    const { id } = ServerIdParamsSchema.parse(req.params);
    return this.runs.startForServer(actorOf(req), id, body, requestMeta(req));
  }

  @ContractRoute(startBaselineRunsRoute)
  startMany(
    @Body() body: StartBaselineRunsRequest,
    @Req() req: AuthedRequest,
  ): Promise<StartBaselineRunsResult> {
    return this.runs.startMany(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(listServerBaselineRunsRoute)
  listForServer(@Req() req: Request): Promise<CheckRunList> {
    const { id } = ServerIdParamsSchema.parse(req.params);
    // Express exposes the query read-only and the interceptor only checks it: read it through the contract.
    return this.runs.listForServer(id, CheckRunListQuerySchema.parse(req.query));
  }

  @ContractRoute(getBaselineRunRoute)
  getRun(@Req() req: Request): Promise<CheckRunView> {
    return this.runs.get(CheckRunIdParamsSchema.parse(req.params).id);
  }

  @ContractRoute(diffBaselineRunRoute)
  diff(@Req() req: Request): Promise<CheckRunDiff> {
    const { id } = CheckRunIdParamsSchema.parse(req.params);
    return this.runs.diff(id, CheckRunDiffQuerySchema.parse(req.query).against);
  }

  @ContractRoute(getBaselineFleetRoute)
  fleet(): Promise<BaselineFleet> {
    return this.runs.fleet();
  }
}
