import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTION_PACK_FORMAT,
  type ConventionFinding,
  type PackRuleConfig,
  type PackScope,
} from '@swellwright/contracts';

import { RULES } from './catalogue.js';
import { lint } from './lint.js';
import type { PanelModel } from './model.js';
import { checkPackValue, resolvePack, type ResolvedPack } from './pack.js';
import {
  externalSquad,
  healthyFleet,
  host,
  inbound,
  internalSquad,
  node,
  profile,
  profileWithConfig,
  template,
  uid,
  at,
} from './test-model.js';

/** A pack that sets only the rules named, and the scope when given. */
export function packOf(
  rules: Record<string, PackRuleConfig> = {},
  scope?: PackScope,
): ResolvedPack {
  const checked = checkPackValue({
    format: CONVENTION_PACK_FORMAT,
    name: 'test pack',
    ...(scope === undefined ? {} : { scope }),
    rules,
  });
  if (checked.document === null) {
    throw new Error(`The test pack is not valid: ${JSON.stringify(checked.result.issues)}`);
  }
  return resolvePack(checked.document, 'custom', 1);
}

/** What one rule finds in a model, with the pack's settings for it. */
function find(model: PanelModel, ruleId: string, config: PackRuleConfig = {}): ConventionFinding[] {
  // Only this rule runs, so a finding of another rule never hides a mistake in the test.
  const others = Object.fromEntries(
    RULES.filter((rule) => rule.id !== ruleId).map((rule) => [rule.id, { enabled: false }]),
  );
  return lint(model, packOf({ ...others, [ruleId]: config })).findings.filter(
    (finding) => finding.ruleId === ruleId,
  );
}

const codes = (findings: readonly ConventionFinding[]): string[] =>
  findings.map((finding) => finding.code).sort();

describe('a healthy fleet', () => {
  it('has no error and no warning under the built-in pack', () => {
    const result = lint(healthyFleet(), packOf());
    const problems = result.findings.filter((finding) => finding.severity !== 'info');
    assert.deepEqual(
      problems.map((p) => `${p.ruleId}/${p.code}/${p.object.name}`),
      [],
    );
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.skipped, []);
  });
});

describe('host.address-policy', () => {
  const rule = 'host.address-policy';
  it('accepts any valid address under the default policy', () => {
    assert.deepEqual(find(healthyFleet(), rule), []);
  });
  it('reports an address that is neither an IP nor a name, with the severity error', () => {
    const base = healthyFleet();
    for (const bad of [
      '',
      '999.1.1.1',
      'two words',
      '-bad.example.com',
      'a..b.example.com',
      '1.2.3',
    ]) {
      const model = { ...base, hosts: [host(1, 'H', null, { address: bad })] };
      const found = find(model, rule);
      assert.deepEqual(codes(found), ['invalid'], JSON.stringify(bad));
      assert.equal(at(found, 0).severity, 'error');
    }
  });
  it('accepts IPv6, a bracketed IPv6, a trailing dot and an upper case name', () => {
    const base = healthyFleet();
    for (const good of [
      '2001:db8::1',
      '[2001:db8::1]',
      'Node.Example.COM.',
      'xn--80ak6aa92e.example.com',
    ]) {
      assert.deepEqual(
        find({ ...base, hosts: [host(1, 'H', null, { address: good })] }, rule),
        [],
        good,
      );
    }
  });
  it('with policy ip reports a name and hints the IP of the only node that serves the host', () => {
    const p = inbound(1, uid(9), 'T', 443);
    const n = node(1, 'N', { uuid: uid(9), inbounds: [p] }, { address: '192.0.2.50' });
    const h = host(1, 'H', { profile: uid(9), inbound: p.uuid }, { address: 'old.example.com' });
    const model = { ...healthyFleet(), nodes: [n], hosts: [h], profiles: [profile(9, 'P', [p])] };
    const found = find(model, rule, { params: { policy: 'ip' } });
    assert.deepEqual(codes(found), ['not_ip']);
    assert.deepEqual(at(found, 0).fix, {
      op: 'replace',
      path: '/address',
      from: 'old.example.com',
      to: '192.0.2.50',
      note: 'The address of the node that serves the host.',
    });
    assert.deepEqual(at(found, 0).fields, ['/address']);
  });
  it('with policy domain reports an IP, and has no hint when no node serves the host', () => {
    const model = { ...healthyFleet(), hosts: [host(1, 'H', null, { address: '192.0.2.7' })] };
    const found = find(model, rule, { params: { policy: 'domain' } });
    assert.deepEqual(codes(found), ['not_domain']);
    assert.equal(at(found, 0).fix?.to, null);
  });
  it('refuses a policy that does not exist when the pack is checked', () => {
    const checked = checkPackValue({
      format: CONVENTION_PACK_FORMAT,
      name: 'x',
      rules: { [rule]: { params: { policy: 'cname' } } },
    });
    assert.equal(checked.result.valid, false);
    assert.match(at(checked.result.issues, 0).path, /host\.address-policy/u);
  });
});

describe('host.sni-explicit', () => {
  const rule = 'host.sni-explicit';
  it('reports a host with no SNI and hints the server name of its inbound', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: [
        host(
          1,
          'H',
          { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
          { sni: null },
        ),
      ],
    };
    const found = find(model, rule);
    assert.deepEqual(codes(found), ['missing']);
    assert.deepEqual(at(found, 0).fix, {
      op: 'add',
      path: '/sni',
      from: null,
      to: 'main.example.com',
      note: 'The server name of the inbound, so that the host does not depend on it.',
    });
  });
  it('counts a blank string as no SNI', () => {
    assert.deepEqual(
      codes(find({ ...healthyFleet(), hosts: [host(1, 'H', null, { sni: '  ' })] }, rule)),
      ['missing'],
    );
  });
  it('lets a deliberate blank pass: override from address, keep blank, no security layer', () => {
    const hosts = [
      host(1, 'A', null, { sni: null, overrideSniFromAddress: true }),
      host(2, 'B', null, { sni: null, keepSniBlank: true }),
      host(3, 'C', null, { sni: null, securityLayer: 'NONE' }),
    ];
    assert.deepEqual(find({ ...healthyFleet(), hosts }, rule), []);
  });
});

describe('host.remark-unique', () => {
  const rule = 'host.remark-unique';
  it('reports hosts that share a remark, ignoring case and white space, each with the others', () => {
    const hosts = [host(1, 'Alpha', null), host(2, ' alpha ', null), host(3, 'Beta', null)];
    const found = find({ ...healthyFleet(), hosts }, rule);
    assert.deepEqual(codes(found), ['duplicate', 'duplicate']);
    assert.equal(at(found, 0).related.length, 1);
    assert.equal(at(found, 0).params['count'], 2);
  });
  it('can be case sensitive', () => {
    const hosts = [host(1, 'Alpha', null), host(2, 'alpha', null)];
    assert.deepEqual(
      find({ ...healthyFleet(), hosts }, rule, { params: { caseSensitive: true } }),
      [],
    );
  });
  it('reports an empty remark as an error and does not count it as a duplicate', () => {
    const hosts = [host(1, '', null), host(2, '   ', null)];
    const found = find({ ...healthyFleet(), hosts }, rule);
    assert.deepEqual(codes(found), ['empty', 'empty']);
    assert.ok(found.every((f) => f.severity === 'error'));
  });
});

describe('host.remark-pattern', () => {
  const rule = 'host.remark-pattern';
  const pattern = '\\p{Regional_Indicator}{2} (🎯|🌐) [A-Z]{2}-\\d{2} - .+';
  it('does nothing until a pattern is given, and says so in the catalogue', () => {
    assert.deepEqual(find(healthyFleet(), rule), []);
    const resolved = packOf().rules.get(rule);
    assert.equal(resolved?.inactive, 'needs_params');
  });
  it('reports a remark that does not match', () => {
    const hosts = [host(1, '🇽🇽 🎯 XX-01 - main', null), host(2, 'plain remark', null)];
    const found = find({ ...healthyFleet(), hosts }, rule, { params: { pattern } });
    assert.deepEqual(
      found.map((f) => f.object.name),
      ['plain remark'],
    );
    assert.equal(at(found, 0).params['pattern'], pattern);
  });
  it('leaves out the objects outside its scope, by tag and by name', () => {
    const hosts = [
      host(1, 'plain', null, { tags: ['TEST'] }),
      host(2, '🧪 test host', null),
      host(3, 'plain too', null),
    ];
    const config = { params: { pattern }, scope: { excludeTags: ['TEST'], exclude: '🧪.*' } };
    assert.deepEqual(
      find({ ...healthyFleet(), hosts }, rule, config).map((f) => f.object.name),
      ['plain too'],
    );
  });
  it('takes only the objects in its scope when it names tags', () => {
    const hosts = [host(1, 'x', null, { tags: ['MAIN'] }), host(2, 'y', null)];
    assert.deepEqual(
      find({ ...healthyFleet(), hosts }, rule, {
        params: { pattern },
        scope: { tags: ['MAIN'] },
      }).map((f) => f.object.name),
      ['x'],
    );
  });
  it('lets the severity of the pack replace the default one', () => {
    const found = find({ ...healthyFleet(), hosts: [host(1, 'x', null)] }, rule, {
      params: { pattern },
      severity: 'info',
    });
    assert.equal(at(found, 0).severity, 'info');
  });
});

describe('host.inbound-exists', () => {
  const rule = 'host.inbound-exists';
  it('is quiet for a host bound to an inbound of its profile', () => {
    assert.deepEqual(find(healthyFleet(), rule), []);
  });
  it('reports every way a binding can be wrong', () => {
    const fleet = healthyFleet();
    const other = profile(2, 'Other', [inbound(0x201, uid(2), 'OTHER', 9443)]);
    const hosts = [
      host(1, 'unbound', null),
      host(2, 'no profile', { profile: uid(99), inbound: fleet.inboundMain.uuid }),
      host(3, 'no inbound', { profile: fleet.profileOne.uuid, inbound: uid(0x999) }),
      host(4, 'mixed up', { profile: fleet.profileOne.uuid, inbound: uid(0x201) }),
    ];
    const found = find({ ...fleet, hosts, profiles: [...fleet.profiles, other] }, rule);
    assert.deepEqual(codes(found), [
      'inbound_of_other_profile',
      'missing_inbound',
      'missing_profile',
      'unbound',
    ]);
    assert.equal(found.find((f) => f.code === 'unbound')?.severity, 'warning');
    assert.equal(found.find((f) => f.code === 'missing_inbound')?.severity, 'error');
  });
});

describe('host.serving-node', () => {
  const rule = 'host.serving-node';
  it('reports an enabled host whose inbound no node serves', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: [host(1, 'H', { profile: fleet.profileOne.uuid, inbound: fleet.inboundSecond.uuid })],
    };
    assert.deepEqual(codes(find(model, rule)), ['no_node']);
  });
  it('does not report a disabled host or one whose binding is broken', () => {
    const fleet = healthyFleet();
    const hosts = [
      host(
        1,
        'off',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundSecond.uuid },
        { isDisabled: true },
      ),
      host(2, 'unbound', null),
    ];
    assert.deepEqual(find({ ...fleet, hosts }, rule), []);
  });
  it('reports an assigned node that does not exist and one that does not serve the inbound', () => {
    const fleet = healthyFleet();
    const stranger = node(9, 'Stranger', null);
    const h = host(
      1,
      'H',
      { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
      { nodeUuids: [uid(0xdead), stranger.uuid, at(fleet.nodes, 0).uuid] },
    );
    const found = find({ ...fleet, nodes: [...fleet.nodes, stranger], hosts: [h] }, rule);
    assert.deepEqual(codes(found), ['node_missing', 'node_not_serving']);
  });
});

describe('host.state', () => {
  const rule = 'host.state';
  it('points out disabled and hidden hosts as information', () => {
    const hosts = [
      host(1, 'off', null, { isDisabled: true }),
      host(2, 'hidden', null, { isHidden: true }),
      host(3, 'fine', null),
    ];
    const found = find({ ...healthyFleet(), hosts }, rule);
    assert.deepEqual(codes(found), ['disabled', 'hidden']);
    assert.ok(found.every((f) => f.severity === 'info'));
  });
  it('can report only one of them', () => {
    const hosts = [
      host(1, 'off', null, { isDisabled: true }),
      host(2, 'hidden', null, { isHidden: true }),
    ];
    assert.deepEqual(
      codes(find({ ...healthyFleet(), hosts }, rule, { params: { report: ['hidden'] } })),
      ['hidden'],
    );
  });
});

describe('host.sni-in-inbound-names', () => {
  const rule = 'host.sni-in-inbound-names';
  it('reports an SNI that the REALITY inbound does not list, with a hint', () => {
    const fleet = healthyFleet();
    const h = host(
      1,
      'H',
      { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
      { sni: 'other.example.org' },
    );
    const found = find({ ...fleet, hosts: [h] }, rule);
    assert.deepEqual(codes(found), ['not_listed']);
    assert.equal(at(found, 0).fix?.to, 'main.example.com');
  });
  it('accepts a listed name, with other case, and a name under a wildcard', () => {
    const fleet = healthyFleet();
    const bound = { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid };
    assert.deepEqual(
      find({ ...fleet, hosts: [host(1, 'H', bound, { sni: 'MAIN.example.com' })] }, rule),
      [],
    );
    const wild = profileWithConfig(1, 'Profile One', [fleet.inboundMain]);
    const config = wild.config as {
      inbounds: { streamSettings: { realitySettings: { serverNames: string[] } } }[];
    };
    at(config.inbounds, 0).streamSettings.realitySettings.serverNames = ['*.example.net'];
    assert.deepEqual(
      find(
        { ...fleet, profiles: [wild], hosts: [host(1, 'H', bound, { sni: 'a.example.net' })] },
        rule,
      ),
      [],
    );
    assert.deepEqual(
      codes(
        find(
          { ...fleet, profiles: [wild], hosts: [host(1, 'H', bound, { sni: 'example.net' })] },
          rule,
        ),
      ),
      ['not_listed'],
    );
  });
  it('is quiet when the configuration was not read, for an override from the address, and for an empty SNI', () => {
    const fleet = healthyFleet();
    const bound = { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid };
    const bare = { ...at(fleet.profiles, 0), config: undefined };
    assert.deepEqual(
      find(
        { ...fleet, profiles: [bare], hosts: [host(1, 'H', bound, { sni: 'x.example.org' })] },
        rule,
      ),
      [],
    );
    assert.deepEqual(
      find(
        {
          ...fleet,
          hosts: [host(1, 'H', bound, { sni: 'x.example.org', overrideSniFromAddress: true })],
        },
        rule,
      ),
      [],
    );
    assert.deepEqual(find({ ...fleet, hosts: [host(1, 'H', bound, { sni: null })] }, rule), []);
  });
});

describe('host.vless-route-id', () => {
  const rule = 'host.vless-route-id';
  it('reports 0 and the range 0x4000-0x4FFF by default, and nothing else', () => {
    const hosts = [0, 16_383, 16_384, 20_479, 20_480, 1001].map((id, i) =>
      host(i + 1, `H${String(id)}`, null, { vlessRouteId: id }),
    );
    const found = find({ ...healthyFleet(), hosts }, rule);
    assert.deepEqual(found.map((f) => f.object.name).sort(), ['H0', 'H16384', 'H20479']);
    assert.ok(found.every((f) => f.code === 'reserved'));
  });
  it('takes the reserved ranges from the pack', () => {
    const hosts = [
      host(1, 'A', null, { vlessRouteId: 5 }),
      host(2, 'B', null, { vlessRouteId: 16_500 }),
    ];
    const config = { params: { reserved: [{ from: 1, to: 10, reason: 'ours' }] } };
    assert.deepEqual(
      find({ ...healthyFleet(), hosts }, rule, config).map((f) => f.object.name),
      ['A'],
    );
  });
  it('reports an id above the largest as out of range', () => {
    const found = find(
      { ...healthyFleet(), hosts: [host(1, 'A', null, { vlessRouteId: 70_000 })] },
      rule,
    );
    assert.deepEqual(codes(found), ['out_of_range']);
  });
  it('also looks at the override of an external squad', () => {
    const squad = externalSquad(1, 'Ext', [], {
      hostOverrides: { serverDescription: null, vlessRouteId: 17_000 },
    });
    const found = find({ ...healthyFleet(), externalSquads: [squad] }, rule);
    assert.deepEqual(
      found.map((f) => f.object.kind),
      ['externalSquad'],
    );
  });
  it('reports one id shared by hosts of different inbounds when asked, and not otherwise', () => {
    const fleet = healthyFleet();
    const hosts = [
      host(
        1,
        'A',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
        { vlessRouteId: 1001 },
      ),
      host(
        2,
        'B',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundSecond.uuid },
        { vlessRouteId: 1001 },
      ),
      host(
        3,
        'C',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
        { vlessRouteId: 1002 },
      ),
      host(
        4,
        'D',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
        { vlessRouteId: 1002 },
      ),
    ];
    assert.deepEqual(find({ ...fleet, hosts }, rule), []);
    const found = find({ ...fleet, hosts }, rule, { params: { warnOnDuplicates: true } });
    assert.deepEqual(found.map((f) => f.object.name).sort(), ['A', 'B']);
  });
  it('skips the squads when the token could not read them', () => {
    const squad = externalSquad(1, 'Ext', [], {
      hostOverrides: { serverDescription: null, vlessRouteId: 17_000 },
    });
    const model = {
      ...healthyFleet(),
      externalSquads: [squad],
      unavailable: new Set(['externalSquads' as const]),
    };
    assert.deepEqual(find(model, rule), []);
  });
});

describe('node.has-host', () => {
  const rule = 'node.has-host';
  it('is quiet when every node has a host assigned to it', () => {
    assert.deepEqual(find(healthyFleet(), rule), []);
  });
  it('reports an enabled node that no host is assigned to and none has the address of', () => {
    const fleet = healthyFleet();
    const lonely = node(7, 'Lonely', { uuid: uid(50), inbounds: [] });
    assert.deepEqual(
      find({ ...fleet, nodes: [...fleet.nodes, lonely] }, rule).map((f) => f.object.name),
      ['Lonely'],
    );
  });
  it('does not count a node that merely serves the same inbound as another, but does count a host that has its address', () => {
    const fleet = healthyFleet();
    const sibling = node(
      8,
      'Sibling',
      { uuid: fleet.profileOne.uuid, inbounds: [fleet.inboundMain] },
      { address: 'sibling.example.com', ips: [{ ip: '192.0.2.88', status: 'INBOUND' }] },
    );
    assert.deepEqual(
      find({ ...fleet, nodes: [...fleet.nodes, sibling] }, rule).map((f) => f.object.name),
      ['Sibling'],
    );
    const byName = {
      ...fleet,
      nodes: [...fleet.nodes, sibling],
      hosts: [...fleet.hosts, host(8, 'Sibling host', null, { address: 'SIBLING.example.com.' })],
    };
    assert.deepEqual(find(byName, rule), []);
    const byIp = {
      ...fleet,
      nodes: [...fleet.nodes, sibling],
      hosts: [...fleet.hosts, host(8, 'Sibling host', null, { address: '192.0.2.88' })],
    };
    assert.deepEqual(find(byIp, rule), []);
  });
  it('counts the only node that serves the inbound of a host that names no node', () => {
    const fleet = healthyFleet();
    const p = fleet.profileOne.uuid;
    const solo = node(9, 'Solo', { uuid: p, inbounds: [fleet.inboundSecond] });
    const unnamed = host(
      9,
      'Unnamed',
      { profile: p, inbound: fleet.inboundSecond.uuid },
      { nodeUuids: [], address: '192.0.2.200' },
    );
    assert.deepEqual(
      find({ ...fleet, nodes: [...fleet.nodes, solo], hosts: [...fleet.hosts, unnamed] }, rule),
      [],
    );
    const twin = node(10, 'Twin', { uuid: p, inbounds: [fleet.inboundSecond] });
    assert.deepEqual(
      find(
        { ...fleet, nodes: [...fleet.nodes, solo, twin], hosts: [...fleet.hosts, unnamed] },
        rule,
      )
        .map((f) => f.object.name)
        .sort(),
      ['Solo', 'Twin'],
    );
  });
  it('does not report a disabled node', () => {
    const fleet = healthyFleet();
    assert.deepEqual(
      find(
        {
          ...fleet,
          nodes: [...fleet.nodes, node(7, 'Off', null, { isDisabled: true, state: 'disabled' })],
        },
        rule,
      ),
      [],
    );
  });
});

describe('node.disabled-referenced', () => {
  const rule = 'node.disabled-referenced';
  it('reports a disabled node that is the only server of a host, and one a host is assigned to', () => {
    const fleet = healthyFleet();
    const off = fleet.nodes.map((n, i) =>
      i === 0 ? { ...n, isDisabled: true, state: 'disabled' as const } : n,
    );
    const hosts = [
      host(
        1,
        'Only',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
        { nodeUuids: [] },
      ),
      host(
        2,
        'Assigned',
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundSecond.uuid },
        { nodeUuids: [at(off, 0).uuid] },
      ),
    ];
    // Node 1 alone serves nothing exclusively (nodes 2 and 3 serve MAIN too): only the assignment counts.
    const found = find({ ...fleet, nodes: off, hosts }, rule);
    assert.deepEqual(codes(found), ['assigned']);
    // With only node 1 on the inbound, it is the last server.
    const solo = [at(off, 0)];
    const found2 = find({ ...fleet, nodes: solo, hosts: [at(hosts, 0)] }, rule);
    assert.deepEqual(codes(found2), ['last_server']);
    assert.equal(at(found2, 0).severity, 'warning');
    assert.equal(at(found, 0).severity, 'info');
  });
  it('is quiet for enabled nodes', () => {
    assert.deepEqual(find(healthyFleet(), rule), []);
  });
});

describe('node.version-skew', () => {
  const rule = 'node.version-skew';
  const withVersions = (
    versions: [string | null, string | null][],
    panelVersion: string | null = '3.4.11',
  ): PanelModel => {
    const fleet = healthyFleet({ panelVersion });
    return {
      ...fleet,
      nodes: versions.map(([nodeVersion, xrayVersion], i) =>
        node(i + 1, `N${String(i + 1)}`, null, { nodeVersion, xrayVersion }),
      ),
    };
  };
  it('reports the node that differs from the majority, for the node and for Xray', () => {
    const model = withVersions([
      ['3.4.6', '26.1.0'],
      ['3.4.6', '26.1.0'],
      ['3.4.5', '26.0.0'],
    ]);
    const found = find(model, rule);
    assert.deepEqual(codes(found), ['node_version', 'xray_version']);
    assert.equal(at(found, 0).object.name, 'N3');
    assert.deepEqual(found.find((f) => f.code === 'node_version')?.params, {
      version: '3.4.5',
      common: '3.4.6',
    });
  });
  it('takes the newest version when the nodes are split evenly', () => {
    const model = withVersions([
      ['3.4.5', null],
      ['3.4.6', null],
    ]);
    assert.deepEqual(
      find(model, rule, { params: { checkXrayVersion: false } }).map((f) => f.object.name),
      ['N1'],
    );
  });
  it('compares versions as numbers, not as text', () => {
    const model = withVersions([
      ['3.4.10', null],
      ['3.4.10', null],
      ['3.4.9', null],
    ]);
    assert.deepEqual(
      find(model, rule).map((f) => f.object.name),
      ['N3'],
    );
  });
  it('has nothing to compare with for one node, and ignores versions it cannot read', () => {
    assert.deepEqual(find(withVersions([['3.4.5', '26.1.0']]), rule), []);
    assert.deepEqual(
      find(
        withVersions([
          ['3.4.6', null],
          ['abc', null],
          ['3.4.6', null],
        ]),
        rule,
        { params: { sameLineAsPanel: false } },
      ),
      [],
    );
  });
  it('reports a node on another release line than the panel, and can be told not to', () => {
    const model = withVersions([
      ['3.3.9', null],
      ['3.3.9', null],
    ]);
    assert.deepEqual(codes(find(model, rule)), ['panel_line', 'panel_line']);
    assert.deepEqual(find(model, rule, { params: { sameLineAsPanel: false } }), []);
    assert.deepEqual(
      find(
        withVersions(
          [
            ['3.3.9', null],
            ['3.3.9', null],
          ],
          null,
        ),
        rule,
      ),
      [],
    );
  });
});

describe('node.address-valid', () => {
  it('reports an address that is neither an IP nor a name', () => {
    const fleet = healthyFleet();
    const found = find(
      {
        ...fleet,
        nodes: [
          node(1, 'A', null, { address: 'not an address' }),
          node(2, 'B', null, { address: '192.0.2.9' }),
        ],
      },
      'node.address-valid',
    );
    assert.deepEqual(
      found.map((f) => f.object.name),
      ['A'],
    );
    assert.equal(at(found, 0).severity, 'error');
  });
});

describe('node.profile-assigned', () => {
  const rule = 'node.profile-assigned';
  it('reports no profile, a missing profile and a profile with no active inbound', () => {
    const fleet = healthyFleet();
    const nodes = [
      node(1, 'none', null),
      node(2, 'missing', { uuid: uid(0x777), inbounds: [] }),
      node(3, 'empty', { uuid: fleet.profileOne.uuid, inbounds: [] }),
      node(4, 'fine', { uuid: fleet.profileOne.uuid, inbounds: [fleet.inboundMain] }),
    ];
    const found = find({ ...fleet, nodes }, rule);
    assert.deepEqual(found.map((f) => `${f.object.name}:${f.code}:${f.severity}`).sort(), [
      'empty:no_inbounds:warning',
      'missing:missing_profile:error',
      'none:none:warning',
    ]);
  });
});

describe('node.plugin-exists', () => {
  it('reports a plugin that does not exist and keeps quiet for one that does', () => {
    const fleet = healthyFleet();
    const nodes = [
      node(1, 'bad', null, { activePluginUuid: uid(0x666) }),
      node(2, 'good', null, { activePluginUuid: at(fleet.nodePlugins, 0).uuid }),
    ];
    assert.deepEqual(
      find({ ...fleet, nodes }, 'node.plugin-exists').map((f) => f.object.name),
      ['bad'],
    );
  });
});

describe('name patterns', () => {
  it('node.name-pattern checks node names against the pattern of the pack', () => {
    const fleet = healthyFleet();
    const nodes = [node(1, 'XX-01', null), node(2, 'xx one', null)];
    assert.deepEqual(
      find({ ...fleet, nodes }, 'node.name-pattern', {
        params: { pattern: '[A-Z]{2}-\\d{2}' },
      }).map((f) => f.object.name),
      ['xx one'],
    );
    assert.deepEqual(find({ ...fleet, nodes }, 'node.name-pattern'), []);
  });
  it('profile.name-pattern and template.name-pattern do the same for their objects', () => {
    const fleet = healthyFleet();
    const pattern = { params: { pattern: '[A-Za-z0-9 _-]+' } };
    assert.deepEqual(
      find(
        { ...fleet, profiles: [profile(1, 'Bad/Name', []), profile(2, 'Good Name', [])] },
        'profile.name-pattern',
        pattern,
      ).map((f) => f.object.name),
      ['Bad/Name'],
    );
    assert.deepEqual(
      find(
        {
          ...fleet,
          templates: [template(1, 'ok_name', 'XRAY_JSON'), template(2, 'no!', 'XRAY_JSON')],
        },
        'template.name-pattern',
        pattern,
      ).map((f) => f.object.name),
      ['no!'],
    );
  });
  it('squad.name-pattern covers internal and external squads, or one kind', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      internalSquads: [internalSquad(1, 'bad one', [])],
      externalSquads: [externalSquad(1, 'bad two', [])],
    };
    const config = { params: { pattern: '[A-Z]+' } };
    assert.deepEqual(
      find(model, 'squad.name-pattern', config)
        .map((f) => f.object.kind)
        .sort(),
      ['externalSquad', 'internalSquad'],
    );
    assert.deepEqual(
      find(model, 'squad.name-pattern', { params: { pattern: '[A-Z]+', kinds: ['internal'] } }).map(
        (f) => f.object.kind,
      ),
      ['internalSquad'],
    );
  });
});

describe('profile.inbound-tag-unique', () => {
  const rule = 'profile.inbound-tag-unique';
  it('is quiet when tags are unique', () => {
    assert.deepEqual(find(healthyFleet(), rule), []);
  });
  it('reports a tag used twice in a profile', () => {
    const p = uid(5);
    const model = {
      ...healthyFleet(),
      profiles: [profile(5, 'P', [inbound(1, p, 'DUP', 443), inbound(2, p, 'DUP', 444)])],
    };
    const found = find(model, rule);
    assert.deepEqual(codes(found), ['duplicate_in_profile']);
    assert.equal(at(found, 0).params['count'], 2);
  });
  it('reports a tag used in two profiles, on both', () => {
    const model = {
      ...healthyFleet(),
      profiles: [
        profile(5, 'P5', [inbound(1, uid(5), 'SAME', 443)]),
        profile(6, 'P6', [inbound(2, uid(6), 'SAME', 443)]),
      ],
    };
    const found = find(model, rule);
    assert.deepEqual(codes(found), ['duplicate_across_profiles', 'duplicate_across_profiles']);
    assert.deepEqual(found.map((f) => f.params['other']).sort(), ['P5', 'P6']);
  });
});

describe('profile.inbound-port-clash', () => {
  const rule = 'profile.inbound-port-clash';
  const p = uid(5);
  it('reports two inbounds on one port', () => {
    const model = {
      ...healthyFleet(),
      profiles: [profile(5, 'P', [inbound(1, p, 'A', 443), inbound(2, p, 'B', 443)])],
    };
    const found = find(model, rule);
    assert.deepEqual(codes(found), ['clash']);
    assert.equal(at(found, 0).related.length, 2);
    assert.equal(at(found, 0).params['port'], 443);
  });
  it('keeps a TCP port apart from a UDP one, and ignores inbounds with no port', () => {
    const model = {
      ...healthyFleet(),
      profiles: [
        profile(5, 'P', [
          inbound(1, p, 'A', 443),
          inbound(2, p, 'B', 443, { network: 'kcp' }),
          inbound(3, p, 'C', null as unknown as number, { port: null }),
          inbound(4, p, 'D', 8443),
        ]),
      ],
    };
    assert.deepEqual(find(model, rule), []);
  });
  it('lets inbounds share a port when they listen on different specific addresses', () => {
    const a = inbound(1, p, 'A', 443, { raw: { tag: 'A', listen: '192.0.2.1' } });
    const b = inbound(2, p, 'B', 443, { raw: { tag: 'B', listen: '192.0.2.2' } });
    assert.deepEqual(find({ ...healthyFleet(), profiles: [profile(5, 'P', [a, b])] }, rule), []);
    const c = inbound(3, p, 'C', 443, { raw: { tag: 'C', listen: '0.0.0.0' } });
    assert.deepEqual(
      codes(find({ ...healthyFleet(), profiles: [profile(5, 'P', [a, c])] }, rule)),
      ['clash'],
    );
  });
});

describe('profile.snippet-exists', () => {
  const rule = 'profile.snippet-exists';
  it('reports snippets named at the root, in an outbound, a rule and a balancer that do not exist', () => {
    const p = profile(5, 'P', [], {
      config: {
        snippets: ['DNS', 'MISSING_ROOT'],
        outbounds: [{ tag: 'x', snippet: 'MISSING_OUT' }, { tag: 'y' }],
        routing: {
          rules: [{ snippet: 'MISSING_RULE' }, { snippet: 'DNS' }],
          balancers: [{ snippet: 'MISSING_BAL' }],
        },
      },
    });
    const found = find({ ...healthyFleet(), profiles: [p] }, rule);
    assert.deepEqual(found.map((f) => f.params['snippet']).sort(), [
      'MISSING_BAL',
      'MISSING_OUT',
      'MISSING_ROOT',
      'MISSING_RULE',
    ]);
  });
  it('is quiet when the configuration was not read or names nothing', () => {
    assert.deepEqual(find({ ...healthyFleet(), profiles: [profile(5, 'P', [])] }, rule), []);
    assert.deepEqual(
      find(
        { ...healthyFleet(), profiles: [profile(5, 'P', [], { config: 'not an object' })] },
        rule,
      ),
      [],
    );
  });
  it('is skipped, not wrong, when the token cannot read snippets', () => {
    const model = { ...healthyFleet(), unavailable: new Set(['snippets' as const]) };
    const result = lint(model, packOf());
    assert.ok(
      result.skipped.some((entry) => entry.ruleId === rule && entry.missing.includes('snippets')),
    );
  });
});

describe('profile.unused and profile.shared', () => {
  it('reports a profile without nodes and one without inbounds', () => {
    const fleet = healthyFleet();
    const model = { ...fleet, profiles: [...fleet.profiles, profile(5, 'Idle', [])] };
    assert.deepEqual(codes(find(model, 'profile.unused')), ['no_inbounds', 'unused']);
  });
  it('reports a profile that several nodes share, from two by default and from a number of the pack', () => {
    const fleet = healthyFleet();
    assert.deepEqual(codes(find(fleet, 'profile.shared')), ['shared']);
    assert.deepEqual(find(fleet, 'profile.shared', { params: { minNodes: 4 } }), []);
    assert.equal(find(fleet, 'profile.shared')[0]?.params['count'], 3);
  });
});

describe('squad rules', () => {
  it('squad.internal-empty reports no inbounds (warning) and no members (info)', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      internalSquads: [
        internalSquad(1, 'Empty', [], { membersCount: 0 }),
        internalSquad(2, 'Fine', [fleet.inboundMain]),
      ],
    };
    const found = find(model, 'squad.internal-empty');
    assert.deepEqual(found.map((f) => `${f.code}:${f.severity}`).sort(), [
      'no_inbounds:warning',
      'no_members:info',
    ]);
  });
  it('squad.inbound-exists reports an inbound that is in no profile', () => {
    const fleet = healthyFleet();
    const ghost = inbound(0xabc, uid(77), 'GHOST', 1);
    const model = { ...fleet, internalSquads: [internalSquad(1, 'S', [fleet.inboundMain, ghost])] };
    const found = find(model, 'squad.inbound-exists');
    assert.deepEqual(
      found.map((f) => f.params['tag']),
      ['GHOST'],
    );
  });
  it('squad.external-template-exists reports a missing template and a type that does not match', () => {
    const fleet = healthyFleet();
    const tpl = at(fleet.templates, 0);
    const model = {
      ...fleet,
      externalSquads: [
        externalSquad(1, 'E', [
          { templateUuid: uid(0xdd), templateType: 'MIHOMO' },
          { templateUuid: tpl.uuid, templateType: 'CLASH' },
          { templateUuid: tpl.uuid, templateType: 'XRAY_JSON' },
        ]),
      ],
    };
    assert.deepEqual(codes(find(model, 'squad.external-template-exists')), [
      'missing_template',
      'type_mismatch',
    ]);
  });
});

describe('template rules', () => {
  it('template.body-present reports a body of a typed template that is empty or unreadable, once per template', () => {
    const fleet = healthyFleet();
    const templates = [
      template(1, 'json ok', 'XRAY_JSON'),
      template(2, 'json empty', 'XRAY_JSON', { templateJson: null }),
      template(3, 'yaml broken', 'CLASH', { templateYaml: null }),
      template(4, 'yaml blank', 'MIHOMO', { templateYaml: '  \n' }),
      template(5, 'other type', 'SUBSCRIPTION', { templateJson: null, templateYaml: null }),
    ];
    const found = find({ ...fleet, templates }, 'template.body-present');
    assert.deepEqual(found.map((f) => f.object.name).sort(), [
      'json empty',
      'yaml blank',
      'yaml broken',
    ]);
    assert.equal(found.find((f) => f.object.name === 'json empty')?.params['format'], 'JSON');
    assert.equal(found.find((f) => f.object.name === 'yaml broken')?.params['format'], 'YAML');
    // The types are the pack's to say.
    assert.deepEqual(
      find({ ...fleet, templates }, 'template.body-present', {
        params: { types: ['SUBSCRIPTION'] },
      }).map((f) => f.object.name),
      ['other type'],
    );
  });
  it('template.unused reports a template no external squad and no host uses', () => {
    const fleet = healthyFleet();
    const stray = template(2, 'Stray', 'XRAY_JSON');
    const viaHost = template(3, 'Via host', 'XRAY_JSON');
    const model = {
      ...fleet,
      templates: [...fleet.templates, stray, viaHost],
      hosts: [host(1, 'H', null, { xrayJsonTemplateUuid: viaHost.uuid })],
    };
    assert.deepEqual(
      find(model, 'template.unused').map((f) => f.object.name),
      ['Stray'],
    );
  });
});

describe('panel.token-expiry', () => {
  const rule = 'panel.token-expiry';
  const token = (daysLeft: number | null) => ({
    secretId: uid(1),
    secretName: 's',
    expiresAt: null,
    daysLeft,
    expiryWarning: false,
  });
  it('warns from 14 days before, errors once expired, and is quiet otherwise', () => {
    const fleet = healthyFleet();
    assert.deepEqual(find({ ...fleet, token: token(30) }, rule), []);
    assert.deepEqual(find({ ...fleet, token: token(null) }, rule), []);
    assert.deepEqual(find({ ...fleet, token: null }, rule), []);
    const soon = find({ ...fleet, token: token(14) }, rule);
    assert.deepEqual(codes(soon), ['expiring']);
    assert.equal(at(soon, 0).params['days'], 14);
    assert.equal(at(soon, 0).severity, 'warning');
    const gone = find({ ...fleet, token: token(-1) }, rule);
    assert.deepEqual(codes(gone), ['expired']);
    assert.equal(at(gone, 0).severity, 'error');
    assert.equal(at(gone, 0).object.kind, 'panel');
  });
  it('takes the warning period from the pack', () => {
    assert.deepEqual(
      find({ ...healthyFleet(), token: token(20) }, rule, { params: { warnDays: 30 } }).map(
        (f) => f.code,
      ),
      ['expiring'],
    );
  });
});

describe('the engine', () => {
  it('names findings stably, sorts them most severe first, and counts them', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: [host(1, 'zzz', null, { address: '' }), host(2, 'aaa', null, { isDisabled: true })],
    };
    const result = lint(model, packOf());
    const again = lint(model, packOf());
    assert.deepEqual(
      result.findings.map((f) => f.id),
      again.findings.map((f) => f.id),
    );
    const ranks = result.findings.map((f) => ['error', 'warning', 'info'].indexOf(f.severity));
    assert.deepEqual(ranks, [...ranks].sort());
    assert.equal(result.summary.total, result.findings.length);
    assert.equal(
      result.summary.error + result.summary.warning + result.summary.info,
      result.summary.total,
    );
    assert.ok(result.summary.byRule['host.address-policy'] === 1);
  });
  it('switches a rule off, changes its severity, and applies the scope of the pack to every rule', () => {
    const fleet = healthyFleet();
    const model = { ...fleet, hosts: [host(1, 'bad', null, { address: '', tags: ['TEST'] })] };
    assert.ok(lint(model, packOf()).findings.some((f) => f.ruleId === 'host.address-policy'));
    assert.ok(
      !lint(model, packOf({ 'host.address-policy': { enabled: false } })).findings.some(
        (f) => f.ruleId === 'host.address-policy',
      ),
    );
    assert.equal(
      lint(model, packOf({ 'host.address-policy': { severity: 'info' } })).findings.find(
        (f) => f.ruleId === 'host.address-policy',
      )?.severity,
      'info',
    );
    assert.ok(
      !lint(model, packOf({}, { excludeTags: ['TEST'] })).findings.some(
        (f) => f.object.name === 'bad',
      ),
    );
    // A rule's own scope replaces the pack's.
    assert.ok(
      lint(
        model,
        packOf({ 'host.address-policy': { scope: {} } }, { excludeTags: ['TEST'] }),
      ).findings.some((f) => f.ruleId === 'host.address-policy'),
    );
  });
  it('lists a rule whose data the token cannot read as skipped, and runs the others', () => {
    const model = { ...healthyFleet(), unavailable: new Set(['nodes' as const]) };
    const result = lint(model, packOf());
    const skipped = result.skipped.map((entry) => entry.ruleId);
    assert.ok(skipped.includes('node.has-host'));
    assert.ok(skipped.includes('host.serving-node'));
    assert.ok(!skipped.includes('host.address-policy'));
  });
  it('keeps going when a rule throws, and says which one', () => {
    const fleet = healthyFleet();
    // A host whose list is not a list: the rule that walks it fails; the others must not be lost.
    const broken = {
      ...fleet,
      hosts: [{ ...host(1, 'H', null), nodeUuids: null as unknown as string[] }],
    };
    const result = lint(broken, packOf());
    assert.ok(result.failed.length > 0);
    assert.ok(result.failed.every((entry) => entry.message.length > 0));
    assert.ok(result.summary.total >= 0);
  });
  it('lists at most the limit of findings and still counts all of them', () => {
    const many = Array.from({ length: 30 }, (_unused, i) =>
      host(i + 1, `H${String(i)}`, null, { address: '' }),
    );
    const result = lint({ ...healthyFleet(), hosts: many }, packOf(), { limit: 10 });
    assert.equal(result.findings.length, 10);
    assert.equal(result.truncated, true);
    assert.ok(result.summary.total > 10);
  });
  it('gives every finding a message with its values filled in, a key, and no unfilled placeholder', () => {
    const fleet = healthyFleet();
    const model = {
      ...fleet,
      hosts: [
        host(1, 'dup', null, { address: 'bad address' }),
        host(2, 'dup', null, { vlessRouteId: 0 }),
      ],
      nodes: [node(1, 'N', null, { address: '', nodeVersion: '3.3.0' })],
    };
    const result = lint(model, packOf());
    assert.ok(result.findings.length > 3);
    for (const finding of result.findings) {
      assert.ok(finding.messageKey.startsWith('findings.'), finding.messageKey);
      assert.doesNotMatch(finding.message, /\{\{|\}\}/u, finding.message);
      assert.notEqual(finding.message, finding.messageKey);
    }
  });
});

describe('the rule catalogue', () => {
  it('has a message for every code of every rule, and a title and a description', async () => {
    const { textFor } = await import('./messages.js');
    for (const rule of RULES) {
      assert.ok(textFor(`rules.${rule.id}.title`), `${rule.id} title`);
      assert.ok(textFor(`rules.${rule.id}.description`), `${rule.id} description`);
      assert.ok(rule.codes.length > 0, rule.id);
      for (const code of rule.codes) {
        assert.ok(textFor(`findings.${rule.id}.${code}`), `${rule.id}/${code}`);
      }
    }
  });
  it('emits only codes the rule declares', () => {
    const fleet = healthyFleet();
    const messy = {
      ...fleet,
      hosts: [
        host(1, '', null, {
          address: 'x y',
          sni: null,
          vlessRouteId: 0,
          isDisabled: true,
          isHidden: true,
        }),
        host(2, 'a', { profile: uid(1), inbound: uid(0x999) }),
      ],
      nodes: [node(1, 'N', null, { address: '', activePluginUuid: uid(0x66), isDisabled: true })],
      profiles: [profile(5, 'P', [inbound(1, uid(5), 'X', 1), inbound(2, uid(5), 'X', 1)])],
      internalSquads: [internalSquad(1, 'S', [], { membersCount: 0 })],
      externalSquads: [externalSquad(1, 'E', [{ templateUuid: uid(0xee), templateType: 'X' }])],
      templates: [template(1, 'T', 'CLASH', { templateYaml: null })],
    };
    const patterns: Record<string, PackRuleConfig> = Object.fromEntries(
      [
        'host.remark-pattern',
        'node.name-pattern',
        'profile.name-pattern',
        'squad.name-pattern',
        'template.name-pattern',
      ].map((id) => [id, { params: { pattern: 'zzz' } }]),
    );
    const result = lint(
      messy,
      packOf({ ...patterns, 'host.vless-route-id': { params: { warnOnDuplicates: true } } }),
    );
    for (const finding of result.findings) {
      const rule = RULES.find((r) => r.id === finding.ruleId);
      assert.ok(rule?.codes.includes(finding.code), `${finding.ruleId} emitted ${finding.code}`);
    }
    // The catalogue has 30 rules, and the messy model touches most of them.
    assert.ok(RULES.length >= 28);
    assert.ok(new Set(result.findings.map((f) => f.ruleId)).size >= 20);
  });
});
