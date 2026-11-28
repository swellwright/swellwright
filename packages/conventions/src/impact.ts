import {
  type CheckObjectRef,
  type ConventionFinding,
  type ImpactKind,
  containsMaskText,
  type ImpactMessage,
  type ImpactReport,
  type ImpactRuleId,
  type JsonPatchOperation,
  PANEL_SUPPORTED_RANGE,
  PanelHostViewSchema,
  type PanelHostView,
  type PanelInboundView,
  type PanelInternalSquadView,
  type PanelNodeView,
  type PanelSubscriptionTemplateView,
  type RiskLevel,
} from '@swellwright/contracts';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

import {
  applyJsonPatch,
  canonicalJson,
  deepEqual,
  diffPaths,
  isMask,
  JsonPatchError,
  parsePointer,
} from './json.js';
import { lint } from './lint.js';
import { message } from './messages.js';
import { ModelIndex, type PanelModel, type ProfileInput, refs } from './model.js';
import type { ResolvedPack } from './pack.js';
import { inboundsFromConfig, rawInboundOf } from './xray.js';

// The impact calculator: given a proposed change to one object and what the panel reported, it says what the change
// would do, without sending anything anywhere. It is a pure function of the model, the pack and the proposal, so that
// the approvals of a later phase can call the same function on the same data and show the same numbers.
//
// The rules are a table (IMPACT_RULES), versioned with the window of panel versions they were written for. The one
// that matters most is observed behaviour of Remnawave 3.4.x: editing the configuration of a profile that several
// nodes share restarts Xray on all of them, even when only one inbound changed. Each rule says where it comes from:
// `observed` (measured on a panel), `documented` (the design of Remnawave 3.4.x) or `assumed` (to be confirmed).

/** The version of the rule table: the line of panel releases it was written for. */
export const IMPACT_RULES_VERSION = '3.4';

type Effect = 'restart' | 'stop' | 'start' | 'none';

export const IMPACT_RULES: Readonly<
  Record<ImpactRuleId, { basis: 'observed' | 'documented' | 'assumed'; effect: Effect }>
> = {
  'profile.config-edit': { basis: 'observed', effect: 'restart' },
  'profile.name-only': { basis: 'assumed', effect: 'none' },
  'squad.inbounds-changed': { basis: 'observed', effect: 'restart' },
  'squad.members-changed': { basis: 'assumed', effect: 'none' },
  'squad.metadata-only': { basis: 'assumed', effect: 'none' },
  'node.profile-move': { basis: 'documented', effect: 'restart' },
  'node.active-inbounds-changed': { basis: 'documented', effect: 'restart' },
  'node.disable': { basis: 'documented', effect: 'stop' },
  'node.enable': { basis: 'assumed', effect: 'start' },
  'node.connection-changed': { basis: 'assumed', effect: 'restart' },
  'node.metadata-only': { basis: 'assumed', effect: 'none' },
  'host.edit': { basis: 'documented', effect: 'none' },
  'template.edit': { basis: 'documented', effect: 'none' },
};

export class ImpactError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_change',
    message: string,
  ) {
    super(message);
    this.name = 'ImpactError';
  }
}

export interface ImpactInput {
  readonly model: PanelModel;
  readonly pack: ResolvedPack;
  readonly kind: ImpactKind;
  readonly uuid: string;
  /** A partial object as the panel API takes it for an update, or a JSON Patch applied to the editable form. */
  readonly change: Record<string, unknown> | readonly JsonPatchOperation[];
}

type Obj = Record<string, unknown>;
type Action = 'restart' | 'stop' | 'start';

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- the editable forms ------------------------------------------------------------------------------------------

interface Editable {
  /** The object as the console and the API show it for editing. */
  readonly current: Obj;
  /** The keys a change may set; anything else in a proposal is ignored (and reported). */
  readonly keys: ReadonlySet<string>;
}

const HOST_KEYS = Object.keys(PanelHostViewSchema.shape).filter(
  (key) => key !== 'uuid' && key !== 'hash',
);

function editableOf(
  kind: ImpactKind,
  model: PanelModel,
  uuid: string,
): { editable: Editable; ref: CheckObjectRef } {
  const index = new ModelIndex(model);
  switch (kind) {
    case 'configProfile': {
      const profile = index.profiles.get(uuid);
      if (profile === undefined) {
        throw new ImpactError('not_found', 'The panel has no such config profile.');
      }
      return {
        ref: refs.profile(profile),
        editable: {
          current: { name: profile.name, tags: [...profile.tags], config: profile.config ?? null },
          keys: new Set(['name', 'tags', 'config']),
        },
      };
    }
    case 'internalSquad': {
      const squad = index.internalSquads.get(uuid);
      if (squad === undefined) {
        throw new ImpactError('not_found', 'The panel has no such internal squad.');
      }
      return {
        ref: refs.internalSquad(squad),
        editable: {
          current: {
            name: squad.name,
            tags: [...squad.tags],
            inbounds: squad.inbounds.map((inbound) => inbound.uuid),
          },
          keys: new Set(['name', 'tags', 'inbounds']),
        },
      };
    }
    case 'host': {
      const host = index.hosts.get(uuid);
      if (host === undefined) {
        throw new ImpactError('not_found', 'The panel has no such host.');
      }
      const current: Record<string, unknown> = structuredClone(host);
      delete current['uuid'];
      delete current['hash'];
      return {
        ref: refs.host(host),
        editable: { current, keys: new Set(HOST_KEYS) },
      };
    }
    case 'node': {
      const node = index.nodes.get(uuid);
      if (node === undefined) {
        throw new ImpactError('not_found', 'The panel has no such node.');
      }
      return {
        ref: refs.node(node),
        editable: {
          current: {
            name: node.name,
            address: node.address,
            port: node.port,
            isDisabled: node.isDisabled,
            tags: [...node.tags],
            note: node.note,
            configProfile: {
              activeConfigProfileUuid: node.configProfile.uuid,
              activeInbounds: node.configProfile.inbounds.map((inbound) => inbound.uuid),
            },
          },
          keys: new Set(['name', 'address', 'port', 'isDisabled', 'tags', 'note', 'configProfile']),
        },
      };
    }
    case 'subscriptionTemplate': {
      const template = index.templates.get(uuid);
      if (template === undefined) {
        throw new ImpactError('not_found', 'The panel has no such subscription template.');
      }
      return {
        ref: refs.template(template),
        editable: {
          current: {
            name: template.name,
            tags: [...template.tags],
            templateJson: template.templateJson,
            templateYaml: template.templateYaml,
          },
          keys: new Set(['name', 'tags', 'templateJson', 'templateYaml']),
        },
      };
    }
  }
}

/** The editable form after the change, and the top-level keys that were not part of it. */
function applyChange(
  editable: Editable,
  change: ImpactInput['change'],
): { proposed: Obj; ignored: string[] } {
  let result: unknown;
  if (Array.isArray(change)) {
    try {
      result = applyJsonPatch(editable.current, change as readonly JsonPatchOperation[]);
    } catch (error) {
      if (error instanceof JsonPatchError) {
        throw new ImpactError('invalid_change', `The patch cannot be applied. ${error.message}.`);
      }
      throw error;
    }
  } else {
    result = { ...structuredClone(editable.current) };
  }
  if (!isObj(result)) {
    throw new ImpactError('invalid_change', 'The patch leaves something that is not an object.');
  }
  const proposed: Obj = {};
  const ignored: string[] = [];
  const source = Array.isArray(change) ? result : { ...result, ...(change as Obj) };
  for (const [key, value] of Object.entries(source)) {
    if (editable.keys.has(key)) {
      proposed[key] = value;
    } else if (!Object.hasOwn(editable.current, key)) {
      ignored.push(key);
    }
  }
  for (const key of editable.keys) {
    if (!Object.hasOwn(proposed, key) && Object.hasOwn(editable.current, key)) {
      // A patch that removed a key: the panel would see the field missing, which leaves it as it is.
      proposed[key] = editable.current[key];
    }
  }
  return { proposed, ignored: ignored.slice(0, 20) };
}

/** The object as a change is written against it: what an editor starts from. Secrets are masked in it already. */
export function editableForm(
  model: PanelModel,
  kind: ImpactKind,
  uuid: string,
): { target: CheckObjectRef; editable: Record<string, unknown>; masked: boolean } {
  const { editable, ref } = editableOf(kind, model, uuid);
  const form = structuredClone(editable.current);
  return {
    target: ref,
    editable: form,
    masked: containsMaskText(canonicalJson(form)),
  };
}

// ---- typed proposals --------------------------------------------------------------------------------------------

const Name = z.string().min(1).max(300);
const Tags = z.array(z.string().max(64)).max(100);

const ProfileProposal = z.object({ name: Name, tags: Tags, config: z.unknown() });
const SquadProposal = z.object({
  name: Name,
  tags: Tags,
  inbounds: z.array(z.string().min(1).max(200)).max(1000),
});
const NodeProposal = z.object({
  name: Name,
  address: z.string().min(1).max(255),
  port: z.number().int().min(0).max(65_535).nullable(),
  isDisabled: z.boolean(),
  tags: Tags,
  note: z.string().max(2000).nullable(),
  configProfile: z.object({
    activeConfigProfileUuid: z.string().max(64).nullable(),
    activeInbounds: z.array(z.string().min(1).max(200)).max(1000).default([]),
  }),
});
const TemplateProposal = z.object({
  name: Name,
  tags: Tags,
  templateJson: z.unknown(),
  templateYaml: z.string().max(1_000_000).nullable(),
});
const HostProposal = PanelHostViewSchema.omit({ uuid: true, hash: true });

function typed<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where =
      first === undefined || first.path.length === 0 ? '' : `${first.path.map(String).join('.')}: `;
    throw new ImpactError(
      'invalid_change',
      `The proposed ${what} is not valid. ${where}${first?.message ?? 'wrong shape'}.`,
    );
  }
  return parsed.data;
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const msg = (
  root: 'risk' | 'safer' | 'notes',
  code: string,
  params: Record<string, string | number | boolean | null> = {},
): ImpactMessage => {
  const key = `impact.${root}.${code}`;
  return { code, message: message(key, params), messageKey: key, params };
};

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
};

/** An inbound named by uuid or by tag, found among the inbounds of the panel. */
function resolveInbound(index: ModelIndex, ref: string): PanelInboundView {
  const byUuid = index.inbounds.get(ref);
  if (byUuid !== undefined) {
    return byUuid.inbound;
  }
  const byTag = index.inboundsByTag.get(ref) ?? [];
  if (byTag.length === 1 && byTag[0] !== undefined) {
    return byTag[0].inbound;
  }
  throw new ImpactError(
    'invalid_change',
    byTag.length > 1
      ? `The inbound tag "${ref.slice(0, 60)}" is used by several profiles: name it by uuid.`
      : `The panel has no inbound "${ref.slice(0, 60)}" (name it by uuid or by tag).`,
  );
}

const runningNodes = (nodes: readonly PanelNodeView[]): PanelNodeView[] =>
  nodes.filter((node) => !node.isDisabled);

interface Disturbance {
  readonly node: PanelNodeView;
  readonly rule: ImpactRuleId;
  readonly action: Action;
}

class Account {
  readonly rules = new Set<ImpactRuleId>();
  readonly disturbed = new Map<string, Disturbance>();
  readonly skipped: { node: PanelNodeView; reason: 'disabled' }[] = [];
  readonly dangling: ImpactReport['dangling'] = [];
  readonly unserved: ImpactReport['unserved'] = [];
  readonly affected = {
    internalSquads: new Map<string, CheckObjectRef>(),
    externalSquads: new Map<string, CheckObjectRef>(),
    templates: new Map<string, CheckObjectRef>(),
    hosts: new Map<string, CheckObjectRef>(),
  };
  readonly notes: ImpactMessage[] = [];
  inbounds: ImpactReport['inbounds'] = null;
  secretsTouched = false;
  /** The textual difference of the editable form means nothing (for example the same YAML written another way). */
  unchanged = false;

  use(rule: ImpactRuleId): void {
    this.rules.add(rule);
  }

  disturb(node: PanelNodeView, rule: ImpactRuleId, action: Action): void {
    if (!this.disturbed.has(node.uuid)) {
      this.disturbed.set(node.uuid, { node, rule, action });
    }
  }

  touchHost(host: PanelHostView): void {
    this.affected.hosts.set(host.uuid, refs.host(host));
  }

  touchSquad(squad: PanelInternalSquadView): void {
    this.affected.internalSquads.set(squad.uuid, refs.internalSquad(squad));
  }
}

// ---- the calculation --------------------------------------------------------------------------------------------

export function calculateImpact(input: ImpactInput): ImpactReport {
  const { model, pack, kind } = input;
  const index = new ModelIndex(model);
  const { editable, ref: target } = editableOf(kind, model, input.uuid);
  const { proposed: proposedDoc, ignored } = applyChange(editable, input.change);
  const account = new Account();
  const memberKeys =
    kind === 'internalSquad'
      ? ignored.filter((key) => ['members', 'users', 'membersCount'].includes(key))
      : [];
  const otherIgnored = ignored.filter((key) => !memberKeys.includes(key));
  if (otherIgnored.length > 0) {
    account.notes.push(
      msg('notes', 'ignored_fields', { fields: otherIgnored.slice(0, 10).join(', ') }),
    );
  }
  if (memberKeys.length > 0) {
    account.use('squad.members-changed');
    account.notes.push(msg('notes', 'members_not_modelled'));
  }
  if (model.panelVersion !== null && !model.panelVersion.startsWith('3.4.')) {
    account.notes.push(
      msg('notes', 'unsupported_panel', {
        version: model.panelVersion,
        range: PANEL_SUPPORTED_RANGE,
      }),
    );
  }

  const textual = diffPaths(editable.current, proposedDoc, 4, 200);
  let after: PanelModel = model;
  if (textual.length > 0 || memberKeys.length > 0) {
    switch (kind) {
      case 'configProfile':
        after = profileChange(model, index, input.uuid, editable, proposedDoc, account);
        break;
      case 'internalSquad':
        after = squadChange(model, index, input.uuid, proposedDoc, account);
        break;
      case 'host':
        after = hostChange(model, index, input.uuid, proposedDoc, account);
        break;
      case 'node':
        after = nodeChange(model, index, input.uuid, proposedDoc, account);
        break;
      case 'subscriptionTemplate':
        after = templateChange(model, index, input.uuid, proposedDoc, account);
        break;
    }
  }

  const changed = !account.unchanged && (textual.length > 0 || memberKeys.length > 0);
  const changes = account.unchanged ? [] : textual;

  // The convention findings the change would introduce or resolve: the linter on the model before and after.
  const before = lint(model, pack, { limit: Number.MAX_SAFE_INTEGER });
  const afterLint = changed ? lint(after, pack, { limit: Number.MAX_SAFE_INTEGER }) : before;
  const beforeIds = new Set(before.findings.map((finding) => finding.id));
  const afterIds = new Set(afterLint.findings.map((finding) => finding.id));
  const introduced = afterLint.findings.filter((finding) => !beforeIds.has(finding.id));
  const fixed = before.findings.filter((finding) => !afterIds.has(finding.id));

  const restarts = [...account.disturbed.values()].map((entry) => ({
    node: refs.node(entry.node),
    rule: entry.rule,
    action: entry.action,
    state: entry.node.state,
    usersOnline: entry.node.usersOnline,
  }));
  const disturbed = restarts.filter((entry) => entry.action !== 'start');
  const disturbedNodes = [...account.disturbed.values()]
    .filter((entry) => entry.action !== 'start')
    .map((entry) => entry.node);

  // Users: connected now to the nodes that are disturbed, and the members of the squads that reach them (an upper bound).
  const known = disturbedNodes.filter((node) => node.usersOnline !== null);
  const onlineOnRestarted =
    known.length === 0 ? null : known.reduce((sum, node) => sum + (node.usersOnline ?? 0), 0);
  const reaching = new Map<string, PanelInternalSquadView>();
  for (const node of disturbedNodes) {
    for (const squad of index.squadsReaching(node)) {
      reaching.set(squad.uuid, squad);
    }
  }
  for (const squad of reaching.values()) {
    account.touchSquad(squad);
  }
  let membersUpTo: number | null = null;
  if (kind === 'subscriptionTemplate') {
    membersUpTo = [...account.affected.externalSquads.keys()].reduce(
      (sum, id) => sum + (index.externalSquads.get(id)?.membersCount ?? 0),
      0,
    );
  } else if (reaching.size > 0 || account.affected.internalSquads.size > 0) {
    membersUpTo = [
      ...new Set([...reaching.keys(), ...account.affected.internalSquads.keys()]),
    ].reduce((sum, id) => sum + (index.internalSquads.get(id)?.membersCount ?? 0), 0);
  }

  const offline = disturbedNodes.filter(
    (node) => node.state === 'offline' || node.state === 'connecting',
  ).length;
  if (offline > 0) {
    account.notes.push(msg('notes', 'offline_nodes', { count: offline }));
  }

  const risk = assessRisk({
    pack,
    changed,
    disturbedCount: disturbed.length,
    runningTotal: runningNodes(model.nodes).length,
    usersOnline: onlineOnRestarted,
    dangling: account.dangling.length,
    unserved: account.unserved.length,
    introduced,
    secretsTouched: account.secretsTouched,
    sharedNodes:
      kind === 'configProfile' ? runningNodes(index.nodesOfProfile(input.uuid)).length : 0,
  });

  const ruleIds = [...account.rules];
  const rules = ruleIds.map((id) => ({
    id,
    title: message(`impact.rules.${id}`, {}),
    basis: IMPACT_RULES[id].basis,
    effect: IMPACT_RULES[id].effect,
    messageKey: `impact.rules.${id}`,
  }));

  let saferWay: ImpactMessage | null = null;
  if (account.rules.has('profile.config-edit') && account.disturbed.size >= 2) {
    saferWay = msg('safer', 'clone_profile', { others: account.disturbed.size - 1 });
  }

  return {
    rulesVersion: IMPACT_RULES_VERSION,
    panelVersion: model.panelVersion,
    target,
    changed,
    changes: changes.map((entry) => ({ op: entry.op, path: entry.path })),
    inbounds: account.inbounds,
    restarts,
    skipped: account.skipped.map((entry) => ({
      node: refs.node(entry.node),
      reason: entry.reason,
    })),
    rules,
    dangling: account.dangling,
    unserved: account.unserved,
    affected: {
      internalSquads: [...account.affected.internalSquads.values()],
      externalSquads: [...account.affected.externalSquads.values()],
      templates: [...account.affected.templates.values()],
      hosts: [...account.affected.hosts.values()].slice(0, 200),
    },
    users: { onlineOnRestartedNodes: onlineOnRestarted, squadMembersUpTo: membersUpTo },
    risk,
    saferWay,
    findings: {
      introduced: introduced.slice(0, 100),
      fixed: fixed.slice(0, 100),
      unchanged: afterLint.findings.length - introduced.length,
    },
    notes: account.notes,
  };
}

// ---- config profile ---------------------------------------------------------------------------------------------

function profileChange(
  model: PanelModel,
  index: ModelIndex,
  uuid: string,
  editable: Editable,
  doc: Obj,
  account: Account,
): PanelModel {
  const profile = index.profiles.get(uuid);
  if (profile === undefined) {
    return model;
  }
  const proposal = typed(ProfileProposal, doc, 'profile');
  const configChanged = !deepEqual(editable.current['config'], proposal.config);
  const metaChanged = proposal.name !== profile.name || !deepEqual(proposal.tags, profile.tags);

  if (profile.config === undefined && Object.hasOwn(doc, 'config') && proposal.config !== null) {
    account.notes.push(msg('notes', 'config_unavailable'));
  }
  if (configChanged) {
    account.use('profile.config-edit');
    // Secrets: the proposal repeats a mask for a value it leaves alone; anything else where a mask was is a change.
    const secretPaths = diffPaths(editable.current['config'], proposal.config, 6, 200).filter(
      (entry) => {
        if (entry.op === 'add') {
          return false;
        }
        try {
          let current: unknown = editable.current['config'];
          for (const part of parsePointer(entry.path)) {
            current = Array.isArray(current)
              ? current[Number(part)]
              : isObj(current)
                ? current[part]
                : undefined;
          }
          return isMask(current);
        } catch {
          return false;
        }
      },
    );
    if (secretPaths.length > 0) {
      account.secretsTouched = true;
      account.notes.push(
        msg('notes', 'secret_changed', {
          paths: secretPaths
            .slice(0, 5)
            .map((entry) => entry.path)
            .join(', '),
        }),
      );
    }
    for (const node of index.nodesOfProfile(uuid)) {
      if (node.isDisabled) {
        account.skipped.push({ node, reason: 'disabled' });
      } else {
        account.disturb(node, 'profile.config-edit', 'restart');
      }
    }
  } else if (metaChanged) {
    account.use('profile.name-only');
  }

  const derived = configChanged
    ? inboundsFromConfig(profile, proposal.config)
    : { inbounds: [...profile.inbounds], created: new Set<string>() };
  const nextProfile: ProfileInput = {
    ...profile,
    name: proposal.name,
    tags: proposal.tags,
    config: proposal.config ?? undefined,
    inbounds: derived.inbounds,
  };

  // Which inbounds appear, go, change or change their tag.
  const oldByTag = new Map(profile.inbounds.map((inbound) => [inbound.tag, inbound]));
  const newByTag = new Map(derived.inbounds.map((inbound) => [inbound.tag, inbound]));
  const added = derived.inbounds.filter((inbound) => !oldByTag.has(inbound.tag));
  const removed = profile.inbounds.filter((inbound) => !newByTag.has(inbound.tag));
  const changedTags = derived.inbounds
    .filter((inbound) => oldByTag.has(inbound.tag))
    .filter((inbound) => {
      const old = oldByTag.get(inbound.tag);
      return (
        old !== undefined &&
        !deepEqual(rawInboundOf(profile, old), rawInboundOf(nextProfile, inbound))
      );
    })
    .map((inbound) => inbound.tag);
  const renamed: { from: string; to: string }[] = [];
  const renamedOld = new Set<string>();
  for (const gone of removed) {
    const twin = added.find(
      (candidate) =>
        !renamed.some((entry) => entry.to === candidate.tag) &&
        candidate.port === gone.port &&
        candidate.type === gone.type &&
        candidate.network === gone.network &&
        candidate.security === gone.security,
    );
    if (twin !== undefined) {
      renamed.push({ from: gone.tag, to: twin.tag });
      renamedOld.add(gone.tag);
    }
  }
  if (configChanged || added.length > 0 || removed.length > 0) {
    account.inbounds = {
      added: added
        .map((inbound) => inbound.tag)
        .filter((tag) => !renamed.some((entry) => entry.to === tag)),
      removed: removed.map((inbound) => inbound.tag).filter((tag) => !renamedOld.has(tag)),
      changed: changedTags,
      renamed,
    };
  }
  if (renamed.length > 0) {
    account.notes.push(msg('notes', 'inbounds_renamed'));
  }

  // References that would point at an inbound that is gone.
  const removedIds = new Set(removed.map((inbound) => inbound.uuid));
  for (const gone of removed) {
    const reason = renamedOld.has(gone.tag) ? 'renamed' : 'removed';
    const inbound = { uuid: gone.uuid, tag: gone.tag };
    for (const host of index.hostsOfInbound(gone.uuid)) {
      account.dangling.push({ from: refs.host(host), inbound, reason });
      account.touchHost(host);
      if (!host.isDisabled && index.servingNodes(host).length > 0) {
        account.unserved.push({ host: refs.host(host), reason: 'inbound_removed' });
      }
    }
    for (const squad of index.squadsWithInbound(gone.uuid)) {
      account.dangling.push({ from: refs.internalSquad(squad), inbound, reason });
      account.touchSquad(squad);
    }
    for (const node of index.nodesServing(profile.uuid, gone.uuid)) {
      account.dangling.push({ from: refs.node(node), inbound, reason });
    }
  }
  // Hosts and squads of inbounds that changed or were added are touched too: their subscriptions change.
  for (const tag of changedTags) {
    const old = oldByTag.get(tag);
    if (old !== undefined) {
      for (const host of index.hostsOfInbound(old.uuid)) {
        account.touchHost(host);
      }
      for (const squad of index.squadsWithInbound(old.uuid)) {
        account.touchSquad(squad);
      }
    }
  }

  // The model after: the profile as proposed, and the nodes that lose an inbound that is gone.
  const nodes = model.nodes.map((node) =>
    node.configProfile.uuid === uuid &&
    node.configProfile.inbounds.some((inbound) => removedIds.has(inbound.uuid))
      ? {
          ...node,
          configProfile: {
            ...node.configProfile,
            inbounds: node.configProfile.inbounds.filter(
              (inbound) => !removedIds.has(inbound.uuid),
            ),
          },
        }
      : node,
  );
  return {
    ...model,
    nodes,
    profiles: model.profiles.map((candidate) =>
      candidate.uuid === uuid ? nextProfile : candidate,
    ),
  };
}

// ---- internal squad ---------------------------------------------------------------------------------------------

function squadChange(
  model: PanelModel,
  index: ModelIndex,
  uuid: string,
  doc: Obj,
  account: Account,
): PanelModel {
  const squad = index.internalSquads.get(uuid);
  if (squad === undefined) {
    return model;
  }
  const proposal = typed(SquadProposal, doc, 'squad');
  const wanted = uniqueBy(
    proposal.inbounds.map((ref) => resolveInbound(index, ref)),
    (inbound) => inbound.uuid,
  );
  const before = new Set(squad.inbounds.map((inbound) => inbound.uuid));
  const afterSet = new Set(wanted.map((inbound) => inbound.uuid));
  const delta = [...new Set([...before, ...afterSet])].filter(
    (id) => before.has(id) !== afterSet.has(id),
  );
  account.touchSquad(squad);
  const inboundsChanged = delta.length > 0;
  const metaChanged = proposal.name !== squad.name || !deepEqual(proposal.tags, squad.tags);
  if (inboundsChanged) {
    account.use('squad.inbounds-changed');
    for (const node of model.nodes) {
      if (node.configProfile.inbounds.some((inbound) => delta.includes(inbound.uuid))) {
        if (node.isDisabled) {
          account.skipped.push({ node, reason: 'disabled' });
        } else {
          account.disturb(node, 'squad.inbounds-changed', 'restart');
        }
      }
    }
    for (const id of delta) {
      for (const host of index.hostsOfInbound(id)) {
        account.touchHost(host);
      }
    }
  } else if (metaChanged) {
    account.use('squad.metadata-only');
  }
  const next: PanelInternalSquadView = {
    ...squad,
    name: proposal.name,
    tags: proposal.tags,
    inbounds: wanted,
    inboundsCount: wanted.length,
  };
  return {
    ...model,
    internalSquads: model.internalSquads.map((candidate) =>
      candidate.uuid === uuid ? next : candidate,
    ),
  };
}

// ---- host -------------------------------------------------------------------------------------------------------

function hostChange(
  model: PanelModel,
  index: ModelIndex,
  uuid: string,
  doc: Obj,
  account: Account,
): PanelModel {
  const host = index.hosts.get(uuid);
  if (host === undefined) {
    return model;
  }
  const proposal = typed(HostProposal, doc, 'host');
  const next: PanelHostView = { ...proposal, uuid: host.uuid, hash: host.hash };
  account.use('host.edit');
  account.touchHost(host);
  for (const id of new Set([
    host.inbound.configProfileInboundUuid,
    next.inbound.configProfileInboundUuid,
  ])) {
    if (id !== null) {
      for (const squad of index.squadsWithInbound(id)) {
        account.touchSquad(squad);
      }
    }
  }
  for (const templateId of new Set([host.xrayJsonTemplateUuid, next.xrayJsonTemplateUuid])) {
    const template = templateId === null ? undefined : index.templates.get(templateId);
    if (template !== undefined) {
      account.affected.templates.set(template.uuid, refs.template(template));
    }
  }
  const nextInbound =
    next.inbound.configProfileInboundUuid === null
      ? undefined
      : index.inbounds.get(next.inbound.configProfileInboundUuid);
  if (next.inbound.configProfileInboundUuid !== null && nextInbound === undefined) {
    account.dangling.push({
      from: refs.host(next),
      inbound: { uuid: next.inbound.configProfileInboundUuid, tag: '' },
      reason: 'unlisted',
    });
  }
  const after = {
    ...model,
    hosts: model.hosts.map((candidate) => (candidate.uuid === uuid ? next : candidate)),
  };
  if (
    !next.isDisabled &&
    nextInbound !== undefined &&
    new ModelIndex(after).servingNodes(next).length === 0 &&
    index.servingNodes(host).length > 0
  ) {
    account.unserved.push({ host: refs.host(next), reason: 'no_node' });
  }
  return after;
}

// ---- node -------------------------------------------------------------------------------------------------------

function nodeChange(
  model: PanelModel,
  index: ModelIndex,
  uuid: string,
  doc: Obj,
  account: Account,
): PanelModel {
  const node = index.nodes.get(uuid);
  if (node === undefined) {
    return model;
  }
  const proposal = typed(NodeProposal, doc, 'node');
  const profileUuid = proposal.configProfile.activeConfigProfileUuid;
  const nextProfile = profileUuid === null ? undefined : index.profiles.get(profileUuid);
  if (profileUuid !== null && nextProfile === undefined) {
    throw new ImpactError(
      'invalid_change',
      'The config profile the node is moved to does not exist.',
    );
  }
  const active = uniqueBy(
    proposal.configProfile.activeInbounds.map((ref) => resolveInbound(index, ref)),
    (inbound) => inbound.uuid,
  );
  for (const inbound of active) {
    if (inbound.profileUuid !== nextProfile?.uuid) {
      throw new ImpactError(
        'invalid_change',
        `The active inbound "${inbound.tag.slice(0, 60)}" is not an inbound of the node's profile.`,
      );
    }
  }
  const moved = profileUuid !== node.configProfile.uuid;
  const inboundsChanged = !deepEqual(
    [...node.configProfile.inbounds.map((inbound) => inbound.uuid)].sort(),
    [...active.map((inbound) => inbound.uuid)].sort(),
  );
  const connectionChanged = proposal.address !== node.address || proposal.port !== node.port;
  const metaChanged =
    proposal.name !== node.name ||
    !deepEqual(proposal.tags, node.tags) ||
    proposal.note !== node.note;
  const disabling = proposal.isDisabled && !node.isDisabled;
  const enabling = !proposal.isDisabled && node.isDisabled;

  if (disabling) {
    account.use('node.disable');
    account.disturb(node, 'node.disable', 'stop');
  }
  if (enabling) {
    account.use('node.enable');
    account.disturb(node, 'node.enable', 'start');
  }
  if (!node.isDisabled && !proposal.isDisabled) {
    if (moved) {
      account.use('node.profile-move');
      account.disturb(node, 'node.profile-move', 'restart');
    } else if (inboundsChanged) {
      account.use('node.active-inbounds-changed');
      account.disturb(node, 'node.active-inbounds-changed', 'restart');
    }
    if (connectionChanged) {
      account.use('node.connection-changed');
      account.disturb(node, 'node.connection-changed', 'restart');
    }
  }
  if (!disabling && !enabling && !moved && !inboundsChanged && !connectionChanged && metaChanged) {
    account.use('node.metadata-only');
  }
  if (node.isDisabled && proposal.isDisabled && (moved || inboundsChanged || connectionChanged)) {
    // Nothing runs, so nothing restarts; the new settings apply when the node is enabled.
    if (moved) {
      account.use('node.profile-move');
    } else if (inboundsChanged) {
      account.use('node.active-inbounds-changed');
    }
    account.skipped.push({ node, reason: 'disabled' });
  }
  const next: PanelNodeView = {
    ...node,
    name: proposal.name,
    address: proposal.address,
    port: proposal.port,
    isDisabled: proposal.isDisabled,
    tags: proposal.tags,
    note: proposal.note,
    state: proposal.isDisabled ? 'disabled' : node.state === 'disabled' ? 'offline' : node.state,
    configProfile: {
      uuid: profileUuid,
      inbounds: active.map((inbound) => ({ uuid: inbound.uuid, tag: inbound.tag })),
    },
  };
  const after = {
    ...model,
    nodes: model.nodes.map((candidate) => (candidate.uuid === uuid ? next : candidate)),
  };
  const afterIndex = new ModelIndex(after);
  // Hosts that lose their last serving node, and squads whose reach changes.
  for (const host of model.hosts) {
    const wasServed = index.servingNodes(host);
    if (!wasServed.some((served) => served.uuid === uuid)) {
      continue;
    }
    const stillServed = afterIndex.servingNodes(host).filter((served) => !served.isDisabled);
    account.touchHost(host);
    if (
      !host.isDisabled &&
      wasServed.some((served) => !served.isDisabled) &&
      stillServed.length === 0
    ) {
      account.unserved.push({
        host: refs.host(host),
        reason: disabling ? 'node_disabled' : 'node_moved',
      });
    }
  }
  for (const squad of [...index.squadsReaching(node), ...afterIndex.squadsReaching(next)]) {
    account.touchSquad(squad);
  }
  return after;
}

// ---- subscription template --------------------------------------------------------------------------------------

function templateChange(
  model: PanelModel,
  index: ModelIndex,
  uuid: string,
  doc: Obj,
  account: Account,
): PanelModel {
  const template = index.templates.get(uuid);
  if (template === undefined) {
    return model;
  }
  const proposal = typed(TemplateProposal, doc, 'template');
  let yamlValue: unknown = null;
  let yamlReadable = true;
  if (proposal.templateYaml !== null && proposal.templateYaml.trim() !== '') {
    try {
      yamlValue = parseYaml(proposal.templateYaml, { maxAliasCount: 0, schema: 'core' });
    } catch {
      yamlReadable = false;
      account.notes.push(msg('notes', 'template_body_unreadable', { format: 'YAML' }));
    }
  }
  let currentYaml: unknown = null;
  if (template.templateYaml !== null && template.templateYaml.trim() !== '') {
    try {
      currentYaml = parseYaml(template.templateYaml, { maxAliasCount: 0, schema: 'core' });
    } catch {
      currentYaml = template.templateYaml;
    }
  }
  const bodyChanged =
    canonicalJson(template.templateJson) !== canonicalJson(proposal.templateJson ?? null) ||
    (yamlReadable && canonicalJson(currentYaml) !== canonicalJson(yamlValue)) ||
    !yamlReadable;
  const metaChanged = proposal.name !== template.name || !deepEqual(proposal.tags, template.tags);
  if (!template.bodyLoaded) {
    // The current body was never read (the list of the panel has none): what is compared with the proposal is nothing.
    account.notes.push(msg('notes', 'template_body_not_loaded'));
  }
  if (bodyChanged || metaChanged || !template.bodyLoaded) {
    account.use('template.edit');
  } else {
    account.unchanged = true;
  }
  account.affected.templates.set(template.uuid, refs.template(template));
  for (const squad of model.externalSquads) {
    if (squad.templates.some((used) => used.templateUuid === uuid)) {
      account.affected.externalSquads.set(squad.uuid, refs.externalSquad(squad));
    }
  }
  for (const host of model.hosts) {
    if (host.xrayJsonTemplateUuid === uuid) {
      account.touchHost(host);
    }
  }
  const next: PanelSubscriptionTemplateView = {
    ...template,
    name: proposal.name,
    tags: proposal.tags,
    templateJson: proposal.templateJson ?? null,
    templateYaml: yamlReadable ? proposal.templateYaml : null,
    bodyLoaded: true,
  };
  return {
    ...model,
    templates: model.templates.map((candidate) => (candidate.uuid === uuid ? next : candidate)),
  };
}

// ---- risk -------------------------------------------------------------------------------------------------------

interface RiskInput {
  readonly pack: ResolvedPack;
  readonly changed: boolean;
  readonly disturbedCount: number;
  readonly runningTotal: number;
  readonly usersOnline: number | null;
  readonly dangling: number;
  readonly unserved: number;
  readonly introduced: readonly ConventionFinding[];
  readonly secretsTouched: boolean;
  readonly sharedNodes: number;
}

const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function assessRisk(input: RiskInput): ImpactReport['risk'] {
  const reasons: (ImpactMessage & { level: RiskLevel })[] = [];
  const add = (
    level: RiskLevel,
    code: string,
    params: Record<string, string | number | boolean | null> = {},
  ): void => {
    reasons.push({ ...msg('risk', code, params), level });
  };
  if (!input.changed) {
    add('low', 'no_effect');
    return { level: 'low', reasons };
  }
  const { highRiskRestartNodes, highRiskRestartShare } = input.pack.impact;
  const share = input.runningTotal === 0 ? 0 : input.disturbedCount / input.runningTotal;
  if (input.disturbedCount === 0) {
    add('low', 'no_restart');
  } else if (input.disturbedCount >= highRiskRestartNodes) {
    add('high', 'restart_count_high', { count: input.disturbedCount, limit: highRiskRestartNodes });
  } else if (input.disturbedCount >= 2 && share >= highRiskRestartShare) {
    add('high', 'restart_share_high', {
      share: Math.round(share * 100),
      limit: Math.round(highRiskRestartShare * 100),
    });
  } else {
    add('medium', 'restarts_some', { count: input.disturbedCount, total: input.runningTotal });
  }
  if (input.sharedNodes >= 2 && input.disturbedCount >= 2) {
    add('medium', 'shared_profile', { count: input.sharedNodes });
  }
  if (input.usersOnline !== null && input.usersOnline > 0 && input.disturbedCount > 0) {
    add('medium', 'users_online', { count: input.usersOnline });
  }
  if (input.dangling > 0) {
    add('high', 'dangling_refs', { count: input.dangling });
  }
  if (input.unserved > 0) {
    add('high', 'hosts_unserved', { count: input.unserved });
  }
  const errors = input.introduced.filter((finding) => finding.severity === 'error').length;
  const warnings = input.introduced.filter((finding) => finding.severity === 'warning').length;
  if (errors > 0) {
    add('high', 'introduces_errors', { count: errors });
  }
  if (warnings > 0) {
    add('medium', 'introduces_warnings', { count: warnings });
  }
  if (input.secretsTouched) {
    add('medium', 'secret_changed');
  }
  const level = reasons.reduce<RiskLevel>(
    (top, reason) => (LEVEL_RANK[reason.level] > LEVEL_RANK[top] ? reason.level : top),
    'low',
  );
  return { level, reasons };
}

/** The impact rules as a list with their texts, for documentation and the console. */
export function describeImpactRules(): {
  id: ImpactRuleId;
  basis: 'observed' | 'documented' | 'assumed';
  effect: Effect;
  text: string;
}[] {
  return (Object.keys(IMPACT_RULES) as ImpactRuleId[]).map((id) => ({
    id,
    ...IMPACT_RULES[id],
    text: message(`impact.rules.${id}`, {}),
  }));
}
