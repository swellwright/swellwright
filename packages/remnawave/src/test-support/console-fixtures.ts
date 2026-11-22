// What the fake panel answers beyond the reads of the typed client, for the API console (ADR 0046): the people who use
// a panel, their devices and requests, subscriptions with links, a few more objects by their identifier, and the
// settings of an administrator. Everything is made up, and every value that is personal or gives access says so, so a
// test can search an answer, an audit record or a log for it.

import { fakeUuid, type Json, type PanelFixtures } from './fixtures.js';

/** Access material of the fake users: it must never leave in any answer of the console. */
export const FAKE_USER_ACCESS = {
  shortUuids: ['FAKE-SHORT-UUID-0001', 'FAKE-SHORT-UUID-0002'],
  subscriptionUrls: [
    'https://sub.example.com/FAKE-SHORT-UUID-0001',
    'https://sub.example.com/FAKE-SHORT-UUID-0002',
  ],
  vlessUuids: [fakeUuid(0x9101), fakeUuid(0x9102)],
  trojanPasswords: ['FAKE-USER-TROJAN-PASSWORD-0001', 'FAKE-USER-TROJAN-PASSWORD-0002'],
  ssPasswords: ['FAKE-USER-SS-PASSWORD-0001', 'FAKE-USER-SS-PASSWORD-0002'],
  nodeSecretKey: 'FAKE-SECRET-NODE-SECRET-KEY',
  oauthClientSecret: 'FAKE-SECRET-OAUTH-CLIENT-SECRET',
  subscriptionBody: 'FAKE-SUBSCRIPTION-BODY-WITH-LINKS',
} as const;

/** Personal data of the fake users: masked in the answers about people, and absent from every record. */
export const FAKE_USER_PERSONAL = {
  usernames: ['fake-user-one', 'fake-user-two'],
  emails: ['fake.one@example.com', 'fake.two@example.com'],
  telegramIds: [90000001, 90000002],
  notes: ['FAKE-USER-NOTE-ONE', 'FAKE-USER-NOTE-TWO'],
  hwids: ['FAKE-HWID-0001', 'FAKE-HWID-0002'],
  addresses: ['203.0.113.17', '203.0.113.18'],
  userAgents: ['FakeClient/1.0 FAKE-AGENT-ONE', 'FakeClient/2.0 FAKE-AGENT-TWO'],
  userUuids: [fakeUuid(0x9001), fakeUuid(0x9002)],
  adminEmails: ['fake.admin@example.com'],
} as const;

/** Every text a test must not find in an answer about nothing but the objects of the panel. */
export function fakeAccessTexts(): string[] {
  return [
    ...FAKE_USER_ACCESS.shortUuids,
    ...FAKE_USER_ACCESS.subscriptionUrls,
    ...FAKE_USER_ACCESS.vlessUuids,
    ...FAKE_USER_ACCESS.trojanPasswords,
    ...FAKE_USER_ACCESS.ssPasswords,
    FAKE_USER_ACCESS.nodeSecretKey,
    FAKE_USER_ACCESS.oauthClientSecret,
    FAKE_USER_ACCESS.subscriptionBody,
  ];
}

/** Every text a test must not find in an answer, a record or a log once personal data is handled. */
export function fakePersonalTexts(): string[] {
  return [
    ...fakeAccessTexts(),
    ...FAKE_USER_PERSONAL.usernames,
    ...FAKE_USER_PERSONAL.emails,
    ...FAKE_USER_PERSONAL.notes,
    ...FAKE_USER_PERSONAL.hwids,
    ...FAKE_USER_PERSONAL.addresses,
    ...FAKE_USER_PERSONAL.userAgents,
    ...FAKE_USER_PERSONAL.userUuids,
    ...FAKE_USER_PERSONAL.adminEmails,
    ...FAKE_USER_PERSONAL.telegramIds.map(String),
  ];
}

const T0 = '2026-01-01T00:00:00.000Z';

function user(index: 0 | 1): Json {
  const id = index + 1;
  return {
    id,
    uuid: FAKE_USER_PERSONAL.userUuids[index],
    shortUuid: FAKE_USER_ACCESS.shortUuids[index],
    username: FAKE_USER_PERSONAL.usernames[index],
    status: 'ACTIVE',
    trafficLimitBytes: 1_000_000_000,
    trafficLimitStrategy: 'MONTH',
    expireAt: '2027-01-01T00:00:00.000Z',
    telegramId: FAKE_USER_PERSONAL.telegramIds[index],
    email: FAKE_USER_PERSONAL.emails[index],
    description: FAKE_USER_PERSONAL.notes[index],
    tag: 'FAKE-TAG',
    hwidDeviceLimit: 3,
    trojanPassword: FAKE_USER_ACCESS.trojanPasswords[index],
    vlessUuid: FAKE_USER_ACCESS.vlessUuids[index],
    ssPassword: FAKE_USER_ACCESS.ssPasswords[index],
    subscriptionUrl: FAKE_USER_ACCESS.subscriptionUrls[index],
    activeInternalSquads: [{ uuid: fakeUuid(0x120 + index), name: 'Fake squad' }],
    userTraffic: { usedTrafficBytes: 1000 * id, lifetimeUsedTrafficBytes: 5000 * id },
    createdAt: T0,
    updatedAt: T0,
  };
}

export interface ConsoleFixtures {
  readonly users: Json[];
  readonly devices: Json[];
  readonly requests: Json[];
}

export function buildConsoleFixtures(): ConsoleFixtures {
  return {
    users: [user(0), user(1)],
    devices: [0, 1].map((index) => ({
      hwid: FAKE_USER_PERSONAL.hwids[index],
      userId: index + 1,
      deviceModel: 'Fake Phone',
      platform: 'android',
      osVersion: '14',
      userAgent: FAKE_USER_PERSONAL.userAgents[index],
      requestIp: FAKE_USER_PERSONAL.addresses[index],
      createdAt: T0,
      updatedAt: T0,
    })),
    requests: [0, 1].map((index) => ({
      id: index + 1,
      userId: index + 1,
      requestAt: T0,
      requestIp: FAKE_USER_PERSONAL.addresses[index],
      userAgent: FAKE_USER_PERSONAL.userAgents[index],
    })),
  };
}

export interface ConsoleReply {
  readonly status: number;
  readonly body?: unknown;
  /** A text body, sent as it is. */
  readonly text?: string;
  readonly contentType?: string;
}

/** The answer for a path the typed client never asks for, or undefined when the fake panel has none. */
export function consoleRoute(
  path: string,
  panel: PanelFixtures,
  extra: ConsoleFixtures,
  adminSession: boolean,
): ConsoleReply | undefined {
  const ok = (response: unknown): ConsoleReply => ({ status: 200, body: { response } });
  const notFound = (what: string): ConsoleReply => ({
    status: 404,
    body: { statusCode: 404, message: `${what} not found`, errorCode: 'A002' },
  });
  switch (path) {
    case '/api/users':
      return ok({ users: extra.users, total: extra.users.length });
    case '/api/users/tags':
      return ok({ tags: ['FAKE-TAG'] });
    case '/api/hwid/devices':
      return ok({ devices: extra.devices, total: extra.devices.length });
    case '/api/hwid/devices/stats':
      return ok({
        stats: { totalUniqueDevices: 2, totalHwidDevices: 2, averageHwidDevicesPerUser: 1 },
        byPlatform: [],
        byApp: [],
      });
    case '/api/subscription-request-history':
      return ok({ records: extra.requests, total: extra.requests.length });
    case '/api/subscriptions':
      return ok({
        subscriptions: extra.users.map((u, index) => ({
          isFound: true,
          user: { shortUuid: u['shortUuid'], username: u['username'], userStatus: 'ACTIVE' },
          links: [
            `vless://${String(FAKE_USER_ACCESS.vlessUuids[index])}@node-1.example.com:443?security=reality&type=tcp#Fake`,
          ],
          ssConfLinks: {},
          subscriptionUrl: u['subscriptionUrl'],
        })),
        total: extra.users.length,
      });
    case '/api/keygen':
      return ok({ secretKey: FAKE_USER_ACCESS.nodeSecretKey });
    case '/api/nodes/tags':
      return ok({ tags: ['PRIMARY'] });
    case '/api/hosts/tags':
      return ok({ tags: ['MAIN'] });
    case '/api/remnawave-settings':
      return ok({
        passkeySettings: { enabled: false },
        oauth2Settings: {
          github: {
            enabled: true,
            clientId: 'fake-client-id',
            clientSecret: FAKE_USER_ACCESS.oauthClientSecret,
            allowedEmails: [...FAKE_USER_PERSONAL.adminEmails],
          },
        },
        passwordSettings: { enabled: true },
        brandingSettings: { title: 'Fake panel', logoUrl: null },
      });
    case '/api/system/stats/recap':
      return ok({
        thisMonth: { users: 2, traffic: 1000 },
        total: { users: 2, nodes: 3, traffic: 5000 },
      });
    case '/api/tokens/scopes':
      return adminSession
        ? ok({ resources: [] })
        : {
            status: 403,
            body: { message: 'Forbidden resource', error: 'Forbidden', statusCode: 403 },
          };
    default:
      break;
  }
  const byId = (
    prefix: string,
    pattern: RegExp,
    items: readonly Json[],
  ): ConsoleReply | undefined => {
    const match = pattern.exec(path);
    if (!path.startsWith(prefix) || !match) {
      return undefined;
    }
    const found = items.find((item) => item['uuid'] === match[1]);
    return found ? ok(found) : notFound('Object');
  };
  const node = byId('/api/nodes/', /^\/api\/nodes\/([0-9a-f-]{36})$/u, panel.nodes);
  if (node) {
    return node;
  }
  const host = byId('/api/hosts/', /^\/api\/hosts\/([0-9a-f-]{36})$/u, panel.hosts);
  if (host) {
    return host;
  }
  const number = /^\/api\/users\/(\d+)$/u.exec(path);
  if (number) {
    const found = extra.users.find((u) => String(u['id']) === number[1]);
    return found ? ok(found) : notFound('User');
  }
  const named = /^\/api\/users\/by-username\/([A-Za-z0-9._-]+)$/u.exec(path);
  if (named) {
    const found = extra.users.find((u) => u['username'] === named[1]);
    return found ? ok(found) : notFound('User');
  }
  const short = /^\/api\/users\/by-short-uuid\/([A-Za-z0-9._-]+)$/u.exec(path);
  if (short) {
    const found = extra.users.find((u) => u['shortUuid'] === short[1]);
    return found ? ok(found) : notFound('User');
  }
  if (/^\/api\/sub\/[A-Za-z0-9._-]+$/u.test(path)) {
    return {
      status: 200,
      text: FAKE_USER_ACCESS.subscriptionBody,
      contentType: 'text/plain; charset=utf-8',
    };
  }
  return undefined;
}
