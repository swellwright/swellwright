import {
  PANEL_SNAPSHOT_OBJECT_KINDS,
  type PanelConfigProfileView,
  type PanelExternalSquadView,
  type PanelHostView,
  type PanelInfraView,
  type PanelInternalSquadView,
  type PanelNodePluginView,
  type PanelNodeView,
  type PanelSnapshotCoverage,
  type PanelSnapshotObjectKind,
  type PanelSnippetView,
  type PanelSubscriptionSettingsView,
  type PanelSubscriptionTemplateView,
} from '@swellwright/contracts';

import type { PanelReader, PanelSystemVersion } from './client.js';
import {
  PanelAuthError,
  PanelError,
  PanelForbiddenError,
  PanelNotFoundError,
  PanelRateLimitedError,
  PanelTimeoutError,
  PanelUnavailableError,
  PanelVersionError,
} from './errors.js';
import { assessPanelVersion } from './version.js';

// Everything a snapshot is made of, read from the panel in one go (ADR 0043): the views of the adapters for every kind
// of object, with the configuration of every config profile (the list does not carry it), and for each kind whether
// it could be read. A kind the token has no scope for, or that the panel answers in a shape this release does not
// know, is left out and says why; a panel that is down, refuses the token or asks to slow down fails the whole read.

export interface PanelStateData {
  readonly nodes: PanelNodeView[];
  readonly hosts: PanelHostView[];
  readonly configProfiles: PanelConfigProfileView[];
  readonly internalSquads: PanelInternalSquadView[];
  readonly externalSquads: PanelExternalSquadView[];
  readonly subscriptionTemplates: PanelSubscriptionTemplateView[];
  readonly subscriptionSettings: PanelSubscriptionSettingsView;
  readonly snippets: PanelSnippetView[];
  readonly nodePlugins: PanelNodePluginView[];
  readonly infra: PanelInfraView;
}

export interface PanelState {
  readonly version: PanelSystemVersion;
  /** What could be read; a key is absent when its read was denied or failed. */
  readonly data: Partial<PanelStateData>;
  /** Per snapshot kind: in the state, denied (no scope) or failed. */
  readonly coverage: Record<PanelSnapshotObjectKind, PanelSnapshotCoverage>;
  /** Why a kind failed, by its code (`panel_contract_changed`); the message names the endpoint and the field. */
  readonly failures: Partial<Record<PanelSnapshotObjectKind, { code: string; message: string }>>;
}

/** The panel resource each snapshot kind comes from; two kinds share the billing read. */
const SOURCE: Record<PanelSnapshotObjectKind, keyof PanelStateData> = {
  nodes: 'nodes',
  hosts: 'hosts',
  configProfiles: 'configProfiles',
  internalSquads: 'internalSquads',
  externalSquads: 'externalSquads',
  subscriptionTemplates: 'subscriptionTemplates',
  subscriptionSettings: 'subscriptionSettings',
  snippets: 'snippets',
  nodePlugins: 'nodePlugins',
  infraProviders: 'infra',
  billingNodes: 'infra',
};

/** The failures that say something about the whole panel and not about one resource. */
function isFatal(error: unknown): boolean {
  return (
    error instanceof PanelAuthError ||
    error instanceof PanelUnavailableError ||
    error instanceof PanelTimeoutError ||
    error instanceof PanelRateLimitedError
  );
}

/** The configuration of every profile: the list, then each detail. A profile that vanished in between is left out. */
async function readProfiles(reader: PanelReader): Promise<PanelConfigProfileView[]> {
  const list = await reader.configProfiles();
  const details = await Promise.all(
    list.map(async (profile) => {
      try {
        return await reader.configProfile(profile.uuid);
      } catch (error) {
        if (error instanceof PanelNotFoundError) {
          return null;
        }
        throw error;
      }
    }),
  );
  return details.filter((profile): profile is PanelConfigProfileView => profile !== null);
}

/**
 * Reads the whole state for a snapshot. The version is read first and judged against the supported window, so that a
 * panel that was updated since the connection was made is not read in a shape nobody tested.
 */
export async function readPanelState(reader: PanelReader): Promise<PanelState> {
  const version = await reader.version();
  const support = assessPanelVersion(version.version);
  if (support.status === 'unsupported') {
    throw new PanelVersionError(
      version.version,
      support.range,
      support.reason ?? 'Unsupported version.',
    );
  }

  const readings: { key: keyof PanelStateData; read: () => Promise<unknown> }[] = [
    { key: 'nodes', read: () => reader.nodes() },
    { key: 'hosts', read: () => reader.hosts() },
    { key: 'configProfiles', read: () => readProfiles(reader) },
    { key: 'internalSquads', read: () => reader.internalSquads() },
    { key: 'externalSquads', read: () => reader.externalSquads() },
    { key: 'subscriptionTemplates', read: () => reader.subscriptionTemplates() },
    { key: 'subscriptionSettings', read: () => reader.subscriptionSettings() },
    { key: 'snippets', read: () => reader.snippets() },
    { key: 'nodePlugins', read: () => reader.nodePlugins() },
    { key: 'infra', read: () => reader.infra() },
  ];
  const settled = await Promise.allSettled(readings.map((reading) => reading.read()));

  const data: Record<string, unknown> = {};
  const outcome: Partial<
    Record<keyof PanelStateData, PanelSnapshotCoverage | { code: string; message: string }>
  > = {};
  settled.forEach((result, index) => {
    const reading = readings[index];
    if (!reading) {
      return;
    }
    if (result.status === 'fulfilled') {
      data[reading.key] = result.value;
      outcome[reading.key] = 'ok';
      return;
    }
    const error: unknown = result.reason;
    if (isFatal(error)) {
      throw error;
    }
    if (error instanceof PanelForbiddenError) {
      outcome[reading.key] = 'denied';
    } else if (error instanceof PanelError) {
      // A shape this release does not know (or a 404 on a list: not the panel's API): this kind only.
      outcome[reading.key] = { code: error.code, message: error.message };
    } else {
      // Not a problem of the panel: a defect, which the caller must see as one.
      throw error;
    }
  });

  const coverage = {} as Record<PanelSnapshotObjectKind, PanelSnapshotCoverage>;
  const failures: Partial<Record<PanelSnapshotObjectKind, { code: string; message: string }>> = {};
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    const result = outcome[SOURCE[kind]];
    if (result === 'ok') {
      coverage[kind] = 'ok';
    } else if (result === 'denied') {
      coverage[kind] = 'denied';
    } else {
      coverage[kind] = 'failed';
      if (result !== undefined && result !== 'failed') {
        failures[kind] = result;
      }
    }
  }
  return { version, data: data, coverage, failures };
}
