import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PanelApiTokenViewSchema,
  PanelConfigProfileSummarySchema,
  PanelConfigProfileViewSchema,
  PanelExternalSquadViewSchema,
  PanelHostViewSchema,
  PanelInfraViewSchema,
  PanelInternalSquadViewSchema,
  PanelNodePluginViewSchema,
  PanelNodeViewSchema,
  PanelSnippetViewSchema,
  PanelSubscriptionSettingsViewSchema,
  PanelSubscriptionTemplateViewSchema,
} from '@swellwright/contracts';
import { type z } from 'zod';

import {
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
  daysUntil,
  maskedYaml,
  nodeState,
} from './adapters.js';
import { type PanelEndpoint, PANEL_ENDPOINTS } from './endpoints.js';
import { MASK } from './mask.js';
import { buildFixtures, FAKE_SECRETS, must } from './test-support/index.js';

// The adapters run on the fixtures of the fake panel, which the spec test has shown to be what the panel's contract
// package accepts. Every view must satisfy its schema in `@swellwright/contracts`, carry a stable hash, and hold none
// of the secrets the fixtures contain.

const fixtures = buildFixtures();
const context = { fingerprintKey: 'adapter-test-key', now: new Date('2026-06-01T00:00:00.000Z') };

/** What the client schema of an endpoint makes of a response (unknown fields dropped), the way the adapters see it. */
function read<S extends z.ZodType>(endpoint: PanelEndpoint<S>, response: unknown): z.infer<S> {
  return endpoint.schema.parse({ response });
}

const secrets = Object.values(FAKE_SECRETS).flat();
function assertNoSecret(view: unknown, label: string): void {
  const text = JSON.stringify(view);
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `${label} holds ${secret}`);
  }
}

describe('the adapters', () => {
  it('make nodes that satisfy the view schema, with the state worked out and the proxy credentials masked', () => {
    const views = read(PANEL_ENDPOINTS.nodes, fixtures.nodes).response.map((dto) =>
      adaptNode(dto, context),
    );
    for (const view of views) {
      PanelNodeViewSchema.parse(view);
      assert.match(view.hash, /^[0-9a-f]{64}$/u);
    }
    assert.deepEqual(
      views.map((v) => v.state),
      ['online', 'online', 'offline'],
    );
    assert.match(
      must(views[1]).proxyUrl ?? '',
      /^socks5:\/\/\[masked:[0-9a-f]{8}\]@192\.0\.2\.50:1080$/u,
    );
    assertNoSecret(views, 'nodes');
    assert.equal(
      nodeState({ isDisabled: true, isConnected: true, isConnecting: false }),
      'disabled',
    );
    assert.equal(
      nodeState({ isDisabled: false, isConnected: false, isConnecting: true }),
      'connecting',
    );
  });

  it('make hosts with every field, and mask the opaque parameters', () => {
    const views = read(PANEL_ENDPOINTS.hosts, fixtures.hosts).response.map((dto) =>
      adaptHost(dto, context),
    );
    for (const view of views) {
      PanelHostViewSchema.parse(view);
    }
    const one = must(views[0]);
    const two = must(views[1]);
    const three = must(views[2]);
    assert.equal(one.remark, 'Host 1');
    assert.equal(one.securityLayer, 'DEFAULT');
    assert.equal(one.isDisabled, false);
    assert.equal(must(views[3]).isDisabled, true);
    assert.deepEqual(one.tags, ['MAIN']);
    assert.ok(JSON.stringify(one.xhttpExtraParams).includes('plain'), 'a harmless header stays');
    assert.ok(JSON.stringify(one.xhttpExtraParams).includes('masked'));
    assert.ok(JSON.stringify(two.finalMask).includes('masked'));
    assert.ok(JSON.stringify(three.mapper).includes('masked'));
    assertNoSecret(views, 'hosts');
  });

  const profiles = () =>
    read(PANEL_ENDPOINTS.configProfiles, {
      total: 2,
      configProfiles: fixtures.configProfiles,
    }).response.configProfiles;

  it('make config profiles: a list item without the configuration, a detail with it masked, the same hash for both', () => {
    const first = must(profiles()[0]);
    const summary = adaptConfigProfile(first, context, false);
    const detail = adaptConfigProfile(first, context, true);
    PanelConfigProfileSummarySchema.parse(summary);
    PanelConfigProfileViewSchema.parse(detail);
    assert.ok(!('config' in summary));
    assert.equal(summary.hash, detail.hash);
    assert.equal(summary.nodeCount, 3);
    assert.deepEqual(
      summary.inbounds.map((i) => i.tag),
      ['VLESS_REALITY_MAIN', 'VLESS_REALITY_SECOND'],
    );
    assert.ok(
      summary.inbounds.every((i) => i.raw === undefined),
      'the list carries no raw inbound',
    );
    // The configuration reads normally except for the secrets, which are masked with a fingerprint.
    const text = JSON.stringify(detail.config);
    assert.ok(
      text.includes('VLESS_REALITY_MAIN') &&
        text.includes('node-1.example.com') &&
        text.includes('xtls-rprx-vision'),
    );
    assert.match(text, /\[masked:[0-9a-f]{8}\]/u);
    assert.ok(detail.masked >= 8, `masked ${String(detail.masked)} values`);
    assert.ok(detail.inbounds.every((i) => i.raw !== undefined));
    assertNoSecret([summary, detail], 'profile');
    // Another read of the same profile gives the same view.
    assert.deepEqual(adaptConfigProfile(first, context, true), detail);
  });

  it('give a profile another hash when a secret in it is rotated or a setting changes', () => {
    const base = must(profiles()[0]);
    const original = adaptConfigProfile(base, context, false).hash;
    const rotated = structuredClone(base);
    const config = rotated.config as {
      inbounds: { streamSettings: { realitySettings: { privateKey: string } } }[];
    };
    must(config.inbounds[0]).streamSettings.realitySettings.privateKey = 'ANOTHER-KEY';
    assert.notEqual(adaptConfigProfile(rotated, context, false).hash, original);
    assert.notEqual(
      adaptConfigProfile({ ...base, name: 'Another name' }, context, false).hash,
      original,
    );
    // The node list of a profile is not part of its configuration.
    assert.equal(adaptConfigProfile({ ...base, nodes: [] }, context, false).hash, original);
  });

  it('make squads, templates, settings, snippets, plugins and billing that satisfy their schemas', () => {
    const internal = read(PANEL_ENDPOINTS.internalSquads, {
      total: 2,
      internalSquads: fixtures.internalSquads,
    }).response.internalSquads.map((dto) => adaptInternalSquad(dto, context));
    for (const view of internal) {
      PanelInternalSquadViewSchema.parse(view);
      assert.ok(view.inbounds.every((i) => i.raw === undefined));
    }
    const externalView = adaptExternalSquad(
      must(
        read(PANEL_ENDPOINTS.externalSquads, { total: 1, externalSquads: fixtures.externalSquads })
          .response.externalSquads[0],
      ),
      context,
    );
    PanelExternalSquadViewSchema.parse(externalView);
    assert.equal(externalView.responseHeadersAdd['Profile-Title'], 'Example');
    assert.match(externalView.responseHeadersAdd['Authorization'] ?? '', /^\[masked/u);

    const [json, yaml, broken] = read(PANEL_ENDPOINTS.subscriptionTemplates, {
      total: 3,
      templates: fixtures.templates,
    }).response.templates.map((t) => adaptSubscriptionTemplate(t, context));
    for (const view of [json, yaml, broken]) {
      PanelSubscriptionTemplateViewSchema.parse(view);
    }
    assert.ok(JSON.stringify(must(json).templateJson).includes('"auth":"password"'));
    assert.equal(must(json).templateYaml, null);
    const yamlText = must(must(yaml).templateYaml);
    assert.ok(yamlText.includes('type: vless') && yamlText.includes('node-1.example.com'));
    assert.ok(yamlText.includes('masked'));
    assert.equal(must(yaml).templateJson, null);
    assert.equal(must(broken).templateYaml, null, 'a YAML that cannot be read is not shown');

    const settings = adaptSubscriptionSettings(
      read(PANEL_ENDPOINTS.subscriptionSettings, fixtures.subscriptionSettings).response,
      context,
    );
    PanelSubscriptionSettingsViewSchema.parse(settings);
    assert.equal(settings.customResponseHeaders['Support-Url'], 'https://support.example.com');
    assert.match(settings.customResponseHeaders['X-Api-Key'] ?? '', /^\[masked/u);

    const snippetViews = read(PANEL_ENDPOINTS.snippets, {
      total: 2,
      snippets: fixtures.snippets,
    }).response.snippets.map((s) => adaptSnippet(s, context));
    snippetViews.forEach((v) => PanelSnippetViewSchema.parse(v));
    assert.deepEqual(must(snippetViews[0]).snippet, { servers: ['8.8.8.8'] });

    const plugin = adaptNodePlugin(
      must(
        read(PANEL_ENDPOINTS.nodePlugins, { total: 1, nodePlugins: fixtures.nodePlugins }).response
          .nodePlugins[0],
      ),
      context,
    );
    PanelNodePluginViewSchema.parse(plugin);
    assert.ok(JSON.stringify(plugin.pluginConfig).includes('hooks.example.com'));

    const infra = adaptInfra(
      read(PANEL_ENDPOINTS.infraProviders, { total: 1, providers: fixtures.providers }).response
        .providers,
      read(PANEL_ENDPOINTS.infraBillingNodes, {
        billingNodes: fixtures.billingNodes,
        availableBillingNodes: [],
        stats: { upcomingNodesCount: 1, currentMonthPayments: 10, totalSpent: 120 },
      }).response,
      context,
    );
    PanelInfraViewSchema.parse(infra);
    assert.equal(must(infra.providers[0]).totalBills, 12);
    assert.equal(must(infra.billingNodes[0]).provider.name, 'Example Hosting');

    assertNoSecret(
      [internal, externalView, json, yaml, broken, settings, snippetViews, plugin, infra],
      'the rest',
    );
  });

  const token = () =>
    must(read(PANEL_ENDPOINTS.apiTokens, { tokens: fixtures.apiTokens }).response.tokens[0]);

  it('count the days left of an API token from the clock they are given', () => {
    const view = adaptApiToken(token(), context);
    PanelApiTokenViewSchema.parse(view);
    assert.equal(view.daysLeft, 214);
    assert.equal(daysUntil(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-02T12:00:00Z')), -2);
    assert.equal(daysUntil(new Date('2026-06-02T12:00:00Z'), new Date('2026-06-01T00:00:00Z')), 1);
  });

  it('give the same hash with a different clock, and other days left', () => {
    const a = adaptApiToken(token(), context);
    const b = adaptApiToken(token(), { ...context, now: new Date('2026-07-01T00:00:00.000Z') });
    assert.notEqual(a.daysLeft, b.daysLeft);
    assert.equal(a.hash, b.hash);
  });

  it('read a YAML template through its parsed form and refuse what is not safe or not YAML', () => {
    const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
    const masked = must(
      maskedYaml(
        encode('proxies:\n  - name: a\n    password: SECRET-PW\n    type: trojan\n'),
        context,
      ),
    );
    assert.ok(!masked.includes('SECRET-PW') && masked.includes('type: trojan'));
    assert.ok(masked.includes(MASK.slice(0, 7)));
    assert.equal(maskedYaml(null, context), null);
    assert.equal(maskedYaml('', context), null);
    assert.equal(maskedYaml(encode('just a string'), context), null, 'a scalar is not a template');
    assert.equal(maskedYaml(encode('a: [unclosed'), context), null);
    // A YAML bomb (aliases that multiply) is refused by the alias limit instead of exhausting memory.
    const letters = 'abcdefghij'.split('');
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x]',
      ...letters.slice(1).map((c, i) => {
        const before = letters[i] ?? 'a';
        return `${c}: &${c} [${Array.from({ length: 9 }, () => `*${before}`).join(',')}]`;
      }),
    ].join('\n');
    assert.equal(maskedYaml(encode(bomb), context), null);
    // Not base64 at all.
    assert.equal(maskedYaml('%%%not base64%%%', context), null);
  });
});
