import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  GetApiTokensCommand,
  GetComputedConfigProfileByUuidCommand,
  GetConfigProfileByUuidCommand,
  GetConfigProfilesCommand,
  GetConfigurationCommand,
  GetExternalSquadsCommand,
  GetHostsCommand,
  GetInfraBillingNodesCommand,
  GetInfraProvidersCommand,
  GetInternalSquadsCommand,
  GetMetadataCommand,
  GetNodePluginsCommand,
  GetNodesCommand,
  GetRemnawaveHealthCommand,
  GetSnippetsCommand,
  GetStatsCommand,
  GetSubscriptionSettingsCommand,
  GetSubscriptionTemplatesCommand,
} from '@remnawave/backend-contract';

import { PANEL_ENDPOINTS, type PanelEndpoint, pathFor } from './endpoints.js';
import { buildFixtures, fakeUuid } from './test-support/index.js';

// The frozen description of the panel's API (3.4.11) is the reference for what this client may ask and what it may
// expect (ADR 0040). These tests fail the build when the client asks for something the description does not have,
// when its schemas expect a field the description does not guarantee, when they reject a response the description
// allows, or when the fake panel strays from the panel's own contract package.

type Json = Record<string, unknown>;
const SPEC = JSON.parse(
  readFileSync(new URL('../spec/remnawave-api-3.4.11.json', import.meta.url), 'utf8'),
) as {
  info: { version: string };
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
};

/** A value as short JSON for a failure message (undefined included). */
function show(value: unknown): string {
  const text: unknown = JSON.stringify(value);
  return typeof text === 'string' ? text.slice(0, 800) : 'undefined';
}

describe('the frozen API description of the panel', () => {
  it('is the 3.4.11 one', () => {
    assert.equal(SPEC.info.version, '3.4.11');
    assert.ok(Object.keys(SPEC.paths).length > 100);
  });

  it('has every path and method the client uses, and nothing in the client is not a GET', () => {
    const endpoints = Object.values(PANEL_ENDPOINTS) as PanelEndpoint[];
    assert.ok(endpoints.length >= 15);
    for (const endpoint of endpoints) {
      assert.equal(endpoint.method, 'GET', endpoint.id);
      const operation = SPEC.paths[endpoint.path]?.['get'];
      assert.ok(operation, `${endpoint.id}: GET ${endpoint.path} is not in the API description`);
      const declared = (
        (operation['parameters'] as { name: string; in: string }[] | undefined) ?? []
      )
        .filter((p) => p.in === 'path')
        .map((p) => p.name)
        .sort();
      const used = [...endpoint.path.matchAll(/\{([A-Za-z]+)\}/gu)].map((m) => m[1] ?? '').sort();
      assert.deepEqual(used, declared, `${endpoint.id}: path parameters`);
      assert.ok(SPEC.paths[endpoint.path]?.['get']?.['responses'], endpoint.id);
    }
    assert.equal(
      new Set(endpoints.map((e) => e.id)).size,
      endpoints.length,
      'endpoint ids are unique',
    );
  });

  it('has the parameters of the paged endpoint under the names the client sends', () => {
    const parameters = SPEC.paths['/api/infra-billing/history']?.['get']?.['parameters'] as
      { name: string }[] | undefined;
    const names = (parameters ?? []).map((p) => p.name);
    assert.ok(names.includes('start') && names.includes('size'));
    assert.equal(
      pathFor(PANEL_ENDPOINTS.infraBillingHistory, {}, { start: 100, size: 100 }),
      '/api/infra-billing/history?start=100&size=100',
    );
  });
});

// ---- samples made from the description -------------------------------------------------------------------------

let counter = 0;

function resolve(node: Json): Json {
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const target = SPEC.components.schemas[ref.slice('#/components/schemas/'.length)];
    assert.ok(target, `dangling ${ref}`);
    return resolve(target);
  }
  return node;
}

/**
 * A value that satisfies a schema of the description. `full` fills every property, `minimal` only the required ones
 * and uses null wherever null is allowed, which is the most a panel may omit.
 */
function sample(schema: Json, mode: 'full' | 'minimal', depth = 0): unknown {
  const node = resolve(schema);
  if (depth > 9) {
    return null;
  }
  if (mode === 'minimal' && node['nullable'] === true) {
    return null;
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = node[key] as Json[] | undefined;
    if (branches) {
      const pick = branches.find((b) => resolve(b)['type'] !== 'null') ?? branches[0];
      return sample(pick ?? {}, mode, depth + 1);
    }
  }
  if (Array.isArray(node['allOf'])) {
    const merged: Json = { type: 'object', properties: {}, required: [] };
    for (const part of node['allOf'] as Json[]) {
      const resolved = resolve(part);
      Object.assign(merged['properties'] as Json, resolved['properties'] ?? {});
      (merged['required'] as string[]).push(
        ...((resolved['required'] as string[] | undefined) ?? []),
      );
    }
    return sample(merged, mode, depth + 1);
  }
  if (Array.isArray(node['enum'])) {
    return (node['enum'] as unknown[]).find((v) => v !== null) ?? null;
  }
  const type = node['type'];
  if (type === 'object' || node['properties'] !== undefined) {
    const properties = (node['properties'] as Record<string, Json> | undefined) ?? {};
    const required = new Set((node['required'] as string[] | undefined) ?? []);
    const out: Json = {};
    for (const [name, child] of Object.entries(properties)) {
      if (mode === 'full' || required.has(name)) {
        out[name] = sample(child, mode, depth + 1);
      }
    }
    if (
      mode === 'full' &&
      typeof node['additionalProperties'] === 'object' &&
      node['additionalProperties'] !== null
    ) {
      out['key'] = sample(node['additionalProperties'] as Json, mode, depth + 1);
    }
    return out;
  }
  if (type === 'array') {
    return mode === 'full'
      ? [sample((node['items'] as Json | undefined) ?? {}, mode, depth + 1)]
      : [];
  }
  if (type === 'string') {
    switch (node['format']) {
      case 'uuid':
        return fakeUuid((counter += 1));
      case 'date-time':
        return '2026-03-04T05:06:07.000Z';
      case 'ipv4':
        return '192.0.2.1';
      case 'ipv6':
        return '2001:db8::1';
      default:
        return 'text';
    }
  }
  if (type === 'integer' || type === 'number') {
    return Math.max(1, typeof node['minimum'] === 'number' ? node['minimum'] : 1);
  }
  if (type === 'boolean') {
    return true;
  }
  return {};
}

function okSchema(path: string): Json {
  const responses = SPEC.paths[path]?.['get']?.['responses'] as Record<string, Json> | undefined;
  const ok = responses?.['200'] ?? responses?.['201'];
  const content = ok?.['content'] as Record<string, { schema: Json }> | undefined;
  const schema = content?.['application/json']?.schema;
  assert.ok(schema, `${path} has no JSON answer in the description`);
  return schema;
}

describe('the schemas of the client against samples made from the description', () => {
  const endpoints = Object.values(PANEL_ENDPOINTS) as PanelEndpoint[];

  for (const mode of ['full', 'minimal'] as const) {
    it(`accept an answer with ${mode === 'full' ? 'every field' : 'only the required fields and null where null is allowed'}`, () => {
      for (const endpoint of endpoints) {
        const body = sample(okSchema(endpoint.path), mode);
        const parsed = endpoint.schema.safeParse(body);
        if (!parsed.success) {
          assert.fail(
            `${endpoint.id} (${mode}) rejects what the description allows: ${JSON.stringify(parsed.error.issues.slice(0, 3))}\n${JSON.stringify(body).slice(0, 600)}`,
          );
        }
      }
    });
  }

  it('reject an answer that lacks what the client cannot do without', () => {
    for (const endpoint of endpoints) {
      assert.equal(endpoint.schema.safeParse(undefined).success, false, endpoint.id);
      assert.equal(endpoint.schema.safeParse({}).success, false, endpoint.id);
      assert.equal(endpoint.schema.safeParse({ response: null }).success, false, endpoint.id);
    }
  });
});

// ---- the fake panel against the panel's own contract package ---------------------------------------------------

describe('the fake panel and the contract package of the panel', () => {
  const fixtures = buildFixtures({ extraNodes: 1, extraHosts: 1 });
  const first = (list: unknown[]): unknown => {
    assert.ok(list.length > 0);
    return list[0];
  };

  const cases: [
    string,
    {
      ResponseSchema: { safeParse(v: unknown): { success: boolean; error?: unknown } };
      url?: unknown;
    },
    unknown,
  ][] = [
    ['nodes', GetNodesCommand, { response: fixtures.nodes }],
    ['hosts', GetHostsCommand, { response: fixtures.hosts }],
    [
      'config profiles',
      GetConfigProfilesCommand,
      {
        response: {
          total: fixtures.configProfiles.length,
          configProfiles: fixtures.configProfiles,
        },
      },
    ],
    ['config profile', GetConfigProfileByUuidCommand, { response: first(fixtures.configProfiles) }],
    [
      'computed config',
      GetComputedConfigProfileByUuidCommand,
      { response: first(fixtures.configProfiles) },
    ],
    [
      'internal squads',
      GetInternalSquadsCommand,
      { response: { total: 2, internalSquads: fixtures.internalSquads } },
    ],
    [
      'external squads',
      GetExternalSquadsCommand,
      { response: { total: 1, externalSquads: fixtures.externalSquads } },
    ],
    [
      'templates',
      GetSubscriptionTemplatesCommand,
      { response: { total: 3, templates: fixtures.templates } },
    ],
    [
      'subscription settings',
      GetSubscriptionSettingsCommand,
      { response: fixtures.subscriptionSettings },
    ],
    ['snippets', GetSnippetsCommand, { response: { total: 2, snippets: fixtures.snippets } }],
    [
      'node plugins',
      GetNodePluginsCommand,
      { response: { total: 1, nodePlugins: fixtures.nodePlugins } },
    ],
    [
      'providers',
      GetInfraProvidersCommand,
      { response: { total: 1, providers: fixtures.providers } },
    ],
    [
      'billing nodes',
      GetInfraBillingNodesCommand,
      {
        response: {
          totalBillingNodes: 1,
          billingNodes: fixtures.billingNodes,
          availableBillingNodes: [],
          totalAvailableBillingNodes: 0,
          stats: { upcomingNodesCount: 1, currentMonthPayments: 1, totalSpent: 1 },
        },
      },
    ],
    ['api tokens', GetApiTokensCommand, { response: { tokens: fixtures.apiTokens } }],
    ['metadata', GetMetadataCommand, { response: fixtures.metadata }],
    ['health', GetRemnawaveHealthCommand, { response: fixtures.health }],
    ['configuration', GetConfigurationCommand, { response: fixtures.configuration }],
    ['stats', GetStatsCommand, { response: fixtures.stats }],
  ];

  for (const [name, command, body] of cases) {
    it(`serves ${name} the way the contract package says`, () => {
      const parsed = command.ResponseSchema.safeParse(body);
      if (!parsed.success) {
        assert.fail(`${name}: ${show((parsed.error as { issues?: unknown } | undefined)?.issues)}`);
      }
    });
  }

  it('asks the paths the contract package names, and each of them is a read', () => {
    const urls: [string, unknown][] = [
      [PANEL_ENDPOINTS.nodes.path, GetNodesCommand.url],
      [PANEL_ENDPOINTS.hosts.path, GetHostsCommand.url],
      [PANEL_ENDPOINTS.configProfiles.path, GetConfigProfilesCommand.url],
      [PANEL_ENDPOINTS.internalSquads.path, GetInternalSquadsCommand.url],
      [PANEL_ENDPOINTS.externalSquads.path, GetExternalSquadsCommand.url],
      [PANEL_ENDPOINTS.subscriptionTemplates.path, GetSubscriptionTemplatesCommand.url],
      [PANEL_ENDPOINTS.subscriptionSettings.path, GetSubscriptionSettingsCommand.url],
      [PANEL_ENDPOINTS.snippets.path, GetSnippetsCommand.url],
      [PANEL_ENDPOINTS.nodePlugins.path, GetNodePluginsCommand.url],
      [PANEL_ENDPOINTS.infraProviders.path, GetInfraProvidersCommand.url],
      [PANEL_ENDPOINTS.infraBillingNodes.path, GetInfraBillingNodesCommand.url],
      [PANEL_ENDPOINTS.apiTokens.path, GetApiTokensCommand.url],
      [PANEL_ENDPOINTS.metadata.path, GetMetadataCommand.url],
      [PANEL_ENDPOINTS.health.path, GetRemnawaveHealthCommand.url],
      [PANEL_ENDPOINTS.configuration.path, GetConfigurationCommand.url],
      [PANEL_ENDPOINTS.stats.path, GetStatsCommand.url],
    ];
    // The package writes `/api/nodes/` where the API description (and the panel's router) has `/api/nodes`.
    const bare = (url: unknown): unknown =>
      typeof url === 'string' ? url.replace(/\/$/u, '') : url;
    for (const [ours, theirs] of urls) {
      assert.equal(ours, bare(theirs));
    }
    const byUuid = GetConfigProfileByUuidCommand.url;
    assert.equal(PANEL_ENDPOINTS.configProfile.path, bare(byUuid('{uuid}')));
    const computed = GetComputedConfigProfileByUuidCommand.url;
    assert.equal(PANEL_ENDPOINTS.computedConfig.path, bare(computed('{uuid}')));
  });
});
