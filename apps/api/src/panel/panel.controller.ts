import { Body, Controller, ForbiddenException, Inject, Req } from '@nestjs/common';
import {
  type ConnectPanelRequest,
  type ConnectPanelWithTokenRequest,
  connectPanelRoute,
  connectPanelWithTokenRoute,
  disconnectPanelRoute,
  getPanelComputedConfigRoute,
  getPanelConfigProfileRoute,
  getPanelConnectionRoute,
  getPanelInfraRoute,
  getPanelOverviewRoute,
  getPanelSubscriptionSettingsRoute,
  listPanelApiTokensRoute,
  listPanelConfigProfilesRoute,
  listPanelExternalSquadsRoute,
  listPanelHostsRoute,
  listPanelInternalSquadsRoute,
  listPanelNodePluginsRoute,
  listPanelNodesRoute,
  listPanelSnippetsRoute,
  listPanelSubscriptionTemplatesRoute,
  PanelProfileParamsSchema,
  PanelReadQuerySchema,
  testPanelRoute,
} from '@swellwright/contracts';
import type {
  PanelConfigProfileAnswer,
  PanelConnectionView,
  PanelOverview,
  PanelTestResult,
} from '@swellwright/contracts';
import type { Request } from 'express';

import { type AuthedRequest, requestMeta, requireAuth } from '../auth/context.js';
import { can } from '../auth/guards.js';
import { ContractRoute } from '../contract-route.js';
import { PanelReaderService, type Read } from './panel-reader.service.js';
import { PanelService } from './panel.service.js';

const actorOf = (req: AuthedRequest): { id: string; name: string } => {
  const { user } = requireAuth(req);
  return { id: user.id, name: user.username };
};

/** `?refresh=true`: read through the contract, since Express exposes the query read-only. */
const wantsRefresh = (req: Request): boolean =>
  PanelReadQuerySchema.parse(req.query).refresh === 'true';

/** The envelope every list answer shares: when it was read and whether it came from memory. */
const stamp = <T>(read: Read<T>): { fetchedAt: string; cached: boolean } => ({
  fetchedAt: read.fetchedAt,
  cached: read.cached,
});

@Controller()
export class PanelController {
  constructor(
    @Inject(PanelService) private readonly panel: PanelService,
    @Inject(PanelReaderService) private readonly reader: PanelReaderService,
  ) {}

  @ContractRoute(getPanelConnectionRoute)
  connection(): Promise<PanelConnectionView> {
    return this.panel.get();
  }

  @ContractRoute(connectPanelRoute)
  connect(
    @Body() body: ConnectPanelRequest,
    @Req() req: AuthedRequest,
  ): Promise<PanelConnectionView> {
    return this.panel.connect(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(connectPanelWithTokenRoute)
  connectWithToken(
    @Body() body: ConnectPanelWithTokenRequest,
    @Req() req: AuthedRequest,
  ): Promise<PanelConnectionView> {
    // The route holds panel:write; keeping the token in the vault is a vault permission of its own.
    if (!can(requireAuth(req), 'vault:manage')) {
      throw new ForbiddenException(
        'Keeping the token in the vault needs the permission to manage secrets as well. Ask an owner to create the secret, then connect with it.',
      );
    }
    return this.panel.connectWithToken(actorOf(req), body, requestMeta(req));
  }

  @ContractRoute(testPanelRoute)
  test(@Req() req: AuthedRequest): Promise<PanelTestResult> {
    return this.panel.test(actorOf(req), requestMeta(req));
  }

  @ContractRoute(disconnectPanelRoute)
  async disconnect(@Req() req: AuthedRequest): Promise<void> {
    await this.panel.disconnect(actorOf(req), requestMeta(req));
  }

  @ContractRoute(getPanelOverviewRoute)
  overview(@Req() req: AuthedRequest): Promise<PanelOverview> {
    return this.reader.overview(actorOf(req), wantsRefresh(req));
  }

  @ContractRoute(listPanelNodesRoute)
  async nodes(@Req() req: AuthedRequest) {
    const read = await this.reader.nodes(actorOf(req), wantsRefresh(req));
    return { nodes: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelHostsRoute)
  async hosts(@Req() req: AuthedRequest) {
    const read = await this.reader.hosts(actorOf(req), wantsRefresh(req));
    return { hosts: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelConfigProfilesRoute)
  async configProfiles(@Req() req: AuthedRequest) {
    const read = await this.reader.configProfiles(actorOf(req), wantsRefresh(req));
    return { configProfiles: read.value, ...stamp(read) };
  }

  @ContractRoute(getPanelConfigProfileRoute)
  async configProfile(@Req() req: AuthedRequest): Promise<PanelConfigProfileAnswer> {
    const { uuid } = PanelProfileParamsSchema.parse(req.params);
    const read = await this.reader.configProfile(actorOf(req), uuid, wantsRefresh(req));
    return { configProfile: read.value, ...stamp(read) };
  }

  @ContractRoute(getPanelComputedConfigRoute)
  async computedConfig(@Req() req: AuthedRequest): Promise<PanelConfigProfileAnswer> {
    const { uuid } = PanelProfileParamsSchema.parse(req.params);
    const read = await this.reader.computedConfig(actorOf(req), uuid);
    return { configProfile: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelInternalSquadsRoute)
  async internalSquads(@Req() req: AuthedRequest) {
    const read = await this.reader.internalSquads(actorOf(req), wantsRefresh(req));
    return { internalSquads: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelExternalSquadsRoute)
  async externalSquads(@Req() req: AuthedRequest) {
    const read = await this.reader.externalSquads(actorOf(req), wantsRefresh(req));
    return { externalSquads: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelSubscriptionTemplatesRoute)
  async subscriptionTemplates(@Req() req: AuthedRequest) {
    const read = await this.reader.subscriptionTemplates(actorOf(req), wantsRefresh(req));
    return { templates: read.value, ...stamp(read) };
  }

  @ContractRoute(getPanelSubscriptionSettingsRoute)
  async subscriptionSettings(@Req() req: AuthedRequest) {
    const read = await this.reader.subscriptionSettings(actorOf(req), wantsRefresh(req));
    return { subscriptionSettings: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelSnippetsRoute)
  async snippets(@Req() req: AuthedRequest) {
    const read = await this.reader.snippets(actorOf(req), wantsRefresh(req));
    return { snippets: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelNodePluginsRoute)
  async nodePlugins(@Req() req: AuthedRequest) {
    const read = await this.reader.nodePlugins(actorOf(req), wantsRefresh(req));
    return { nodePlugins: read.value, ...stamp(read) };
  }

  @ContractRoute(getPanelInfraRoute)
  async infra(@Req() req: AuthedRequest) {
    const read = await this.reader.infra(actorOf(req), wantsRefresh(req));
    return { infra: read.value, ...stamp(read) };
  }

  @ContractRoute(listPanelApiTokensRoute)
  async apiTokens(@Req() req: AuthedRequest) {
    const read = await this.reader.apiTokens(actorOf(req), wantsRefresh(req));
    return { apiTokens: read.value, ...stamp(read) };
  }
}
