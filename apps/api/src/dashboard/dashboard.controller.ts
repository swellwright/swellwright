import { Controller, Inject, Req } from '@nestjs/common';
import {
  type AttentionFeed,
  type FleetHealth,
  getDashboardAttentionRoute,
  getDashboardFleetRoute,
} from '@swellwright/contracts';
import type { Request } from 'express';

import { type AuthedRequest, requireAuth } from '../auth/context.js';
import { ContractRoute } from '../contract-route.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The dashboard (ADR 0047). The permission of the fleet is in the contract; the feed is open to every signed-in caller
 * and leaves out what the caller's role may not read.
 */
@Controller()
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @ContractRoute(getDashboardAttentionRoute)
  attention(@Req() req: AuthedRequest): Promise<AttentionFeed> {
    return this.dashboard.attention(requireAuth(req));
  }

  @ContractRoute(getDashboardFleetRoute)
  fleet(@Req() req: AuthedRequest & Request): Promise<FleetHealth> {
    // Express exposes the query read-only and the interceptor only checks it: read it through the contract.
    return this.dashboard.fleet(
      requireAuth(req),
      getDashboardFleetRoute.request.query.parse(req.query),
    );
  }
}
