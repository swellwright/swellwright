import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTION_PACK_FORMAT,
  type ConventionPackDocument,
  type ReconciliationRow,
} from '@swellwright/contracts';

import type { DnsAnswer } from './dns.js';
import type { PanelModel } from './model.js';
import { checkPackValue, resolvePack, type ResolvedPack } from './pack.js';
import { namesToResolve, reconcile, type InventoryServer } from './reconcile.js';
import { at, healthyFleet, host, must, node, uid } from './test-model.js';

type Settings = NonNullable<ConventionPackDocument['reconciliation']>;

const pack = (reconciliation: Settings = {}): ResolvedPack => {
  const checked = checkPackValue({ format: CONVENTION_PACK_FORMAT, name: 'p', reconciliation });
  if (checked.document === null) {
    throw new Error(JSON.stringify(checked.result.issues));
  }
  return resolvePack(checked.document, 'custom', 1);
};

const ok = (...ips: string[]): DnsAnswer => ({
  status: 'ok',
  addresses: ips,
  refused: [],
  cnames: [],
  ttl: 300,
});
const failed = (status: DnsAnswer['status']): DnsAnswer => ({
  status,
  addresses: [],
  refused: [],
  cnames: [],
  ttl: null,
});

/** The name of each node of the healthy fleet resolves to the IP the host has. */
const resolvedFleet = (): Map<string, DnsAnswer> =>
  new Map([
    ['n1.example.com', ok('192.0.2.11')],
    ['n2.example.com', ok('192.0.2.12')],
    ['n3.example.com', ok('192.0.2.13')],
  ]);

const run = (
  model: PanelModel,
  settings: Settings = {},
  dns: Map<string, DnsAnswer> = resolvedFleet(),
  inventory: InventoryServer[] | null = null,
  skipped: string[] = [],
) => reconcile({ model, pack: pack(settings), dns, dnsSkipped: new Set(skipped), inventory });

const rowsOf = (
  rows: readonly ReconciliationRow[],
  check: string,
  status?: string,
): ReconciliationRow[] =>
  rows.filter((row) => row.check === check && (status === undefined || row.status === status));

const server = (
  n: number,
  name: string,
  address: string,
  extra: Partial<InventoryServer> = {},
): InventoryServer => ({
  id: uid(0x7000 + n),
  name,
  address,
  state: 'active',
  tags: [],
  hostname: null,
  ...extra,
});

describe('host address and the node that serves it', () => {
  it('is ok when the address is an IP the node resolves to', () => {
    const { rows } = run(healthyFleet());
    const found = rowsOf(rows, 'host.address');
    assert.equal(found.length, 3);
    assert.ok(found.every((row) => row.status === 'ok'));
    assert.equal(at(found, 0).reasonKey, 'reconciliation.reasons.address_is_node_ip');
    assert.equal(at(found, 0).counterpart?.kind, 'node');
  });

  it('finds drift: the address is not the node address and does not resolve to it (the acceptance case)', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: fleet.hosts.map((h, i) => (i === 1 ? { ...h, address: '198.51.100.99' } : h)),
    };
    const result = run(model);
    const drift = rowsOf(result.rows, 'host.address', 'drift');
    assert.equal(drift.length, 1);
    assert.equal(at(drift, 0).subject.name, 'Host 2');
    assert.equal(at(drift, 0).actual, '198.51.100.99');
    assert.equal(at(drift, 0).expected, 'n2.example.com');
    assert.equal(at(drift, 0).counterpart?.name, 'Node 2');
    assert.deepEqual(at(drift, 0).fix, {
      op: 'replace',
      path: '/address',
      from: '198.51.100.99',
      to: 'n2.example.com',
      note: 'The address the pack expects for the node that serves the host.',
    });
    assert.equal(result.summary.drift >= 1, true);
    assert.equal(result.summary.byCheck['host.address'], 1);
    assert.match(at(drift, 0).reason, /198\.51\.100\.99/u);
  });

  it('is ok when the address is the node name, or a name that resolves to an IP of the node', () => {
    const fleet = healthyFleet();
    const dns = resolvedFleet();
    dns.set('alias.example.org', ok('192.0.2.12'));
    const hosts = [
      { ...at(fleet.hosts, 0), address: 'N1.Example.com.' },
      { ...at(fleet.hosts, 1), address: 'alias.example.org' },
      at(fleet.hosts, 2),
    ];
    const rows = rowsOf(run({ ...fleet, hosts }, {}, dns).rows, 'host.address');
    assert.deepEqual(
      rows.map((row) => row.status),
      ['ok', 'ok', 'ok'],
    );
    assert.deepEqual(
      rows.map((row) => row.reasonKey.split('.').pop()),
      ['address_matches_node', 'address_resolves_to_node', 'address_is_node_ip'],
    );
  });

  it('says unknown, not drift, when a name did not resolve and the answer cannot be told', () => {
    const fleet = healthyFleet();
    const dns = resolvedFleet();
    dns.set('n1.example.com', failed('timeout'));
    dns.set('alias.example.org', failed('timeout'));
    const hosts = [
      at(fleet.hosts, 0),
      { ...at(fleet.hosts, 1), address: 'alias.example.org' },
      at(fleet.hosts, 2),
    ];
    const rows = rowsOf(run({ ...fleet, hosts }, {}, dns).rows, 'host.address');
    assert.deepEqual(
      rows.map((row) => row.status),
      ['unknown', 'unknown', 'ok'],
    );
    assert.equal(at(rows, 0).reasonKey, 'reconciliation.reasons.node_ip_unknown');
    assert.equal(at(rows, 1).reasonKey, 'reconciliation.reasons.host_name_unresolved');
  });

  it('says unknown when nothing serves the inbound and the host names no node', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: [
        host(1, 'Orphan', { profile: fleet.profileOne.uuid, inbound: fleet.inboundSecond.uuid }),
      ],
    };
    const rows = rowsOf(run(model).rows, 'host.address');
    assert.equal(at(rows, 0).status, 'unknown');
    assert.equal(at(rows, 0).reasonKey, 'reconciliation.reasons.no_serving_node');
  });

  it('with the policy node-ip wants an IP of the node and calls a name drift', () => {
    const fleet = healthyFleet();
    const hosts = [
      { ...at(fleet.hosts, 0), address: 'n1.example.com' },
      { ...at(fleet.hosts, 1), address: '192.0.2.77' },
      at(fleet.hosts, 2),
    ];
    const rows = rowsOf(run({ ...fleet, hosts }, { hostAddress: 'node-ip' }).rows, 'host.address');
    assert.deepEqual(
      rows.map((row) => [row.status, row.reasonKey.split('.').pop()]),
      [
        ['drift', 'address_not_ip'],
        ['drift', 'address_not_node_ip'],
        ['ok', 'address_is_node_ip'],
      ],
    );
    assert.equal(at(rows, 0).fix?.to, '192.0.2.11');
  });

  it('with the policy node-address wants exactly the address the panel has for the node', () => {
    const fleet = healthyFleet();
    const rows = rowsOf(run(fleet, { hostAddress: 'node-address' }).rows, 'host.address');
    assert.ok(
      rows.every(
        (row) => row.status === 'drift' && row.reasonKey.endsWith('address_not_node_address'),
      ),
    );
    const named = {
      ...fleet,
      hosts: fleet.hosts.map((h, i) => ({ ...h, address: `n${String(i + 1)}.example.com` })),
    };
    assert.ok(
      rowsOf(run(named, { hostAddress: 'node-address' }).rows, 'host.address').every(
        (row) => row.status === 'ok',
      ),
    );
  });

  it('does nothing about addresses when the policy is none', () => {
    assert.deepEqual(rowsOf(run(healthyFleet(), { hostAddress: 'none' }).rows, 'host.address'), []);
  });

  it('handles IPv6 addresses, however they are written', () => {
    const fleet = healthyFleet();
    const dns = resolvedFleet();
    dns.set('n1.example.com', ok('2001:db8::1'));
    const hosts = [
      { ...at(fleet.hosts, 0), address: '[2001:DB8::1]' },
      at(fleet.hosts, 1),
      at(fleet.hosts, 2),
    ];
    const rows = rowsOf(run({ ...fleet, hosts }, {}, dns).rows, 'host.address');
    assert.equal(at(rows, 0).status, 'ok');
  });

  it('compares with the nodes a host is assigned to, when it names any, not with every server of the inbound', () => {
    const fleet = healthyFleet();
    // Host 1 is assigned to node 3 and has node 3's address: ok. With node 1's address it would be drift.
    const hosts = [
      { ...at(fleet.hosts, 0), nodeUuids: [at(fleet.nodes, 2).uuid], address: '192.0.2.13' },
    ];
    assert.equal(rowsOf(run({ ...fleet, hosts }).rows, 'host.address')[0]?.status, 'ok');
    const wrong = [
      { ...at(fleet.hosts, 0), nodeUuids: [at(fleet.nodes, 2).uuid], address: '192.0.2.11' },
    ];
    assert.equal(rowsOf(run({ ...fleet, hosts: wrong }).rows, 'host.address')[0]?.status, 'drift');
  });

  it('is ok when any of several serving nodes matches, and lists the nodes it was compared with', () => {
    const fleet = healthyFleet();
    const hosts = [{ ...at(fleet.hosts, 0), nodeUuids: [], address: '192.0.2.12' }];
    const rows = rowsOf(run({ ...fleet, hosts }).rows, 'host.address');
    assert.equal(at(rows, 0).status, 'ok');
    assert.equal(at(rows, 0).counterpart?.name, 'Node 2');
    const lost = rowsOf(
      run({ ...fleet, hosts: [{ ...at(hosts, 0), address: '203.0.113.5' }] }).rows,
      'host.address',
    )[0];
    assert.equal(lost?.status, 'drift');
    assert.equal(must(lost).related.length, 2);
    assert.equal(must(lost).fix, null, 'no hint when there are several candidates');
  });
});

describe('host SNI, port and assigned nodes', () => {
  it('checks the SNI against the node address when the pack asks, and not otherwise', () => {
    const fleet = healthyFleet();
    assert.deepEqual(rowsOf(run(fleet).rows, 'host.sni'), []);
    const hosts = [
      at(fleet.hosts, 0),
      { ...at(fleet.hosts, 1), sni: 'other.example.org' },
      { ...at(fleet.hosts, 2), sni: null },
    ];
    const rows = rowsOf(run({ ...fleet, hosts }, { hostSni: 'node-address' }).rows, 'host.sni');
    assert.deepEqual(
      rows.map((row) => [row.status, row.reasonKey.split('.').pop()]),
      [
        ['ok', 'sni_matches'],
        ['drift', 'sni_differs'],
        ['drift', 'sni_missing'],
      ],
    );
    assert.equal(at(rows, 1).fix?.to, 'n2.example.com');
    assert.equal(at(rows, 2).fix?.op, 'add');
  });

  it('leaves a deliberately blank SNI alone, takes the address as the SNI when it is overridden, and says unknown for an IP node', () => {
    const fleet = healthyFleet();
    const hosts = [
      { ...at(fleet.hosts, 0), sni: null, keepSniBlank: true },
      {
        ...at(fleet.hosts, 1),
        sni: 'x.example.org',
        overrideSniFromAddress: true,
        address: 'n2.example.com',
      },
    ];
    const rows = rowsOf(run({ ...fleet, hosts }, { hostSni: 'node-address' }).rows, 'host.sni');
    assert.deepEqual(
      rows.map((row) => row.status),
      ['ok'],
    );
    const ipNode = {
      ...fleet,
      nodes: fleet.nodes.map((n, i) => (i === 0 ? { ...n, address: '192.0.2.11' } : n)),
      hosts: [at(fleet.hosts, 0)],
    };
    assert.equal(
      rowsOf(run(ipNode, { hostSni: 'node-address' }).rows, 'host.sni')[0]?.status,
      'unknown',
    );
  });

  it('checks the port against the inbound when the pack asks', () => {
    const fleet = healthyFleet();
    assert.deepEqual(rowsOf(run(fleet).rows, 'host.port'), []);
    const hosts = [{ ...at(fleet.hosts, 0), port: 8443 }, at(fleet.hosts, 1)];
    const rows = rowsOf(run({ ...fleet, hosts }, { hostPort: 'inbound' }).rows, 'host.port');
    assert.deepEqual(
      rows.map((row) => row.status),
      ['drift', 'ok'],
    );
    assert.equal(at(rows, 0).fix?.to, 443);
    assert.equal(at(rows, 0).expected, '443');
  });

  it('checks that the nodes a host is assigned to exist and serve its inbound', () => {
    const fleet = healthyFleet();
    const stranger = node(9, 'Stranger', null);
    const hosts = [
      at(fleet.hosts, 0),
      { ...at(fleet.hosts, 1), nodeUuids: [uid(0xbad)] },
      { ...at(fleet.hosts, 2), nodeUuids: [stranger.uuid] },
      host(4, 'No nodes', { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid }),
    ];
    const rows = rowsOf(
      run({ ...fleet, nodes: [...fleet.nodes, stranger], hosts }).rows,
      'host.node',
    );
    assert.deepEqual(
      rows.map(
        (row) => `${row.subject.name}:${row.status}:${String(row.reasonKey.split('.').pop())}`,
      ),
      [
        'Host 1:ok:assigned_nodes_serve',
        'Host 2:drift:assigned_node_missing',
        'Host 3:drift:assigned_node_not_serving',
      ],
    );
  });

  it('finds hosts that are the same entry twice', () => {
    const fleet = healthyFleet();
    const hosts = [
      at(fleet.hosts, 0),
      { ...at(fleet.hosts, 0), uuid: uid(0x2999), remark: 'Copy' },
      at(fleet.hosts, 1),
    ];
    const rows = rowsOf(run({ ...fleet, hosts }).rows, 'host.duplicate');
    assert.deepEqual(rows.map((row) => row.subject.name).sort(), ['Copy', 'Host 1']);
    assert.ok(rows.every((row) => row.status === 'drift' && row.related.length === 1));
  });
});

describe('node addresses and DNS', () => {
  it('is ok for a name that resolves, with its time to live', () => {
    const rows = rowsOf(run(healthyFleet()).rows, 'node.dns');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.status === 'ok' && row.ttlSeconds === 300));
    assert.equal(at(rows, 0).actual, '192.0.2.11');
  });

  it('has no row for a node whose address is an IP', () => {
    const fleet = healthyFleet();
    const model = { ...fleet, nodes: [node(1, 'A', null, { address: '192.0.2.1' })], hosts: [] };
    assert.deepEqual(rowsOf(run(model).rows, 'node.dns'), []);
  });

  it('hints a long time to live', () => {
    const dns = resolvedFleet();
    dns.set('n1.example.com', { ...ok('192.0.2.11'), ttl: 86_400 });
    const rows = rowsOf(run(healthyFleet(), {}, dns).rows, 'node.dns');
    assert.equal(at(rows, 0).reasonKey, 'reconciliation.reasons.resolves_high_ttl');
    assert.equal(at(rows, 0).status, 'ok');
    assert.equal(
      rowsOf(run(healthyFleet(), { dns: { maxTtlSeconds: 86_400 } }, dns).rows, 'node.dns')[0]
        ?.reasonKey,
      'reconciliation.reasons.resolves',
    );
  });

  it('reports a name with no record as missing, and a lookup that failed as unknown, never an exception', () => {
    const dns = resolvedFleet();
    dns.set('n1.example.com', failed('nxdomain'));
    dns.set('n2.example.com', failed('timeout'));
    dns.set('n3.example.com', failed('error'));
    const rows = rowsOf(run(healthyFleet(), {}, dns).rows, 'node.dns');
    assert.deepEqual(
      rows.map((row) => [row.status, row.reasonKey.split('.').pop()]),
      [
        ['missing', 'no_record'],
        ['unknown', 'dns_timeout'],
        ['unknown', 'dns_error'],
      ],
    );
    const loop = new Map([...resolvedFleet(), ['n1.example.com', failed('cname_loop')] as const]);
    assert.equal(
      rowsOf(run(healthyFleet(), {}, loop).rows, 'node.dns')[0]?.reasonKey,
      'reconciliation.reasons.dns_cname_loop',
    );
  });

  it('says so when a name was left out because of the cap, and when lookups are off', () => {
    const skipped = rowsOf(
      run(healthyFleet(), {}, new Map(), null, [
        'n1.example.com',
        'n2.example.com',
        'n3.example.com',
      ]).rows,
      'node.dns',
    );
    assert.ok(
      skipped.every((row) => row.status === 'unknown' && row.reasonKey.endsWith('dns_skipped_cap')),
    );
    const off = rowsOf(
      run(healthyFleet(), { dns: { enabled: false } }, new Map()).rows,
      'node.dns',
    );
    assert.ok(
      off.every((row) => row.status === 'unknown' && row.reasonKey.endsWith('dns_disabled')),
    );
  });

  it('reports a name that resolves to an address this installation does not allow', () => {
    const dns = resolvedFleet();
    dns.set('n1.example.com', {
      status: 'ok',
      addresses: [],
      refused: ['127.0.0.1'],
      cnames: [],
      ttl: 10,
    });
    const rows = rowsOf(run(healthyFleet(), {}, dns).rows, 'node.dns');
    assert.equal(at(rows, 0).status, 'drift');
    assert.equal(at(rows, 0).params['ip'], '127.0.0.1');
  });

  it('reports a disabled node whose name still resolves', () => {
    const fleet = healthyFleet();
    const nodes = fleet.nodes.map((n, i) =>
      i === 2 ? { ...n, isDisabled: true, state: 'disabled' as const } : n,
    );
    const rows = rowsOf(run({ ...fleet, nodes }).rows, 'node.disabled-resolving');
    assert.equal(rows.length, 1);
    assert.equal(at(rows, 0).subject.name, 'Node 3');
    assert.equal(at(rows, 0).status, 'drift');
    const gone = resolvedFleet();
    gone.set('n3.example.com', failed('nxdomain'));
    assert.deepEqual(
      rowsOf(run({ ...fleet, nodes }, {}, gone).rows, 'node.disabled-resolving'),
      [],
    );
  });

  it('finds nodes that share an address, or an IP, once per node and group', () => {
    const fleet = healthyFleet();
    const dns = resolvedFleet();
    dns.set('n2.example.com', ok('192.0.2.11'));
    const rows = rowsOf(run(fleet, {}, dns).rows, 'node.duplicate');
    assert.deepEqual(rows.map((row) => row.subject.name).sort(), ['Node 1', 'Node 2']);
    assert.ok(rows.every((row) => row.status === 'drift' && row.params['value'] === '192.0.2.11'));
    const same = {
      ...fleet,
      nodes: fleet.nodes.map((n, i) => (i === 1 ? { ...n, address: 'N1.example.com' } : n)),
    };
    assert.equal(
      rowsOf(run(same).rows, 'node.duplicate').length,
      2,
      'one row per node, though the address and the IP both repeat',
    );
  });
});

describe('the server inventory', () => {
  const fleet = healthyFleet();

  it('matches a node with a server by address, by what both resolve to, and by host name', () => {
    const dns = resolvedFleet();
    dns.set('srv3.example.org', ok('192.0.2.13'));
    const model = {
      ...fleet,
      nodes: fleet.nodes.map((n, i) =>
        i === 2
          ? {
              ...n,
              system: {
                hostname: 'box-three',
                platform: null,
                release: null,
                arch: null,
                cpus: null,
                memoryTotal: null,
                memoryUsed: null,
                uptimeSeconds: null,
                loadAvg: [],
              },
            }
          : n,
      ),
    };
    const servers = [
      server(1, 'one', 'n1.example.com'),
      server(2, 'two', '192.0.2.12'),
      server(3, 'three', 'srv3.example.org', { hostname: 'BOX-THREE' }),
    ];
    const rows = rowsOf(run(model, {}, dns, servers).rows, 'node.server');
    assert.deepEqual(
      rows.map((row) => [row.status, row.reasonKey.split('.').pop(), row.counterpart?.name]),
      [
        ['ok', 'matched_by_address', 'one'],
        ['ok', 'matched_by_dns', 'two'],
        ['ok', 'matched_by_dns', 'three'],
      ],
    );
    // By host name alone, when the other two ways are off.
    const only = rowsOf(
      run(model, { inventory: { matchBy: ['hostname'] } }, dns, servers).rows,
      'node.server',
    );
    assert.deepEqual(
      only.map((row) => row.status),
      ['missing', 'missing', 'ok'],
    );
    assert.equal(at(only, 2).reasonKey, 'reconciliation.reasons.matched_by_hostname');
  });

  it('reports a node no server matches as missing (unmanaged) and a server no node matches as extra', () => {
    const servers = [server(1, 'one', 'n1.example.com'), server(9, 'Orphan', '203.0.113.9')];
    const result = run(fleet, {}, resolvedFleet(), servers);
    const missing = rowsOf(result.rows, 'node.server', 'missing');
    assert.deepEqual(
      missing.map((row) => row.subject.name),
      ['Node 2', 'Node 3'],
    );
    assert.equal(at(missing, 0).reasonKey, 'reconciliation.reasons.unmanaged');
    const extra = rowsOf(result.rows, 'server.node', 'extra');
    assert.deepEqual(
      extra.map((row) => row.subject.name),
      ['Orphan'],
    );
    assert.equal(at(extra, 0).subject.kind, 'server');
    assert.equal(result.summary.missing, 2);
    assert.equal(result.summary.extra, 1);
  });

  it('never reports a retired server as extra, and can be told to report neither side', () => {
    const servers = [server(1, 'Gone', '203.0.113.9', { state: 'retired' })];
    assert.deepEqual(rowsOf(run(fleet, {}, resolvedFleet(), servers).rows, 'server.node'), []);
    const quiet = run(
      fleet,
      { inventory: { reportUnmanaged: false, reportExtra: false } },
      resolvedFleet(),
      [server(9, 'Orphan', '203.0.113.9')],
    );
    assert.deepEqual(rowsOf(quiet.rows, 'node.server'), []);
    assert.deepEqual(rowsOf(quiet.rows, 'server.node'), []);
  });

  it('is undecided, not missing, when a name did not resolve and could have matched', () => {
    const dns = resolvedFleet();
    dns.set('n1.example.com', failed('timeout'));
    const rows = rowsOf(
      run(fleet, {}, dns, [server(9, 'Other', '203.0.113.9')]).rows,
      'node.server',
    );
    assert.equal(at(rows, 0).status, 'unknown');
    assert.equal(at(rows, 0).reasonKey, 'reconciliation.reasons.match_undecided');
    assert.equal(at(rows, 1).status, 'missing');
  });

  it('reports a node that several servers match', () => {
    const servers = [server(1, 'one', 'n1.example.com'), server(2, 'one again', '192.0.2.11')];
    const rows = rowsOf(run(fleet, {}, resolvedFleet(), servers).rows, 'node.server');
    assert.equal(at(rows, 0).status, 'drift');
    assert.equal(at(rows, 0).params['count'], 2);
    assert.equal(at(rows, 0).related.length, 1);
  });

  it('finds two servers with the same address or the same IP', () => {
    const dns = resolvedFleet();
    dns.set('alias.example.org', ok('192.0.2.50'));
    const servers = [
      server(1, 'a', '192.0.2.50'),
      server(2, 'b', 'alias.example.org'),
      server(3, 'c', '192.0.2.51'),
    ];
    const rows = rowsOf(run(fleet, {}, dns, servers).rows, 'server.duplicate');
    assert.deepEqual(rows.map((row) => row.subject.name).sort(), ['a', 'b']);
  });

  it('has no inventory rows at all when the caller may not read the inventory', () => {
    const rows = run(fleet, {}, resolvedFleet(), null).rows;
    assert.ok(!rows.some((row) => row.check.startsWith('server.') || row.check === 'node.server'));
  });
});

describe('what a pack can switch off and leave out', () => {
  it('drops a check that is switched off', () => {
    const rows = run(healthyFleet(), {
      checks: { 'node.dns': { enabled: false }, 'host.address': { enabled: false } },
    }).rows;
    assert.ok(!rows.some((row) => row.check === 'node.dns' || row.check === 'host.address'));
  });
  it('leaves out the objects of its scope, hosts and nodes and servers alike', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: fleet.hosts.map((h, i) =>
        i === 0 ? { ...h, address: '198.51.100.1', tags: ['TEST'] } : h,
      ),
      nodes: fleet.nodes.map((n, i) => (i === 1 ? { ...n, tags: ['TEST'] } : n)),
    };
    const servers = [server(9, '🧪 lab', '203.0.113.9', { tags: ['lab'] })];
    const rows = run(
      model,
      { scope: { excludeTags: ['TEST'], exclude: '🧪.*' } },
      resolvedFleet(),
      servers,
    ).rows;
    assert.ok(
      !rows.some(
        (row) =>
          row.subject.name === 'Host 1' ||
          row.subject.name === 'Node 2' ||
          row.subject.name === '🧪 lab',
      ),
    );
    assert.ok(rows.some((row) => row.subject.name === 'Host 2'));
  });
});

describe('the report', () => {
  it('counts every status and the problems by check, and gives every row an id, a reason and a key', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: fleet.hosts.map((h, i) => (i === 0 ? { ...h, address: '198.51.100.1' } : h)),
    };
    const result = run(model, { hostSni: 'node-address', hostPort: 'inbound' }, resolvedFleet(), [
      server(9, 'Orphan', '203.0.113.9'),
    ]);
    const counted =
      result.summary.ok +
      result.summary.drift +
      result.summary.missing +
      result.summary.extra +
      result.summary.unknown;
    assert.equal(counted, result.summary.total);
    assert.equal(result.summary.total, result.rows.length);
    assert.equal(new Set(result.rows.map((row) => row.id)).size, result.rows.length);
    for (const row of result.rows) {
      assert.ok(row.reasonKey.startsWith('reconciliation.reasons.'));
      assert.notEqual(row.reason, row.reasonKey, row.reasonKey);
      assert.doesNotMatch(row.reason, /\{\{/u, row.reason);
    }
    assert.equal(result.summary.byCheck['host.address'], 1);
    assert.equal(result.truncated, false);
  });

  it('writes nothing: the model it was given is the model it still has', () => {
    const fleet = healthyFleet();
    const before = JSON.stringify(fleet);
    run(fleet, { hostSni: 'node-address' }, resolvedFleet(), [server(1, 'a', 'x.example.com')]);
    assert.equal(JSON.stringify(fleet), before);
  });
});

describe('which names a run needs', () => {
  it('lists node names first, then servers, then host names, once each, and only names', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: [
        { ...at(fleet.hosts, 0), address: 'h.example.org' },
        { ...at(fleet.hosts, 1), address: '192.0.2.5' },
      ],
    };
    const names = namesToResolve(model, pack(), [
      server(1, 's', 'srv.example.org'),
      server(2, 't', '192.0.2.9'),
    ]);
    assert.deepEqual(names, [
      'n1.example.com',
      'n2.example.com',
      'n3.example.com',
      'srv.example.org',
      'h.example.org',
    ]);
  });
  it('asks for nothing when lookups are off, and not for host names when the policy does not need them', () => {
    assert.deepEqual(namesToResolve(healthyFleet(), pack({ dns: { enabled: false } }), null), []);
    const fleet = healthyFleet();
    const model = { ...fleet, hosts: [{ ...at(fleet.hosts, 0), address: 'h.example.org' }] };
    assert.ok(
      !namesToResolve(model, pack({ hostAddress: 'node-address' }), null).includes('h.example.org'),
    );
  });
});
