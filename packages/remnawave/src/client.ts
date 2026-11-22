import type {
  PanelApiTokenView,
  PanelConfigProfileSummary,
  PanelConfigProfileView,
  PanelExternalSquadView,
  PanelHostView,
  PanelInfraView,
  PanelInternalSquadView,
  PanelNodePluginView,
  PanelNodeView,
  PanelSnippetView,
  PanelSubscriptionSettingsView,
  PanelSubscriptionTemplateView,
} from '@swellwright/contracts';
import { type z } from 'zod';

import {
  type AdaptContext,
  adaptApiToken,
  adaptConfigProfile,
  adaptExternalSquad,
  adaptHost,
  adaptInfra,
  adaptInternalSquad,
  adaptNode,
  adaptNodePlugin,
  adaptSnippet,
  adaptSubscriptionSettings,
  adaptSubscriptionTemplate,
} from './adapters.js';
import { type PanelEndpoint, PANEL_ENDPOINTS, pathFor } from './endpoints.js';
import { type ContractIssue, PanelContractError, PanelNotFoundError } from './errors.js';
import { PanelHttp, type PanelHttpOptions } from './http.js';

export interface PanelClientOptions extends PanelHttpOptions {
  /** Key of the fingerprint in a mask (see `MaskOptions`). Without it a mask is the plain `[masked]`. */
  readonly maskKey?: Uint8Array | string;
  /** The clock for "days left" (tests). */
  readonly clock?: () => Date;
}

export interface PanelSystemVersion {
  readonly version: string;
  readonly buildTime: string | null;
  readonly buildNumber: string | null;
}

export interface PanelHealth {
  /** Processes of the panel that reported in the health answer. */
  readonly instances: number;
  readonly uptimeSeconds: number | null;
}

export interface PanelConfigurationSummary {
  readonly webhookNotifications: boolean | null;
  readonly shortUuidLength: number | null;
  readonly subscriptionPublicDomain: string | null;
  readonly cleanUsageHistory: boolean | null;
}

/** Counts of users, nothing about any of them. */
export interface PanelUserCounts {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly onlineNow: number | null;
  readonly uptimeSeconds: number | null;
}

/**
 * What can be read from a panel, and nothing else. The type has no method that writes, and no way to build a request
 * that is not a GET: this is the read-only client of ADR 0041. Writes come in later phases through a separate type
 * that has to be asked for by name and goes through approval.
 */
export interface PanelReader {
  readonly baseUrl: string;
  version(): Promise<PanelSystemVersion>;
  health(): Promise<PanelHealth>;
  configuration(): Promise<PanelConfigurationSummary>;
  userCounts(): Promise<PanelUserCounts>;
  nodes(): Promise<PanelNodeView[]>;
  hosts(): Promise<PanelHostView[]>;
  configProfiles(): Promise<PanelConfigProfileSummary[]>;
  configProfile(uuid: string): Promise<PanelConfigProfileView>;
  computedConfig(uuid: string): Promise<PanelConfigProfileView>;
  internalSquads(): Promise<PanelInternalSquadView[]>;
  externalSquads(): Promise<PanelExternalSquadView[]>;
  /**
   * The templates as the list reports them. The list of the 3.4 line has no bodies (`bodyLoaded` is false for each
   * template unless the list carries one): enough for names and counts, not for what a template says.
   */
  subscriptionTemplates(): Promise<PanelSubscriptionTemplateView[]>;
  /** One template with its body (the detail request). */
  subscriptionTemplate(uuid: string): Promise<PanelSubscriptionTemplateView>;
  /**
   * Every template with its body: the list, then the detail of each template whose body the list did not carry, at
   * most as many at a time as the client allows requests. A template that vanished in between is left out.
   */
  subscriptionTemplatesWithBodies(): Promise<PanelSubscriptionTemplateView[]>;
  subscriptionSettings(): Promise<PanelSubscriptionSettingsView>;
  snippets(): Promise<PanelSnippetView[]>;
  /** The node plugins as the list reports them; `configLoaded` is false where the list left the configuration out. */
  nodePlugins(): Promise<PanelNodePluginView[]>;
  /** One node plugin with its configuration. */
  nodePlugin(uuid: string): Promise<PanelNodePluginView>;
  /** Every node plugin with its configuration, read the way `subscriptionTemplatesWithBodies` reads templates. */
  nodePluginsWithConfigs(): Promise<PanelNodePluginView[]>;
  infra(): Promise<PanelInfraView>;
  apiTokens(): Promise<PanelApiTokenView[]>;
  /** The newest billing records, paged through the panel's own paging, at most `maxRecords`. */
  billingHistory(maxRecords?: number): Promise<PanelBillingRecord[]>;
  close(): void;
}

export interface PanelBillingRecord {
  readonly uuid: string;
  readonly providerUuid: string;
  readonly amount: number;
  readonly billedAt: string;
}

const PATH_PART = /^\d+$/u;

/** `response.nodes[3].port` from the path of a Zod issue. */
function pathText(path: readonly PropertyKey[]): string {
  let text = '';
  for (const part of path) {
    if (typeof part === 'number' || (typeof part === 'string' && PATH_PART.test(part))) {
      text += `[${String(part)}]`;
    } else {
      text += `${text === '' ? '' : '.'}${String(part)}`;
    }
  }
  return text;
}

/**
 * The issues of a failed parse, in words that name the field and what was wrong with it and never repeat the value:
 * Zod's own messages name the expected and the received type, not the value.
 */
export function contractIssues(error: z.ZodError): ContractIssue[] {
  return error.issues.slice(0, 5).map((issue) => ({
    path: pathText(issue.path),
    problem: `is wrong: ${issue.message.slice(0, 120)}`,
  }));
}

const BILLING_PAGE = 100;

export class PanelClient implements PanelReader {
  private readonly http: PanelHttp;
  private readonly context: () => AdaptContext;

  constructor(options: PanelClientOptions) {
    this.http = new PanelHttp(options);
    const clock = options.clock;
    const maskKey = options.maskKey;
    this.context = () => ({
      ...(maskKey === undefined ? {} : { fingerprintKey: maskKey }),
      ...(clock === undefined ? {} : { now: clock() }),
    });
  }

  get baseUrl(): string {
    return this.http.target.base;
  }

  close(): void {
    this.http.close();
  }

  /**
   * The views of a list with the detail read for each one whose content the list did not carry. The requests go
   * through the one gate of the HTTP layer, so no more than `concurrency` are in flight at a time, and each has the
   * timeout, the size cap and the retry (GET only) of every other request. An object that vanished between the list and
   * its detail (404) is left out; any other failure is the failure of the read, as for the profiles of a snapshot.
   */
  private async withDetails<V extends { readonly uuid: string }>(
    views: readonly V[],
    loaded: (view: V) => boolean,
    detail: (uuid: string) => Promise<V>,
  ): Promise<V[]> {
    // Each answer is boxed: `await` of a bare type parameter is typed `Awaited<V>`, which TypeScript cannot take for `V`.
    const boxes = await Promise.all(
      views.map(async (view): Promise<{ readonly view: V | null }> => {
        if (loaded(view)) {
          return { view };
        }
        try {
          return { view: await detail(view.uuid) };
        } catch (error) {
          if (error instanceof PanelNotFoundError) {
            return { view: null };
          }
          throw error;
        }
      }),
    );
    return boxes.flatMap((box) => (box.view === null ? [] : [box.view]));
  }

  /** One GET, checked against the schema of its endpoint. */
  private async call<S extends z.ZodType>(
    endpoint: PanelEndpoint<S>,
    params: Readonly<Record<string, string>> = {},
    query: Readonly<Record<string, string | number>> = {},
  ): Promise<z.infer<S>> {
    const body = await this.http.getJson(endpoint.id, pathFor(endpoint, params, query));
    const parsed = endpoint.schema.safeParse(body);
    if (!parsed.success) {
      throw new PanelContractError(endpoint.id, contractIssues(parsed.error));
    }
    return parsed.data;
  }

  async version(): Promise<PanelSystemVersion> {
    const { response } = await this.call(PANEL_ENDPOINTS.metadata);
    return {
      version: response.version,
      buildTime: response.build?.time ?? null,
      buildNumber: response.build?.number ?? null,
    };
  }

  async health(): Promise<PanelHealth> {
    const { response } = await this.call(PANEL_ENDPOINTS.health);
    const metrics = response.runtimeMetrics ?? [];
    const uptimes = metrics.flatMap((metric) =>
      metric.uptime === undefined ? [] : [metric.uptime],
    );
    return {
      instances: metrics.length,
      uptimeSeconds: uptimes.length === 0 ? null : Math.max(...uptimes),
    };
  }

  async configuration(): Promise<PanelConfigurationSummary> {
    const { response } = await this.call(PANEL_ENDPOINTS.configuration);
    return {
      webhookNotifications: response.notifications?.webhook ?? null,
      shortUuidLength: response.misc?.shortUuidLength ?? null,
      subscriptionPublicDomain: response.misc?.subPublicDomain ?? null,
      cleanUsageHistory: response.service?.cleanUsageHistory ?? null,
    };
  }

  async userCounts(): Promise<PanelUserCounts> {
    const { response } = await this.call(PANEL_ENDPOINTS.stats);
    return {
      total: response.users?.totalUsers ?? 0,
      byStatus: response.users?.statusCounts ?? {},
      onlineNow: response.onlineStats?.onlineNow ?? null,
      uptimeSeconds: response.uptime ?? null,
    };
  }

  async nodes(): Promise<PanelNodeView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.nodes);
    const context = this.context();
    return response.map((node) => adaptNode(node, context));
  }

  async hosts(): Promise<PanelHostView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.hosts);
    const context = this.context();
    return response.map((host) => adaptHost(host, context));
  }

  async configProfiles(): Promise<PanelConfigProfileSummary[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.configProfiles);
    const context = this.context();
    return response.configProfiles.map((profile) => adaptConfigProfile(profile, context, false));
  }

  async configProfile(uuid: string): Promise<PanelConfigProfileView> {
    const { response } = await this.call(PANEL_ENDPOINTS.configProfile, { uuid });
    return adaptConfigProfile(response, this.context(), true);
  }

  async computedConfig(uuid: string): Promise<PanelConfigProfileView> {
    const { response } = await this.call(PANEL_ENDPOINTS.computedConfig, { uuid });
    return adaptConfigProfile(response, this.context(), true);
  }

  async internalSquads(): Promise<PanelInternalSquadView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.internalSquads);
    const context = this.context();
    return response.internalSquads.map((squad) => adaptInternalSquad(squad, context));
  }

  async externalSquads(): Promise<PanelExternalSquadView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.externalSquads);
    const context = this.context();
    return response.externalSquads.map((squad) => adaptExternalSquad(squad, context));
  }

  async subscriptionTemplates(): Promise<PanelSubscriptionTemplateView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.subscriptionTemplates);
    const context = this.context();
    return response.templates.map((template) => adaptSubscriptionTemplate(template, context));
  }

  async subscriptionTemplate(uuid: string): Promise<PanelSubscriptionTemplateView> {
    const { response } = await this.call(PANEL_ENDPOINTS.subscriptionTemplate, { uuid });
    return adaptSubscriptionTemplate(response, this.context(), true);
  }

  async subscriptionTemplatesWithBodies(): Promise<PanelSubscriptionTemplateView[]> {
    return this.withDetails(await this.subscriptionTemplates(), (view) => view.bodyLoaded, (uuid) =>
      this.subscriptionTemplate(uuid),
    );
  }

  async subscriptionSettings(): Promise<PanelSubscriptionSettingsView> {
    const { response } = await this.call(PANEL_ENDPOINTS.subscriptionSettings);
    return adaptSubscriptionSettings(response, this.context());
  }

  async snippets(): Promise<PanelSnippetView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.snippets);
    const context = this.context();
    return response.snippets.map((snippet) => adaptSnippet(snippet, context));
  }

  async nodePlugins(): Promise<PanelNodePluginView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.nodePlugins);
    const context = this.context();
    return response.nodePlugins.map((plugin) => adaptNodePlugin(plugin, context));
  }

  async nodePlugin(uuid: string): Promise<PanelNodePluginView> {
    const { response } = await this.call(PANEL_ENDPOINTS.nodePlugin, { uuid });
    return adaptNodePlugin(response, this.context(), true);
  }

  async nodePluginsWithConfigs(): Promise<PanelNodePluginView[]> {
    return this.withDetails(await this.nodePlugins(), (view) => view.configLoaded, (uuid) =>
      this.nodePlugin(uuid),
    );
  }

  async infra(): Promise<PanelInfraView> {
    const [providers, billing] = await Promise.all([
      this.call(PANEL_ENDPOINTS.infraProviders),
      this.call(PANEL_ENDPOINTS.infraBillingNodes),
    ]);
    return adaptInfra(providers.response.providers, billing.response, this.context());
  }

  async apiTokens(): Promise<PanelApiTokenView[]> {
    const { response } = await this.call(PANEL_ENDPOINTS.apiTokens);
    const context = this.context();
    return response.tokens.map((token) => adaptApiToken(token, context));
  }

  async billingHistory(maxRecords = 1000): Promise<PanelBillingRecord[]> {
    const out: PanelBillingRecord[] = [];
    for (let start = 0; out.length < maxRecords; start += BILLING_PAGE) {
      const { response } = await this.call(
        PANEL_ENDPOINTS.infraBillingHistory,
        {},
        {
          start,
          size: BILLING_PAGE,
        },
      );
      for (const record of response.records) {
        out.push({
          uuid: record.uuid,
          providerUuid: record.providerUuid,
          amount: record.amount,
          billedAt: new Date(record.billedAt).toISOString(),
        });
      }
      // The panel says how many there are; an empty or short page also ends the walk, so a wrong total cannot loop.
      if (response.records.length < BILLING_PAGE || out.length >= response.total) {
        break;
      }
    }
    return out.slice(0, maxRecords);
  }
}
