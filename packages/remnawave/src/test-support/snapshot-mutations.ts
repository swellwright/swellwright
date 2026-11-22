import { fakeUuid, type Json, type PanelFixtures } from './fixtures.js';

// Ways to make the fake panel say something else, for the tests of snapshots and diff (ADR 0043): each one is what a
// person could do in the real panel. They change the fixtures in place and return what they changed, so that a test
// can assert on it. Synthetic values only.

/** The secret a rotation puts in the place of the REALITY private key: it must never reach a response or a record. */
export const ROTATED_SECRETS = {
  realityPrivateKey: 'FAKE-SECRET-ROTATED-PRIVATE-KEY-0009',
  newClientId: '99999999-8888-4777-8666-555555555555',
} as const;

const list = (
  fixtures: PanelFixtures,
  key: 'nodes' | 'hosts' | 'configProfiles' | 'templates',
): Json[] => fixtures[key];

const at = (items: Json[], index: number, what: string): Json => {
  const found = items[index];
  if (!found) {
    throw new Error(`The fake panel has no ${what} number ${String(index)}.`);
  }
  return found;
};

/** A host gets another address (the drift that the reconciliation will look for). */
export function changeHostAddress(fixtures: PanelFixtures, index: number, address: string): string {
  const host = at(list(fixtures, 'hosts'), index, 'host');
  host['address'] = address;
  return String(host['uuid']);
}

/** A profile gets one more inbound, in the list of inbounds and in its Xray configuration. */
export function addProfileInbound(
  fixtures: PanelFixtures,
  index: number,
  tag: string,
  port: number,
): string {
  const profile = at(list(fixtures, 'configProfiles'), index, 'config profile');
  const uuid = fakeUuid(0x900 + port);
  const inbounds = profile['inbounds'] as Json[];
  inbounds.push({
    uuid,
    profileUuid: profile['uuid'],
    tag,
    type: 'vless',
    network: 'raw',
    security: 'none',
    port,
    rawInbound: { tag, port, protocol: 'vless', settings: { clients: [], decryption: 'none' } },
  });
  const config = profile['config'] as Json;
  (config['inbounds'] as Json[]).push({
    tag,
    port,
    protocol: 'vless',
    settings: { clients: [], decryption: 'none' },
  });
  return uuid;
}

/** A node is deleted in the panel. */
export function removeNode(fixtures: PanelFixtures, index: number): string {
  const node = at(list(fixtures, 'nodes'), index, 'node');
  fixtures.nodes = fixtures.nodes.filter((other) => other !== node);
  return String(node['uuid']);
}

/** The body of a JSON template changes: the local port of its first inbound. */
export function changeTemplateBody(fixtures: PanelFixtures, index: number, port: number): string {
  const template = at(list(fixtures, 'templates'), index, 'template');
  const body = template['templateJson'] as Json;
  const inbound = (body['inbounds'] as Json[])[0];
  if (!inbound) {
    throw new Error('The template has no inbound.');
  }
  inbound['port'] = port;
  return String(template['uuid']);
}

/** The REALITY private key of the first profile is replaced, in its configuration and in its raw inbound. */
export function rotateRealityKey(fixtures: PanelFixtures, index = 0): string {
  const profile = at(list(fixtures, 'configProfiles'), index, 'config profile');
  const config = profile['config'] as Json;
  const first = (config['inbounds'] as Json[])[0];
  const reality = (first?.['streamSettings'] as Json | undefined)?.['realitySettings'] as
    Json | undefined;
  if (!reality) {
    throw new Error('The profile has no REALITY inbound to rotate.');
  }
  reality['privateKey'] = ROTATED_SECRETS.realityPrivateKey;
  const raw = (profile['inbounds'] as Json[])[0]?.['rawInbound'] as Json | undefined;
  const rawReality = (raw?.['streamSettings'] as Json | undefined)?.['realitySettings'] as
    Json | undefined;
  if (rawReality) {
    rawReality['privateKey'] = ROTATED_SECRETS.realityPrivateKey;
  }
  return String(profile['uuid']);
}

/** A client is added to the first inbound of the first profile (a list that a diff only counts). */
export function addClient(fixtures: PanelFixtures, index = 0): string {
  const profile = at(list(fixtures, 'configProfiles'), index, 'config profile');
  const config = profile['config'] as Json;
  const first = (config['inbounds'] as Json[])[0];
  const settings = first?.['settings'] as Json | undefined;
  const clients = settings?.['clients'] as Json[] | undefined;
  if (!clients) {
    throw new Error('The profile has no clients list.');
  }
  clients.push({
    id: ROTATED_SECRETS.newClientId,
    flow: 'xtls-rprx-vision',
    email: 'new@example.com',
  });
  return String(profile['uuid']);
}

/** What a node does by itself: uptime, users online, traffic, the last change of state. Not a change of the panel. */
export function changeRuntimeOnly(fixtures: PanelFixtures): void {
  for (const node of fixtures.nodes) {
    node['usersOnline'] = Number(node['usersOnline'] ?? 0) + 1;
    node['xrayUptime'] = Number(node['xrayUptime'] ?? 0) + 600;
    node['trafficUsedBytes'] = Number(node['trafficUsedBytes'] ?? 0) + 4096;
    node['lastStatusChange'] = '2026-03-01T08:00:00.000Z';
    node['updatedAt'] = '2026-03-01T08:00:00.000Z';
    const system = node['system'] as Json | undefined;
    const stats = system?.['stats'] as Json | undefined;
    if (stats) {
      stats['uptime'] = Number(stats['uptime'] ?? 0) + 600;
    }
  }
  fixtures.stats['onlineStats'] = { lastDay: 99, lastWeek: 99, neverOnline: 0, onlineNow: 99 };
}

/** The tags of a node are reordered: a change of nothing. */
export function reorderNodeTags(fixtures: PanelFixtures, index: number): string {
  const node = at(list(fixtures, 'nodes'), index, 'node');
  const tags = [...((node['tags'] as string[] | undefined) ?? [])];
  node['tags'] = tags.reverse();
  return String(node['uuid']);
}
