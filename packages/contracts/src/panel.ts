import { z } from 'zod';

// The connection to a Remnawave panel and what is read from it (ADR 0040). Everything here is a normalised view
// that Swellwright owns: it does not repeat the panel's DTOs, so a change of the panel moves one adapter and not the
// console. Nothing in a view can be a secret: the adapters of `@swellwright/remnawave` mask keys, short ids, passwords
// and credentials in URLs before a value gets here, and every object carries a hash of its masked content.

/** The versions of the panel that this release is built and tested against (ADR 0040): the 3.4 line. */
export const PANEL_SUPPORTED_RANGE = '3.4.x';

export const PANEL_CONNECTION_STATES = [
  'unconfigured',
  'connected',
  'degraded',
  'unreachable',
  'unauthorized',
  'unsupported',
] as const;
export const PanelConnectionStateSchema = z.enum(PANEL_CONNECTION_STATES).meta({
  id: 'PanelConnectionState',
  description:
    '`unconfigured`: no panel connected. `connected`: reachable, the token works, the version is supported and every resource can be read. `degraded`: it works, but the token cannot read some resources or expires soon. `unreachable`: the panel did not answer (network, TLS, timeout, 5xx). `unauthorized`: the panel refused the token (expired, revoked or wrong). `unsupported`: the version is outside the supported window or the panel answers in a shape this release does not know.',
});
export type PanelConnectionState = z.infer<typeof PanelConnectionStateSchema>;

/** The kinds of panel object this release reads, in the order the console shows them. */
export const PANEL_RESOURCES = [
  'system',
  'nodes',
  'hosts',
  'configProfiles',
  'internalSquads',
  'externalSquads',
  'subscriptionTemplates',
  'subscriptionSettings',
  'snippets',
  'nodePlugins',
  'infra',
  'apiTokens',
] as const;
export const PanelResourceSchema = z.enum(PANEL_RESOURCES).meta({ id: 'PanelResource' });
export type PanelResource = z.infer<typeof PanelResourceSchema>;

export const PANEL_CAPABILITY_STATES = ['ok', 'denied', 'failed'] as const;
export const PanelCapabilityStateSchema = z.enum(PANEL_CAPABILITY_STATES).meta({
  id: 'PanelCapabilityState',
  description:
    '`ok`: the token can read it. `denied`: the panel answered 403, the token has no scope for it. `failed`: the read failed for another reason (see `lastError`).',
});
export type PanelCapabilityState = z.infer<typeof PanelCapabilityStateSchema>;

export const PanelCapabilitiesSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    resources: z.record(PanelResourceSchema, PanelCapabilityStateSchema),
  })
  .meta({
    id: 'PanelCapabilities',
    description:
      'What the token can read, found by reading each resource once. The panel does not allow an API token to list API tokens, so `apiTokens` is normally `denied`.',
  });
export type PanelCapabilities = z.infer<typeof PanelCapabilitiesSchema>;

export const PanelVersionSupportSchema = z
  .object({
    status: z.enum(['supported', 'unsupported']),
    range: z.string().describe('The window this release supports.'),
    reason: z.string().nullable().describe('Why it is unsupported; null when supported.'),
  })
  .meta({ id: 'PanelVersionSupport' });
export type PanelVersionSupport = z.infer<typeof PanelVersionSupportSchema>;

/** How many days before the expiry of its token a connection starts to warn (docs/en/design/05-security.md). */
export const PANEL_TOKEN_WARNING_DAYS = 14;

export const PanelTokenInfoSchema = z
  .object({
    secretId: z.uuid().describe('The vault secret (kind `panel_token`) that holds the token.'),
    secretName: z.string(),
    expiresAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'Read from the token itself when it is a signed token with an expiry claim; null when it carries none. The token is never returned.',
      ),
    daysLeft: z.number().int().nullable().describe('Negative once it has expired.'),
    expiryWarning: z
      .boolean()
      .describe(`True from ${String(PANEL_TOKEN_WARNING_DAYS)} days before the expiry on.`),
  })
  .meta({ id: 'PanelTokenInfo' });
export type PanelTokenInfo = z.infer<typeof PanelTokenInfoSchema>;

export const PanelWarningSchema = z
  .object({
    code: z.enum(['token_expiring', 'capabilities_limited']),
    message: z.string(),
  })
  .meta({ id: 'PanelWarning' });
export type PanelWarning = z.infer<typeof PanelWarningSchema>;

export const PanelLastErrorSchema = z
  .object({ code: z.string(), message: z.string() })
  .meta({ id: 'PanelLastError' });
export type PanelLastError = z.infer<typeof PanelLastErrorSchema>;

export const PanelConnectionViewSchema = z
  .object({
    state: PanelConnectionStateSchema,
    baseUrl: z.string().nullable(),
    panelVersion: z.string().nullable(),
    versionSupport: PanelVersionSupportSchema.nullable(),
    capabilities: PanelCapabilitiesSchema.nullable(),
    token: PanelTokenInfoSchema.nullable(),
    warnings: z.array(PanelWarningSchema),
    lastCheckedAt: z.iso.datetime().nullable(),
    lastError: PanelLastErrorSchema.nullable(),
    trustedCa: z
      .boolean()
      .describe('A certificate authority of its own is configured for this panel (not a secret).'),
    createdAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({
    id: 'PanelConnectionView',
    description:
      'The connection to the panel. Never carries the token: it names the vault secret that holds it.',
  });
export type PanelConnectionView = z.infer<typeof PanelConnectionViewSchema>;

const PanelBaseUrl = z
  .string()
  .trim()
  .min(8)
  .max(2048)
  .describe(
    'The address of the panel, for example `https://panel.example.com`. https only (plain http only for a loopback or private address when `SW_PANEL_ALLOW_HTTP` is on), no credentials, query or fragment. A path is allowed for a panel behind a prefix; the API itself is `/api/...` under it.',
  );

const TrustedCa = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .nullable()
  .optional()
  .describe(
    'PEM text of a certificate authority to trust for this panel (a private CA or a self-signed certificate). Public material, not a secret. `null` removes it. Without it the system trust store is used.',
  );

export const ConnectPanelRequestSchema = z
  .object({
    baseUrl: PanelBaseUrl,
    tokenSecretId: z
      .uuid()
      .describe('A vault secret of kind `panel_token` with the API token of the panel.'),
    trustedCa: TrustedCa,
  })
  .meta({
    id: 'ConnectPanelRequest',
    description:
      'Connects to the panel with a token that is in the vault already. The panel is asked first; nothing is stored when it refuses.',
  });
export type ConnectPanelRequest = z.infer<typeof ConnectPanelRequestSchema>;

export const ConnectPanelWithTokenRequestSchema = z
  .object({
    baseUrl: PanelBaseUrl,
    token: z
      .string()
      .trim()
      .min(16)
      .max(4096)
      .describe('The API token as the panel showed it. Stored in the vault, never returned.'),
    secretName: z.string().trim().min(1).max(100).describe('The name of the new vault secret.'),
    trustedCa: TrustedCa,
  })
  .meta({
    id: 'ConnectPanelWithTokenRequest',
    description:
      'The wizard path for a token that is not in the vault yet: the panel is asked with it first, and only when it answers is the token stored (kind `panel_token`) and the connection saved, in one transaction.',
  });
export type ConnectPanelWithTokenRequest = z.infer<typeof ConnectPanelWithTokenRequestSchema>;

export const PanelTestResultSchema = z
  .object({
    ok: z.boolean().describe('True when the state is `connected` or `degraded`.'),
    connection: PanelConnectionViewSchema,
    latencyMs: z.number().int().nonnegative(),
  })
  .meta({
    id: 'PanelTestResult',
    description:
      'The outcome of a connection test. A panel that does not answer is a result (`ok: false` and the state), not an error.',
  });
export type PanelTestResult = z.infer<typeof PanelTestResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Read views. Every object has `hash`: the SHA-256 of the canonical JSON of its masked, normalised content, without
// the fields that change on their own (online state, counters). Two reads with the same hash are the same object.

const Hash = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .describe(
    'SHA-256 (hex) of the canonical JSON of the masked configuration of this object; runtime state is not part of it. Stable between reads and safe to show.',
  );
const Uuid = z.uuid();
const Iso = z.iso.datetime();
const Opaque = z
  .unknown()
  .describe('JSON as the panel keeps it, with every secret in it replaced by a mask.');

export const PanelInboundViewSchema = z
  .object({
    uuid: Uuid,
    profileUuid: Uuid,
    tag: z.string(),
    type: z.string().describe('The Xray protocol (`vless`, `trojan`, ...).'),
    network: z.string().nullable(),
    security: z.string().nullable(),
    port: z.number().int().nullable(),
    raw: Opaque.optional().describe('The raw inbound; only on the detail of a profile.'),
  })
  .meta({ id: 'PanelInboundView' });
export type PanelInboundView = z.infer<typeof PanelInboundViewSchema>;

export const PANEL_NODE_STATES = ['online', 'connecting', 'offline', 'disabled'] as const;
export const PanelNodeStateSchema = z.enum(PANEL_NODE_STATES).meta({ id: 'PanelNodeState' });
export type PanelNodeState = z.infer<typeof PanelNodeStateSchema>;

export const PanelNodeViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    address: z.string(),
    port: z.number().int().nullable(),
    countryCode: z.string(),
    state: PanelNodeStateSchema,
    isConnected: z.boolean(),
    isConnecting: z.boolean(),
    isDisabled: z.boolean(),
    lastStatusChange: Iso.nullable(),
    lastStatusMessage: z.string().nullable(),
    xrayVersion: z.string().nullable(),
    nodeVersion: z.string().nullable(),
    xrayUptimeSeconds: z.number().nullable(),
    usersOnline: z.number().int().nullable(),
    configProfile: z.object({
      uuid: Uuid.nullable(),
      inbounds: z.array(z.object({ uuid: Uuid, tag: z.string() })),
    }),
    tags: z.array(z.string()),
    provider: z.object({ uuid: Uuid, name: z.string() }).nullable(),
    activePluginUuid: Uuid.nullable(),
    integrationUuids: z.array(Uuid),
    ips: z.array(z.object({ ip: z.string(), status: z.string() })),
    proxyUrl: z.string().nullable().describe('With the credentials in it, if any, masked.'),
    traffic: z.object({
      trackingActive: z.boolean(),
      usedBytes: z.number().nullable(),
      limitBytes: z.number().nullable(),
      resetDay: z.number().int().nullable(),
      notifyPercent: z.number().int().nullable(),
    }),
    consumptionMultiplier: z.number(),
    nodeConsumptionMultiplier: z.number(),
    viewPosition: z.number().int(),
    note: z.string().nullable(),
    system: z
      .object({
        hostname: z.string().nullable(),
        platform: z.string().nullable(),
        release: z.string().nullable(),
        arch: z.string().nullable(),
        cpus: z.number().int().nullable(),
        memoryTotal: z.number().nullable(),
        memoryUsed: z.number().nullable(),
        uptimeSeconds: z.number().nullable(),
        loadAvg: z.array(z.number()),
      })
      .nullable(),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({ id: 'PanelNodeView' });
export type PanelNodeView = z.infer<typeof PanelNodeViewSchema>;

export const PanelHostViewSchema = z
  .object({
    uuid: Uuid,
    viewPosition: z.number().int(),
    remark: z.string(),
    address: z.string(),
    port: z.number().int(),
    path: z.string().nullable(),
    sni: z.string().nullable(),
    host: z.string().nullable(),
    alpn: z.string().nullable(),
    fingerprint: z.string().nullable(),
    isDisabled: z.boolean(),
    isHidden: z.boolean(),
    securityLayer: z.string(),
    inbound: z.object({
      configProfileUuid: Uuid.nullable(),
      configProfileInboundUuid: Uuid.nullable(),
    }),
    nodeUuids: z.array(Uuid),
    tags: z.array(z.string()),
    serverDescription: z.string().nullable(),
    overrideSniFromAddress: z.boolean(),
    keepSniBlank: z.boolean(),
    vlessRouteId: z.number().int().nullable(),
    pinnedPeerCertSha256: z.string().nullable(),
    verifyPeerCertByName: z.string().nullable(),
    shuffleHost: z.boolean(),
    mihomoX25519: z.boolean(),
    mihomoIpVersion: z.string().nullable(),
    xrayJsonTemplateUuid: Uuid.nullable(),
    excludeFromSubscriptionTypes: z.array(z.string()),
    includeInSrrRules: z.array(z.string()),
    internalSquads: z.object({ mode: z.string(), squadUuids: z.array(Uuid) }),
    xhttpExtraParams: Opaque,
    muxParams: Opaque,
    sockoptParams: Opaque,
    finalMask: Opaque,
    mapper: Opaque,
    hash: Hash,
  })
  .meta({ id: 'PanelHostView' });
export type PanelHostView = z.infer<typeof PanelHostViewSchema>;

export const PanelConfigProfileSummarySchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    viewPosition: z.number().int(),
    tags: z.array(z.string()),
    inbounds: z.array(PanelInboundViewSchema),
    nodes: z.array(z.object({ uuid: Uuid, name: z.string(), countryCode: z.string() })),
    nodeCount: z.number().int().nonnegative(),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({
    id: 'PanelConfigProfileSummary',
    description:
      'A config profile without its Xray configuration (the list does not carry it); `hash` covers the masked configuration all the same.',
  });
export type PanelConfigProfileSummary = z.infer<typeof PanelConfigProfileSummarySchema>;

export const PanelConfigProfileViewSchema = PanelConfigProfileSummarySchema.extend({
  config: Opaque,
  masked: z
    .number()
    .int()
    .nonnegative()
    .describe('How many values were replaced by a mask in `config` and the raw inbounds.'),
}).meta({
  id: 'PanelConfigProfileView',
  description:
    'A config profile with its Xray configuration as JSON. Private keys, short ids, passwords, client ids and credentials in URLs are replaced by `[masked:xxxxxxxx]`, where the eight characters are a keyed fingerprint (the same value gives the same fingerprint, so a rotation shows as a change).',
});
export type PanelConfigProfileView = z.infer<typeof PanelConfigProfileViewSchema>;

export const PanelInternalSquadViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    viewPosition: z.number().int(),
    tags: z.array(z.string()),
    membersCount: z.number().int().nonnegative(),
    inboundsCount: z.number().int().nonnegative(),
    inbounds: z.array(PanelInboundViewSchema),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({ id: 'PanelInternalSquadView' });
export type PanelInternalSquadView = z.infer<typeof PanelInternalSquadViewSchema>;

export const PanelExternalSquadViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    viewPosition: z.number().int(),
    tags: z.array(z.string()),
    membersCount: z.number().int().nonnegative(),
    templates: z.array(z.object({ templateUuid: Uuid, templateType: z.string() })),
    subscriptionSettings: z.object({
      serveJsonAtBaseSubscription: z.boolean().nullable(),
      isShowCustomRemarks: z.boolean().nullable(),
      randomizeHosts: z.boolean().nullable(),
    }),
    hostOverrides: z.object({
      serverDescription: z.string().nullable(),
      vlessRouteId: z.number().int().nullable(),
    }),
    responseHeadersAdd: z
      .record(z.string(), z.string())
      .describe('Values of headers that carry credentials are masked.'),
    responseHeadersRemove: z.array(z.string()),
    hwidSettings: z.object({
      enabled: z.boolean(),
      fallbackDeviceLimit: z.number(),
      maxDevicesAnnounce: z.string().nullable(),
    }),
    customRemarks: z.record(z.string(), z.array(z.string())),
    subpageConfigUuid: Uuid.nullable(),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({ id: 'PanelExternalSquadView' });
export type PanelExternalSquadView = z.infer<typeof PanelExternalSquadViewSchema>;

export const PanelSubscriptionTemplateViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    viewPosition: z.number().int(),
    tags: z.array(z.string()),
    templateType: z.string(),
    templateJson: Opaque.nullable(),
    templateYaml: z
      .string()
      .nullable()
      .describe(
        'The YAML body, decoded and read back from its parsed form with every secret masked (comments are dropped). Null when the template has none or it could not be read.',
      ),
    hash: Hash,
  })
  .meta({ id: 'PanelSubscriptionTemplateView' });
export type PanelSubscriptionTemplateView = z.infer<typeof PanelSubscriptionTemplateViewSchema>;

export const PanelSubscriptionSettingsViewSchema = z
  .object({
    uuid: Uuid,
    serveJsonAtBaseSubscription: z.boolean(),
    isShowCustomRemarks: z.boolean(),
    randomizeHosts: z.boolean(),
    customRemarks: z.record(z.string(), z.array(z.string())),
    customResponseHeaders: z.record(z.string(), z.string()),
    responseRules: Opaque,
    hwidSettings: z.object({
      enabled: z.boolean(),
      fallbackDeviceLimit: z.number(),
      maxDevicesAnnounce: z.string().nullable(),
    }),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({ id: 'PanelSubscriptionSettingsView' });
export type PanelSubscriptionSettingsView = z.infer<typeof PanelSubscriptionSettingsViewSchema>;

export const PanelSnippetViewSchema = z
  .object({ name: z.string(), snippet: Opaque, hash: Hash })
  .meta({ id: 'PanelSnippetView' });
export type PanelSnippetView = z.infer<typeof PanelSnippetViewSchema>;

export const PanelNodePluginViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    viewPosition: z.number().int(),
    tags: z.array(z.string()),
    pluginConfig: Opaque.nullable(),
    hash: Hash,
  })
  .meta({ id: 'PanelNodePluginView' });
export type PanelNodePluginView = z.infer<typeof PanelNodePluginViewSchema>;

export const PanelInfraProviderViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    loginUrl: z.string().nullable(),
    faviconLink: z.string().nullable(),
    totalAmount: z.number(),
    totalBills: z.number().int(),
    nodes: z.array(z.object({ name: z.string(), nodeUuid: Uuid, countryCode: z.string() })),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({ id: 'PanelInfraProviderView' });
export type PanelInfraProviderView = z.infer<typeof PanelInfraProviderViewSchema>;

export const PanelBillingNodeViewSchema = z
  .object({
    uuid: Uuid,
    nodeUuid: Uuid.nullable(),
    name: z.string().nullable(),
    provider: z.object({ uuid: Uuid, name: z.string() }),
    node: z.object({ uuid: Uuid, name: z.string(), countryCode: z.string() }).nullable(),
    nextBillingAt: Iso,
    hash: Hash,
  })
  .meta({ id: 'PanelBillingNodeView' });
export type PanelBillingNodeView = z.infer<typeof PanelBillingNodeViewSchema>;

export const PanelInfraViewSchema = z
  .object({
    providers: z.array(PanelInfraProviderViewSchema),
    billingNodes: z.array(PanelBillingNodeViewSchema),
    availableBillingNodes: z.array(
      z.object({ uuid: Uuid, name: z.string(), countryCode: z.string() }),
    ),
    stats: z.object({
      upcomingNodesCount: z.number().int(),
      currentMonthPayments: z.number(),
      totalSpent: z.number(),
    }),
  })
  .meta({ id: 'PanelInfraView' });
export type PanelInfraView = z.infer<typeof PanelInfraViewSchema>;

export const PanelApiTokenViewSchema = z
  .object({
    uuid: Uuid,
    name: z.string(),
    scopes: z.array(z.string()),
    expireAt: Iso,
    daysLeft: z.number().int(),
    createdAt: Iso,
    updatedAt: Iso,
    hash: Hash,
  })
  .meta({
    id: 'PanelApiTokenView',
    description:
      'A token of the panel by name, scopes and expiry. The value of a token is never read.',
  });
export type PanelApiTokenView = z.infer<typeof PanelApiTokenViewSchema>;

/** What every list answer carries besides the items. */
const listMeta = {
  fetchedAt: Iso.describe('When the panel was asked.'),
  cached: z
    .boolean()
    .describe('True when the answer comes from the short-lived memory of this server.'),
};

export const PanelNodeListSchema = z
  .object({ nodes: z.array(PanelNodeViewSchema), ...listMeta })
  .meta({ id: 'PanelNodeList' });
export const PanelHostListSchema = z
  .object({ hosts: z.array(PanelHostViewSchema), ...listMeta })
  .meta({ id: 'PanelHostList' });
export const PanelConfigProfileListSchema = z
  .object({ configProfiles: z.array(PanelConfigProfileSummarySchema), ...listMeta })
  .meta({ id: 'PanelConfigProfileList' });
export const PanelInternalSquadListSchema = z
  .object({ internalSquads: z.array(PanelInternalSquadViewSchema), ...listMeta })
  .meta({ id: 'PanelInternalSquadList' });
export const PanelExternalSquadListSchema = z
  .object({ externalSquads: z.array(PanelExternalSquadViewSchema), ...listMeta })
  .meta({ id: 'PanelExternalSquadList' });
export const PanelSubscriptionTemplateListSchema = z
  .object({ templates: z.array(PanelSubscriptionTemplateViewSchema), ...listMeta })
  .meta({ id: 'PanelSubscriptionTemplateList' });
export const PanelSnippetListSchema = z
  .object({ snippets: z.array(PanelSnippetViewSchema), ...listMeta })
  .meta({ id: 'PanelSnippetList' });
export const PanelNodePluginListSchema = z
  .object({ nodePlugins: z.array(PanelNodePluginViewSchema), ...listMeta })
  .meta({ id: 'PanelNodePluginList' });
export const PanelInfraAnswerSchema = z
  .object({ infra: PanelInfraViewSchema, ...listMeta })
  .meta({ id: 'PanelInfraAnswer' });
export const PanelApiTokenListSchema = z
  .object({ apiTokens: z.array(PanelApiTokenViewSchema), ...listMeta })
  .meta({ id: 'PanelApiTokenList' });
export const PanelSubscriptionSettingsAnswerSchema = z
  .object({ subscriptionSettings: PanelSubscriptionSettingsViewSchema, ...listMeta })
  .meta({ id: 'PanelSubscriptionSettingsAnswer' });
export const PanelConfigProfileAnswerSchema = z
  .object({ configProfile: PanelConfigProfileViewSchema, ...listMeta })
  .meta({ id: 'PanelConfigProfileAnswer' });

export type PanelNodeList = z.infer<typeof PanelNodeListSchema>;
export type PanelHostList = z.infer<typeof PanelHostListSchema>;
export type PanelConfigProfileList = z.infer<typeof PanelConfigProfileListSchema>;
export type PanelInternalSquadList = z.infer<typeof PanelInternalSquadListSchema>;
export type PanelExternalSquadList = z.infer<typeof PanelExternalSquadListSchema>;
export type PanelSubscriptionTemplateList = z.infer<typeof PanelSubscriptionTemplateListSchema>;
export type PanelSnippetList = z.infer<typeof PanelSnippetListSchema>;
export type PanelNodePluginList = z.infer<typeof PanelNodePluginListSchema>;
export type PanelInfraAnswer = z.infer<typeof PanelInfraAnswerSchema>;
export type PanelApiTokenList = z.infer<typeof PanelApiTokenListSchema>;
export type PanelSubscriptionSettingsAnswer = z.infer<typeof PanelSubscriptionSettingsAnswerSchema>;
export type PanelConfigProfileAnswer = z.infer<typeof PanelConfigProfileAnswerSchema>;

export const PanelReadQuerySchema = z.object({
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'true: ask the panel again instead of answering from the memory of this server. Rate limited per user.',
    ),
});

export const PanelProfileParamsSchema = z.object({ uuid: z.uuid() });

const Count = z.number().int().nonnegative();

export const PanelOverviewSchema = z
  .object({
    connection: z.object({
      state: PanelConnectionStateSchema,
      baseUrl: z.string(),
      panelVersion: z.string().nullable(),
      versionSupport: PanelVersionSupportSchema.nullable(),
    }),
    system: z
      .object({
        version: z.string(),
        build: z.object({ time: z.string().nullable(), number: z.string().nullable() }),
        health: z
          .enum(['ok', 'unknown'])
          .describe('`ok`: the health endpoint answered and listed the instances of the panel.'),
        instances: Count.describe('Processes of the panel that reported in the health answer.'),
        uptimeSeconds: z.number().nullable(),
      })
      .nullable(),
    counts: z.object({
      nodes: Count.nullable(),
      hosts: Count.nullable(),
      configProfiles: Count.nullable(),
      internalSquads: Count.nullable(),
      externalSquads: Count.nullable(),
      subscriptionTemplates: Count.nullable(),
      snippets: Count.nullable(),
      nodePlugins: Count.nullable(),
    }),
    nodes: z
      .object({ online: Count, connecting: Count, offline: Count, disabled: Count })
      .nullable(),
    users: z
      .object({
        total: Count,
        byStatus: z.record(z.string(), Count),
        onlineNow: Count.nullable(),
      })
      .nullable()
      .describe('Counts only; no personal data of any user is read in this release.'),
    token: PanelTokenInfoSchema.nullable(),
    warnings: z.array(PanelWarningSchema),
    fetchedAt: Iso,
  })
  .meta({ id: 'PanelOverview' });
export type PanelOverview = z.infer<typeof PanelOverviewSchema>;
