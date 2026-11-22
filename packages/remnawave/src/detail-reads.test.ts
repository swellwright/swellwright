import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { adaptNodePlugin, adaptSubscriptionTemplate } from './adapters.js';
import { PanelClient } from './client.js';
import { PanelForbiddenError } from './errors.js';
import { buildSnapshotContent, maskKeyIdOf } from './snapshot-content.js';
import { readPanelState } from './panel-state.js';
import { diffSnapshotContents } from './diff.js';
import {
  changeTemplateBody,
  FAKE_SECRETS,
  FakePanel,
  fakeUuid,
  type Json,
  must,
} from './test-support/index.js';
import { SubscriptionTemplateDto, NodePluginDto } from './schemas.js';

// What the real panel (3.4.11) does and the first fake panel did not: its list of subscription templates is "without
// content" (the API description says so), with `templateJson` and `encodedTemplateYaml` null for every template, and the
// body is in the detail request only. The node plugins are read the same way, as the description lets the list leave
// the configuration out. A view built from such a list must never pass for "a template without a body", and the reads
// that need the bodies (checks, snapshots, the console) must go and fetch them.

const KEY = 'a key for the fingerprints of masks, made up for the tests';

/** The hostile bodies: secrets under names and in places that a hurried masker would miss. */
const HOSTILE = {
  jsonPassword: 'FAKE-SECRET-HOSTILE-JSON-PASSWORD',
  jsonBearer: 'FAKE-SECRET-HOSTILE-BEARER-VALUE',
  jsonQuery: 'FAKE-SECRET-HOSTILE-QUERY-VALUE',
  jsonEmbedded: 'FAKE-SECRET-HOSTILE-EMBEDDED-VALUE',
  jsonPem: 'FAKE-SECRET-HOSTILE-PEM-BODY',
  yamlPassword: 'FAKE-SECRET-HOSTILE-YAML-PASSWORD',
  yamlUserinfo: 'FAKE-SECRET-HOSTILE-YAML-USERINFO',
  pluginKey: 'FAKE-SECRET-HOSTILE-PLUGIN-APIKEY',
} as const;

/** The lines of a PEM block, written so that the source holds no literal key block (the hygiene check). */
const pem = (edge: 'BEGIN' | 'END'): string => ['-----', edge, ' PRIVATE', ' KEY-----'].join('');

function hostileTemplates(): Json[] {
  const yaml = [
    'proxies:',
    '  - name: hostile',
    '    type: trojan',
    '    server: node-1.example.com',
    '    port: 443',
    `    password: ${HOSTILE.yamlPassword}`,
    'dns:',
    `  nameserver: [ "https://user:${HOSTILE.yamlUserinfo}@dns.example.com/dns-query" ]`,
    '',
  ].join('\n');
  return [
    {
      uuid: fakeUuid(0x7001),
      viewPosition: 10,
      name: 'Hostile Json',
      tags: [],
      templateType: 'XRAY_JSON',
      templateJson: {
        outbounds: [
          {
            tag: 'proxy',
            protocol: 'trojan',
            settings: {
              servers: [{ address: 'node-1.example.com', password: HOSTILE.jsonPassword }],
            },
            streamSettings: {
              wsSettings: { headers: { Authorization: `Bearer ${HOSTILE.jsonBearer}` } },
            },
          },
        ],
        remarks: { upstream: `https://example.com/api?token=${HOSTILE.jsonQuery}&x=1` },
        embedded: JSON.stringify({ apiKey: HOSTILE.jsonEmbedded }),
        key: `${pem('BEGIN')}\n${HOSTILE.jsonPem}\n${pem('END')}`,
      },
      encodedTemplateYaml: null,
    },
    {
      uuid: fakeUuid(0x7002),
      viewPosition: 11,
      name: 'Hostile Yaml',
      tags: [],
      templateType: 'MIHOMO',
      templateJson: null,
      encodedTemplateYaml: Buffer.from(yaml, 'utf8').toString('base64'),
    },
  ];
}

describe('the lists of the panel that leave bodies out, and the reads that fetch them', () => {
  let panel: FakePanel;
  const clients: PanelClient[] = [];

  const make = (extra: { maskKey?: string; concurrency?: number } = {}): PanelClient => {
    const client = new PanelClient({
      baseUrl: panel.url,
      token: panel.token,
      allowInsecureHttp: true,
      sleep: () => Promise.resolve(),
      maskKey: extra.maskKey ?? KEY,
      ...(extra.concurrency === undefined ? {} : { concurrency: extra.concurrency }),
    });
    clients.push(client);
    return client;
  };

  const count = (pattern: RegExp): number =>
    panel.requests.filter((request) => pattern.test(request.path)).length;

  before(async () => {
    panel = await FakePanel.start();
  });
  afterEach(() => {
    panel.clearInjections();
    panel.requests.length = 0;
  });
  after(async () => {
    for (const client of clients) {
      client.close();
    }
    await panel.close();
  });

  describe('the fake panel', () => {
    it('answers the way the real one does: no bodies in the list, the bodies in the detail', async () => {
      const authorization = { authorization: `Bearer ${panel.token}` };
      const list = (await (
        await fetch(`${panel.url}/api/subscription-templates`, { headers: authorization })
      ).json()) as { response: { templates: Json[] } };
      assert.equal(list.response.templates.length, 3);
      for (const template of list.response.templates) {
        assert.equal(template['templateJson'], null);
        assert.equal(template['encodedTemplateYaml'], null);
      }
      const first = must(panel.fixtures.templates[0]);
      const detail = (await (
        await fetch(`${panel.url}/api/subscription-templates/${String(first['uuid'])}`, {
          headers: authorization,
        })
      ).json()) as { response: Json };
      assert.notEqual(detail.response['templateJson'], null);
      const missing = await fetch(`${panel.url}/api/subscription-templates/${fakeUuid(0x9999)}`, {
        headers: authorization,
      });
      assert.equal(missing.status, 404);
      const plugins = (await (
        await fetch(`${panel.url}/api/node-plugins`, { headers: authorization })
      ).json()) as { response: { nodePlugins: Json[] } };
      assert.equal(must(plugins.response.nodePlugins[0])['pluginConfig'], null);
    });
  });

  describe('subscription templates', () => {
    it('are not "without a body" when they come from the list alone: bodyLoaded says so', async () => {
      const list = await make().subscriptionTemplates();
      assert.equal(list.length, 3);
      for (const template of list) {
        assert.equal(template.bodyLoaded, false, template.name);
        assert.equal(template.templateJson, null);
        assert.equal(template.templateYaml, null);
      }
      assert.equal(count(/^\/api\/subscription-templates\/[0-9a-f-]{36}$/u), 0);
    });

    it('come with their bodies through the detail request, one for each template', async () => {
      const client = make();
      const [listed] = await client.subscriptionTemplates();
      const one = await client.subscriptionTemplate(must(listed).uuid);
      assert.equal(one.bodyLoaded, true);
      assert.notEqual(one.templateJson, null);

      panel.requests.length = 0;
      const full = await client.subscriptionTemplatesWithBodies();
      assert.equal(full.length, 3);
      assert.ok(full.every((template) => template.bodyLoaded));
      assert.equal(count(/^\/api\/subscription-templates$/u), 1);
      assert.equal(count(/^\/api\/subscription-templates\/[0-9a-f-]{36}$/u), 3);
      assert.ok(panel.requests.every((request) => request.method === 'GET'));
      assert.deepEqual(
        full.map((template) => template.name),
        ['Template Json', 'Template Yaml', 'Template Broken Yaml'],
        'the order of the list is kept',
      );
      // The JSON body and the YAML body are both there, masked; a body that is not YAML is loaded and unreadable.
      assert.notEqual(must(full[0]).templateJson, null);
      assert.ok(must(full[1]).templateYaml?.includes('type: vless'));
      assert.equal(must(full[2]).templateYaml, null);
      assert.equal(must(full[2]).bodyLoaded, true);
    });

    it('are not fetched again when the list carries the bodies (an older or other panel)', async () => {
      const other = await FakePanel.start({ bodiesInLists: true });
      try {
        const client = new PanelClient({
          baseUrl: other.url,
          token: other.token,
          allowInsecureHttp: true,
          maskKey: KEY,
        });
        try {
          const full = await client.subscriptionTemplatesWithBodies();
          // The template whose body is not YAML still has an encoded body in the list, so it counts as carried.
          assert.equal(full.length, 3);
          assert.ok(full.every((template) => template.bodyLoaded));
          const details = other.requests.filter((request) =>
            /^\/api\/subscription-templates\/[0-9a-f-]{36}$/u.test(request.path),
          );
          assert.equal(details.length, 0);
        } finally {
          client.close();
        }
      } finally {
        await other.close();
      }
    });

    it('are read with bounded concurrency, however many there are', async () => {
      const added: Json[] = [];
      for (let i = 0; i < 12; i += 1) {
        added.push({
          uuid: fakeUuid(0x7100 + i),
          viewPosition: 100 + i,
          name: `Many ${String(i)}`,
          tags: [],
          templateType: 'XRAY_JSON',
          templateJson: { n: i },
          encodedTemplateYaml: null,
        });
      }
      panel.fixtures.templates.push(...added);
      panel.inject(/^\/api\/subscription-templates\/[0-9a-f-]{36}$/u, { kind: 'delay', ms: 25 });
      try {
        panel.peakConcurrency = 0;
        const full = await make({ concurrency: 3 }).subscriptionTemplatesWithBodies();
        assert.equal(full.length, 15);
        assert.ok(panel.peakConcurrency <= 3, `peak ${String(panel.peakConcurrency)}`);
        assert.ok(panel.peakConcurrency >= 2, 'and the reads did overlap');
      } finally {
        panel.fixtures.templates = panel.fixtures.templates.filter((t) => !added.includes(t));
      }
    });

    it('leave out a template that was deleted between the list and its detail', async () => {
      const gone = must(panel.fixtures.templates[1]);
      panel.inject(`/api/subscription-templates/${String(gone['uuid'])}`, {
        kind: 'status',
        status: 404,
        body: { message: 'Subscription template not found', errorCode: 'A170' },
      });
      const full = await make().subscriptionTemplatesWithBodies();
      assert.deepEqual(
        full.map((template) => template.name),
        ['Template Json', 'Template Broken Yaml'],
      );
    });

    it('fail the read when a detail is refused, and never hand back a half-read list', async () => {
      const refused = must(panel.fixtures.templates[0]);
      panel.forbid(`/api/subscription-templates/${String(refused['uuid'])}`);
      await assert.rejects(() => make().subscriptionTemplatesWithBodies(), PanelForbiddenError);
    });

    it('have a hash that covers the body, and not how the view was read', () => {
      const dto = SubscriptionTemplateDto.parse(must(panel.fixtures.templates[0]));
      const context = { fingerprintKey: KEY };
      const fromList = adaptSubscriptionTemplate(dto, context);
      const fromDetail = adaptSubscriptionTemplate(dto, context, true);
      assert.equal(fromList.bodyLoaded, true, 'a body in the list is a body that was read');
      assert.equal(fromList.hash, fromDetail.hash);
      const edited = adaptSubscriptionTemplate(
        SubscriptionTemplateDto.parse({
          ...dto,
          templateJson: { ...(dto.templateJson as Json), extra: 1 },
        }),
        context,
        true,
      );
      assert.notEqual(edited.hash, fromDetail.hash, 'the hash moves with the body');
      const bare = SubscriptionTemplateDto.parse({ ...dto, templateJson: null });
      const unread = adaptSubscriptionTemplate(bare, context);
      const readEmpty = adaptSubscriptionTemplate(bare, context, true);
      assert.equal(unread.bodyLoaded, false);
      assert.equal(readEmpty.bodyLoaded, true);
      assert.equal(unread.hash, readEmpty.hash, 'the flag is not part of the hash');
    });
  });

  describe('node plugins', () => {
    it('say that their configuration was not read when the list leaves it out', async () => {
      const [plugin] = await make().nodePlugins();
      assert.equal(must(plugin).configLoaded, false);
      assert.equal(must(plugin).pluginConfig, null);
    });

    it('come with their configuration through the detail request', async () => {
      const client = make();
      const [listed] = await client.nodePlugins();
      const one = await client.nodePlugin(must(listed).uuid);
      assert.equal(one.configLoaded, true);
      assert.notEqual(one.pluginConfig, null);
      panel.requests.length = 0;
      const full = await client.nodePluginsWithConfigs();
      assert.equal(full.length, 1);
      assert.equal(must(full[0]).configLoaded, true);
      assert.equal(count(/^\/api\/node-plugins\/[0-9a-f-]{36}$/u), 1);
    });

    it('have a hash that covers the configuration, and not how the view was read', () => {
      const dto = NodePluginDto.parse(must(panel.fixtures.nodePlugins[0]));
      const context = { fingerprintKey: KEY };
      const read = adaptNodePlugin(dto, context);
      assert.equal(read.configLoaded, true);
      assert.equal(read.hash, adaptNodePlugin(dto, context, true).hash);
      const bare = NodePluginDto.parse({ ...dto, pluginConfig: null });
      assert.equal(adaptNodePlugin(bare, context).configLoaded, false);
      assert.equal(adaptNodePlugin(bare, context).hash, adaptNodePlugin(bare, context, true).hash);
      assert.notEqual(adaptNodePlugin(bare, context).hash, read.hash);
    });
  });

  describe('the secrets in what the new reads return', () => {
    const secrets = [...Object.values(FAKE_SECRETS).flat(), ...Object.values(HOSTILE)];

    it('never leave the client, in a body or in a request, whatever the body holds', async () => {
      const hostile = hostileTemplates();
      panel.fixtures.templates.push(...hostile);
      panel.fixtures.nodePlugins.push({
        uuid: fakeUuid(0x7201),
        viewPosition: 5,
        name: 'Hostile Plugin',
        tags: [],
        pluginConfig: {
          endpoints: [{ url: 'https://hooks.example.com/x', apiKey: HOSTILE.pluginKey }],
        },
      });
      try {
        const client = make();
        const templates = await client.subscriptionTemplatesWithBodies();
        const plugins = await client.nodePluginsWithConfigs();
        const state = await readPanelState(client);
        const content = buildSnapshotContent(state, maskKeyIdOf(KEY));
        const everything = JSON.stringify([templates, plugins, state, content]);
        for (const secret of secrets) {
          assert.ok(!everything.includes(secret), `${secret} came through`);
        }
        // The masks are there, and so are the neighbours of the secrets that are not secret.
        const hostileJson = must(templates.find((template) => template.name === 'Hostile Json'));
        assert.match(JSON.stringify(hostileJson.templateJson), /\[masked:[0-9a-f]{8}\]/u);
        assert.match(JSON.stringify(hostileJson.templateJson), /"address":"node-1\.example\.com"/u);
        const hostileYaml = must(templates.find((template) => template.name === 'Hostile Yaml'));
        assert.ok(hostileYaml.templateYaml?.includes('type: trojan'));
        assert.match(hostileYaml.templateYaml ?? '', /\[masked:[0-9a-f]{8}\]/u);
        assert.equal(
          must(plugins.find((plugin) => plugin.name === 'Hostile Plugin')).configLoaded,
          true,
        );
        // What went over the wire to the panel holds no secret either (the paths name uuids only).
        for (const request of panel.requests) {
          for (const secret of [...secrets, panel.token]) {
            assert.ok(!request.path.includes(secret), request.path);
          }
        }
      } finally {
        panel.fixtures.templates = panel.fixtures.templates.filter((t) => !hostile.includes(t));
        panel.fixtures.nodePlugins = panel.fixtures.nodePlugins.filter(
          (p) => p['name'] !== 'Hostile Plugin',
        );
      }
    });
  });

  describe('the snapshot of a panel whose list has no bodies', () => {
    it('holds the bodies, and a change of a body shows in the hash and in the diff', async () => {
      const client = make();
      const before = buildSnapshotContent(await readPanelState(client), maskKeyIdOf(KEY));
      const templates = must(before.kinds.subscriptionTemplates);
      assert.equal(templates.length, 3);
      for (const entry of templates) {
        const config = entry.config as Json;
        if (entry.name === 'Template Broken Yaml') {
          // A body that cannot be parsed cannot be masked either, so it is not stored in any form (ADR 0043, note).
          assert.equal(config['templateYaml'], null);
          continue;
        }
        assert.ok(
          config['templateJson'] !== null || config['templateYaml'] !== null,
          `${entry.name} has a body in the snapshot`,
        );
        assert.equal('bodyLoaded' in config, false, 'how a view was read is not content');
      }

      const uuid = changeTemplateBody(panel.fixtures, 0, 20_999);
      try {
        const after = buildSnapshotContent(await readPanelState(client), maskKeyIdOf(KEY));
        const was = must(templates.find((entry) => entry.id === uuid));
        const now = must(
          must(after.kinds.subscriptionTemplates).find((entry) => entry.id === uuid),
        );
        assert.notEqual(now.hash, was.hash, 'the object hash includes the body');
        const diff = diffSnapshotContents(before, after);
        assert.equal(diff.identical, false);
        const changed = must(diff.objects[0]);
        assert.equal(changed.kind, 'subscriptionTemplates');
        assert.deepEqual(
          changed.changes.map((change) => [change.path, change.before, change.after]),
          [['templateJson.inbounds[tag=socks].port', 10_808, 20_999]],
        );
        assert.equal(diff.objects.length, 1);
      } finally {
        changeTemplateBody(panel.fixtures, 0, 10_808);
      }
    });
  });
});
