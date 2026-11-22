import { type z } from 'zod';

import { PanelUrlError } from './errors.js';
import {
  ApiTokensResponse,
  BillingNodesResponse,
  BillingRecordsResponse,
  ConfigProfileResponse,
  ConfigProfilesResponse,
  ConfigurationResponse,
  ExternalSquadsResponse,
  HealthResponse,
  HostsResponse,
  InfraProvidersResponse,
  InternalSquadsResponse,
  MetadataResponse,
  NodePluginsResponse,
  NodesResponse,
  SnippetsResponse,
  StatsResponse,
  SubscriptionSettingsResponse,
  SubscriptionTemplatesResponse,
} from './schemas.js';

/**
 * Every request this client can make. The method is the literal `'GET'`: there is no way to declare an endpoint that
 * writes, so there is no way for the client to send one (ADR 0041). A test checks that each path and method exists in
 * the frozen OpenAPI document of the panel.
 */
export interface PanelEndpoint<S extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly method: 'GET';
  /** The path as the OpenAPI document writes it, for example `/api/config-profiles/{uuid}`. */
  readonly path: string;
  readonly schema: S;
}

const get = <S extends z.ZodType>(id: string, path: string, schema: S): PanelEndpoint<S> => ({
  id,
  method: 'GET',
  path,
  schema,
});

export const PANEL_ENDPOINTS = {
  metadata: get('system.metadata', '/api/system/metadata', MetadataResponse),
  health: get('system.health', '/api/system/health', HealthResponse),
  configuration: get('system.configuration', '/api/system/configuration', ConfigurationResponse),
  stats: get('system.stats', '/api/system/stats', StatsResponse),
  nodes: get('nodes.list', '/api/nodes', NodesResponse),
  hosts: get('hosts.list', '/api/hosts', HostsResponse),
  configProfiles: get('configProfiles.list', '/api/config-profiles', ConfigProfilesResponse),
  configProfile: get('configProfiles.get', '/api/config-profiles/{uuid}', ConfigProfileResponse),
  computedConfig: get(
    'configProfiles.computedConfig',
    '/api/config-profiles/{uuid}/computed-config',
    ConfigProfileResponse,
  ),
  internalSquads: get('internalSquads.list', '/api/internal-squads', InternalSquadsResponse),
  externalSquads: get('externalSquads.list', '/api/external-squads', ExternalSquadsResponse),
  subscriptionTemplates: get(
    'subscriptionTemplates.list',
    '/api/subscription-templates',
    SubscriptionTemplatesResponse,
  ),
  subscriptionSettings: get(
    'subscriptionSettings.get',
    '/api/subscription-settings',
    SubscriptionSettingsResponse,
  ),
  snippets: get('snippets.list', '/api/snippets', SnippetsResponse),
  nodePlugins: get('nodePlugins.list', '/api/node-plugins', NodePluginsResponse),
  infraProviders: get('infra.providers', '/api/infra-billing/providers', InfraProvidersResponse),
  infraBillingNodes: get('infra.billingNodes', '/api/infra-billing/nodes', BillingNodesResponse),
  infraBillingHistory: get('infra.history', '/api/infra-billing/history', BillingRecordsResponse),
  apiTokens: get('apiTokens.list', '/api/tokens', ApiTokensResponse),
} as const;

export type PanelEndpointName = keyof typeof PANEL_ENDPOINTS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The path with its `{placeholders}` filled in, and a query string when there are parameters. Every value is
 * encoded; a placeholder named `uuid` must be a UUID, so a value from outside cannot add a path segment.
 */
export function pathFor(
  endpoint: PanelEndpoint,
  params: Readonly<Record<string, string>> = {},
  query: Readonly<Record<string, string | number>> = {},
): string {
  const path = endpoint.path.replace(/\{([A-Za-z]+)\}/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new PanelUrlError(`The request ${endpoint.id} needs the parameter ${name}.`);
    }
    if (name === 'uuid' && !UUID.test(value)) {
      throw new PanelUrlError(`The parameter ${name} of ${endpoint.id} is not a UUID.`);
    }
    return encodeURIComponent(value);
  });
  const pairs = Object.entries(query).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
  );
  return pairs.length === 0 ? path : `${path}?${pairs.join('&')}`;
}
