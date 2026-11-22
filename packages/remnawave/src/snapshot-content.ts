import { createHmac } from 'node:crypto';

import {
  PANEL_SNAPSHOT_OBJECT_KINDS,
  type PanelBillingNodeView,
  type PanelConfigProfileView,
  type PanelExternalSquadView,
  type PanelHostView,
  type PanelInfraProviderView,
  type PanelInternalSquadView,
  type PanelNodePluginView,
  type PanelNodeView,
  type PanelSnapshotObjectKind,
  type PanelSnippetView,
  type PanelSubscriptionSettingsView,
  type PanelSubscriptionTemplateView,
} from '@swellwright/contracts';

import { contentHash } from './mask.js';
import type { PanelState } from './panel-state.js';

// The content of a snapshot (ADR 0043): per kind, the objects as `{ id, name, hash, config }`, where `config` is the
// masked configuration that the object's hash covers (ADR 0041) and nothing else. Runtime state (online flags, counters,
// versions of a node, member counts, timestamps) is not in it, so a snapshot changes when somebody edits the panel
// and not when a node restarts. Everything in a view is already masked, so nothing here can be a secret.

export const SNAPSHOT_CONTENT_FORMAT = 'swellwright.panel-snapshot-content';
export const SNAPSHOT_CONTENT_VERSION = 1;

export interface SnapshotItem {
  /** The uuid of the object; the name for a snippet, which has no uuid. */
  readonly id: string;
  readonly name: string;
  /** SHA-256 of the canonical JSON of `config`; the same hash the view carries (ADR 0041). */
  readonly hash: string;
  /** The masked configuration: what is compared in a diff. */
  readonly config: unknown;
}

export interface SnapshotContent {
  readonly format: typeof SNAPSHOT_CONTENT_FORMAT;
  readonly schemaVersion: typeof SNAPSHOT_CONTENT_VERSION;
  /**
   * Which key the fingerprints in the masks were made with (`maskKeyId`). Two snapshots made with different keys
   * cannot tell a rotated secret from an unchanged one by fingerprint.
   */
  readonly maskKeyId: string;
  readonly kinds: Partial<Record<PanelSnapshotObjectKind, SnapshotItem[]>>;
}

/** A short public identifier of the key that makes the fingerprints of masks: it reveals nothing about the key. */
export function maskKeyIdOf(key: Uint8Array | string): string {
  return createHmac('sha256', key)
    .update('swellwright:panel-snapshot:mask-key-id:v1')
    .digest('hex')
    .slice(0, 12);
}

const without = (value: object, names: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)));

// ---- what each kind compares: exactly what its hash covers (see `adapters.ts`) -----------------------------------------

export const projections = {
  node: (view: PanelNodeView) => ({
    name: view.name,
    address: view.address,
    port: view.port,
    countryCode: view.countryCode,
    isDisabled: view.isDisabled,
    configProfile: view.configProfile,
    tags: view.tags,
    provider: view.provider,
    activePluginUuid: view.activePluginUuid,
    integrationUuids: view.integrationUuids,
    proxyUrl: view.proxyUrl,
    trackingActive: view.traffic.trackingActive,
    limitBytes: view.traffic.limitBytes,
    resetDay: view.traffic.resetDay,
    notifyPercent: view.traffic.notifyPercent,
    consumptionMultiplier: view.consumptionMultiplier,
    nodeConsumptionMultiplier: view.nodeConsumptionMultiplier,
    viewPosition: view.viewPosition,
    note: view.note,
  }),
  host: (view: PanelHostView) => without(view, ['hash']),
  configProfile: (view: PanelConfigProfileView) => ({
    name: view.name,
    tags: view.tags,
    config: view.config,
    inbounds: view.inbounds,
  }),
  internalSquad: (view: PanelInternalSquadView) => ({
    name: view.name,
    tags: view.tags,
    viewPosition: view.viewPosition,
    inbounds: view.inbounds.map((inbound) => inbound.uuid).sort(),
  }),
  externalSquad: (view: PanelExternalSquadView) =>
    without(view, ['membersCount', 'createdAt', 'updatedAt', 'hash']),
  // `bodyLoaded` says how the view was read, not what the template is: it is not what the hash covers.
  template: (view: PanelSubscriptionTemplateView) => without(view, ['hash', 'bodyLoaded']),
  settings: (view: PanelSubscriptionSettingsView) =>
    without(view, ['createdAt', 'updatedAt', 'hash']),
  snippet: (view: PanelSnippetView) => without(view, ['hash']),
  plugin: (view: PanelNodePluginView) => without(view, ['hash', 'configLoaded']),
  provider: (view: PanelInfraProviderView) => ({
    name: view.name,
    loginUrl: view.loginUrl,
    faviconLink: view.faviconLink,
  }),
  billingNode: (view: PanelBillingNodeView) => without(view, ['hash']),
} as const;

function item(id: string, name: string, config: unknown): SnapshotItem {
  return { id, name, hash: contentHash(config), config };
}

const byIdThenName = (a: SnapshotItem, b: SnapshotItem): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * The content of a snapshot from a state read from the panel. A kind that was not read is absent (and so is not
 * compared later); a kind that was read and is empty is an empty list.
 */
export function buildSnapshotContent(state: PanelState, maskKeyId: string): SnapshotContent {
  const { data, coverage } = state;
  const kinds: SnapshotContent['kinds'] = {};
  const put = (kind: PanelSnapshotObjectKind, items: SnapshotItem[] | undefined): void => {
    if (coverage[kind] === 'ok' && items !== undefined) {
      kinds[kind] = items.sort(byIdThenName);
    }
  };
  put(
    'nodes',
    data.nodes?.map((view) => item(view.uuid, view.name, projections.node(view))),
  );
  put(
    'hosts',
    data.hosts?.map((view) => item(view.uuid, view.remark, projections.host(view))),
  );
  put(
    'configProfiles',
    data.configProfiles?.map((view) => item(view.uuid, view.name, projections.configProfile(view))),
  );
  put(
    'internalSquads',
    data.internalSquads?.map((view) => item(view.uuid, view.name, projections.internalSquad(view))),
  );
  put(
    'externalSquads',
    data.externalSquads?.map((view) => item(view.uuid, view.name, projections.externalSquad(view))),
  );
  put(
    'subscriptionTemplates',
    data.subscriptionTemplates?.map((view) =>
      item(view.uuid, view.name, projections.template(view)),
    ),
  );
  put(
    'subscriptionSettings',
    data.subscriptionSettings === undefined
      ? undefined
      : [
          item(
            data.subscriptionSettings.uuid,
            'subscription settings',
            projections.settings(data.subscriptionSettings),
          ),
        ],
  );
  put(
    'snippets',
    data.snippets?.map((view) => item(view.name, view.name, projections.snippet(view))),
  );
  put(
    'nodePlugins',
    data.nodePlugins?.map((view) => item(view.uuid, view.name, projections.plugin(view))),
  );
  put(
    'infraProviders',
    data.infra?.providers.map((view) => item(view.uuid, view.name, projections.provider(view))),
  );
  put(
    'billingNodes',
    data.infra?.billingNodes.map((view) =>
      item(
        view.uuid,
        view.name ?? view.node?.name ?? view.provider.name,
        projections.billingNode(view),
      ),
    ),
  );
  return {
    format: SNAPSHOT_CONTENT_FORMAT,
    schemaVersion: SNAPSHOT_CONTENT_VERSION,
    maskKeyId,
    kinds,
  };
}

// ---- hashes and counts ----------------------------------------------------------------------------------------------

/** The `[id, hash]` pairs of a kind, in the order of the ids: what the hash of a kind covers. */
function pairs(items: readonly SnapshotItem[]): [string, string][] {
  return items
    .map((entry): [string, string] => [entry.id, entry.hash])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function kindHashesOf(
  content: SnapshotContent,
): Partial<Record<PanelSnapshotObjectKind, string>> {
  const out: Partial<Record<PanelSnapshotObjectKind, string>> = {};
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    const items = content.kinds[kind];
    if (items !== undefined) {
      out[kind] = contentHash(pairs(items));
    }
  }
  return out;
}

/** One hash for the whole snapshot: the same configuration of the same objects gives the same hash. */
export function overallHashOf(content: SnapshotContent): string {
  const kinds: Record<string, [string, string][]> = {};
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    const items = content.kinds[kind];
    if (items !== undefined) {
      kinds[kind] = pairs(items);
    }
  }
  return contentHash({ v: SNAPSHOT_CONTENT_VERSION, kinds });
}

export function countsOf(content: SnapshotContent): Record<PanelSnapshotObjectKind, number> {
  const out = {} as Record<PanelSnapshotObjectKind, number>;
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    out[kind] = content.kinds[kind]?.length ?? 0;
  }
  return out;
}

export function objectCountOf(content: SnapshotContent): number {
  return PANEL_SNAPSHOT_OBJECT_KINDS.reduce(
    (sum, kind) => sum + (content.kinds[kind]?.length ?? 0),
    0,
  );
}

/**
 * Checks that every object's hash is the hash of its configuration. A content that was changed on disk, or written by
 * a defect, fails here instead of producing a diff that lies. Returns what is wrong, or null.
 */
export function verifySnapshotContent(content: SnapshotContent): string | null {
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    for (const entry of content.kinds[kind] ?? []) {
      if (contentHash(entry.config) !== entry.hash) {
        return `The hash of an object of kind ${kind} is not the hash of its content.`;
      }
    }
  }
  return null;
}
