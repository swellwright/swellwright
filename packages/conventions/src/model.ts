import { isIP } from 'node:net';

import type {
  CheckObjectRef,
  PanelConfigProfileSummary,
  PanelExternalSquadView,
  PanelHostView,
  PanelInboundView,
  PanelInternalSquadView,
  PanelNodePluginView,
  PanelNodeView,
  PanelResource,
  PanelSnippetView,
  PanelSubscriptionSettingsView,
  PanelSubscriptionTemplateView,
  PanelTokenInfo,
} from '@swellwright/contracts';

// What the checks look at: everything the panel reported, as the normalised and masked views of ADR 0041, in one value.
// The model has no connection to anything: the linter, the reconciliation and the impact calculator are functions of it
// (and of a pack, a DNS answer and the inventory), so they can be tested with plain objects and run on a proposed
// state as well as on the real one.

/** A config profile as the list reports it, with its configuration when the detail was read. */
export interface ProfileInput extends PanelConfigProfileSummary {
  /** The masked Xray configuration. Absent when only the list was read. */
  readonly config?: unknown;
}

export interface PanelModel {
  readonly panelVersion: string | null;
  readonly nodes: readonly PanelNodeView[];
  readonly hosts: readonly PanelHostView[];
  readonly profiles: readonly ProfileInput[];
  readonly internalSquads: readonly PanelInternalSquadView[];
  readonly externalSquads: readonly PanelExternalSquadView[];
  readonly templates: readonly PanelSubscriptionTemplateView[];
  readonly snippets: readonly PanelSnippetView[];
  readonly nodePlugins: readonly PanelNodePluginView[];
  readonly subscriptionSettings: PanelSubscriptionSettingsView | null;
  /** The token of the connection (days left), when known. */
  readonly token: PanelTokenInfo | null;
  /** Kinds of object the token could not read: the rules that need them are skipped, not wrong. */
  readonly unavailable: ReadonlySet<PanelResource>;
  /** The clock of the run. */
  readonly now: Date;
}

export function emptyModel(overrides: Partial<PanelModel> = {}): PanelModel {
  return {
    panelVersion: null,
    nodes: [],
    hosts: [],
    profiles: [],
    internalSquads: [],
    externalSquads: [],
    templates: [],
    snippets: [],
    nodePlugins: [],
    subscriptionSettings: null,
    token: null,
    unavailable: new Set(),
    now: new Date(),
    ...overrides,
  };
}

// ---- references -------------------------------------------------------------------------------------------------

export const refs = {
  panel: (): CheckObjectRef => ({ kind: 'panel', uuid: null, name: 'Remnawave panel' }),
  host: (h: Pick<PanelHostView, 'uuid' | 'remark'>): CheckObjectRef => ({
    kind: 'host',
    uuid: h.uuid,
    name: h.remark,
  }),
  node: (n: Pick<PanelNodeView, 'uuid' | 'name'>): CheckObjectRef => ({
    kind: 'node',
    uuid: n.uuid,
    name: n.name,
  }),
  profile: (p: Pick<ProfileInput, 'uuid' | 'name'>): CheckObjectRef => ({
    kind: 'configProfile',
    uuid: p.uuid,
    name: p.name,
  }),
  inbound: (i: Pick<PanelInboundView, 'uuid' | 'tag'>): CheckObjectRef => ({
    kind: 'inbound',
    uuid: i.uuid,
    name: i.tag,
  }),
  internalSquad: (s: Pick<PanelInternalSquadView, 'uuid' | 'name'>): CheckObjectRef => ({
    kind: 'internalSquad',
    uuid: s.uuid,
    name: s.name,
  }),
  externalSquad: (s: Pick<PanelExternalSquadView, 'uuid' | 'name'>): CheckObjectRef => ({
    kind: 'externalSquad',
    uuid: s.uuid,
    name: s.name,
  }),
  template: (t: Pick<PanelSubscriptionTemplateView, 'uuid' | 'name'>): CheckObjectRef => ({
    kind: 'subscriptionTemplate',
    uuid: t.uuid,
    name: t.name,
  }),
  snippet: (s: Pick<PanelSnippetView, 'name'>): CheckObjectRef => ({
    kind: 'snippet',
    uuid: null,
    name: s.name,
  }),
  nodePlugin: (p: Pick<PanelNodePluginView, 'uuid' | 'name'>): CheckObjectRef => ({
    kind: 'nodePlugin',
    uuid: p.uuid,
    name: p.name,
  }),
  server: (s: { id: string; name: string }): CheckObjectRef => ({
    kind: 'server',
    uuid: s.id,
    name: s.name,
  }),
};

/** An object a rule reports on: the reference and the tags the scope of a rule is judged by. */
export interface Subject {
  readonly ref: CheckObjectRef;
  readonly tags: readonly string[];
}

export const subjects = {
  panel: (): Subject => ({ ref: refs.panel(), tags: [] }),
  host: (h: PanelHostView): Subject => ({ ref: refs.host(h), tags: h.tags }),
  node: (n: PanelNodeView): Subject => ({ ref: refs.node(n), tags: n.tags }),
  profile: (p: ProfileInput): Subject => ({ ref: refs.profile(p), tags: p.tags }),
  internalSquad: (s: PanelInternalSquadView): Subject => ({
    ref: refs.internalSquad(s),
    tags: s.tags,
  }),
  externalSquad: (s: PanelExternalSquadView): Subject => ({
    ref: refs.externalSquad(s),
    tags: s.tags,
  }),
  template: (t: PanelSubscriptionTemplateView): Subject => ({
    ref: refs.template(t),
    tags: t.tags,
  }),
  nodePlugin: (p: PanelNodePluginView): Subject => ({ ref: refs.nodePlugin(p), tags: p.tags }),
  server: (s: { id: string; name: string; tags: readonly string[] }): Subject => ({
    ref: refs.server(s),
    tags: s.tags,
  }),
};

// ---- addresses --------------------------------------------------------------------------------------------------

export type AddressKind = 'ipv4' | 'ipv6' | 'name' | 'invalid';

const NAME_LABEL = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?$/u;

/** The form an address is compared in: trimmed, lower case, no trailing dot, no brackets around an IPv6 address. */
export function normalizeAddress(address: string): string {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) {
    text = text.slice(1, -1);
  }
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

export function addressKind(address: string): AddressKind {
  const text = normalizeAddress(address);
  if (text === '') {
    return 'invalid';
  }
  const ip = isIP(text);
  if (ip === 4) {
    return 'ipv4';
  }
  if (ip === 6) {
    return 'ipv6';
  }
  if (text.length > 253 || /^\d+(\.\d+)*$/u.test(text)) {
    // `300.1.1.1` and `1.2.3` are not names; they look like an IP that is wrong.
    return 'invalid';
  }
  return text.split('.').every((label) => NAME_LABEL.test(label)) ? 'name' : 'invalid';
}

export const isIpAddress = (address: string): boolean => {
  const kind = addressKind(address);
  return kind === 'ipv4' || kind === 'ipv6';
};

// ---- relations --------------------------------------------------------------------------------------------------

/** Lookups over a model, built once per run. */
export class ModelIndex {
  readonly nodes = new Map<string, PanelNodeView>();
  readonly hosts = new Map<string, PanelHostView>();
  readonly profiles = new Map<string, ProfileInput>();
  readonly internalSquads = new Map<string, PanelInternalSquadView>();
  readonly externalSquads = new Map<string, PanelExternalSquadView>();
  readonly templates = new Map<string, PanelSubscriptionTemplateView>();
  readonly snippets = new Map<string, PanelSnippetView>();
  readonly nodePlugins = new Map<string, PanelNodePluginView>();
  /** Every inbound of every profile, by its uuid. */
  readonly inbounds = new Map<string, { inbound: PanelInboundView; profile: ProfileInput }>();
  /** Inbounds by tag (a tag is unique in a healthy panel; a list shows when it is not). */
  readonly inboundsByTag = new Map<
    string,
    { inbound: PanelInboundView; profile: ProfileInput }[]
  >();

  constructor(readonly model: PanelModel) {
    for (const node of model.nodes) {
      this.nodes.set(node.uuid, node);
    }
    for (const host of model.hosts) {
      this.hosts.set(host.uuid, host);
    }
    for (const profile of model.profiles) {
      this.profiles.set(profile.uuid, profile);
      for (const inbound of profile.inbounds) {
        this.inbounds.set(inbound.uuid, { inbound, profile });
        const list = this.inboundsByTag.get(inbound.tag) ?? [];
        list.push({ inbound, profile });
        this.inboundsByTag.set(inbound.tag, list);
      }
    }
    for (const squad of model.internalSquads) {
      this.internalSquads.set(squad.uuid, squad);
    }
    for (const squad of model.externalSquads) {
      this.externalSquads.set(squad.uuid, squad);
    }
    for (const template of model.templates) {
      this.templates.set(template.uuid, template);
    }
    for (const snippet of model.snippets) {
      this.snippets.set(snippet.name, snippet);
    }
    for (const plugin of model.nodePlugins) {
      this.nodePlugins.set(plugin.uuid, plugin);
    }
  }

  nodesOfProfile(profileUuid: string): PanelNodeView[] {
    return this.model.nodes.filter((node) => node.configProfile.uuid === profileUuid);
  }

  /** The nodes on which this inbound of this profile is active: the ones that serve it. */
  nodesServing(profileUuid: string, inboundUuid: string): PanelNodeView[] {
    return this.model.nodes.filter(
      (node) =>
        node.configProfile.uuid === profileUuid &&
        node.configProfile.inbounds.some((inbound) => inbound.uuid === inboundUuid),
    );
  }

  /** The nodes that serve the inbound of a host. */
  servingNodes(host: PanelHostView): PanelNodeView[] {
    const { configProfileUuid, configProfileInboundUuid } = host.inbound;
    if (configProfileUuid === null || configProfileInboundUuid === null) {
      return [];
    }
    return this.nodesServing(configProfileUuid, configProfileInboundUuid);
  }

  hostsOfInbound(inboundUuid: string): PanelHostView[] {
    return this.model.hosts.filter((host) => host.inbound.configProfileInboundUuid === inboundUuid);
  }

  /** The internal squads that include an inbound. */
  squadsWithInbound(inboundUuid: string): PanelInternalSquadView[] {
    return this.model.internalSquads.filter((squad) =>
      squad.inbounds.some((inbound) => inbound.uuid === inboundUuid),
    );
  }

  /** The internal squads that reach a node: they include one of its active inbounds. */
  squadsReaching(node: PanelNodeView): PanelInternalSquadView[] {
    const active = new Set(node.configProfile.inbounds.map((inbound) => inbound.uuid));
    return this.model.internalSquads.filter((squad) =>
      squad.inbounds.some((inbound) => active.has(inbound.uuid)),
    );
  }
}

/** A string list as a set of its normalised members (for a comparison that ignores case). */
export const lowerSet = (values: readonly string[]): Set<string> =>
  new Set(values.map((value) => value.toLowerCase()));
