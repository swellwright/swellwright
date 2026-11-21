import type {
  PanelApiTokenView,
  PanelCapabilityState,
  PanelConfigProfileSummary,
  PanelExternalSquadView,
  PanelHostView,
  PanelInfraView,
  PanelInternalSquadView,
  PanelNodePluginView,
  PanelNodeView,
  PanelResource,
  PanelSnippetView,
  PanelSubscriptionSettingsView,
  PanelSubscriptionTemplateView,
  PanelVersionSupport,
} from '@swellwright/contracts';
import { PANEL_RESOURCES } from '@swellwright/contracts';

import type {
  PanelConfigurationSummary,
  PanelHealth,
  PanelReader,
  PanelSystemVersion,
  PanelUserCounts,
} from './client.js';
import {
  describePanelError,
  PanelAuthError,
  PanelError,
  PanelForbiddenError,
  PanelVersionError,
} from './errors.js';
import { assessPanelVersion } from './version.js';

/** The objects of every kind that could be read, as the views of the adapters. */
export interface PanelData {
  readonly nodes: PanelNodeView[];
  readonly hosts: PanelHostView[];
  readonly configProfiles: PanelConfigProfileSummary[];
  readonly internalSquads: PanelInternalSquadView[];
  readonly externalSquads: PanelExternalSquadView[];
  readonly subscriptionTemplates: PanelSubscriptionTemplateView[];
  readonly subscriptionSettings: PanelSubscriptionSettingsView;
  readonly snippets: PanelSnippetView[];
  readonly nodePlugins: PanelNodePluginView[];
  readonly infra: PanelInfraView;
  readonly apiTokens: PanelApiTokenView[];
}

export interface PanelSystemData {
  readonly health: PanelHealth | null;
  readonly configuration: PanelConfigurationSummary | null;
  readonly userCounts: PanelUserCounts | null;
}

export interface PanelProbe {
  readonly version: PanelSystemVersion | null;
  readonly support: PanelVersionSupport | null;
  readonly system: PanelSystemData;
  /** Per resource: could the token read it. Empty when the probe ended before it could ask (see `fatal`). */
  readonly capabilities: Partial<Record<PanelResource, PanelCapabilityState>>;
  /** Why a resource is `failed` (never `denied`: that needs no explanation). */
  readonly failures: Partial<
    Record<PanelResource, { readonly code: string; readonly message: string }>
  >;
  /** What was read, so that a caller can keep it instead of asking again. */
  readonly data: Partial<PanelData>;
  /**
   * The error that makes the panel unusable at all: it did not answer, refused the token, answers in a shape this
   * release does not know, or runs an unsupported version. Null when the panel can be used (maybe not all of it).
   */
  readonly fatal: PanelError | null;
  readonly latencyMs: number;
}

interface Reading {
  resource: PanelResource;
  read: () => Promise<unknown>;
}

/**
 * Asks the panel what it is and what the token can read (ADR 0040): the version first (this is also the check that the
 * token works at all), then, for a supported version, each kind of object once. A resource the token has no scope for
 * is `denied`; one that failed in another way is `failed` with its code. The version and the token decide whether the
 * panel can be used (`fatal`); a missing scope only limits it. Never throws for a panel error.
 */
export async function probePanel(
  reader: PanelReader,
  now: () => number = Date.now,
): Promise<PanelProbe> {
  const started = now();
  const done = (partial: Partial<PanelProbe> & Pick<PanelProbe, 'fatal'>): PanelProbe => ({
    version: null,
    support: null,
    system: { health: null, configuration: null, userCounts: null },
    capabilities: {},
    failures: {},
    data: {},
    latencyMs: now() - started,
    ...partial,
  });
  let version: PanelSystemVersion;
  try {
    version = await reader.version();
  } catch (error) {
    if (error instanceof PanelError) {
      return done({ fatal: error });
    }
    // Not a problem of the panel: a defect, which the caller must see as one.
    throw error;
  }
  const support = assessPanelVersion(version.version);
  if (support.status === 'unsupported') {
    return done({
      version,
      support,
      fatal: new PanelVersionError(
        version.version,
        support.range,
        support.reason ?? 'Unsupported version.',
      ),
    });
  }

  const data: Record<string, unknown> = {};
  const system: {
    health: PanelHealth | null;
    configuration: PanelConfigurationSummary | null;
    userCounts: PanelUserCounts | null;
  } = {
    health: null,
    configuration: null,
    userCounts: null,
  };
  const readings: Reading[] = [
    { resource: 'nodes', read: async () => (data['nodes'] = await reader.nodes()) },
    { resource: 'hosts', read: async () => (data['hosts'] = await reader.hosts()) },
    {
      resource: 'configProfiles',
      read: async () => (data['configProfiles'] = await reader.configProfiles()),
    },
    {
      resource: 'internalSquads',
      read: async () => (data['internalSquads'] = await reader.internalSquads()),
    },
    {
      resource: 'externalSquads',
      read: async () => (data['externalSquads'] = await reader.externalSquads()),
    },
    {
      resource: 'subscriptionTemplates',
      read: async () => (data['subscriptionTemplates'] = await reader.subscriptionTemplates()),
    },
    {
      resource: 'subscriptionSettings',
      read: async () => (data['subscriptionSettings'] = await reader.subscriptionSettings()),
    },
    { resource: 'snippets', read: async () => (data['snippets'] = await reader.snippets()) },
    {
      resource: 'nodePlugins',
      read: async () => (data['nodePlugins'] = await reader.nodePlugins()),
    },
    { resource: 'infra', read: async () => (data['infra'] = await reader.infra()) },
    { resource: 'apiTokens', read: async () => (data['apiTokens'] = await reader.apiTokens()) },
    // The three system reads share one capability: `system` is ok only when all of them are.
    { resource: 'system', read: async () => (system.health = await reader.health()) },
    { resource: 'system', read: async () => (system.configuration = await reader.configuration()) },
    { resource: 'system', read: async () => (system.userCounts = await reader.userCounts()) },
  ];
  const settled = await Promise.allSettled(readings.map((reading) => reading.read()));

  const capabilities: Partial<Record<PanelResource, PanelCapabilityState>> = {};
  const failures: Partial<Record<PanelResource, { code: string; message: string }>> = {};
  let fatal: PanelError | null = null;
  const rank: Record<PanelCapabilityState, number> = { ok: 0, denied: 1, failed: 2 };
  readings.forEach((reading, index) => {
    const outcome = settled[index];
    let state: PanelCapabilityState = 'ok';
    if (outcome?.status === 'rejected') {
      const error: unknown = outcome.reason;
      if (error instanceof PanelAuthError) {
        // The token worked a moment ago and does not now: revoked or expired in between.
        fatal ??= error;
        state = 'failed';
      } else if (error instanceof PanelForbiddenError) {
        state = 'denied';
      } else {
        state = 'failed';
      }
      if (state === 'failed') {
        const { code, message } = describePanelError(error);
        failures[reading.resource] ??= { code, message };
      }
    }
    const before = capabilities[reading.resource];
    if (before === undefined || rank[state] > rank[before]) {
      capabilities[reading.resource] = state;
    }
  });
  // Every resource has an entry, even if the list above did not mention it.
  for (const resource of PANEL_RESOURCES) {
    capabilities[resource] ??= 'failed';
  }
  return {
    version,
    support,
    system,
    capabilities,
    failures,
    data: data,
    fatal,
    latencyMs: now() - started,
  };
}
