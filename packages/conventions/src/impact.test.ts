import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTION_PACK_FORMAT,
  type ConventionPackDocument,
  type ImpactKind,
  type ImpactReport,
  ImpactReportSchema,
  type JsonPatchOperation,
} from '@swellwright/contracts';

import {
  calculateImpact,
  describeImpactRules,
  editableForm,
  IMPACT_RULES,
  IMPACT_RULES_VERSION,
  ImpactError,
} from './impact.js';
import type { PanelModel } from './model.js';
import { checkPackValue, resolvePack, type ResolvedPack } from './pack.js';
import {
  at,
  externalSquad,
  healthyFleet,
  host,
  inbound,
  internalSquad,
  must,
  node,
  profile,
  profileWithConfig,
  template,
  uid,
} from './test-model.js';

const pack = (impact: NonNullable<ConventionPackDocument['impact']> = {}): ResolvedPack => {
  const checked = checkPackValue({ format: CONVENTION_PACK_FORMAT, name: 'p', impact });
  if (checked.document === null) {
    throw new Error(JSON.stringify(checked.result.issues));
  }
  return resolvePack(checked.document, 'custom', 1);
};

/** Every report is checked against the contract, so the console never receives a shape it does not know. */
function calculate(
  model: PanelModel,
  kind: ImpactKind,
  uuid: string,
  change: Record<string, unknown> | JsonPatchOperation[],
  settings = pack(),
): ImpactReport {
  const report = calculateImpact({ model, pack: settings, kind, uuid, change });
  return ImpactReportSchema.parse(report);
}

const config = (model: ReturnType<typeof healthyFleet>) =>
  structuredClone(model.profileOne.config) as { inbounds: Record<string, unknown>[] } & Record<
    string,
    unknown
  >;

/** The healthy fleet and a second, solo profile with its own node and host. */
function fleetWithSolo() {
  const fleet = healthyFleet();
  const soloProfileUuid = uid(2);
  const soloInbound = inbound(0x201, soloProfileUuid, 'SOLO', 9443);
  const solo = profileWithConfig(2, 'Solo', [soloInbound]);
  const soloNode = node(
    4,
    'Solo node',
    { uuid: soloProfileUuid, inbounds: [soloInbound] },
    { address: 'solo.example.com', usersOnline: 3 },
  );
  const soloHost = host(
    4,
    'Solo host',
    { profile: soloProfileUuid, inbound: soloInbound.uuid },
    { address: '192.0.2.14', nodeUuids: [soloNode.uuid] },
  );
  const model: PanelModel = {
    ...fleet,
    nodes: [...fleet.nodes, soloNode],
    hosts: [...fleet.hosts, soloHost],
    profiles: [
      ...fleet.profiles,
      {
        ...solo,
        nodes: [{ uuid: soloNode.uuid, name: soloNode.name, countryCode: 'NL' }],
        nodeCount: 1,
      },
    ],
    internalSquads: [
      ...fleet.internalSquads,
      internalSquad(2, 'Solo squad', [soloInbound], { membersCount: 4 }),
    ],
  };
  return { fleet, model, soloProfileUuid, soloInbound, soloNode, soloHost, solo };
}

describe('the acceptance case: editing one inbound of a shared profile', () => {
  const { model, fleet } = fleetWithSolo();
  const edited = (() => {
    const c = config(fleet);
    at(c.inbounds, 0)['sniffing'] = {
      enabled: true,
      destOverride: ['http', 'tls'],
      routeOnly: true,
    };
    return c;
  })();

  it('restarts all the nodes of the profile, though only one inbound changed, by the rule that says so', () => {
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: edited });
    assert.equal(report.changed, true);
    assert.deepEqual(
      report.restarts.map((r) => r.node.name),
      ['Node 1', 'Node 2', 'Node 3'],
    );
    assert.ok(
      report.restarts.every((r) => r.rule === 'profile.config-edit' && r.action === 'restart'),
    );
    assert.deepEqual(
      report.rules.map((r) => [r.id, r.basis, r.effect]),
      [['profile.config-edit', 'observed', 'restart']],
    );
    assert.deepEqual(report.inbounds, { added: [], removed: [], changed: ['MAIN'], renamed: [] });
    assert.equal(report.rulesVersion, IMPACT_RULES_VERSION);
    assert.equal(report.risk.level, 'high');
    assert.ok(
      report.risk.reasons.some((r) => r.code === 'restart_count_high' && r.level === 'high'),
    );
    assert.deepEqual(report.users, { onlineOnRestartedNodes: 5 + 5 + 5, squadMembersUpTo: 10 });
    assert.deepEqual(
      report.affected.internalSquads.map((s) => s.name),
      ['Squad One'],
    );
    assert.deepEqual(report.affected.hosts.map((h) => h.name).sort(), [
      'Host 1',
      'Host 2',
      'Host 3',
    ]);
    assert.deepEqual(report.dangling, []);
    assert.deepEqual(
      report.changes.map((c) => c.path),
      ['/config/inbounds/0/sniffing'],
    );
  });

  it('is the same as a JSON Patch of the editable form', () => {
    const asObject = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: edited });
    const asPatch = calculate(model, 'configProfile', fleet.profileOne.uuid, [
      {
        op: 'add',
        path: '/config/inbounds/0/sniffing',
        value: { enabled: true, destOverride: ['http', 'tls'], routeOnly: true },
      },
    ]);
    assert.deepEqual(asPatch.restarts, asObject.restarts);
    assert.deepEqual(asPatch.changes, asObject.changes);
    assert.deepEqual(asPatch.risk, asObject.risk);
  });

  it('suggests a clone of the profile for the node that needs the change, naming how many others stay untouched', () => {
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: edited });
    assert.equal(report.saferWay?.code, 'clone_profile');
    const safer = must(report.saferWay);
    assert.equal(safer.params['others'], 2);
    assert.match(safer.message, /Clone the profile/u);
    assert.equal(safer.messageKey, 'impact.safer.clone_profile');
  });

  it('does not restart the nodes of other profiles', () => {
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: edited });
    assert.ok(!report.restarts.some((r) => r.node.name === 'Solo node'));
  });

  it('restarts only the nodes of the clone when the same edit is made on a profile of one node, and has no safer way to offer', () => {
    const { model: m, solo, soloNode } = fleetWithSolo();
    const c = structuredClone(solo.config) as { inbounds: Record<string, unknown>[] };
    at(c.inbounds, 0)['sniffing'] = { enabled: true };
    const report = calculate(m, 'configProfile', solo.uuid, { config: c });
    assert.deepEqual(
      report.restarts.map((r) => r.node.uuid),
      [soloNode.uuid],
    );
    assert.equal(report.saferWay, null);
    assert.equal(report.risk.level, 'medium');
  });

  it('does not restart a disabled node of the profile, and lists it as skipped', () => {
    const off = {
      ...model,
      nodes: model.nodes.map((n) =>
        n.name === 'Node 2' ? { ...n, isDisabled: true, state: 'disabled' as const } : n,
      ),
    };
    const report = calculate(off, 'configProfile', fleet.profileOne.uuid, { config: edited });
    assert.deepEqual(
      report.restarts.map((r) => r.node.name),
      ['Node 1', 'Node 3'],
    );
    assert.deepEqual(
      report.skipped.map((s) => [s.node.name, s.reason]),
      [['Node 2', 'disabled']],
    );
  });

  it('notes the nodes that are offline and will restart when they come back', () => {
    const offline = {
      ...model,
      nodes: model.nodes.map((n) =>
        n.name === 'Node 3'
          ? { ...n, state: 'offline' as const, isConnected: false, usersOnline: null }
          : n,
      ),
    };
    const report = calculate(offline, 'configProfile', fleet.profileOne.uuid, { config: edited });
    assert.ok(report.notes.some((n) => n.code === 'offline_nodes' && n.params['count'] === 1));
    assert.equal(report.users.onlineOnRestartedNodes, 10);
  });

  it('judges the risk by the thresholds of the pack, not by a number of its own', () => {
    const many = {
      ...model,
      nodes: [
        ...model.nodes,
        ...[10, 11, 12, 13, 14, 15].map((n) => node(n, `Extra ${String(n)}`, null)),
      ],
    };
    // 3 of 10 running nodes restart: below half, but at the default limit of three nodes.
    assert.equal(
      calculate(many, 'configProfile', fleet.profileOne.uuid, { config: edited }).risk.level,
      'high',
    );
    // A pack that allows five before it calls it high, and a share of half: 3 of 10 is medium.
    const relaxed = calculate(
      many,
      'configProfile',
      fleet.profileOne.uuid,
      { config: edited },
      pack({ highRiskRestartNodes: 5 }),
    );
    assert.equal(relaxed.risk.level, 'medium');
    assert.ok(relaxed.risk.reasons.some((r) => r.code === 'restarts_some'));
    // And a pack that is stricter about the share.
    const strict = calculate(
      many,
      'configProfile',
      fleet.profileOne.uuid,
      { config: edited },
      pack({ highRiskRestartNodes: 5, highRiskRestartShare: 0.25 }),
    );
    assert.equal(strict.risk.level, 'high');
    assert.ok(strict.risk.reasons.some((r) => r.code === 'restart_share_high'));
  });
});

describe('profile edits that restart nothing, or change nothing', () => {
  const { model, fleet } = fleetWithSolo();

  it('a new name or new tags restart no node', () => {
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, {
      name: 'Renamed',
      tags: ['x'],
    });
    assert.equal(report.changed, true);
    assert.deepEqual(report.restarts, []);
    assert.deepEqual(
      report.rules.map((r) => r.id),
      ['profile.name-only'],
    );
    assert.equal(report.risk.level, 'low');
    assert.ok(report.risk.reasons.some((r) => r.code === 'no_restart'));
  });

  it('the same configuration, or the same with its keys in another order, is no change', () => {
    const same = calculate(model, 'configProfile', fleet.profileOne.uuid, {
      config: structuredClone(fleet.profileOne.config),
    });
    assert.equal(same.changed, false);
    assert.deepEqual(same.rules, []);
    assert.deepEqual(same.restarts, []);
    assert.equal(same.risk.level, 'low');
    assert.equal(at(same.risk.reasons, 0).code, 'no_effect');
    const c = config(fleet);
    const reordered = Object.fromEntries(Object.entries(c).reverse());
    assert.equal(
      calculate(model, 'configProfile', fleet.profileOne.uuid, { config: reordered }).changed,
      false,
    );
  });
});

describe('inbounds added, removed, renamed and changed', () => {
  const { model, fleet, soloProfileUuid } = fleetWithSolo();

  it('names the inbounds a configuration adds, and does not call them dangling', () => {
    const c = config(fleet);
    c.inbounds.push({
      tag: 'NEW',
      port: 9999,
      protocol: 'vless',
      streamSettings: { network: 'raw', security: 'reality' },
    });
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.deepEqual(report.inbounds, { added: ['NEW'], removed: [], changed: [], renamed: [] });
    assert.deepEqual(report.dangling, []);
    assert.equal(report.restarts.length, 3, 'any edit of the configuration restarts every node');
  });

  it('lists what would point at an inbound that is gone: hosts, squads and the nodes that serve it', () => {
    const c = config(fleet);
    c.inbounds = c.inbounds.filter((i) => i['tag'] !== 'MAIN');
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.deepEqual(report.inbounds?.removed, ['MAIN']);
    const from = report.dangling.map((d) => `${d.from.kind}:${d.from.name}:${d.reason}`).sort();
    assert.deepEqual(from, [
      'host:Host 1:removed',
      'host:Host 2:removed',
      'host:Host 3:removed',
      'internalSquad:Squad One:removed',
      'node:Node 1:removed',
      'node:Node 2:removed',
      'node:Node 3:removed',
    ]);
    assert.deepEqual(report.unserved.map((u) => [u.host.name, u.reason]).sort(), [
      ['Host 1', 'inbound_removed'],
      ['Host 2', 'inbound_removed'],
      ['Host 3', 'inbound_removed'],
    ]);
    assert.equal(report.risk.level, 'high');
    assert.ok(report.risk.reasons.some((r) => r.code === 'dangling_refs'));
    assert.ok(report.risk.reasons.some((r) => r.code === 'hosts_unserved'));
    // And the linter, run on the state after, says the hosts and the squad now point nowhere.
    const introduced = report.findings.introduced.map((f) => f.ruleId);
    assert.ok(introduced.includes('host.inbound-exists'));
    assert.ok(introduced.includes('squad.inbound-exists'));
    assert.ok(report.risk.reasons.some((r) => r.code === 'introduces_errors'));
  });

  it('removing an inbound nothing uses leaves nothing dangling', () => {
    const c = config(fleet);
    c.inbounds = c.inbounds.filter((i) => i['tag'] !== 'SECOND');
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.deepEqual(report.inbounds?.removed, ['SECOND']);
    assert.deepEqual(
      report.dangling.map((d) => d.from.name),
      ['Squad One'],
    );
    assert.deepEqual(report.unserved, []);
  });

  it('recognises a rename by the same port and protocol, and says that the old name is lost to hosts and squads', () => {
    const c = config(fleet);
    at(c.inbounds, 0)['tag'] = 'MAIN_RENAMED';
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.deepEqual(report.inbounds, {
      added: [],
      removed: [],
      changed: [],
      renamed: [{ from: 'MAIN', to: 'MAIN_RENAMED' }],
    });
    assert.ok(report.dangling.length > 0 && report.dangling.every((d) => d.reason === 'renamed'));
    assert.ok(report.notes.some((n) => n.code === 'inbounds_renamed'));
  });

  it('introduces a port clash when the new inbound reuses a port, and flags it as an error', () => {
    const c = config(fleet);
    c.inbounds.push({
      tag: 'CLASH',
      port: 443,
      protocol: 'vless',
      streamSettings: { network: 'raw', security: 'reality' },
    });
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.ok(
      report.findings.introduced.some(
        (f) => f.ruleId === 'profile.inbound-port-clash' && f.severity === 'error',
      ),
    );
    assert.equal(report.risk.level, 'high');
  });

  it('introduces a missing snippet when the configuration names one that does not exist, and fixes one that does', () => {
    const c = config(fleet);
    c['snippets'] = ['NOT_THERE'];
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.ok(report.findings.introduced.some((f) => f.ruleId === 'profile.snippet-exists'));
    const fixedFirst = {
      ...model,
      profiles: model.profiles.map((p) =>
        p.uuid === fleet.profileOne.uuid
          ? { ...p, config: { ...(p.config as object), snippets: ['NOT_THERE'] } }
          : p,
      ),
    };
    const fixed = calculate(fixedFirst, 'configProfile', fleet.profileOne.uuid, {
      config: config(fleet),
    });
    assert.ok(fixed.findings.fixed.some((f) => f.ruleId === 'profile.snippet-exists'));
    assert.deepEqual(fixed.findings.introduced, []);
  });

  it('leaves the other profile alone', () => {
    const c = config(fleet);
    c.inbounds = [];
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.ok(
      !report.dangling.some((d) => d.from.name === 'Solo squad' || d.from.name === 'Solo node'),
    );
    assert.ok(soloProfileUuid.length > 0);
  });
});

describe('masked values', () => {
  const { model, fleet } = fleetWithSolo();
  const LITERAL = 'LITERAL-SECRET-VALUE-9f3a1';

  it('treats a mask repeated as it was as unchanged', () => {
    const c = config(fleet);
    (
      c.inbounds[0] as { streamSettings: { realitySettings: Record<string, unknown> } }
    ).streamSettings.realitySettings['privateKey'] = '[masked:00000001]';
    assert.equal(
      calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c }).changed,
      false,
    );
  });

  it('counts a value in place of a mask as a change of a secret, names the path, and never repeats the value', () => {
    const c = config(fleet);
    (
      c.inbounds[0] as { streamSettings: { realitySettings: Record<string, unknown> } }
    ).streamSettings.realitySettings['privateKey'] = LITERAL;
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.equal(report.changed, true);
    assert.equal(report.restarts.length, 3);
    const note = report.notes.find((n) => n.code === 'secret_changed');
    assert.match(String(note?.params['paths']), /privateKey/u);
    assert.ok(report.risk.reasons.some((r) => r.code === 'secret_changed'));
    assert.ok(
      !JSON.stringify(report).includes(LITERAL),
      'the value of the proposal is not in the answer',
    );
    assert.ok(!JSON.stringify(report.changes).includes(LITERAL));
  });

  it('does not echo any value of a proposal, whatever kind of object it is for', () => {
    const secret = 'SECRET-IN-A-HOST-FIELD-77';
    const report = calculate(model, 'host', at(model.hosts, 0).uuid, {
      serverDescription: secret,
      remark: secret,
    });
    assert.ok(!JSON.stringify(report).includes(secret));
  });
});

describe('internal squads', () => {
  const { model, fleet, soloInbound } = fleetWithSolo();
  const squad = at(fleet.internalSquads, 0);

  it('restarts the nodes that serve an inbound added to or removed from the list, and only those', () => {
    const report = calculate(model, 'internalSquad', squad.uuid, {
      inbounds: [fleet.inboundMain.uuid, fleet.inboundSecond.uuid, soloInbound.uuid],
    });
    assert.deepEqual(
      report.restarts.map((r) => r.node.name),
      ['Solo node'],
    );
    assert.deepEqual(
      report.rules.map((r) => [r.id, r.basis]),
      [['squad.inbounds-changed', 'observed']],
    );
    assert.equal(report.risk.level, 'medium');
    const removeMain = calculate(model, 'internalSquad', squad.uuid, {
      inbounds: [fleet.inboundSecond.uuid],
    });
    assert.deepEqual(
      removeMain.restarts.map((r) => r.node.name),
      ['Node 1', 'Node 2', 'Node 3'],
    );
    assert.equal(at(removeMain.restarts, 0).rule, 'squad.inbounds-changed');
  });

  it('restarts nothing when the inbound that changes is on no node', () => {
    const report = calculate(model, 'internalSquad', squad.uuid, {
      inbounds: [fleet.inboundMain.uuid],
    });
    assert.deepEqual(report.restarts, [], 'SECOND is active on no node');
    assert.deepEqual(
      report.rules.map((r) => r.id),
      ['squad.inbounds-changed'],
    );
    assert.equal(report.risk.level, 'low');
  });

  it('takes inbounds by uuid or by tag, and refuses one it does not know or one that is ambiguous', () => {
    const byTag = calculate(model, 'internalSquad', squad.uuid, { inbounds: ['MAIN', 'SOLO'] });
    assert.deepEqual(
      byTag.restarts.map((r) => r.node.name),
      ['Solo node'],
    );
    assert.throws(
      () =>
        calculateImpact({
          model,
          pack: pack(),
          kind: 'internalSquad',
          uuid: squad.uuid,
          change: { inbounds: ['NOPE'] },
        }),
      (e: unknown) =>
        e instanceof ImpactError && e.code === 'invalid_change' && e.message.includes('NOPE'),
    );
    const twin = {
      ...model,
      profiles: [...model.profiles, profile(7, 'Twin', [inbound(0x301, uid(7), 'MAIN', 1)])],
    };
    assert.throws(
      () =>
        calculateImpact({
          model: twin,
          pack: pack(),
          kind: 'internalSquad',
          uuid: squad.uuid,
          change: { inbounds: ['MAIN'] },
        }),
      /several profiles/u,
    );
  });

  it('a new name or tags restart nothing; members are users and are not compared', () => {
    const meta = calculate(model, 'internalSquad', squad.uuid, { name: 'Squad Renamed' });
    assert.deepEqual(
      meta.rules.map((r) => r.id),
      ['squad.metadata-only'],
    );
    assert.deepEqual(meta.restarts, []);
    const members = calculate(model, 'internalSquad', squad.uuid, { members: [1, 2, 3] });
    assert.equal(members.changed, true);
    assert.deepEqual(
      members.rules.map((r) => r.id),
      ['squad.members-changed'],
    );
    assert.ok(members.notes.some((n) => n.code === 'members_not_modelled'));
    assert.ok(!members.notes.some((n) => n.code === 'ignored_fields'));
    assert.deepEqual(members.restarts, []);
  });

  it('counts the members of the squads that reach the nodes, as an upper bound', () => {
    const report = calculate(model, 'internalSquad', squad.uuid, {
      inbounds: [fleet.inboundSecond.uuid],
    });
    assert.equal(report.users.squadMembersUpTo, 10);
  });
});

describe('nodes', () => {
  const { model, soloProfileUuid, soloInbound, soloNode, fleet } = fleetWithSolo();
  const node1 = at(fleet.nodes, 0);

  it('moving a node to another profile restarts that node and no other', () => {
    const report = calculate(model, 'node', node1.uuid, {
      configProfile: {
        activeConfigProfileUuid: soloProfileUuid,
        activeInbounds: [soloInbound.uuid],
      },
    });
    assert.deepEqual(
      report.restarts.map((r) => [r.node.name, r.rule, r.action]),
      [['Node 1', 'node.profile-move', 'restart']],
    );
    assert.deepEqual(
      report.rules.map((r) => r.id),
      ['node.profile-move'],
    );
    // Hosts 2 and 3 are still served by the other nodes of the profile; nothing is left unserved.
    assert.deepEqual(report.unserved, []);
    assert.equal(report.risk.level, 'medium');
  });

  it('says which hosts lose their last node when the only server of an inbound moves away', () => {
    const report = calculate(model, 'node', soloNode.uuid, {
      configProfile: {
        activeConfigProfileUuid: fleet.profileOne.uuid,
        activeInbounds: [fleet.inboundMain.uuid],
      },
    });
    assert.deepEqual(
      report.unserved.map((u) => [u.host.name, u.reason]),
      [['Solo host', 'node_moved']],
    );
    assert.equal(report.risk.level, 'high');
    assert.ok(report.risk.reasons.some((r) => r.code === 'hosts_unserved'));
  });

  it('changing only the active inbounds restarts that node', () => {
    const report = calculate(model, 'node', node1.uuid, {
      configProfile: {
        activeConfigProfileUuid: fleet.profileOne.uuid,
        activeInbounds: [fleet.inboundMain.uuid, fleet.inboundSecond.uuid],
      },
    });
    assert.deepEqual(
      report.restarts.map((r) => r.rule),
      ['node.active-inbounds-changed'],
    );
    const byTag = calculate(model, 'node', node1.uuid, {
      configProfile: {
        activeConfigProfileUuid: fleet.profileOne.uuid,
        activeInbounds: ['MAIN', 'SECOND'],
      },
    });
    assert.deepEqual(
      byTag.restarts.map((r) => r.rule),
      ['node.active-inbounds-changed'],
    );
  });

  it('refuses a profile that does not exist and an active inbound that is not in the profile', () => {
    for (const configProfile of [
      { activeConfigProfileUuid: uid(0x999), activeInbounds: [] },
      { activeConfigProfileUuid: fleet.profileOne.uuid, activeInbounds: [soloInbound.uuid] },
    ]) {
      assert.throws(
        () =>
          calculateImpact({
            model,
            pack: pack(),
            kind: 'node',
            uuid: node1.uuid,
            change: { configProfile },
          }),
        (e: unknown) => e instanceof ImpactError && e.code === 'invalid_change',
      );
    }
  });

  it('disabling a node stops it and disconnects its users, and does not restart the others', () => {
    const report = calculate(model, 'node', node1.uuid, { isDisabled: true });
    assert.deepEqual(
      report.restarts.map((r) => [r.node.name, r.action, r.rule, r.usersOnline]),
      [['Node 1', 'stop', 'node.disable', 5]],
    );
    assert.equal(at(report.rules, 0).effect, 'stop');
    assert.deepEqual(report.unserved, []);
    assert.deepEqual(report.users.onlineOnRestartedNodes, 5);
  });

  it('says that disabling the last node of an inbound leaves its hosts unserved', () => {
    const report = calculate(model, 'node', soloNode.uuid, { isDisabled: true });
    assert.deepEqual(
      report.unserved.map((u) => [u.host.name, u.reason]),
      [['Solo host', 'node_disabled']],
    );
    assert.equal(report.risk.level, 'high');
  });

  it('enabling a node starts it: it is listed, but it is not a restart and not a risk', () => {
    const off = {
      ...model,
      nodes: model.nodes.map((n) =>
        n.uuid === node1.uuid ? { ...n, isDisabled: true, state: 'disabled' as const } : n,
      ),
    };
    const report = calculate(off, 'node', node1.uuid, { isDisabled: false });
    assert.deepEqual(
      report.restarts.map((r) => [r.action, r.rule]),
      [['start', 'node.enable']],
    );
    assert.equal(report.risk.level, 'low');
  });

  it('a change of address or port makes the panel connect again, which restarts that node (an assumption, and labelled so)', () => {
    const report = calculate(model, 'node', node1.uuid, { address: 'new.example.com' });
    assert.deepEqual(
      report.restarts.map((r) => r.rule),
      ['node.connection-changed'],
    );
    assert.equal(at(report.rules, 0).basis, 'assumed');
    assert.equal(calculate(model, 'node', node1.uuid, { port: 62_051 }).restarts.length, 1);
  });

  it('a new name, tags or note restart nothing', () => {
    const report = calculate(model, 'node', node1.uuid, {
      name: 'Renamed',
      note: 'hello',
      tags: ['a'],
    });
    assert.deepEqual(report.restarts, []);
    assert.deepEqual(
      report.rules.map((r) => r.id),
      ['node.metadata-only'],
    );
    assert.equal(report.risk.level, 'low');
  });

  it('moving a node that is disabled restarts nothing: it applies when the node is enabled', () => {
    const off = {
      ...model,
      nodes: model.nodes.map((n) =>
        n.uuid === node1.uuid ? { ...n, isDisabled: true, state: 'disabled' as const } : n,
      ),
    };
    const report = calculate(off, 'node', node1.uuid, {
      configProfile: {
        activeConfigProfileUuid: soloProfileUuid,
        activeInbounds: [soloInbound.uuid],
      },
    });
    assert.deepEqual(report.restarts, []);
    assert.deepEqual(
      report.skipped.map((s) => s.node.name),
      ['Node 1'],
    );
  });

  it('introduces a finding when the new address is not an address, and reports the old address as fixed when it is mended', () => {
    const bad = calculate(model, 'node', node1.uuid, { address: 'not an address' });
    assert.ok(bad.findings.introduced.some((f) => f.ruleId === 'node.address-valid'));
    assert.equal(bad.risk.level, 'high');
    const broken = {
      ...model,
      nodes: model.nodes.map((n) => (n.uuid === node1.uuid ? { ...n, address: '???' } : n)),
    };
    const mended = calculate(broken, 'node', node1.uuid, { address: 'n1.example.com' });
    assert.ok(mended.findings.fixed.some((f) => f.ruleId === 'node.address-valid'));
  });

  it('refuses a node with the wrong kind of value', () => {
    assert.throws(
      () =>
        calculateImpact({
          model,
          pack: pack(),
          kind: 'node',
          uuid: node1.uuid,
          change: { port: 'high' },
        }),
      (e: unknown) => e instanceof ImpactError && e.message.includes('port'),
    );
    assert.throws(
      () =>
        calculateImpact({
          model,
          pack: pack(),
          kind: 'node',
          uuid: node1.uuid,
          change: { isDisabled: 'yes' },
        }),
      ImpactError,
    );
  });
});

describe('hosts', () => {
  const { model, fleet, soloInbound, soloProfileUuid } = fleetWithSolo();
  const host1 = at(fleet.hosts, 0);

  it('editing a host restarts nothing and says which subscriptions change', () => {
    const report = calculate(model, 'host', host1.uuid, { address: '192.0.2.99', port: 8443 });
    assert.deepEqual(report.restarts, []);
    assert.deepEqual(
      report.rules.map((r) => [r.id, r.effect]),
      [['host.edit', 'none']],
    );
    assert.deepEqual(
      report.affected.hosts.map((h) => h.name),
      ['Host 1'],
    );
    assert.deepEqual(
      report.affected.internalSquads.map((s) => s.name),
      ['Squad One'],
    );
    assert.deepEqual(
      report.changes.map((c) => c.path),
      ['/address', '/port'],
    );
    assert.equal(report.risk.level, 'low');
  });

  it('introduces what the linter would find after the edit, and resolves what it finds now', () => {
    const dup = calculate(model, 'host', host1.uuid, { remark: 'Host 2' });
    assert.ok(dup.findings.introduced.some((f) => f.ruleId === 'host.remark-unique'));
    assert.equal(dup.risk.level, 'medium');
    const clashing = {
      ...model,
      hosts: model.hosts.map((h) => (h.uuid === host1.uuid ? { ...h, remark: 'Host 2' } : h)),
    };
    const mended = calculate(clashing, 'host', host1.uuid, { remark: 'Host 1' });
    assert.ok(mended.findings.fixed.some((f) => f.ruleId === 'host.remark-unique'));
    assert.deepEqual(mended.findings.introduced, []);
    const worse = calculate(model, 'host', host1.uuid, { address: '' });
    assert.ok(
      worse.findings.introduced.some(
        (f) => f.ruleId === 'host.address-policy' && f.severity === 'error',
      ),
    );
    assert.equal(worse.risk.level, 'high');
  });

  it('says when the host would point at an inbound the panel does not list, or that no node serves', () => {
    const lost = calculate(model, 'host', host1.uuid, {
      inbound: { configProfileUuid: fleet.profileOne.uuid, configProfileInboundUuid: uid(0x999) },
    });
    assert.deepEqual(
      lost.dangling.map((d) => [d.from.name, d.reason]),
      [['Host 1', 'unlisted']],
    );
    const unserved = calculate(model, 'host', host1.uuid, {
      inbound: {
        configProfileUuid: fleet.profileOne.uuid,
        configProfileInboundUuid: fleet.inboundSecond.uuid,
      },
    });
    assert.deepEqual(
      unserved.unserved.map((u) => [u.host.name, u.reason]),
      [['Host 1', 'no_node']],
    );
    const fine = calculate(model, 'host', host1.uuid, {
      inbound: { configProfileUuid: soloProfileUuid, configProfileInboundUuid: soloInbound.uuid },
    });
    assert.deepEqual(fine.unserved, []);
  });

  it('names the templates a change of the host template affects', () => {
    const tpl = at(fleet.templates, 0);
    const withTemplate = {
      ...model,
      hosts: model.hosts.map((h) =>
        h.uuid === host1.uuid ? { ...h, xrayJsonTemplateUuid: tpl.uuid } : h,
      ),
    };
    const report = calculate(withTemplate, 'host', host1.uuid, { xrayJsonTemplateUuid: null });
    assert.deepEqual(
      report.affected.templates.map((t) => t.name),
      ['Template One'],
    );
  });

  it('refuses a host with a value of the wrong type', () => {
    for (const change of [{ port: 'x' }, { isDisabled: 'no' }, { inbound: 'x' }, { tags: 'a' }]) {
      assert.throws(
        () => calculateImpact({ model, pack: pack(), kind: 'host', uuid: host1.uuid, change }),
        (e: unknown) => e instanceof ImpactError && e.code === 'invalid_change',
        JSON.stringify(change),
      );
    }
  });
});

describe('subscription templates', () => {
  const { model, fleet } = fleetWithSolo();
  const tpl = at(fleet.templates, 0);

  it('editing a body restarts nothing and names the external squads and their members', () => {
    const report = calculate(model, 'subscriptionTemplate', tpl.uuid, {
      templateJson: { outbounds: [{ tag: 'x' }] },
    });
    assert.deepEqual(report.restarts, []);
    assert.deepEqual(
      report.rules.map((r) => [r.id, r.effect]),
      [['template.edit', 'none']],
    );
    assert.deepEqual(
      report.affected.externalSquads.map((s) => s.name),
      ['External One'],
    );
    assert.deepEqual(
      report.affected.templates.map((t) => t.name),
      ['Template One'],
    );
    assert.equal(report.users.squadMembersUpTo, 7);
    assert.equal(report.risk.level, 'low');
  });

  it('a body that is the same is no change', () => {
    assert.equal(
      calculate(model, 'subscriptionTemplate', tpl.uuid, { templateJson: { outbounds: [] } })
        .changed,
      false,
    );
  });

  it('YAML is compared by what it says, not by how it is written, and one that does not parse is reported', () => {
    const yamlTpl = template(2, 'Yaml', 'MIHOMO', {
      templateYaml: 'proxies:\n  - name: a\n    type: vless\n',
    });
    const m = { ...model, templates: [...model.templates, yamlTpl] };
    const same = calculate(m, 'subscriptionTemplate', yamlTpl.uuid, {
      templateYaml: 'proxies: [ { name: a, type: vless } ]',
    });
    assert.equal(same.changed, false);
    assert.deepEqual(same.changes, []);
    assert.deepEqual(same.restarts, []);
    const broken = calculate(m, 'subscriptionTemplate', yamlTpl.uuid, {
      templateYaml: '{ not: [valid',
    });
    assert.ok(broken.notes.some((n) => n.code === 'template_body_unreadable'));
    assert.ok(broken.findings.introduced.some((f) => f.ruleId === 'template.body-present'));
    assert.equal(broken.risk.level, 'high');
  });

  it('affects the hosts that use the template', () => {
    const used = {
      ...model,
      hosts: model.hosts.map((h, i) => (i === 0 ? { ...h, xrayJsonTemplateUuid: tpl.uuid } : h)),
    };
    const report = calculate(used, 'subscriptionTemplate', tpl.uuid, { name: 'Renamed' });
    assert.deepEqual(
      report.affected.hosts.map((h) => h.name),
      ['Host 1'],
    );
  });
});

describe('a change that cannot be applied', () => {
  const { model, fleet } = fleetWithSolo();

  it('says the object does not exist, for each kind', () => {
    for (const kind of [
      'configProfile',
      'internalSquad',
      'host',
      'node',
      'subscriptionTemplate',
    ] as const) {
      assert.throws(
        () =>
          calculateImpact({ model, pack: pack(), kind, uuid: uid(0xfff), change: { name: 'x' } }),
        (e: unknown) => e instanceof ImpactError && e.code === 'not_found',
        kind,
      );
    }
  });

  it('refuses a patch that does not apply, and names the operation', () => {
    for (const change of [
      [{ op: 'remove', path: '/nothing' }],
      [
        { op: 'replace', path: '/name', value: 'ok' },
        { op: 'add', path: '/config/inbounds/99/tag', value: 'x' },
      ],
      [{ op: 'test', path: '/name', value: 'something else' }],
      [{ op: 'add', path: '/__proto__/x', value: 1 }],
      [{ op: 'add', path: 'no-slash', value: 1 }],
    ] as JsonPatchOperation[][]) {
      assert.throws(
        () =>
          calculateImpact({
            model,
            pack: pack(),
            kind: 'configProfile',
            uuid: fleet.profileOne.uuid,
            change,
          }),
        (e: unknown) =>
          e instanceof ImpactError &&
          e.code === 'invalid_change' &&
          e.message.includes('patch cannot be applied'),
        JSON.stringify(change),
      );
    }
  });

  it('ignores fields that are not part of the editable form, and says which', () => {
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, {
      name: 'Renamed',
      uuid: uid(1),
      nodes: [],
      bogus: 1,
    });
    assert.deepEqual(report.restarts, []);
    const note = report.notes.find((n) => n.code === 'ignored_fields');
    assert.match(String(note?.params['fields']), /bogus/u);
    assert.match(String(note?.params['fields']), /uuid/u);
  });

  it('cannot change its own identity: the object stays the one asked about', () => {
    const report = calculate(model, 'host', at(fleet.hosts, 0).uuid, {
      uuid: uid(0x2002),
      remark: 'x',
    });
    assert.equal(report.target.uuid, at(fleet.hosts, 0).uuid);
  });
});

describe('the editable form an editor starts from', () => {
  const { model, fleet } = fleetWithSolo();

  it('has the fields of the form and not the identity, hash or counters', () => {
    const form = editableForm(model, 'configProfile', fleet.profileOne.uuid);
    assert.equal(form.target.kind, 'configProfile');
    assert.equal(form.target.uuid, fleet.profileOne.uuid);
    assert.deepEqual(Object.keys(form.editable).sort(), ['config', 'name', 'tags']);
  });

  it('starts every kind from something the same kind accepts as a change', () => {
    const asked = [
      ['configProfile', fleet.profileOne.uuid],
      ['internalSquad', at(fleet.internalSquads, 0).uuid],
      ['host', at(fleet.hosts, 0).uuid],
      ['node', at(fleet.nodes, 0).uuid],
    ] as const;
    for (const [kind, uuid] of asked) {
      const form = editableForm(model, kind, uuid);
      // Giving it back unchanged is the empty change: it must be accepted and change nothing.
      const report = calculate(model, kind, uuid, form.editable);
      assert.equal(report.changed, false, kind);
      assert.deepEqual(report.restarts, [], kind);
    }
  });

  it('says whether it holds a masked secret, and does not copy the model', () => {
    const form = editableForm(model, 'configProfile', fleet.profileOne.uuid);
    assert.equal(typeof form.masked, 'boolean');
    const before = JSON.stringify(model);
    (form.editable as { name: string }).name = 'changed by the caller';
    assert.equal(JSON.stringify(model), before);
  });

  it('refuses an object that does not exist', () => {
    assert.throws(
      () => editableForm(model, 'host', uid(0xfff)),
      (e: unknown) => e instanceof ImpactError && e.code === 'not_found',
    );
  });
});

describe('what the calculation guarantees', () => {
  it('never changes the model it was given', () => {
    const { model, fleet } = fleetWithSolo();
    const before = JSON.stringify(model);
    const c = config(fleet);
    c.inbounds = [];
    calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    calculate(model, 'node', at(fleet.nodes, 0).uuid, { isDisabled: true });
    calculate(model, 'host', at(fleet.hosts, 0).uuid, [
      { op: 'replace', path: '/remark', value: 'x' },
    ]);
    calculate(model, 'internalSquad', at(fleet.internalSquads, 0).uuid, { inbounds: [] });
    assert.equal(JSON.stringify(model), before);
  });

  it('gives the same answer for the same question, and a key for every text', () => {
    const { model, fleet } = fleetWithSolo();
    const c = config(fleet);
    c.inbounds.push({ tag: 'NEW', port: 443, protocol: 'vless' });
    const a = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    const b = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.deepEqual(a, b);
    for (const text of [
      ...a.risk.reasons,
      ...a.notes,
      ...(a.saferWay === null ? [] : [a.saferWay]),
    ]) {
      assert.ok(text.messageKey.startsWith('impact.'), text.messageKey);
      assert.doesNotMatch(text.message, /\{\{/u, text.message);
      assert.notEqual(text.message, text.messageKey);
    }
  });

  it('warns when the panel is of another release line than the rules were written for', () => {
    const { model, fleet } = fleetWithSolo();
    const report = calculate({ ...model, panelVersion: '3.5.0' }, 'host', at(fleet.hosts, 0).uuid, {
      remark: 'x',
    });
    assert.ok(report.notes.some((n) => n.code === 'unsupported_panel'));
    assert.ok(
      !calculate(model, 'host', at(fleet.hosts, 0).uuid, { remark: 'x' }).notes.some(
        (n) => n.code === 'unsupported_panel',
      ),
    );
    assert.ok(
      !calculate({ ...model, panelVersion: null }, 'host', at(fleet.hosts, 0).uuid, {
        remark: 'x',
      }).notes.some((n) => n.code === 'unsupported_panel'),
    );
  });

  it('notes that a configuration that was not read cannot be compared', () => {
    const { model, fleet } = fleetWithSolo();
    const bare = { ...model, profiles: model.profiles.map((p) => ({ ...p, config: undefined })) };
    const report = calculate(bare, 'configProfile', fleet.profileOne.uuid, {
      config: config(fleet),
    });
    assert.ok(report.notes.some((n) => n.code === 'config_unavailable'));
    assert.equal(
      report.changed,
      true,
      'a proposal is taken as a change when there is nothing to compare it with',
    );
  });

  it('documents every rule of the table with its source and a text', () => {
    const rules = describeImpactRules();
    assert.deepEqual(rules.map((r) => r.id).sort(), Object.keys(IMPACT_RULES).sort());
    for (const rule of rules) {
      assert.ok(['observed', 'documented', 'assumed'].includes(rule.basis));
      assert.ok(rule.text.length > 20, rule.id);
    }
    // The headline rule is the one that was measured on a panel.
    assert.equal(IMPACT_RULES['profile.config-edit'].basis, 'observed');
    assert.equal(IMPACT_RULES['profile.config-edit'].effect, 'restart');
  });
});

describe('a larger fleet', () => {
  it('computes the impact of a shared profile of 60 nodes quickly', () => {
    const fleet = healthyFleet();
    const nodes = Array.from({ length: 60 }, (_u, i) =>
      node(
        i + 1,
        `Big ${String(i + 1)}`,
        { uuid: fleet.profileOne.uuid, inbounds: [fleet.inboundMain] },
        { address: `big${String(i)}.example.com` },
      ),
    );
    const hosts = Array.from({ length: 120 }, (_u, i) =>
      host(
        i + 1,
        `Big host ${String(i)}`,
        { profile: fleet.profileOne.uuid, inbound: fleet.inboundMain.uuid },
        { address: `192.0.2.${String((i % 200) + 1)}` },
      ),
    );
    const model = { ...fleet, nodes, hosts };
    const c = config(fleet);
    at(c.inbounds, 0)['sniffing'] = { enabled: true };
    const started = performance.now();
    const report = calculate(model, 'configProfile', fleet.profileOne.uuid, { config: c });
    assert.equal(report.restarts.length, 60);
    assert.equal(report.affected.hosts.length, 120);
    assert.ok(performance.now() - started < 3000);
  });
});

describe('external squads in the model', () => {
  it('are listed for a template edit only when they use the template', () => {
    const fleet = healthyFleet();
    const other = template(2, 'Other', 'XRAY_JSON');
    const model = {
      ...fleet,
      templates: [...fleet.templates, other],
      externalSquads: [
        ...fleet.externalSquads,
        externalSquad(2, 'Ext Two', [{ templateUuid: other.uuid, templateType: 'XRAY_JSON' }]),
      ],
    };
    const report = calculate(model, 'subscriptionTemplate', other.uuid, { name: 'Other renamed' });
    assert.deepEqual(
      report.affected.externalSquads.map((s) => s.name),
      ['Ext Two'],
    );
  });
});
