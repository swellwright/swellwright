import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTION_PACK_FORMAT,
  type ConventionFinding,
  type PackRuleConfig,
  type PanelNodeView,
  type ReconciliationRow,
} from '@swellwright/contracts';

import { RULES } from './catalogue.js';
import { calculateImpact } from './impact.js';
import { lint } from './lint.js';
import { type PanelModel } from './model.js';
import { checkPackValue, resolvePack, type ResolvedPack } from './pack.js';
import { reconcile } from './reconcile.js';
import {
  at,
  healthyFleet,
  host,
  inbound,
  node,
  profile,
  realLayout,
  template,
  uid,
} from './test-model.js';

// What the real panel (3.4.11) showed when the checks first ran against it, and a fake panel could not: the lists of
// templates carry no bodies, a profile holds one inbound for each node and every node activates one of them, and a node
// has two hosts, one for each subscription template. The checks were wrong for each of these (ADR 0044, note of
// 2026-11-22); these tests keep them right. Every name and address here is made up.

const pack = (rules: Record<string, PackRuleConfig> = {}): ResolvedPack => {
  const checked = checkPackValue({ format: CONVENTION_PACK_FORMAT, name: 'real shapes', rules });
  if (checked.document === null) {
    throw new Error(JSON.stringify(checked.result.issues));
  }
  return resolvePack(checked.document, 'custom', 1);
};

/** What one rule finds, the others being off. */
function find(model: PanelModel, ruleId: string, config: PackRuleConfig = {}): ConventionFinding[] {
  const others = Object.fromEntries(
    RULES.filter((rule) => rule.id !== ruleId).map((rule) => [rule.id, { enabled: false }]),
  );
  return lint(model, pack({ ...others, [ruleId]: config })).findings.filter(
    (finding) => finding.ruleId === ruleId,
  );
}

const reconciled = (model: PanelModel): ReconciliationRow[] =>
  reconcile({ model, pack: pack(), dns: new Map(), dnsSkipped: new Set(), inventory: null }).rows;

/** The same model with a node changed. */
const withNode = (
  model: PanelModel,
  index: number,
  change: Partial<PanelNodeView>,
): PanelModel => ({
  ...model,
  nodes: model.nodes.map((candidate, i) => (i === index ? { ...candidate, ...change } : candidate)),
});

describe('the layout of a real fleet', () => {
  const fleet = realLayout();

  it('is what the real panel showed: counts, one active inbound on every node', () => {
    assert.equal(fleet.nodes.length, 14);
    assert.equal(fleet.hosts.length, 35);
    assert.equal(fleet.templates.length, 10);
    assert.deepEqual(
      fleet.profiles.map((p) => p.inbounds.length),
      [12, 1, 1],
    );
    assert.ok(fleet.nodes.every((n) => n.configProfile.inbounds.length === 1));
    assert.ok(fleet.mainInbounds.every((i) => i.port === 443));
  });

  it('has nothing for the built-in pack to complain about but the information that a profile is shared', () => {
    const run = lint(fleet, pack());
    assert.deepEqual(run.failed, []);
    assert.deepEqual(run.skipped, []);
    assert.deepEqual(
      run.findings.map((f) => `${f.severity}:${f.ruleId}`),
      ['info:profile.shared'],
    );
  });

  it('has no reconciliation row for the pairs of hosts of one node', () => {
    assert.deepEqual(
      reconciled(fleet).filter((row) => row.check === 'host.duplicate'),
      [],
    );
  });
});

describe('profile.inbound-port-clash on the common layout', () => {
  const rule = 'profile.inbound-port-clash';
  const fleet = realLayout();

  it('does not report twelve inbounds on port 443 of which every node activates one (it did, as an error)', () => {
    assert.deepEqual(find(fleet, rule), []);
  });

  it('reports two inbounds that one node has active together, as an error naming the node', () => {
    const [first, second] = fleet.mainInbounds;
    assert.ok(first !== undefined && second !== undefined);
    const model = withNode(fleet, 0, {
      configProfile: {
        uuid: fleet.mainProfile.uuid,
        inbounds: [first, second].map((i) => ({ uuid: i.uuid, tag: i.tag })),
      },
    });
    const found = find(model, rule);
    assert.equal(found.length, 1);
    const clash = at(found, 0);
    assert.equal(clash.code, 'clash');
    assert.equal(clash.severity, 'error');
    assert.equal(clash.params['port'], 443);
    assert.equal(clash.params['nodes'], 'Node 1');
    assert.match(String(clash.params['tags']), /NODE_01/u);
    assert.match(String(clash.params['tags']), /NODE_02/u);
    assert.ok(clash.related.some((ref) => ref.kind === 'node' && ref.name === 'Node 1'));
  });

  it('names every node that has the clash, once', () => {
    const [first, second] = fleet.mainInbounds;
    assert.ok(first !== undefined && second !== undefined);
    const both = {
      uuid: fleet.mainProfile.uuid,
      inbounds: [first, second].map((i) => ({ uuid: i.uuid, tag: i.tag })),
    };
    const model = withNode(withNode(fleet, 0, { configProfile: both }), 4, { configProfile: both });
    const found = find(model, rule);
    assert.equal(found.length, 1);
    assert.equal(at(found, 0).params['nodes'], 'Node 1, Node 5');
  });

  it('does not report an inbound that two nodes share, whatever else each of them runs', () => {
    // A profile of three inbounds: A and B are both on 443 but no node has them together; C is on 8443 and both nodes
    // run it. Node 1 runs A and C, node 2 runs B and C. Compared over the whole profile, A and B would clash.
    const profileUuid = uid(0x40);
    const a = inbound(0x401, profileUuid, 'A', 443);
    const b = inbound(0x402, profileUuid, 'B', 443);
    const c = inbound(0x403, profileUuid, 'C', 8443);
    const model: PanelModel = {
      ...healthyFleet(),
      profiles: [profile(0x40, 'Shared', [a, b, c])],
      nodes: [
        node(1, 'Node 1', { uuid: profileUuid, inbounds: [a, c] }),
        node(2, 'Node 2', { uuid: profileUuid, inbounds: [b, c] }),
      ],
      hosts: [],
    };
    assert.deepEqual(find(model, rule), []);
  });

  it('keeps comparing the inbounds of a node: a shared inbound does not hide a clash of the others', () => {
    const profileUuid = uid(0x41);
    const a = inbound(0x411, profileUuid, 'A', 443);
    const b = inbound(0x412, profileUuid, 'B', 443);
    const c = inbound(0x413, profileUuid, 'C', 8443);
    const model: PanelModel = {
      ...healthyFleet(),
      profiles: [profile(0x41, 'Shared', [a, b, c])],
      nodes: [
        node(1, 'Node 1', { uuid: profileUuid, inbounds: [a, c] }),
        node(2, 'Node 2', { uuid: profileUuid, inbounds: [a, b, c] }),
      ],
      hosts: [],
    };
    const found = find(model, rule);
    assert.equal(found.length, 1);
    assert.equal(at(found, 0).params['nodes'], 'Node 2');
  });

  it('can only warn when no node has an inbound of the profile active, and says it matters only if one does', () => {
    const profileUuid = uid(0x42);
    const unused = profile(0x42, 'Nobody', [
      inbound(0x421, profileUuid, 'A', 443),
      inbound(0x422, profileUuid, 'B', 443),
    ]);
    const nobody: PanelModel = { ...healthyFleet(), profiles: [unused], nodes: [], hosts: [] };
    const found = find(nobody, rule);
    assert.equal(found.length, 1);
    assert.equal(at(found, 0).code, 'possible_clash');
    assert.equal(at(found, 0).severity, 'warning');
    assert.match(at(found, 0).message, /only if they become active on one node/u);

    // A node that uses the profile with nothing active is the same: nothing is running.
    const idle: PanelModel = {
      ...nobody,
      nodes: [node(1, 'Idle', { uuid: profileUuid, inbounds: [] })],
    };
    assert.deepEqual(codes(find(idle, rule)), ['possible_clash']);

    // The pack can still call it an error, as it can for any rule.
    assert.equal(at(find(nobody, rule, { severity: 'error' }), 0).severity, 'error');
  });

  it('compares everything it is told: a node of another profile does not count for this one', () => {
    const profileUuid = uid(0x43);
    const a = inbound(0x431, profileUuid, 'A', 443);
    const b = inbound(0x432, profileUuid, 'B', 443);
    const model: PanelModel = {
      ...healthyFleet(),
      profiles: [profile(0x43, 'Mine', [a, b])],
      nodes: [node(1, 'Elsewhere', { uuid: uid(0x99), inbounds: [a, b] })],
      hosts: [],
    };
    assert.deepEqual(codes(find(model, rule)), ['possible_clash']);
  });
});

const codes = (found: readonly ConventionFinding[]): string[] => found.map((f) => f.code).sort();

describe('host.duplicate on the common layout', () => {
  const fleet = realLayout();
  const duplicates = (model: PanelModel): ReconciliationRow[] =>
    reconciled(model).filter((row) => row.check === 'host.duplicate');

  it('is quiet for a "global" and a "selective" host of one node: only remark, position and template differ', () => {
    const [global, selective] = fleet.hosts;
    assert.ok(global !== undefined && selective !== undefined);
    assert.equal(global.address, selective.address);
    assert.equal(global.port, selective.port);
    assert.equal(global.sni, selective.sni);
    assert.deepEqual(global.inbound, selective.inbound);
    assert.notEqual(global.xrayJsonTemplateUuid, selective.xrayJsonTemplateUuid);
    assert.deepEqual(duplicates(fleet), []);
  });

  it('reports a true duplicate: the same entry under another remark and position, each with the other', () => {
    const copy = { ...at(fleet.hosts, 1), uuid: uid(0x2f00), remark: 'Copy', viewPosition: 99 };
    const rows = duplicates({ ...fleet, hosts: [...fleet.hosts, copy] });
    assert.deepEqual(rows.map((row) => row.subject.name).sort(), ['Copy', 'Selective 1']);
    assert.ok(rows.every((row) => row.status === 'drift' && row.related.length === 1));
    assert.ok(rows.every((row) => row.reason.includes('the same entry')));
  });

  it('does not take a copy for a duplicate when anything that selects what a client gets differs', () => {
    const original = at(fleet.hosts, 1);
    const differences: Record<string, Partial<typeof original>> = {
      template: { xrayJsonTemplateUuid: fleet.defaults[0]?.uuid ?? null },
      port: { port: 8443 },
      sni: { sni: 'other.example.com' },
      path: { path: '/x' },
      alpn: { alpn: 'h2' },
      fingerprint: { fingerprint: 'firefox' },
      route: { vlessRouteId: 1001 },
      squads: { internalSquads: { mode: 'ALLOW_ONLY', squadUuids: [uid(0x3001)] } },
      tags: { tags: ['OTHER'] },
      options: { muxParams: { enabled: true } },
      description: { serverDescription: 'another text' },
      types: { excludeFromSubscriptionTypes: ['CLASH'] },
    };
    for (const [name, change] of Object.entries(differences)) {
      const copy = { ...original, ...change, uuid: uid(0x2f01), remark: 'Copy' };
      assert.deepEqual(duplicates({ ...fleet, hosts: [...fleet.hosts, copy] }), [], name);
    }
  });

  it('sees through what does not select anything: the case of the address and the order of the lists', () => {
    const original = at(fleet.hosts, 1);
    const tagged = { ...original, tags: ['B', 'A'], uuid: uid(0x2f02) };
    const retagged = {
      ...original,
      tags: ['A', 'B'],
      uuid: uid(0x2f03),
      remark: 'Same tags',
      sni: original.sni?.toUpperCase() ?? null,
    };
    const rows = duplicates({ ...fleet, hosts: [tagged, retagged] });
    assert.equal(rows.length, 2);
  });

  it('leaves out a disabled host: it is in no subscription, so it duplicates nothing', () => {
    const original = at(fleet.hosts, 1);
    const spare = { ...original, uuid: uid(0x2f04), remark: 'Spare', isDisabled: true };
    assert.deepEqual(duplicates({ ...fleet, hosts: [...fleet.hosts, spare] }), []);
  });

  it('still reports three of one entry, with the others of each', () => {
    const original = at(fleet.hosts, 1);
    const copies = [uid(0x2f05), uid(0x2f06)].map((id, i) => ({
      ...original,
      uuid: id,
      remark: `Copy ${String(i)}`,
    }));
    const rows = duplicates({ ...fleet, hosts: [...fleet.hosts, ...copies] });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.related.length === 2));
  });
});

describe('template.body-present and template.unused on what the list gives', () => {
  const fleet = realLayout();

  it('never takes a body that was not read for a missing one', () => {
    // As the list of the panel gives them: both bodies null, nothing read.
    const unread = fleet.templates.map((t) => ({
      ...t,
      templateJson: null,
      templateYaml: null,
      bodyLoaded: false,
    }));
    const found = find({ ...fleet, templates: unread }, 'template.body-present');
    assert.equal(found.length, 10);
    assert.ok(found.every((f) => f.code === 'not_loaded' && f.severity === 'info'));
    assert.ok(found.every((f) => !/empty or could not be read/u.test(f.message)));
  });

  it('still reports a body that was read and is empty, and one that was read and is fine', () => {
    const readEmpty = template(30, 'Read, empty', 'XRAY_JSON', { templateJson: null });
    const readFine = template(31, 'Read, fine', 'XRAY_JSON');
    const found = find({ ...fleet, templates: [readEmpty, readFine] }, 'template.body-present');
    assert.deepEqual(
      found.map((f) => [f.object.name, f.code]),
      [['Read, empty', 'unreadable']],
    );
  });

  it('does not report the Default template of a type as unused, and still reports another one', () => {
    assert.deepEqual(find(fleet, 'template.unused'), []);
    const stray = template(40, 'Stray', 'XRAY_JSON');
    assert.deepEqual(
      find({ ...fleet, templates: [...fleet.templates, stray] }, 'template.unused').map(
        (f) => f.object.name,
      ),
      ['Stray'],
    );
    // The names left out are the pack's to say: without any, the five Defaults of the real fleet are reported.
    assert.equal(find(fleet, 'template.unused', { params: { ignoreNames: [] } }).length, 5);
  });
});

describe('host.sni-explicit on an inbound without security', () => {
  const rule = 'host.sni-explicit';
  const profileUuid = uid(0x50);
  const plain = inbound(0x501, profileUuid, 'PLAIN', 8080, { security: 'none' });
  const reality = inbound(0x502, profileUuid, 'REALITY', 443);
  const base = { ...healthyFleet(), profiles: [profile(0x50, 'P', [plain, reality])] };

  it('has nothing to say about a host with no SNI that takes the security of an inbound that has none', () => {
    const hosts = [host(1, 'plain', { profile: profileUuid, inbound: plain.uuid }, { sni: null })];
    assert.deepEqual(find({ ...base, hosts }, rule), []);
  });

  it('still reports it for a REALITY inbound, and for a host that forces TLS on a plain inbound', () => {
    const hosts = [
      host(1, 'reality', { profile: profileUuid, inbound: reality.uuid }, { sni: null }),
      host(
        2,
        'forced',
        { profile: profileUuid, inbound: plain.uuid },
        { sni: null, securityLayer: 'TLS' },
      ),
    ];
    assert.deepEqual(
      find({ ...base, hosts }, rule)
        .map((f) => f.object.name)
        .sort(),
      ['forced', 'reality'],
    );
  });
});

describe('the impact calculator on the common layout', () => {
  const fleet = realLayout();
  const impact = (
    kind: 'configProfile' | 'internalSquad',
    uuid: string,
    change: Record<string, unknown>,
  ) => calculateImpact({ model: fleet, pack: pack(), kind, uuid, change });

  it('restarts the twelve nodes of the profile that holds twelve inbounds, and one node for each of the others', () => {
    const edited = (profileRef: (typeof fleet.profiles)[number]) => {
      const config = structuredClone(profileRef.config) as { log: { loglevel: string } };
      config.log.loglevel = 'debug';
      return impact('configProfile', profileRef.uuid, { config });
    };
    const [main, hop, exit] = fleet.profiles;
    assert.ok(main !== undefined && hop !== undefined && exit !== undefined);
    assert.equal(edited(main).restarts.length, 12);
    assert.equal(edited(hop).restarts.length, 1);
    assert.equal(edited(exit).restarts.length, 1);
    assert.ok(edited(main).restarts.every((r) => r.rule === 'profile.config-edit'));
  });

  it('restarts only the node that has the inbound active when an inbound leaves a squad', () => {
    const squad = at(fleet.internalSquads, 0);
    const without = squad.inbounds.filter((i) => i.tag !== 'NODE_03').map((i) => i.uuid);
    const report = impact('internalSquad', squad.uuid, { inbounds: without });
    assert.deepEqual(
      report.restarts.map((r) => r.node.name),
      ['Node 3'],
    );
    assert.deepEqual(
      report.rules.map((r) => r.id),
      ['squad.inbounds-changed'],
    );
  });
});

describe('a template whose body was not read, in the impact calculator', () => {
  it('cannot tell whether the proposed body differs, says so, and counts the edit as a change', () => {
    const fleet = realLayout();
    const unread = {
      ...fleet.selective,
      templateJson: null,
      templateYaml: null,
      bodyLoaded: false,
    };
    const model = {
      ...fleet,
      templates: fleet.templates.map((t) => (t.uuid === unread.uuid ? unread : t)),
    };
    const report = calculateImpact({
      model,
      pack: pack(),
      kind: 'subscriptionTemplate',
      uuid: unread.uuid,
      change: { templateJson: { outbounds: [] } },
    });
    assert.equal(report.changed, true);
    assert.ok(report.notes.some((note) => /was not read/u.test(note.message)));
    // The same edit against a template that was read, with the same body, changes nothing.
    const read = calculateImpact({
      model: fleet,
      pack: pack(),
      kind: 'subscriptionTemplate',
      uuid: fleet.selective.uuid,
      change: { templateJson: fleet.selective.templateJson },
    });
    assert.equal(read.changed, false);
  });
});
