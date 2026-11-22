import { Body, Controller, Inject, Req } from '@nestjs/common';
import {
  getPanelConsoleOperationRoute,
  listPanelConsoleOperationsRoute,
  type PanelConsoleCatalogue,
  type PanelConsoleOperationDetail,
  type PanelConsoleRequest,
  type PanelConsoleResult,
  sendPanelConsoleRequestRoute,
} from '@swellwright/contracts';

import { type AuthedRequest, requestMeta, requireAuth } from '../../auth/context.js';
import { ContractRoute } from '../../contract-route.js';
import { PanelConsoleService } from './console.service.js';

/** The API console (ADR 0046): what can be asked of the panel, and asking it. */
@Controller()
export class PanelConsoleController {
  constructor(@Inject(PanelConsoleService) private readonly console: PanelConsoleService) {}

  @ContractRoute(listPanelConsoleOperationsRoute)
  operations(): PanelConsoleCatalogue {
    return this.console.catalogue();
  }

  @ContractRoute(getPanelConsoleOperationRoute)
  operation(@Req() req: AuthedRequest): PanelConsoleOperationDetail {
    const { operationId } = getPanelConsoleOperationRoute.request.params.parse(req.params);
    return this.console.operation(operationId);
  }

  @ContractRoute(sendPanelConsoleRequestRoute)
  send(@Body() body: PanelConsoleRequest, @Req() req: AuthedRequest): Promise<PanelConsoleResult> {
    return this.console.send(requireAuth(req), body, requestMeta(req));
  }
}
