import { fakeUuid, type Json, type PanelFixtures } from './fixtures.js';

// A fleet with things wrong in it, for the checks of phase 3 (ADR 0044): the convention linter, the reconciliation and the
// impact calculator. It is made from the default fixtures by `applyChecksScenario`, which changes them in place, so the
// fixtures of every other test stay as they are. Everything is made up: documentation names and addresses.
//
// What is wrong, on purpose:
// - Host 2 has an address that is no node's address and resolves to no node (address drift).
// - Host 3 has an SNI its inbound does not list. Host 4 (disabled) points at the address of another node.
// - "Host 2 again" repeats a remark, has a reserved route id, and its inbound is on no node. Another host is bound to an
//   inbound that does not exist, and another has no SNI at all.
// - Node 3 runs an older node version; Node 4 has no host; Node 5 is disabled but its name still resolves.
// - Profile One names a snippet that does not exist. A squad lists an inbound that is in no profile. An external squad uses
//   a template that does not exist. A template has a body that is not YAML.

/** What the names of the scenario resolve to: the answers of a fake DNS for the tests and the stand. */
export const CHECKS_ZONE: Readonly<Record<string, readonly string[]>> = {
  'node-1.example.com': ['192.0.2.11'],
  'node-2.example.com': ['192.0.2.12'],
  'node-3.example.com': ['192.0.2.13'],
  'node-4.example.com': ['192.0.2.14'],
  'node-5.example.com': ['192.0.2.15'],
  // A name of an inventory server, to match a node by what both resolve to.
  'server-2.example.org': ['192.0.2.12'],
};

const at = (list: Json[], index: number): Json => {
  const found = list[index];
  if (found === undefined) {
    throw new Error(`The fixtures have nothing at ${String(index)}.`);
  }
  return found;
};

export function applyChecksScenario(fixtures: PanelFixtures): {
  readonly zone: typeof CHECKS_ZONE;
} {
  const { nodes, hosts } = fixtures;
  const profileOne = at(fixtures.configProfiles, 0);
  const profileTwo = at(fixtures.configProfiles, 1);
  const profileOneUuid = String(profileOne['uuid']);
  const profileTwoUuid = String(profileTwo['uuid']);
  const inboundsOne = profileOne['inbounds'] as Json[];
  const inboundsTwo = profileTwo['inbounds'] as Json[];
  const main = at(inboundsOne, 0);
  const second = at(inboundsOne, 1);
  const third = at(inboundsTwo, 0);
  const activeOf = (inbound: Json): Json => ({ ...inbound, rawInbound: null });

  // The server names of the first inbound: the names of the nodes, as in the configuration and in the raw inbound.
  const serverNames = [
    'node-1.example.com',
    'node-2.example.com',
    'node-3.example.com',
    'node-4.example.com',
  ];
  const realityOf = (inbound: Json): Json => {
    const stream = inbound['streamSettings'] as Json;
    return stream['realitySettings'] as Json;
  };
  realityOf(at((profileOne['config'] as Json)['inbounds'] as Json[], 0))['serverNames'] =
    serverNames;
  realityOf(main['rawInbound'] as Json)['serverNames'] = serverNames;

  // Names instead of addresses for the nodes, and one node on an older version.
  nodes.forEach((node, i) => {
    node['address'] = `node-${String(i + 1)}.example.com`;
  });
  at(nodes, 2)['versions'] = { xray: '26.0.0-fake', node: '3.4.5-fake' };

  // A node that no host points at, and a disabled one that still has a name.
  const template = at(nodes, 0);
  const extraNode = (n: number, overrides: Json): Json => ({
    ...structuredClone(template),
    uuid: fakeUuid(0x500 + n),
    id: n,
    name: `Node ${String(n)}`,
    address: `node-${String(n)}.example.com`,
    isConnected: true,
    ips: [{ ip: `192.0.2.${String(10 + n)}`, status: 'INBOUND' }],
    viewPosition: n,
    note: null,
    tags: [],
    ...overrides,
  });
  nodes.push(
    extraNode(4, {
      configProfile: { activeConfigProfileUuid: profileOneUuid, activeInbounds: [activeOf(main)] },
    }),
    extraNode(5, {
      isDisabled: true,
      isConnected: false,
      usersOnline: 0,
      configProfile: { activeConfigProfileUuid: profileTwoUuid, activeInbounds: [activeOf(third)] },
    }),
  );
  profileOne['nodes'] = nodes
    .filter((node) => (node['configProfile'] as Json)['activeConfigProfileUuid'] === profileOneUuid)
    .map((node) => ({ uuid: node['uuid'], name: node['name'], countryCode: node['countryCode'] }));
  profileTwo['nodes'] = [at(nodes, 4)].map((node) => ({
    uuid: node['uuid'],
    name: node['name'],
    countryCode: node['countryCode'],
  }));

  // Hosts: the first is fine, the others are wrong in one way each.
  at(hosts, 1)['address'] = '192.0.2.99';
  at(hosts, 2)['sni'] = 'wrong.example.com';
  at(hosts, 3)['address'] = '192.0.2.12';
  const host = (n: number, overrides: Json): Json => ({
    ...structuredClone(at(hosts, 0)),
    uuid: fakeUuid(0x600 + n),
    viewPosition: 10 + n,
    remark: `Host ${String(n)}`,
    tags: [],
    nodes: [],
    ...overrides,
  });
  hosts.push(
    host(5, {
      remark: 'Host 2',
      vlessRouteId: 17_000,
      inbound: { configProfileUuid: profileOneUuid, configProfileInboundUuid: second['uuid'] },
    }),
    host(6, {
      remark: 'Host 6',
      inbound: { configProfileUuid: profileOneUuid, configProfileInboundUuid: fakeUuid(0xdead) },
    }),
    host(7, { remark: 'Host 7', sni: null }),
  );

  // Profile One names a snippet that is not there.
  const config = profileOne['config'] as Json;
  const routing = config['routing'] as { rules: Json[] };
  routing.rules.push({ type: 'field', snippet: 'MISSING_SNIPPET', outboundTag: 'DIRECT' });

  // A squad that lists an inbound that no profile has, and an external squad with a template that does not exist.
  fixtures.internalSquads.push({
    uuid: fakeUuid(0x700),
    viewPosition: 3,
    name: 'Ghost Squad',
    tags: [],
    info: { membersCount: 3, inboundsCount: 1 },
    inbounds: [
      {
        uuid: fakeUuid(0xbeef),
        profileUuid: fakeUuid(0xcafe),
        tag: 'GHOST',
        type: 'vless',
        network: 'raw',
        security: 'reality',
        port: 1,
        rawInbound: null,
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  fixtures.externalSquads.push({
    ...structuredClone(at(fixtures.externalSquads, 0)),
    uuid: fakeUuid(0x701),
    name: 'Lost Template Squad',
    templates: [{ templateUuid: fakeUuid(0x7ff), templateType: 'MIHOMO' }],
  });
  return { zone: CHECKS_ZONE };
}
