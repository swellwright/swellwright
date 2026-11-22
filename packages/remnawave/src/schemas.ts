import { z } from 'zod';

// What this release reads from a panel of the 3.4 line, as Zod schemas (ADR 0041). They describe the parts of each
// response that the adapters use, taken from the frozen OpenAPI document of 3.4.11 (`spec/`), and are deliberately
// tolerant: an object drops the fields it does not know (a later patch release may add some; they are ignored and never kept in memory),
// a field the adapters can do without is optional, and an enumeration is a string. What a field must be when it is
// there is checked, so a panel that changes the type of something we read fails with a named endpoint and field path
// instead of being half understood. `@remnawave/backend-contract` is not used at run time (ADR 0041 says why); the
// tests feed its schemas and these ones the same responses.

const Uuid = z.uuid();
const Date_ = z.iso.datetime({ offset: true });
/** An opaque JSON value the panel keeps for us (a config, a template, an overrides block). */
const Json = z.unknown();
const nullish = <T extends z.ZodType>(schema: T) => schema.nullish();

const envelope = <T extends z.ZodType>(inner: T) => z.object({ response: inner });

export const InboundDto = z.object({
  uuid: Uuid,
  profileUuid: Uuid,
  tag: z.string(),
  type: z.string(),
  network: nullish(z.string()),
  security: nullish(z.string()),
  port: nullish(z.number()),
  rawInbound: Json.optional(),
});

const NodeIp = z.object({ ip: z.string(), status: z.string() });

export const NodeDto = z.object({
  uuid: Uuid,
  name: z.string(),
  address: z.string(),
  port: nullish(z.number()),
  proxyUrl: nullish(z.string()),
  isConnected: z.boolean(),
  isDisabled: z.boolean(),
  isConnecting: z.boolean(),
  lastStatusChange: nullish(Date_),
  lastStatusMessage: nullish(z.string()),
  isTrafficTrackingActive: z.boolean().optional(),
  trafficResetDay: nullish(z.number()),
  trafficLimitBytes: nullish(z.number()),
  trafficUsedBytes: nullish(z.number()),
  notifyPercent: nullish(z.number()),
  viewPosition: z.number().optional(),
  countryCode: z.string(),
  consumptionMultiplier: z.number().optional(),
  nodeConsumptionMultiplier: z.number().optional(),
  tags: z.array(z.string()).optional(),
  integrationUuids: z.array(Uuid).optional(),
  ips: z.array(NodeIp).optional(),
  createdAt: Date_,
  updatedAt: Date_,
  configProfile: z
    .looseObject({
      activeConfigProfileUuid: nullish(Uuid),
      activeInbounds: z.array(InboundDto).optional(),
    })
    .optional(),
  providerUuid: nullish(Uuid),
  provider: nullish(z.object({ uuid: Uuid, name: z.string() })),
  activePluginUuid: nullish(Uuid),
  system: nullish(
    z.object({
      info: nullish(
        z.object({
          arch: z.string().optional(),
          cpus: z.number().optional(),
          hostname: z.string().optional(),
          platform: z.string().optional(),
          release: z.string().optional(),
        }),
      ),
      stats: nullish(
        z.object({
          memoryFree: z.number().optional(),
          memoryUsed: z.number().optional(),
          uptime: z.number().optional(),
          loadAvg: z.array(z.number()).optional(),
        }),
      ),
    }),
  ),
  versions: nullish(z.object({ xray: z.string().optional(), node: z.string().optional() })),
  xrayUptime: z.number().optional(),
  usersOnline: nullish(z.number()),
  note: nullish(z.string()),
});

export const HostDto = z.object({
  uuid: Uuid,
  viewPosition: z.number().optional(),
  remark: z.string(),
  address: z.string(),
  port: z.number(),
  path: nullish(z.string()),
  sni: nullish(z.string()),
  host: nullish(z.string()),
  alpn: nullish(z.string()),
  fingerprint: nullish(z.string()),
  isDisabled: z.boolean(),
  securityLayer: z.string().optional(),
  xhttpExtraParams: Json.optional(),
  muxParams: Json.optional(),
  sockoptParams: Json.optional(),
  finalMask: Json.optional(),
  inbound: z
    .looseObject({ configProfileUuid: nullish(Uuid), configProfileInboundUuid: nullish(Uuid) })
    .optional(),
  serverDescription: nullish(z.string()),
  tags: z.array(z.string()).optional(),
  isHidden: z.boolean().optional(),
  overrideSniFromAddress: z.boolean().optional(),
  keepSniBlank: z.boolean().optional(),
  vlessRouteId: nullish(z.number()),
  pinnedPeerCertSha256: nullish(z.string()),
  verifyPeerCertByName: nullish(z.string()),
  shuffleHost: z.boolean().optional(),
  mihomoX25519: z.boolean().optional(),
  mihomoIpVersion: nullish(z.string()),
  nodes: z.array(Uuid).optional(),
  xrayJsonTemplateUuid: nullish(Uuid),
  excludeFromSubscriptionTypes: z.array(z.string()).optional(),
  mapper: Json.optional(),
  includeInSrrRules: z.array(z.string()).optional(),
  internalSquads: nullish(z.object({ mode: z.string(), squads: z.array(Uuid) })),
});

const ProfileNode = z.object({ uuid: Uuid, name: z.string(), countryCode: z.string() });

export const ConfigProfileDto = z.object({
  uuid: Uuid,
  viewPosition: z.number().optional(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  config: Json,
  inbounds: z.array(InboundDto).optional(),
  nodes: z.array(ProfileNode).optional(),
  createdAt: Date_,
  updatedAt: Date_,
});

export const InternalSquadDto = z.object({
  uuid: Uuid,
  viewPosition: z.number().optional(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  info: z
    .looseObject({ membersCount: z.number().optional(), inboundsCount: z.number().optional() })
    .optional(),
  inbounds: z.array(InboundDto).optional(),
  createdAt: Date_,
  updatedAt: Date_,
});

const HwidSettings = z.object({
  enabled: z.boolean().optional(),
  fallbackDeviceLimit: z.number().optional(),
  maxDevicesAnnounce: nullish(z.string()),
});

const CustomRemarks = z.record(z.string(), z.array(z.string()));

export const ExternalSquadDto = z.object({
  uuid: Uuid,
  viewPosition: z.number().optional(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  info: z.object({ membersCount: z.number().optional() }).optional(),
  templates: z.array(z.object({ templateUuid: Uuid, templateType: z.string() })).optional(),
  subscriptionSettings: nullish(
    z.object({
      serveJsonAtBaseSubscription: nullish(z.boolean()),
      isShowCustomRemarks: nullish(z.boolean()),
      randomizeHosts: nullish(z.boolean()),
    }),
  ),
  hostOverrides: nullish(
    z.object({ serverDescription: nullish(z.string()), vlessRouteId: nullish(z.number()) }),
  ),
  responseHeadersAdd: nullish(z.record(z.string(), z.string())),
  responseHeadersRemove: z.array(z.string()).optional(),
  hwidSettings: nullish(HwidSettings),
  customRemarks: nullish(CustomRemarks),
  subpageConfigUuid: nullish(Uuid),
  createdAt: Date_,
  updatedAt: Date_,
});

export const SubscriptionTemplateDto = z.object({
  uuid: Uuid,
  viewPosition: z.number().optional(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  templateType: z.string(),
  templateJson: Json.optional(),
  encodedTemplateYaml: nullish(z.string()),
});

export const SubscriptionSettingsDto = z.object({
  uuid: Uuid,
  serveJsonAtBaseSubscription: z.boolean().optional(),
  isShowCustomRemarks: z.boolean().optional(),
  customRemarks: nullish(CustomRemarks),
  customResponseHeaders: nullish(z.record(z.string(), z.string())),
  randomizeHosts: z.boolean().optional(),
  responseRules: Json.optional(),
  hwidSettings: nullish(HwidSettings),
  createdAt: Date_,
  updatedAt: Date_,
});

export const SnippetDto = z.object({ name: z.string(), snippet: Json });

export const NodePluginDto = z.object({
  uuid: Uuid,
  viewPosition: z.number().optional(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  pluginConfig: Json.optional(),
});

export const InfraProviderDto = z.object({
  uuid: Uuid,
  name: z.string(),
  faviconLink: nullish(z.string()),
  loginUrl: nullish(z.string()),
  createdAt: Date_,
  updatedAt: Date_,
  billingHistory: z
    .looseObject({ totalAmount: z.number().optional(), totalBills: z.number().optional() })
    .optional(),
  billingNodes: z
    .array(
      z.object({
        name: z.string(),
        details: z.object({ nodeUuid: Uuid, countryCode: z.string() }),
      }),
    )
    .optional(),
});

export const BillingNodeDto = z.object({
  uuid: Uuid,
  nodeUuid: nullish(Uuid),
  name: nullish(z.string()),
  providerUuid: Uuid.optional(),
  provider: z.object({ uuid: Uuid, name: z.string() }),
  node: nullish(z.object({ uuid: Uuid, name: z.string(), countryCode: z.string() })),
  nextBillingAt: Date_,
});

export const ApiTokenDto = z.object({
  uuid: Uuid,
  name: z.string(),
  expireAt: Date_,
  scopes: z.array(z.string()).optional(),
  createdAt: Date_,
  updatedAt: Date_,
});

// ---- the envelopes of the endpoints ----------------------------------------------------------------------------

export const MetadataResponse = envelope(
  z.object({
    version: z.string(),
    build: z.looseObject({ time: nullish(z.string()), number: nullish(z.string()) }).optional(),
  }),
);

export const HealthResponse = envelope(
  z.object({
    runtimeMetrics: z
      .array(z.object({ uptime: z.number().optional(), instanceId: z.string().optional() }))
      .optional(),
  }),
);

export const ConfigurationResponse = envelope(
  z.object({
    notifications: nullish(z.object({ webhook: z.boolean().optional() })),
    service: nullish(
      z.object({
        cleanUsageHistory: z.boolean().optional(),
        disableUserUsageRecords: z.boolean().optional(),
      }),
    ),
    misc: nullish(
      z.object({
        shortUuidLength: z.number().optional(),
        subPublicDomain: z.string().optional(),
      }),
    ),
  }),
);

export const StatsResponse = envelope(
  z.object({
    uptime: z.number().optional(),
    users: nullish(
      z.object({
        statusCounts: z.record(z.string(), z.number()).optional(),
        totalUsers: z.number().optional(),
      }),
    ),
    onlineStats: nullish(z.object({ onlineNow: z.number().optional() })),
  }),
);

export const NodesResponse = envelope(z.array(NodeDto));
export const HostsResponse = envelope(z.array(HostDto));
export const ConfigProfilesResponse = envelope(
  z.object({ total: z.number().optional(), configProfiles: z.array(ConfigProfileDto) }),
);
export const ConfigProfileResponse = envelope(ConfigProfileDto);
export const InternalSquadsResponse = envelope(
  z.object({ total: z.number().optional(), internalSquads: z.array(InternalSquadDto) }),
);
export const ExternalSquadsResponse = envelope(
  z.object({ total: z.number().optional(), externalSquads: z.array(ExternalSquadDto) }),
);
export const SubscriptionTemplatesResponse = envelope(
  z.object({ total: z.number().optional(), templates: z.array(SubscriptionTemplateDto) }),
);
export const SubscriptionSettingsResponse = envelope(SubscriptionSettingsDto);
export const SnippetsResponse = envelope(
  z.object({ total: z.number().optional(), snippets: z.array(SnippetDto) }),
);
export const NodePluginsResponse = envelope(
  z.object({ total: z.number().optional(), nodePlugins: z.array(NodePluginDto) }),
);
export const InfraProvidersResponse = envelope(
  z.object({ total: z.number().optional(), providers: z.array(InfraProviderDto) }),
);
export const BillingNodesResponse = envelope(
  z.object({
    billingNodes: z.array(BillingNodeDto),
    availableBillingNodes: z
      .array(z.object({ uuid: Uuid, name: z.string(), countryCode: z.string() }))
      .optional(),
    stats: nullish(
      z.object({
        upcomingNodesCount: z.number().optional(),
        currentMonthPayments: z.number().optional(),
        totalSpent: z.number().optional(),
      }),
    ),
  }),
);
export const ApiTokensResponse = envelope(z.object({ tokens: z.array(ApiTokenDto) }));
export const BillingRecordsResponse = envelope(
  z.object({
    records: z.array(
      z.object({
        uuid: Uuid,
        providerUuid: Uuid,
        amount: z.number(),
        billedAt: Date_,
      }),
    ),
    total: z.number(),
  }),
);

export type NodeDtoType = z.infer<typeof NodeDto>;
export type HostDtoType = z.infer<typeof HostDto>;
export type InboundDtoType = z.infer<typeof InboundDto>;
export type ConfigProfileDtoType = z.infer<typeof ConfigProfileDto>;
export type InternalSquadDtoType = z.infer<typeof InternalSquadDto>;
export type ExternalSquadDtoType = z.infer<typeof ExternalSquadDto>;
export type SubscriptionTemplateDtoType = z.infer<typeof SubscriptionTemplateDto>;
export type SubscriptionSettingsDtoType = z.infer<typeof SubscriptionSettingsDto>;
export type SnippetDtoType = z.infer<typeof SnippetDto>;
export type NodePluginDtoType = z.infer<typeof NodePluginDto>;
export type InfraProviderDtoType = z.infer<typeof InfraProviderDto>;
export type BillingNodeDtoType = z.infer<typeof BillingNodeDto>;
export type ApiTokenDtoType = z.infer<typeof ApiTokenDto>;
