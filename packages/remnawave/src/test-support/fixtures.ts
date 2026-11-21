// Synthetic panel objects for the fake panel and the tests (ADR 0040). Everything here is made up: documentation
// names (`example.com`), documentation addresses (`192.0.2.x`, `198.51.100.x`), identifiers from a counter, and
// secrets that say they are fake. No value comes from any real panel.

/** Every secret the fixtures hold. A test asserts that none of them is ever returned by the API or recorded. */
export const FAKE_SECRETS = {
  realityPrivateKey: 'FAKE-SECRET-REALITY-PRIVATE-KEY-0001',
  shortIds: ['FAKE-SECRET-SHORTID-0001', 'FAKE-SECRET-SHORTID-0002'],
  realityPrivateKeyInbound: 'FAKE-SECRET-INBOUND-PRIVATE-KEY-0002',
  clientId: '11111111-2222-4333-8444-555555555555',
  localProxyPassword: 'FAKE-SECRET-LOCAL-PROXY-PASSWORD',
  localProxyUser: 'fake-secret-local-proxy-user',
  hostMaskPassword: 'FAKE-SECRET-HOST-MASK-PASSWORD',
  hostMapperToken: 'FAKE-SECRET-HOST-MAPPER-TOKEN',
  yamlShortId: 'FAKE-SECRET-YAML-SHORTID',
  yamlPassword: 'FAKE-SECRET-YAML-PASSWORD',
  snippetPassword: 'FAKE-SECRET-SNIPPET-PASSWORD',
  pluginSecret: 'FAKE-SECRET-PLUGIN-WEBHOOK-TOKEN',
  headerAuthorization: 'Bearer FAKE-SECRET-HEADER-AUTHORIZATION',
  proxyUserinfo: 'fakeproxyuser:FAKE-SECRET-PROXY-PASSWORD',
  ageKey: 'FAKE-SECRET-AGE-KEY-0001',
} as const;

export const FAKE_TOKEN = 'fake-panel-token-0000000000000000000000000000';
export const FAKE_PANEL_VERSION = '3.4.11';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T12:30:00.000Z';

export type Json = Record<string, unknown>;

/** The panel wants at least one line in each list of custom remarks. */
const REMARKS = {
  expiredUsers: ['Expired'],
  limitedUsers: ['Limited'],
  disabledUsers: ['Disabled'],
  emptyHosts: ['No hosts'],
  HWIDMaxDevicesExceeded: ['Too many devices'],
  HWIDNotSupported: ['No device id'],
};

/** The objects the fake panel serves. Tests change them to make the panel say something else. */
export interface PanelFixtures {
  readonly metadata: Json;
  readonly health: Json;
  readonly configuration: Json;
  readonly stats: Json;
  nodes: Json[];
  hosts: Json[];
  configProfiles: Json[];
  internalSquads: Json[];
  externalSquads: Json[];
  templates: Json[];
  subscriptionSettings: Json;
  snippets: Json[];
  nodePlugins: Json[];
  providers: Json[];
  billingNodes: Json[];
  billingRecords: Json[];
  apiTokens: Json[];
}

/** `00000000-0000-4000-8000-0000000000NN`: valid version 4 UUIDs that say they are made up. */
export function fakeUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export interface FixtureOptions {
  readonly version?: string;
  /** How many extra nodes and hosts to add on top of the three of each (large lists). */
  readonly extraNodes?: number;
  readonly extraHosts?: number;
}

function xrayConfig(): Json {
  return {
    log: { loglevel: 'warning' },
    dns: { servers: ['1.1.1.1'], queryStrategy: 'UseIPv4' },
    inbounds: [
      {
        tag: 'VLESS_REALITY_MAIN',
        port: 443,
        protocol: 'vless',
        settings: {
          clients: [
            {
              id: FAKE_SECRETS.clientId,
              flow: 'xtls-rprx-vision',
              email: 'fake-client@example.com',
            },
          ],
          decryption: 'none',
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
        streamSettings: {
          network: 'raw',
          security: 'reality',
          realitySettings: {
            show: false,
            target: '127.0.0.1:8443',
            xver: 0,
            serverNames: ['node-1.example.com'],
            privateKey: FAKE_SECRETS.realityPrivateKey,
            shortIds: [...FAKE_SECRETS.shortIds, ''],
          },
        },
      },
      {
        tag: 'VLESS_REALITY_SECOND',
        port: 8443,
        protocol: 'vless',
        settings: { clients: [], decryption: 'none' },
        streamSettings: {
          network: 'raw',
          security: 'reality',
          realitySettings: {
            target: '127.0.0.1:8444',
            serverNames: ['node-2.example.com'],
            privateKey: FAKE_SECRETS.realityPrivateKeyInbound,
            shortIds: ['FAKE-SECRET-SHORTID-0003'],
          },
        },
      },
    ],
    outbounds: [
      { tag: 'DIRECT', protocol: 'freedom' },
      { tag: 'BLOCK', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'BLOCK' }],
    },
  };
}

function yamlTemplate(): string {
  const text = [
    'proxies:',
    '  - name: fake-proxy',
    '    type: vless',
    '    server: node-1.example.com',
    '    port: 443',
    `    uuid: ${FAKE_SECRETS.clientId}`,
    '    reality-opts:',
    '      public-key: FAKE-PUBLIC-KEY-0001',
    `      short-id: ${FAKE_SECRETS.yamlShortId}`,
    '  - name: fake-other',
    '    type: trojan',
    '    server: node-2.example.com',
    '    port: 443',
    `    password: ${FAKE_SECRETS.yamlPassword}`,
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
  return Buffer.from(text, 'utf8').toString('base64');
}

export function buildFixtures(options: FixtureOptions = {}): PanelFixtures {
  let counter = 0x100;
  const next = (): string => fakeUuid((counter += 1));

  const profileUuid = next();
  const secondProfileUuid = next();
  const inboundA = next();
  const inboundB = next();
  const inboundC = next();
  const nodeUuids = [next(), next(), next()];
  const hostUuids = [next(), next(), next(), next()];
  const squadUuids = [next(), next()];
  const externalSquadUuid = next();
  const templateUuids = [next(), next(), next()];
  const pluginUuid = next();
  const providerUuid = next();

  const rawInbound = (tag: string, port: number): Json => ({
    tag,
    port,
    protocol: 'vless',
    streamSettings: {
      network: 'raw',
      security: 'reality',
      realitySettings: {
        privateKey:
          tag === 'VLESS_REALITY_MAIN'
            ? FAKE_SECRETS.realityPrivateKey
            : FAKE_SECRETS.realityPrivateKeyInbound,
        shortIds:
          tag === 'VLESS_REALITY_MAIN' ? [...FAKE_SECRETS.shortIds] : ['FAKE-SECRET-SHORTID-0003'],
      },
    },
  });
  const inbound = (uuid: string, profile: string, tag: string, port: number): Json => ({
    uuid,
    profileUuid: profile,
    tag,
    type: 'vless',
    network: 'raw',
    security: 'reality',
    port,
    rawInbound: rawInbound(tag, port),
  });

  const node = (index: number, uuid: string, overrides: Json = {}): Json => ({
    uuid,
    id: index,
    name: `Node ${String(index)}`,
    address: `192.0.2.${String(10 + index)}`,
    port: 62050,
    proxyUrl: null,
    isConnected: index !== 3,
    isDisabled: false,
    isConnecting: false,
    lastStatusChange: T1,
    lastStatusMessage: index === 3 ? 'connection lost' : null,
    isTrafficTrackingActive: true,
    trafficResetDay: 1,
    trafficLimitBytes: 1_000_000_000_000,
    trafficUsedBytes: 123_456_789 * index,
    notifyPercent: 80,
    viewPosition: index,
    countryCode: ['NL', 'DE', 'FI'][index - 1] ?? 'NL',
    consumptionMultiplier: 1,
    nodeConsumptionMultiplier: 1,
    tags: index === 1 ? ['PRIMARY'] : [],
    integrationUuids: [],
    ips: [{ ip: `192.0.2.${String(10 + index)}`, status: 'INBOUND' }],
    createdAt: T0,
    updatedAt: T1,
    configProfile: {
      activeConfigProfileUuid: profileUuid,
      activeInbounds: [
        {
          uuid: inboundA,
          profileUuid,
          tag: 'VLESS_REALITY_MAIN',
          type: 'vless',
          network: 'raw',
          security: 'reality',
          port: 443,
          rawInbound: null,
        },
      ],
    },
    providerUuid,
    provider: {
      uuid: providerUuid,
      name: 'Example Hosting',
      faviconLink: null,
      loginUrl: 'https://hosting.example.com/login',
      createdAt: T0,
      updatedAt: T0,
    },
    activePluginUuid: null,
    system: {
      info: {
        arch: 'x64',
        cpus: 2,
        cpuModel: 'Fake CPU',
        memoryTotal: 4_000_000_000,
        hostname: `node-${String(index)}`,
        platform: 'linux',
        release: '6.8.0-fake',
        type: 'Linux',
        version: '#1 FAKE',
        networkInterfaces: ['eth0'],
      },
      stats: {
        memoryFree: 1_000_000_000,
        memoryUsed: 3_000_000_000,
        uptime: 86_400 * index,
        loadAvg: [0.1, 0.2, 0.3],
        interface: {
          interface: 'eth0',
          rxBytesPerSec: 1,
          txBytesPerSec: 2,
          rxTotal: 3,
          txTotal: 4,
        },
      },
    },
    versions: { xray: '26.0.0-fake', node: '3.4.6-fake' },
    xrayUptime: 3600 * index,
    usersOnline: index === 3 ? 0 : 5 * index,
    note: index === 1 ? 'the first node' : null,
    ...overrides,
  });

  const host = (index: number, uuid: string, overrides: Json = {}): Json => ({
    uuid,
    viewPosition: index,
    remark: `Host ${String(index)}`,
    address: `192.0.2.${String(10 + index)}`,
    port: 443,
    path: null,
    sni: `node-${String(index)}.example.com`,
    host: null,
    alpn: null,
    fingerprint: 'chrome',
    isDisabled: index === 4,
    securityLayer: 'DEFAULT',
    xhttpExtraParams: null,
    muxParams: null,
    sockoptParams: null,
    finalMask: null,
    inbound: { configProfileUuid: profileUuid, configProfileInboundUuid: inboundA },
    serverDescription: null,
    tags: index === 1 ? ['MAIN'] : [],
    isHidden: false,
    overrideSniFromAddress: false,
    keepSniBlank: false,
    vlessRouteId: null,
    pinnedPeerCertSha256: null,
    verifyPeerCertByName: null,
    shuffleHost: false,
    mihomoX25519: false,
    mihomoIpVersion: null,
    nodes: [nodeUuids[index - 1] ?? nodeUuids[0]],
    xrayJsonTemplateUuid: null,
    excludeFromSubscriptionTypes: [],
    mapper: {},
    includeInSrrRules: [],
    internalSquads: { mode: 'EXCLUDE', squads: [] },
    ...overrides,
  });

  const nodes = [1, 2, 3].map((i) =>
    node(
      i,
      nodeUuids[i - 1] ?? next(),
      i === 2 ? { proxyUrl: `socks5://${FAKE_SECRETS.proxyUserinfo}@192.0.2.50:1080` } : {},
    ),
  );
  const hosts: Json[] = [
    host(1, hostUuids[0] ?? next(), {
      xhttpExtraParams: {
        headers: { Authorization: FAKE_SECRETS.headerAuthorization, 'X-Note': 'plain' },
      },
      sockoptParams: { tcpFastOpen: true },
    }),
    host(2, hostUuids[1] ?? next(), {
      finalMask: { udp: [{ type: 'fake', settings: { password: FAKE_SECRETS.hostMaskPassword } }] },
    }),
    host(3, hostUuids[2] ?? next(), {
      mapper: {
        xrayJson: [{ op: 'set', to: 'extra', value: { token: FAKE_SECRETS.hostMapperToken } }],
      },
    }),
    host(4, hostUuids[3] ?? next()),
  ];
  for (let i = 0; i < (options.extraNodes ?? 0); i += 1) {
    nodes.push(
      node(100 + i, next(), {
        name: `Extra node ${String(i)}`,
        address: `198.51.100.${String((i % 250) + 1)}`,
      }),
    );
  }
  for (let i = 0; i < (options.extraHosts ?? 0); i += 1) {
    hosts.push(
      host(100 + i, next(), {
        remark: `Extra host ${String(i)}`,
        address: `198.51.100.${String((i % 250) + 1)}`,
      }),
    );
  }

  return {
    metadata: {
      version: options.version ?? FAKE_PANEL_VERSION,
      build: { time: '2026-01-01T00:00:00.000Z', number: 'fake-build-1' },
      git: {
        backend: {
          commitSha: 'fake',
          branch: 'main',
          commitUrl: 'https://example.com/commit/fake',
        },
        frontend: { commitSha: 'fake', commitUrl: 'https://example.com/commit/fake' },
      },
    },
    health: {
      runtimeMetrics: [
        {
          rss: 1,
          heapUsed: 1,
          heapTotal: 1,
          external: 1,
          arrayBuffers: 1,
          eventLoopDelayMs: 1,
          eventLoopP99Ms: 1,
          activeHandles: 1,
          uptime: 7200,
          pid: 1,
          timestamp: 1,
          instanceId: '0',
          instanceType: 'api',
        },
        {
          rss: 1,
          heapUsed: 1,
          heapTotal: 1,
          external: 1,
          arrayBuffers: 1,
          eventLoopDelayMs: 1,
          eventLoopP99Ms: 1,
          activeHandles: 1,
          uptime: 3600,
          pid: 2,
          timestamp: 1,
          instanceId: '1',
          instanceType: 'jobs',
        },
      ],
    },
    configuration: {
      notifications: {
        webhook: false,
        bandwidthUsage: [80],
        notConnectedAfter: [5],
        expirationNotifications: [3],
      },
      service: {
        cleanUsageHistory: true,
        disableUserUsageRecords: false,
        disableSrhRecords: false,
        exportToRedisStream: false,
      },
      misc: {
        shortUuidLength: 16,
        subPublicDomain: 'sub.example.com',
        userUsageIgnoreBelowBytes: 0,
      },
    },
    stats: {
      cpu: { cores: 2 },
      memory: { total: 1, free: 1, used: 1 },
      uptime: 7200,
      timestamp: 1,
      users: { statusCounts: { ACTIVE: 40, DISABLED: 3, EXPIRED: 2, LIMITED: 1 }, totalUsers: 46 },
      onlineStats: { lastDay: 20, lastWeek: 30, neverOnline: 5, onlineNow: 7 },
      nodes: { totalOnline: 2, totalBytesLifetime: '1000' },
    },
    nodes,
    hosts,
    configProfiles: [
      {
        uuid: profileUuid,
        viewPosition: 1,
        name: 'Profile One',
        tags: ['MAIN'],
        config: xrayConfig(),
        inbounds: [
          inbound(inboundA, profileUuid, 'VLESS_REALITY_MAIN', 443),
          inbound(inboundB, profileUuid, 'VLESS_REALITY_SECOND', 8443),
        ],
        nodes: nodes
          .slice(0, 3)
          .map((n) => ({ uuid: n['uuid'], name: n['name'], countryCode: n['countryCode'] })),
        createdAt: T0,
        updatedAt: T1,
      },
      {
        uuid: secondProfileUuid,
        viewPosition: 2,
        name: 'Profile Two',
        tags: [],
        config: { inbounds: [], outbounds: [] },
        inbounds: [inbound(inboundC, secondProfileUuid, 'VLESS_REALITY_THIRD', 9443)],
        nodes: [],
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    internalSquads: [
      {
        uuid: squadUuids[0] ?? next(),
        viewPosition: 1,
        name: 'Default Squad',
        tags: [],
        info: { membersCount: 40, inboundsCount: 2 },
        inbounds: [
          inbound(inboundA, profileUuid, 'VLESS_REALITY_MAIN', 443),
          inbound(inboundB, profileUuid, 'VLESS_REALITY_SECOND', 8443),
        ],
        createdAt: T0,
        updatedAt: T1,
      },
      {
        uuid: squadUuids[1] ?? next(),
        viewPosition: 2,
        name: 'Empty Squad',
        tags: ['TEST'],
        info: { membersCount: 0, inboundsCount: 0 },
        inbounds: [],
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    externalSquads: [
      {
        uuid: externalSquadUuid,
        viewPosition: 1,
        name: 'Default External',
        tags: [],
        info: { membersCount: 12 },
        templates: [{ templateUuid: templateUuids[0] ?? next(), templateType: 'XRAY_JSON' }],
        subscriptionSettings: { serveJsonAtBaseSubscription: true },
        hostOverrides: { serverDescription: null, vlessRouteId: null },
        responseHeadersAdd: {
          'Profile-Title': 'Example',
          Authorization: FAKE_SECRETS.headerAuthorization,
        },
        responseHeadersRemove: [],
        hwidSettings: { enabled: false, fallbackDeviceLimit: 3, maxDevicesAnnounce: null },
        customRemarks: REMARKS,
        subpageConfigUuid: null,
        createdAt: T0,
        updatedAt: T1,
      },
    ],
    templates: [
      {
        uuid: templateUuids[0] ?? next(),
        viewPosition: 1,
        name: 'Template Json',
        tags: [],
        templateType: 'XRAY_JSON',
        templateJson: {
          inbounds: [
            {
              tag: 'socks',
              port: 10808,
              protocol: 'socks',
              settings: {
                auth: 'password',
                accounts: [
                  { user: FAKE_SECRETS.localProxyUser, pass: FAKE_SECRETS.localProxyPassword },
                ],
                udp: true,
              },
            },
          ],
          outbounds: [
            {
              tag: 'proxy',
              protocol: 'vless',
              settings: {
                vnext: [
                  {
                    address: 'node-1.example.com',
                    port: 443,
                    users: [{ id: FAKE_SECRETS.clientId, encryption: 'none' }],
                  },
                ],
              },
            },
          ],
        },
        encodedTemplateYaml: null,
      },
      {
        uuid: templateUuids[1] ?? next(),
        viewPosition: 2,
        name: 'Template Yaml',
        tags: [],
        templateType: 'MIHOMO',
        templateJson: null,
        encodedTemplateYaml: yamlTemplate(),
      },
      {
        uuid: templateUuids[2] ?? next(),
        viewPosition: 3,
        name: 'Template Broken Yaml',
        tags: [],
        templateType: 'CLASH',
        templateJson: null,
        encodedTemplateYaml: Buffer.from('{ not: [valid', 'utf8').toString('base64'),
      },
    ],
    subscriptionSettings: {
      uuid: next(),
      serveJsonAtBaseSubscription: false,
      isShowCustomRemarks: true,
      customRemarks: REMARKS,
      customResponseHeaders: {
        'Support-Url': 'https://support.example.com',
        'X-Api-Key': FAKE_SECRETS.headerAuthorization,
      },
      randomizeHosts: false,
      responseRules: {
        version: '1',
        rules: [
          {
            name: 'Encrypted',
            enabled: true,
            operator: 'AND',
            conditions: [
              {
                headerName: 'user-agent',
                operator: 'CONTAINS',
                value: 'Fake',
                caseSensitive: false,
              },
            ],
            responseType: 'XRAY_JSON',
            responseModifications: { encryption: { method: 'age1', key: FAKE_SECRETS.ageKey } },
          },
        ],
      },
      hwidSettings: { enabled: false, fallbackDeviceLimit: 3, maxDevicesAnnounce: null },
      createdAt: T0,
      updatedAt: T1,
    },
    snippets: [
      { name: 'DNS_FAKE', snippet: { servers: ['8.8.8.8'] } },
      {
        name: 'SECRET_FAKE',
        snippet: { outbound: { settings: { password: FAKE_SECRETS.snippetPassword } } },
      },
    ],
    nodePlugins: [
      {
        uuid: pluginUuid,
        viewPosition: 1,
        name: 'Plugin One',
        tags: [],
        pluginConfig: {
          webhook: { url: 'https://hooks.example.com/x', token: FAKE_SECRETS.pluginSecret },
        },
      },
    ],
    providers: [
      {
        uuid: providerUuid,
        name: 'Example Hosting',
        faviconLink: null,
        loginUrl: 'https://hosting.example.com/login',
        createdAt: T0,
        updatedAt: T0,
        billingHistory: { totalAmount: 120, totalBills: 12 },
        billingNodes: nodes.slice(0, 2).map((n) => ({
          name: n['name'],
          details: { nodeUuid: n['uuid'], countryCode: n['countryCode'] },
        })),
      },
    ],
    billingNodes: [
      {
        uuid: next(),
        nodeUuid: nodeUuids[0] ?? null,
        name: 'Billing One',
        providerUuid,
        provider: {
          uuid: providerUuid,
          name: 'Example Hosting',
          loginUrl: 'https://hosting.example.com/login',
          faviconLink: null,
        },
        node: { uuid: nodeUuids[0] ?? providerUuid, name: 'Node 1', countryCode: 'NL' },
        nextBillingAt: '2026-12-01T00:00:00.000Z',
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    billingRecords: Array.from({ length: 5 }, (_unused, i) => ({
      uuid: next(),
      providerUuid,
      amount: 10 + i,
      billedAt: `2026-0${String(i + 1)}-01T00:00:00.000Z`,
      provider: { uuid: providerUuid, name: 'Example Hosting', faviconLink: null },
    })),
    apiTokens: [
      {
        uuid: next(),
        name: 'fake-readonly',
        expireAt: '2027-01-01T00:00:00.000Z',
        scopes: ['nodes:read'],
        createdAt: T0,
        updatedAt: T0,
      },
    ],
  };
}
