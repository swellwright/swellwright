import { Body, Controller, Inject, Req } from '@nestjs/common';
import {
  calculatePanelImpactRoute,
  ChecksQuerySchema,
  type ConventionLastRun,
  ConventionPackQuerySchema,
  type ConventionPackValidation,
  type ConventionPackVersionList,
  type ConventionPackView,
  type ConventionRuleCatalog,
  type ConventionRun,
  getConventionPackRoute,
  getConventionRulesRoute,
  getImpactTargetRoute,
  ImpactTargetQuerySchema,
  type ImpactTarget,
  getLastConventionRunRoute,
  type ImpactReport,
  type ImpactRequest,
  listConventionPackVersionsRoute,
  putConventionPackRoute,
  type ReconciliationReport,
  resetConventionPackRoute,
  runConventionChecksRoute,
  runReconciliationRoute,
  type SaveConventionPackRequest,
  validateConventionPackRoute,
  type ValidateConventionPackRequest,
} from '@swellwright/contracts';
import type { Request } from 'express';

import { type AuthedRequest, requestMeta, requireAuth } from '../auth/context.js';
import { ContractRoute } from '../contract-route.js';
import { ChecksService } from './checks.service.js';
import { ConventionPackService } from './pack.service.js';

const actorOf = (req: AuthedRequest): { id: string; name: string } => {
  const { user } = requireAuth(req);
  return { id: user.id, name: user.username };
};

/** `?refresh=true`, read through the contract (Express exposes the query read-only). */
const wantsRefresh = (req: Request): boolean =>
  ChecksQuerySchema.parse(req.query).refresh === 'true';

/** The checks of the panel (ADR 0044): the convention linter and its pack, reconciliation, and the dry run of a change. */
@Controller()
export class ChecksController {
  constructor(
    @Inject(ChecksService) private readonly checks: ChecksService,
    @Inject(ConventionPackService) private readonly packs: ConventionPackService,
  ) {}

  @ContractRoute(getConventionRulesRoute)
  rules(): Promise<ConventionRuleCatalog> {
    return this.checks.rules();
  }

  @ContractRoute(runConventionChecksRoute)
  run(@Req() req: AuthedRequest): Promise<ConventionRun> {
    return this.checks.runConventions(actorOf(req), wantsRefresh(req));
  }

  @ContractRoute(getLastConventionRunRoute)
  last(): Promise<ConventionLastRun> {
    return this.checks.last();
  }

  @ContractRoute(getConventionPackRoute)
  pack(@Req() req: AuthedRequest): Promise<ConventionPackView> {
    return this.packs.view(ConventionPackQuerySchema.parse(req.query).version);
  }

  @ContractRoute(putConventionPackRoute)
  save(
    @Body() body: SaveConventionPackRequest,
    @Req() req: AuthedRequest,
  ): Promise<ConventionPackView> {
    return this.packs.save(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(resetConventionPackRoute)
  async reset(@Req() req: AuthedRequest): Promise<void> {
    await this.packs.reset(actorOf(req), requestMeta(req));
  }

  @ContractRoute(listConventionPackVersionsRoute)
  versions(): Promise<ConventionPackVersionList> {
    return this.packs.versions();
  }

  @ContractRoute(validateConventionPackRoute)
  validate(@Body() body: ValidateConventionPackRequest): ConventionPackValidation {
    return this.packs.validate(body);
  }

  @ContractRoute(runReconciliationRoute)
  reconcile(@Req() req: AuthedRequest): Promise<ReconciliationReport> {
    return this.checks.reconcile(actorOf(req), requireAuth(req), wantsRefresh(req));
  }

  @ContractRoute(getImpactTargetRoute)
  target(@Req() req: AuthedRequest): Promise<ImpactTarget> {
    return this.checks.target(actorOf(req), ImpactTargetQuerySchema.parse(req.query));
  }

  @ContractRoute(calculatePanelImpactRoute)
  impact(@Body() body: ImpactRequest, @Req() req: AuthedRequest): Promise<ImpactReport> {
    return this.checks.impact(actorOf(req), body);
  }
}
