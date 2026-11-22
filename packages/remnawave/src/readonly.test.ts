import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { PanelClient, type PanelReader } from './client.js';
import { type PanelEndpoint, PANEL_ENDPOINTS } from './endpoints.js';
import { FakePanel } from './test-support/index.js';

// The client of this slice reads and never writes (ADR 0041). Three independent checks say so: the type has no write
// method, the sources contain no verb but GET, and a client that is used for everything it can do never makes the
// panel see another method.

const READ_METHODS = [
  'baseUrl',
  'billingHistory',
  'call',
  'close',
  'computedConfig',
  'configProfile',
  'configProfiles',
  'configuration',
  'constructor',
  'externalSquads',
  'health',
  'hosts',
  'infra',
  'internalSquads',
  'nodePlugin',
  'nodePlugins',
  'nodePluginsWithConfigs',
  'nodes',
  'snippets',
  'subscriptionSettings',
  'subscriptionTemplate',
  'subscriptionTemplates',
  'subscriptionTemplatesWithBodies',
  'userCounts',
  'version',
  'apiTokens',
  'withDetails',
];

describe('the client is read-only', () => {
  it('has no method that writes, by name and by verb', () => {
    const names = Object.getOwnPropertyNames(PanelClient.prototype).sort();
    assert.deepEqual(names, [...READ_METHODS].sort());
    for (const name of names) {
      assert.ok(
        !/^(post|put|patch|delete|create|update|remove|set|save|restart|enable|disable|reorder|bulk|add|write|send|revoke|rotate|execute|run|apply)/iu.test(
          name,
        ),
        name,
      );
    }
  });

  it('has no write method in its type either', () => {
    const reader = {} as PanelReader;
    // Each line below must not compile; `@ts-expect-error` fails the build if one of them starts to.
    // @ts-expect-error there is no post on the reader
    assert.equal(typeof reader.post, 'undefined');
    // @ts-expect-error there is no delete on the reader
    assert.equal(typeof reader.delete, 'undefined');
    // @ts-expect-error nodes cannot be created
    assert.equal(typeof reader.createNode, 'undefined');
    // @ts-expect-error nodes cannot be updated
    assert.equal(typeof reader.updateNode, 'undefined');
    // @ts-expect-error no raw request escape hatch
    assert.equal(typeof reader.request, 'undefined');
    // The endpoint type admits GET and nothing else.
    // @ts-expect-error only the literal GET
    const bad: PanelEndpoint['method'] = 'POST';
    assert.notEqual(bad, 'GET');
  });

  it('has no endpoint that is not a GET', () => {
    for (const endpoint of Object.values(PANEL_ENDPOINTS) as PanelEndpoint[]) {
      assert.equal(endpoint.method, 'GET', endpoint.id);
    }
  });

  it('has no other HTTP verb in its sources', () => {
    // The sources of the client, and those of the API console (ADR 0046), which also only sends a GET.
    const dirs = [new URL('../src/', import.meta.url), new URL('../src/console/', import.meta.url)];
    const verbs =
      /['"`](POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)['"`]|\.(post|put|patch|delete)\(/u;
    let scanned = 0;
    for (const dir of dirs) {
      const files = readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
        )
        .map((entry) => entry.name);
      for (const file of files) {
        const text = readFileSync(new URL(file, dir), 'utf8');
        assert.ok(!verbs.test(text), `${file} names another HTTP verb`);
        scanned += 1;
      }
      if (dir === dirs[0]) {
        assert.ok(files.includes('transport.ts') && files.includes('http.ts'));
      }
    }
    assert.ok(scanned > 20);
  });

  describe('against a panel that records what it is asked', () => {
    let panel: FakePanel;
    before(async () => {
      panel = await FakePanel.start();
    });
    after(async () => {
      await panel.close();
    });

    it('sees only GET, whatever the client is made to do', async () => {
      const client = new PanelClient({
        baseUrl: panel.url,
        token: panel.token,
        allowInsecureHttp: true,
      });
      try {
        await client.nodes();
        await client.hosts();
        const [profile] = await client.configProfiles();
        await client.configProfile(profile?.uuid ?? '');
        await client.infra();
        await client.billingHistory();
        await client.subscriptionTemplates();
        await client.snippets();
        await client.version();
        assert.ok(panel.requests.length >= 10);
        assert.deepEqual([...new Set(panel.requests.map((r) => r.method))], ['GET']);
      } finally {
        client.close();
      }
    });
  });
});
