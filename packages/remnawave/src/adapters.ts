import type {
  PanelApiTokenView,
  PanelBillingNodeView,
  PanelConfigProfileSummary,
  PanelConfigProfileView,
  PanelExternalSquadView,
  PanelHostView,
  PanelInboundView,
  PanelInfraProviderView,
  PanelInfraView,
  PanelInternalSquadView,
  PanelNodePluginView,
  PanelNodeState,
  PanelNodeView,
  PanelSnippetView,
  PanelSubscriptionSettingsView,
  PanelSubscriptionTemplateView,
} from '@swellwright/contracts';
import { stringify as stringifyYaml } from 'yaml';

import {
  contentHash,
  MASK,
  maskSecrets,
  type MaskOptions,
  maskText,
  readYamlDocuments,
} from './mask.js';
import type {
  ApiTokenDtoType,
  BillingNodeDtoType,
  ConfigProfileDtoType,
  ExternalSquadDtoType,
  HostDtoType,
  InboundDtoType,
  InfraProviderDtoType,
  InternalSquadDtoType,
  NodeDtoType,
  NodePluginDtoType,
  SnippetDtoType,
  SubscriptionSettingsDtoType,
  SubscriptionTemplateDtoType,
} from './schemas.js';

// The adapters turn what the panel sends into the views of `@swellwright/contracts` (ADR 0041). A view is what the
// rest of Swellwright and the console know about a panel object; a change of the panel moves these functions and
// nothing else. Every opaque JSON part and every URL goes through the masking before it is put into a view, and each
// view carries the hash of its configuration so that two reads can be compared without comparing the objects.

export interface AdaptContext extends MaskOptions {
  /** The clock for "days left" (tests set it). */
  readonly now?: Date;
}

const iso = (value: string): string => new Date(value).toISOString();
const isoOrNull = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : iso(value);

/** The fields of an object except the named ones: what a hash covers when some fields change on their own. */
function without(value: object, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)));
}

/** Adds the hash of the fields that describe the object's configuration. */
function withHash<T extends object>(view: T, hashed: unknown): T & { hash: string } {
  return { ...view, hash: contentHash(hashed) };
}

// ---- nodes ------------------------------------------------------------------------------------------------------

export function nodeState(
  dto: Pick<NodeDtoType, 'isDisabled' | 'isConnected' | 'isConnecting'>,
): PanelNodeState {
  if (dto.isDisabled) {
    return 'disabled';
  }
  if (dto.isConnected) {
    return 'online';
  }
  return dto.isConnecting ? 'connecting' : 'offline';
}

export function adaptNode(dto: NodeDtoType, context: AdaptContext): PanelNodeView {
  const inbounds = (dto.configProfile?.activeInbounds ?? []).map((inbound) => ({
    uuid: inbound.uuid,
    tag: inbound.tag,
  }));
  const proxyUrl =
    dto.proxyUrl === null || dto.proxyUrl === undefined
      ? null
      : maskText(dto.proxyUrl, context).value;
  const info = dto.system?.info;
  const stats = dto.system?.stats;
  const memoryUsed = stats?.memoryUsed;
  const system =
    dto.system === null || dto.system === undefined
      ? null
      : {
          hostname: info?.hostname ?? null,
          platform: info?.platform ?? null,
          release: info?.release ?? null,
          arch: info?.arch ?? null,
          cpus: info?.cpus ?? null,
          memoryTotal:
            memoryUsed !== undefined && stats?.memoryFree !== undefined
              ? memoryUsed + stats.memoryFree
              : null,
          memoryUsed: memoryUsed ?? null,
          uptimeSeconds: stats?.uptime ?? null,
          loadAvg: stats?.loadAvg ?? [],
        };
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    address: dto.address,
    port: dto.port ?? null,
    countryCode: dto.countryCode,
    state: nodeState(dto),
    isConnected: dto.isConnected,
    isConnecting: dto.isConnecting,
    isDisabled: dto.isDisabled,
    lastStatusChange: isoOrNull(dto.lastStatusChange),
    lastStatusMessage: dto.lastStatusMessage ?? null,
    xrayVersion: dto.versions?.xray ?? null,
    nodeVersion: dto.versions?.node ?? null,
    xrayUptimeSeconds: dto.xrayUptime ?? null,
    usersOnline: dto.usersOnline ?? null,
    configProfile: { uuid: dto.configProfile?.activeConfigProfileUuid ?? null, inbounds },
    tags: dto.tags ?? [],
    provider: dto.provider ? { uuid: dto.provider.uuid, name: dto.provider.name } : null,
    activePluginUuid: dto.activePluginUuid ?? null,
    integrationUuids: dto.integrationUuids ?? [],
    ips: (dto.ips ?? []).map((ip) => ({ ip: ip.ip, status: ip.status })),
    proxyUrl,
    traffic: {
      trackingActive: dto.isTrafficTrackingActive ?? false,
      usedBytes: dto.trafficUsedBytes ?? null,
      limitBytes: dto.trafficLimitBytes ?? null,
      resetDay: dto.trafficResetDay ?? null,
      notifyPercent: dto.notifyPercent ?? null,
    },
    consumptionMultiplier: dto.consumptionMultiplier ?? 1,
    nodeConsumptionMultiplier: dto.nodeConsumptionMultiplier ?? 1,
    viewPosition: dto.viewPosition ?? 0,
    note: dto.note ?? null,
    system,
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  // The hash is the configuration of the node, not how it is doing: online state, versions, counters, host facts and
  // the clock fields are left out, so the hash changes when somebody edits the node and not when it restarts.
  return withHash(view, {
    name: view.name,
    address: view.address,
    port: view.port,
    countryCode: view.countryCode,
    isDisabled: view.isDisabled,
    configProfile: view.configProfile,
    tags: view.tags,
    provider: view.provider,
    activePluginUuid: view.activePluginUuid,
    integrationUuids: view.integrationUuids,
    proxyUrl: view.proxyUrl,
    trackingActive: view.traffic.trackingActive,
    limitBytes: view.traffic.limitBytes,
    resetDay: view.traffic.resetDay,
    notifyPercent: view.traffic.notifyPercent,
    consumptionMultiplier: view.consumptionMultiplier,
    nodeConsumptionMultiplier: view.nodeConsumptionMultiplier,
    viewPosition: view.viewPosition,
    note: view.note,
  });
}

// ---- hosts ------------------------------------------------------------------------------------------------------

export function adaptHost(dto: HostDtoType, context: AdaptContext): PanelHostView {
  const opaque = (value: unknown): unknown => maskSecrets(value ?? null, context).value;
  const view = {
    uuid: dto.uuid,
    viewPosition: dto.viewPosition ?? 0,
    remark: dto.remark,
    address: dto.address,
    port: dto.port,
    path: dto.path ?? null,
    sni: dto.sni ?? null,
    host: dto.host ?? null,
    alpn: dto.alpn ?? null,
    fingerprint: dto.fingerprint ?? null,
    isDisabled: dto.isDisabled,
    isHidden: dto.isHidden ?? false,
    securityLayer: dto.securityLayer ?? 'DEFAULT',
    inbound: {
      configProfileUuid: dto.inbound?.configProfileUuid ?? null,
      configProfileInboundUuid: dto.inbound?.configProfileInboundUuid ?? null,
    },
    nodeUuids: dto.nodes ?? [],
    tags: dto.tags ?? [],
    serverDescription: dto.serverDescription ?? null,
    overrideSniFromAddress: dto.overrideSniFromAddress ?? false,
    keepSniBlank: dto.keepSniBlank ?? false,
    vlessRouteId: dto.vlessRouteId ?? null,
    pinnedPeerCertSha256: dto.pinnedPeerCertSha256 ?? null,
    verifyPeerCertByName: dto.verifyPeerCertByName ?? null,
    shuffleHost: dto.shuffleHost ?? false,
    mihomoX25519: dto.mihomoX25519 ?? false,
    mihomoIpVersion: dto.mihomoIpVersion ?? null,
    xrayJsonTemplateUuid: dto.xrayJsonTemplateUuid ?? null,
    excludeFromSubscriptionTypes: dto.excludeFromSubscriptionTypes ?? [],
    includeInSrrRules: dto.includeInSrrRules ?? [],
    internalSquads: {
      mode: dto.internalSquads?.mode ?? 'EXCLUDE',
      squadUuids: dto.internalSquads?.squads ?? [],
    },
    xhttpExtraParams: opaque(dto.xhttpExtraParams),
    muxParams: opaque(dto.muxParams),
    sockoptParams: opaque(dto.sockoptParams),
    finalMask: opaque(dto.finalMask),
    mapper: opaque(dto.mapper),
  };
  return withHash(view, view);
}

// ---- config profiles --------------------------------------------------------------------------------------------

function adaptInbound(
  dto: InboundDtoType,
  context: AdaptContext,
  withRaw: boolean,
): { view: PanelInboundView; masked: number } {
  const base = {
    uuid: dto.uuid,
    profileUuid: dto.profileUuid,
    tag: dto.tag,
    type: dto.type,
    network: dto.network ?? null,
    security: dto.security ?? null,
    port: dto.port ?? null,
  };
  if (!withRaw || dto.rawInbound === undefined || dto.rawInbound === null) {
    return { view: base, masked: 0 };
  }
  const raw = maskSecrets(dto.rawInbound, context);
  return { view: { ...base, raw: raw.value }, masked: raw.count };
}

/**
 * A config profile. `includeConfig` decides whether the Xray configuration and the raw inbounds are in the view (the
 * detail) or only counted in the hash (the list).
 */
export function adaptConfigProfile(
  dto: ConfigProfileDtoType,
  context: AdaptContext,
  includeConfig: true,
): PanelConfigProfileView;
export function adaptConfigProfile(
  dto: ConfigProfileDtoType,
  context: AdaptContext,
  includeConfig: false,
): PanelConfigProfileSummary;
export function adaptConfigProfile(
  dto: ConfigProfileDtoType,
  context: AdaptContext,
  includeConfig: boolean,
): PanelConfigProfileSummary | PanelConfigProfileView {
  const config = maskSecrets(dto.config ?? null, context);
  // The inbounds are masked in any case, because the hash covers them.
  const withRaw = (dto.inbounds ?? []).map((inbound) => adaptInbound(inbound, context, true));
  const maskedCount = config.count + withRaw.reduce((sum, item) => sum + item.masked, 0);
  const inbounds = (dto.inbounds ?? []).map(
    (inbound) => adaptInbound(inbound, context, includeConfig).view,
  );
  const summary = {
    uuid: dto.uuid,
    name: dto.name,
    viewPosition: dto.viewPosition ?? 0,
    tags: dto.tags ?? [],
    inbounds,
    nodes: (dto.nodes ?? []).map((node) => ({
      uuid: node.uuid,
      name: node.name,
      countryCode: node.countryCode,
    })),
    nodeCount: dto.nodes?.length ?? 0,
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  const hashed = {
    name: summary.name,
    tags: summary.tags,
    config: config.value,
    inbounds: withRaw.map((item) => item.view),
  };
  const hash = contentHash(hashed);
  if (!includeConfig) {
    return { ...summary, hash };
  }
  return { ...summary, config: config.value, masked: maskedCount, hash };
}

// ---- squads -----------------------------------------------------------------------------------------------------

export function adaptInternalSquad(
  dto: InternalSquadDtoType,
  context: AdaptContext,
): PanelInternalSquadView {
  const inbounds = (dto.inbounds ?? []).map(
    (inbound) => adaptInbound(inbound, context, false).view,
  );
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    viewPosition: dto.viewPosition ?? 0,
    tags: dto.tags ?? [],
    membersCount: dto.info?.membersCount ?? 0,
    inboundsCount: dto.info?.inboundsCount ?? inbounds.length,
    inbounds,
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  return withHash(view, {
    name: view.name,
    tags: view.tags,
    viewPosition: view.viewPosition,
    inbounds: view.inbounds.map((inbound) => inbound.uuid).sort(),
  });
}

/** Header maps must keep their contract shape even when the masker refuses an entire input. */
function maskedHeaders(
  headers: Record<string, string>,
  context: AdaptContext,
): Record<string, string> {
  const { value } = maskSecrets<unknown>(headers, context);
  return typeof value === 'string' ? {} : (value as Record<string, string>);
}

export function adaptExternalSquad(
  dto: ExternalSquadDtoType,
  context: AdaptContext,
): PanelExternalSquadView {
  const headers = maskedHeaders(dto.responseHeadersAdd ?? {}, context);
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    viewPosition: dto.viewPosition ?? 0,
    tags: dto.tags ?? [],
    membersCount: dto.info?.membersCount ?? 0,
    templates: (dto.templates ?? []).map((t) => ({
      templateUuid: t.templateUuid,
      templateType: t.templateType,
    })),
    subscriptionSettings: {
      serveJsonAtBaseSubscription: dto.subscriptionSettings?.serveJsonAtBaseSubscription ?? null,
      isShowCustomRemarks: dto.subscriptionSettings?.isShowCustomRemarks ?? null,
      randomizeHosts: dto.subscriptionSettings?.randomizeHosts ?? null,
    },
    hostOverrides: {
      serverDescription: dto.hostOverrides?.serverDescription ?? null,
      vlessRouteId: dto.hostOverrides?.vlessRouteId ?? null,
    },
    responseHeadersAdd: headers,
    responseHeadersRemove: dto.responseHeadersRemove ?? [],
    hwidSettings: {
      enabled: dto.hwidSettings?.enabled ?? false,
      fallbackDeviceLimit: dto.hwidSettings?.fallbackDeviceLimit ?? 0,
      maxDevicesAnnounce: dto.hwidSettings?.maxDevicesAnnounce ?? null,
    },
    customRemarks: dto.customRemarks ?? {},
    subpageConfigUuid: dto.subpageConfigUuid ?? null,
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  return withHash(view, without(view, ['membersCount', 'createdAt', 'updatedAt']));
}

// ---- templates, settings, snippets, plugins ---------------------------------------------------------------------

/** The YAML body of a template: decoded from base64, read, masked, written back. Null when it cannot be read. */
export function maskedYaml(
  encoded: string | null | undefined,
  context: AdaptContext,
): string | null {
  if (encoded === null || encoded === undefined || encoded.trim() === '') {
    return null;
  }
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    // Read with bounds and without the parser's log, which quotes the source (see `readYamlDocuments`).
    const documents = readYamlDocuments(text);
    const [parsed] = documents ?? [];
    if (documents?.length !== 1 || parsed === null || typeof parsed !== 'object') {
      return null;
    }
    const masked = maskSecrets<unknown>(parsed, context).value;
    return masked === MASK ? null : stringifyYaml(masked, { lineWidth: 0 });
  } catch {
    return null;
  }
}

/** Whether a body is in a response: a JSON body, or a YAML text with something in it. */
function carriesBody(dto: SubscriptionTemplateDtoType): boolean {
  return (
    (dto.templateJson !== undefined && dto.templateJson !== null) ||
    (dto.encodedTemplateYaml !== undefined &&
      dto.encodedTemplateYaml !== null &&
      dto.encodedTemplateYaml.trim() !== '')
  );
}

/**
 * A subscription template. `fromDetail` says that the response is the answer to the detail request, which carries the
 * body (the list of 3.4 does not: `templateJson` and `encodedTemplateYaml` are null there for every template). A body
 * that is null in an answer that is not a detail says nothing about the template, so such a view has `bodyLoaded`
 * false. The flag describes how the view was read, not the template, and is not part of the hash.
 */
export function adaptSubscriptionTemplate(
  dto: SubscriptionTemplateDtoType,
  context: AdaptContext,
  fromDetail = false,
): PanelSubscriptionTemplateView {
  const templateJson =
    dto.templateJson === undefined || dto.templateJson === null
      ? null
      : maskSecrets(dto.templateJson, context).value;
  const templateYaml = maskedYaml(dto.encodedTemplateYaml, context);
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    viewPosition: dto.viewPosition ?? 0,
    tags: dto.tags ?? [],
    templateType: dto.templateType,
    templateJson,
    templateYaml,
    bodyLoaded: fromDetail || carriesBody(dto),
  };
  return withHash(view, without(view, ['bodyLoaded']));
}

export function adaptSubscriptionSettings(
  dto: SubscriptionSettingsDtoType,
  context: AdaptContext,
): PanelSubscriptionSettingsView {
  const view = {
    uuid: dto.uuid,
    serveJsonAtBaseSubscription: dto.serveJsonAtBaseSubscription ?? false,
    isShowCustomRemarks: dto.isShowCustomRemarks ?? false,
    randomizeHosts: dto.randomizeHosts ?? false,
    customRemarks: dto.customRemarks ?? {},
    customResponseHeaders: maskedHeaders(dto.customResponseHeaders ?? {}, context),
    responseRules: maskSecrets(dto.responseRules ?? null, context).value,
    hwidSettings: {
      enabled: dto.hwidSettings?.enabled ?? false,
      fallbackDeviceLimit: dto.hwidSettings?.fallbackDeviceLimit ?? 0,
      maxDevicesAnnounce: dto.hwidSettings?.maxDevicesAnnounce ?? null,
    },
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  return withHash(view, without(view, ['createdAt', 'updatedAt']));
}

export function adaptSnippet(dto: SnippetDtoType, context: AdaptContext): PanelSnippetView {
  const view = { name: dto.name, snippet: maskSecrets(dto.snippet ?? null, context).value };
  return withHash(view, view);
}

/**
 * A node plugin. `fromDetail` as for `adaptSubscriptionTemplate`: a configuration that is null in the list may only be
 * left out there, so such a view has `configLoaded` false (not part of the hash).
 */
export function adaptNodePlugin(
  dto: NodePluginDtoType,
  context: AdaptContext,
  fromDetail = false,
): PanelNodePluginView {
  const present = dto.pluginConfig !== undefined && dto.pluginConfig !== null;
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    viewPosition: dto.viewPosition ?? 0,
    tags: dto.tags ?? [],
    pluginConfig: present ? maskSecrets(dto.pluginConfig, context).value : null,
    configLoaded: fromDetail || present,
  };
  return withHash(view, without(view, ['configLoaded']));
}

// ---- billing ----------------------------------------------------------------------------------------------------

export function adaptInfraProvider(
  dto: InfraProviderDtoType,
  context: AdaptContext,
): PanelInfraProviderView {
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    loginUrl:
      dto.loginUrl === null || dto.loginUrl === undefined
        ? null
        : maskText(dto.loginUrl, context).value,
    faviconLink:
      dto.faviconLink === null || dto.faviconLink === undefined
        ? null
        : maskText(dto.faviconLink, context).value,
    totalAmount: dto.billingHistory?.totalAmount ?? 0,
    totalBills: dto.billingHistory?.totalBills ?? 0,
    nodes: (dto.billingNodes ?? []).map((node) => ({
      name: node.name,
      nodeUuid: node.details.nodeUuid,
      countryCode: node.details.countryCode,
    })),
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  return withHash(view, {
    name: view.name,
    loginUrl: view.loginUrl,
    faviconLink: view.faviconLink,
  });
}

export function adaptBillingNode(dto: BillingNodeDtoType): PanelBillingNodeView {
  const view = {
    uuid: dto.uuid,
    nodeUuid: dto.nodeUuid ?? null,
    name: dto.name ?? null,
    provider: { uuid: dto.provider.uuid, name: dto.provider.name },
    node: dto.node
      ? { uuid: dto.node.uuid, name: dto.node.name, countryCode: dto.node.countryCode }
      : null,
    nextBillingAt: iso(dto.nextBillingAt),
  };
  return withHash(view, view);
}

export function adaptInfra(
  providers: readonly InfraProviderDtoType[],
  billing: {
    readonly billingNodes: readonly BillingNodeDtoType[];
    readonly availableBillingNodes?:
      readonly { uuid: string; name: string; countryCode: string }[] | undefined;
    readonly stats?:
      | {
          readonly upcomingNodesCount?: number | undefined;
          readonly currentMonthPayments?: number | undefined;
          readonly totalSpent?: number | undefined;
        }
      | null
      | undefined;
  },
  context: AdaptContext,
): PanelInfraView {
  return {
    providers: providers.map((provider) => adaptInfraProvider(provider, context)),
    billingNodes: billing.billingNodes.map((node) => adaptBillingNode(node)),
    availableBillingNodes: (billing.availableBillingNodes ?? []).map((node) => ({
      uuid: node.uuid,
      name: node.name,
      countryCode: node.countryCode,
    })),
    stats: {
      upcomingNodesCount: billing.stats?.upcomingNodesCount ?? 0,
      currentMonthPayments: billing.stats?.currentMonthPayments ?? 0,
      totalSpent: billing.stats?.totalSpent ?? 0,
    },
  };
}

// ---- API tokens -------------------------------------------------------------------------------------------------

/** Whole days from `now` to `expiry`, rounded down; negative once the moment has passed. */
export function daysUntil(expiry: Date, now: Date): number {
  return Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);
}

export function adaptApiToken(dto: ApiTokenDtoType, context: AdaptContext): PanelApiTokenView {
  const expireAt = iso(dto.expireAt);
  const view = {
    uuid: dto.uuid,
    name: dto.name,
    scopes: dto.scopes ?? [],
    expireAt,
    daysLeft: daysUntil(new Date(expireAt), context.now ?? new Date()),
    createdAt: iso(dto.createdAt),
    updatedAt: iso(dto.updatedAt),
  };
  return withHash(view, {
    name: view.name,
    scopes: [...view.scopes].sort(),
    expireAt: view.expireAt,
  });
}
