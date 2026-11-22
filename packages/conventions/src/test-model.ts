import type {
  PanelConfigProfileSummary,
  PanelExternalSquadView,
  PanelHostView,
  PanelInboundView,
  PanelInternalSquadView,
  PanelNodePluginView,
  PanelNodeView,
  PanelSnippetView,
  PanelSubscriptionTemplateView,
} from '@swellwright/contracts';

import { emptyModel, type PanelModel, type ProfileInput } from './model.js';

// Builders of the objects the checks look at, for the tests. Every value is made up (documentation addresses and
// names); nothing here comes from any panel. The defaults make a small healthy fleet, and a test changes the one thing
// it is about.

const HASH = 'a'.repeat(64);
const T = '2026-01-01T00:00:00.000Z';

/** `00000000-0000-4000-8000-00000000NNNN`: valid UUIDs that say they are made up. */
export const uid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export function inbound(
  n: number,
  profileUuid: string,
  tag: string,
  port: number,
  extra: Partial<PanelInboundView> = {},
): PanelInboundView {
  return {
    uuid: uid(n),
    profileUuid,
    tag,
    type: 'vless',
    network: 'raw',
    security: 'reality',
    port,
    ...extra,
  };
}

export function profile(
  n: number,
  name: string,
  inbounds: PanelInboundView[],
  extra: Partial<ProfileInput> = {},
): ProfileInput {
  return {
    uuid: uid(n),
    name,
    viewPosition: n,
    tags: [],
    inbounds,
    nodes: [],
    nodeCount: 0,
    createdAt: T,
    updatedAt: T,
    hash: HASH,
    ...extra,
  };
}

/** A profile as the list would carry it, with a configuration made from its inbounds. */
export function profileWithConfig(
  n: number,
  name: string,
  inbounds: PanelInboundView[],
  extra: Partial<ProfileInput> = {},
  serverNames: string[] | null = null,
): ProfileInput {
  const config = {
    log: { loglevel: 'warning' },
    inbounds: inbounds.map((i) => ({
      tag: i.tag,
      port: i.port,
      protocol: i.type,
      streamSettings: {
        network: i.network,
        security: i.security,
        realitySettings: {
          serverNames: serverNames ?? [`${i.tag.toLowerCase()}.example.com`],
          privateKey: '[masked:00000001]',
          shortIds: '[masked:00000002]',
        },
      },
    })),
    outbounds: [{ tag: 'DIRECT', protocol: 'freedom' }],
  };
  return profile(n, name, inbounds, { config, ...extra });
}

export function node(
  n: number,
  name: string,
  profileRef: { uuid: string; inbounds: PanelInboundView[] } | null,
  extra: Partial<PanelNodeView> = {},
): PanelNodeView {
  return {
    uuid: uid(0x1000 + n),
    name,
    address: `192.0.2.${String(10 + n)}`,
    port: 62_050,
    countryCode: 'NL',
    state: 'online',
    isConnected: true,
    isConnecting: false,
    isDisabled: false,
    lastStatusChange: null,
    lastStatusMessage: null,
    xrayVersion: '26.1.0',
    nodeVersion: '3.4.6',
    xrayUptimeSeconds: 100,
    usersOnline: 5,
    configProfile: {
      uuid: profileRef?.uuid ?? null,
      inbounds: (profileRef?.inbounds ?? []).map((i) => ({ uuid: i.uuid, tag: i.tag })),
    },
    tags: [],
    provider: null,
    activePluginUuid: null,
    integrationUuids: [],
    ips: [],
    proxyUrl: null,
    traffic: {
      trackingActive: false,
      usedBytes: null,
      limitBytes: null,
      resetDay: null,
      notifyPercent: null,
    },
    consumptionMultiplier: 1,
    nodeConsumptionMultiplier: 1,
    viewPosition: n,
    note: null,
    system: null,
    createdAt: T,
    updatedAt: T,
    hash: HASH,
    ...extra,
  };
}

export function host(
  n: number,
  remark: string,
  bound: { profile: string; inbound: string } | null,
  extra: Partial<PanelHostView> = {},
): PanelHostView {
  return {
    uuid: uid(0x2000 + n),
    viewPosition: n,
    remark,
    address: `192.0.2.${String(10 + n)}`,
    port: 443,
    path: null,
    sni: `node-${String(n)}.example.com`,
    host: null,
    alpn: null,
    fingerprint: 'chrome',
    isDisabled: false,
    isHidden: false,
    securityLayer: 'DEFAULT',
    inbound: {
      configProfileUuid: bound?.profile ?? null,
      configProfileInboundUuid: bound?.inbound ?? null,
    },
    nodeUuids: [],
    tags: [],
    serverDescription: null,
    overrideSniFromAddress: false,
    keepSniBlank: false,
    vlessRouteId: null,
    pinnedPeerCertSha256: null,
    verifyPeerCertByName: null,
    shuffleHost: false,
    mihomoX25519: false,
    mihomoIpVersion: null,
    xrayJsonTemplateUuid: null,
    excludeFromSubscriptionTypes: [],
    includeInSrrRules: [],
    internalSquads: { mode: 'EXCLUDE', squadUuids: [] },
    xhttpExtraParams: null,
    muxParams: null,
    sockoptParams: null,
    finalMask: null,
    mapper: null,
    hash: HASH,
    ...extra,
  };
}

export function internalSquad(
  n: number,
  name: string,
  inbounds: PanelInboundView[],
  extra: Partial<PanelInternalSquadView> = {},
): PanelInternalSquadView {
  return {
    uuid: uid(0x3000 + n),
    name,
    viewPosition: n,
    tags: [],
    membersCount: 10,
    inboundsCount: inbounds.length,
    inbounds,
    createdAt: T,
    updatedAt: T,
    hash: HASH,
    ...extra,
  };
}

export function externalSquad(
  n: number,
  name: string,
  templates: { templateUuid: string; templateType: string }[],
  extra: Partial<PanelExternalSquadView> = {},
): PanelExternalSquadView {
  return {
    uuid: uid(0x4000 + n),
    name,
    viewPosition: n,
    tags: [],
    membersCount: 7,
    templates,
    subscriptionSettings: {
      serveJsonAtBaseSubscription: null,
      isShowCustomRemarks: null,
      randomizeHosts: null,
    },
    hostOverrides: { serverDescription: null, vlessRouteId: null },
    responseHeadersAdd: {},
    responseHeadersRemove: [],
    hwidSettings: { enabled: false, fallbackDeviceLimit: 0, maxDevicesAnnounce: null },
    customRemarks: {},
    subpageConfigUuid: null,
    createdAt: T,
    updatedAt: T,
    hash: HASH,
    ...extra,
  };
}

export function template(
  n: number,
  name: string,
  type: string,
  extra: Partial<PanelSubscriptionTemplateView> = {},
): PanelSubscriptionTemplateView {
  return {
    uuid: uid(0x5000 + n),
    name,
    viewPosition: n,
    tags: [],
    templateType: type,
    templateJson: type === 'XRAY_JSON' ? { outbounds: [] } : null,
    templateYaml: type === 'XRAY_JSON' ? null : 'proxies: []\n',
    bodyLoaded: true,
    hash: HASH,
    ...extra,
  };
}

export const snippet = (name: string): PanelSnippetView => ({
  name,
  snippet: { servers: ['192.0.2.53'] },
  hash: HASH,
});

export function nodePlugin(n: number, name: string): PanelNodePluginView {
  return {
    uuid: uid(0x6000 + n),
    name,
    viewPosition: n,
    tags: [],
    pluginConfig: null,
    configLoaded: true,
    hash: HASH,
  };
}

export function summaryOf(p: ProfileInput): PanelConfigProfileSummary {
  const summary: Record<string, unknown> = { ...p };
  delete summary['config'];
  return summary as unknown as PanelConfigProfileSummary;
}

/**
 * A small healthy fleet: one profile with two inbounds shared by three nodes, a host for each node, one squad with the
 * two inbounds, one external squad with one template. Tests take it and break one thing.
 */
export function healthyFleet(overrides: Partial<PanelModel> = {}): PanelModel & {
  readonly profileOne: ProfileInput;
  readonly inboundMain: PanelInboundView;
  readonly inboundSecond: PanelInboundView;
} {
  const profileUuid = uid(1);
  const main = inbound(0x101, profileUuid, 'MAIN', 443);
  const second = inbound(0x102, profileUuid, 'SECOND', 8443);
  const profileOne = profileWithConfig(1, 'Profile One', [main, second], {}, [
    'main.example.com',
    'n1.example.com',
    'n2.example.com',
    'n3.example.com',
  ]);
  const nodes = [1, 2, 3].map((n) =>
    node(
      n,
      `Node ${String(n)}`,
      { uuid: profileUuid, inbounds: [main] },
      { address: `n${String(n)}.example.com`, countryCode: ['NL', 'DE', 'FI'][n - 1] ?? 'NL' },
    ),
  );
  const hosts = [1, 2, 3].map((n) =>
    host(
      n,
      `Host ${String(n)}`,
      { profile: profileUuid, inbound: main.uuid },
      {
        sni: `n${String(n)}.example.com`,
        address: `192.0.2.${String(10 + n)}`,
        nodeUuids: [nodes[n - 1]?.uuid ?? ''],
      },
    ),
  );
  const tpl = template(1, 'Template One', 'XRAY_JSON');
  const model = emptyModel({
    panelVersion: '3.4.11',
    nodes,
    hosts,
    profiles: [
      {
        ...profileOne,
        nodes: nodes.map((n) => ({ uuid: n.uuid, name: n.name, countryCode: n.countryCode })),
        nodeCount: nodes.length,
      },
    ],
    internalSquads: [internalSquad(1, 'Squad One', [main, second])],
    externalSquads: [
      externalSquad(1, 'External One', [{ templateUuid: tpl.uuid, templateType: 'XRAY_JSON' }]),
    ],
    templates: [tpl],
    snippets: [snippet('DNS')],
    nodePlugins: [nodePlugin(1, 'Plugin One')],
    now: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  });
  return { ...model, profileOne, inboundMain: main, inboundSecond: second };
}

/** The element of a list that has to be there, or a failed test; keeps the lines after it free of `?.` and `!`. */
export function at<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) {
    throw new Error(`There is no element ${String(index)} (the list has ${String(list.length)}).`);
  }
  return found;
}

/** A value that has to be there, or a failed test. */
export function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) {
    throw new Error('A value is missing.');
  }
  return value;
}
