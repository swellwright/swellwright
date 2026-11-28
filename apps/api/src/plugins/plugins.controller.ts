import { Body, Controller, Headers, Inject, Req } from '@nestjs/common';
import {
  checkPluginRoute,
  disablePluginRoute,
  enablePluginRoute,
  type EnablePluginRequest,
  getPluginConfigRoute,
  getPluginSidecarRoute,
  hasPermission,
  listPluginsRoute,
  PluginIdParamsSchema,
  type PluginConfigView,
  type PluginGatewayReply,
  type PluginGatewayRequest,
  pluginGatewayRoute,
  type PluginList,
  type PluginSidecarFragment,
  type PluginView,
  updatePluginConfigRoute,
  type UpdatePluginConfigRequest,
} from '@swellwright/contracts';

import { type AuthedRequest, requestMeta, requireAuth } from '../auth/context.js';
import { ContractRoute } from '../contract-route.js';
import { PluginHostService } from './host/plugin-host.service.js';
import { PluginsService } from './plugins.service.js';

const actorOf = (req: AuthedRequest): { id: string; name: string } => {
  const { user } = requireAuth(req);
  return { id: user.id, name: user.username };
};

@Controller()
export class PluginsController {
  constructor(
    @Inject(PluginsService) private readonly plugins: PluginsService,
    @Inject(PluginHostService) private readonly host: PluginHostService,
  ) {}

  @ContractRoute(listPluginsRoute)
  list(): Promise<PluginList> {
    return this.plugins.list();
  }

  @ContractRoute(enablePluginRoute)
  enable(@Body() body: EnablePluginRequest, @Req() req: AuthedRequest): Promise<PluginView> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.plugins.enable(
      actorOf(req),
      id,
      body.digest,
      requestMeta(req),
      hasPermission(requireAuth(req).user.role, 'vault:reveal'),
    );
  }

  @ContractRoute(disablePluginRoute)
  disable(@Req() req: AuthedRequest): Promise<PluginView> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.plugins.disable(actorOf(req), id, requestMeta(req));
  }

  @ContractRoute(checkPluginRoute)
  check(@Req() req: AuthedRequest): Promise<PluginView> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.host.check(actorOf(req), id, requestMeta(req));
  }

  @ContractRoute(getPluginConfigRoute)
  config(@Req() req: AuthedRequest): Promise<PluginConfigView> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.plugins.getConfig(id);
  }

  @ContractRoute(updatePluginConfigRoute)
  updateConfig(
    @Body() body: UpdatePluginConfigRequest,
    @Req() req: AuthedRequest,
  ): Promise<PluginConfigView> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.plugins.updateConfig(
      actorOf(req),
      id,
      body.values,
      requestMeta(req),
      hasPermission(requireAuth(req).user.role, 'vault:reveal'),
    );
  }

  @ContractRoute(getPluginSidecarRoute)
  sidecar(@Req() req: AuthedRequest): Promise<PluginSidecarFragment> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.host.fragment(
      actorOf(req),
      id,
      requestMeta(req),
      hasPermission(requireAuth(req).user.role, 'vault:reveal'),
    );
  }

  /** Open to the network and guarded by the token of the plugin: see `PluginHostService.gateway`. */
  @ContractRoute(pluginGatewayRoute)
  gateway(
    @Body() body: PluginGatewayRequest,
    @Headers('authorization') authorization: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<PluginGatewayReply> {
    const { id } = PluginIdParamsSchema.parse(req.params);
    return this.host.sidecarGateway(id, authorization, body, req.ip);
  }
}
