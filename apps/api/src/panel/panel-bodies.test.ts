import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ConventionRunSchema,
  PanelNodePluginListSchema,
  PanelSubscriptionTemplateListSchema,
} from '@swellwright/contracts';
import { changeTemplateBody, FakePanel, FAKE_SECRETS } from '@swellwright/remnawave/test-support';

import { databaseUrl, found, type Instance, stop } from '../test-support.js';
import {
  boot,
  type Booted,
  connectTo,
  diffAgainst,
  takeSnapshot,
} from './snapshots/snapshot-test-support.js';

// The list of subscription templates of the panel has no bodies (3.4.11: "without content"). The first probe, the
// overview, the console, the checks and the snapshots all had to be taught that (ADR 0041, 0043 and 0044, notes of
// 2026-11-22). The fake panel answers like the real one, so these tests see what the first run on a real panel saw.

describe('what the lists of the panel leave out, over the API', { skip: !databaseUrl }, () => {
  let fake: FakePanel;
  let booted: Booted;
  let instance: Instance;

  const detailRequests = (kind: 'subscription-templates' | 'node-plugins'): number =>
    fake.requests.filter((request) =>
      new RegExp(`^/api/${kind}/[0-9a-f-]{36}$`, 'u').test(request.path),
    ).length;

  before(async () => {
    fake = await FakePanel.start();
    booted = await boot(fake.token);
    instance = booted.instance;
    await connectTo(booted, fake.url);
  });
  after(async () => {
    await stop(instance);
    await fake.close();
  });

  it('serves the bodies of the templates right after the connection, which the first probe saw without them', async () => {
    // The probe that made the connection read the list only, and its answers are what the memory of the server was
    // seeded with: they must not be taken for the templates with their bodies.
    const reply = await booted.owner.get('/panel/subscription-templates');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const list = PanelSubscriptionTemplateListSchema.parse(reply.body);
    assert.equal(list.templates.length, 3);
    for (const template of list.templates) {
      assert.equal(template.bodyLoaded, true, template.name);
    }
    assert.match(JSON.stringify(found(list.templates[0], 'a template').templateJson), /socks/u);
    assert.match(found(list.templates[1], 'a yaml template').templateYaml ?? '', /type: vless/u);
    assert.equal(detailRequests('subscription-templates'), 3);
    // The password in the body of a template for a local proxy is not in the answer.
    assert.ok(!JSON.stringify(reply.body).includes(FAKE_SECRETS.localProxyPassword));
  });

  it('serves the configuration of the node plugins the same way', async () => {
    const reply = await booted.owner.get('/panel/node-plugins');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const list = PanelNodePluginListSchema.parse(reply.body);
    const plugin = found(list.nodePlugins[0], 'a plugin');
    assert.equal(plugin.configLoaded, true);
    assert.match(JSON.stringify(plugin.pluginConfig), /hooks\.example\.com/u);
    assert.ok(!JSON.stringify(reply.body).includes(FAKE_SECRETS.pluginSecret));
    assert.equal(detailRequests('node-plugins'), 1);
  });

  it('counts the templates in the overview without reading a body', async () => {
    const before = detailRequests('subscription-templates');
    const reply = await booted.owner.get('/panel/overview?refresh=true');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(
      (reply.body as { counts: { subscriptionTemplates: number } }).counts.subscriptionTemplates,
      3,
    );
    assert.equal(
      detailRequests('subscription-templates'),
      before,
      'the overview asked for no detail',
    );
  });

  it('reads the bodies again on a forced read, and the checks see them: no template is called empty', async () => {
    const reply = await booted.owner.get('/panel/checks/convention?refresh=true');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const run = ConventionRunSchema.parse(reply.body);
    const empty = run.findings.filter(
      (finding) => finding.ruleId === 'template.body-present' && finding.code !== 'unreadable',
    );
    assert.deepEqual(empty, []);
    // The one body that is not YAML at all is the one that is reported, and only as unreadable.
    assert.deepEqual(
      run.findings
        .filter((finding) => finding.ruleId === 'template.body-present')
        .map((finding) => [finding.object.name, finding.code]),
      [['Template Broken Yaml', 'unreadable']],
    );
  });

  it('shows an edited body of a template in the snapshot and in the diff, which the list could not', async () => {
    const first = await takeSnapshot(booted.owner, 'before');
    const uuid = changeTemplateBody(fake.fixtures, 0, 20_808);
    const second = await takeSnapshot(booted.owner, 'after');
    const diff = await diffAgainst(booted.owner, first.id, second.id);
    assert.equal(diff.identical, false);
    const changed = found(
      diff.objects.find((object) => object.id === uuid),
      'the changed template',
    );
    assert.equal(changed.kind, 'subscriptionTemplates');
    assert.deepEqual(
      changed.changes.map((change) => [change.path, change.before, change.after]),
      [['templateJson.inbounds[tag=socks].port', 10_808, 20_808]],
    );
    changeTemplateBody(fake.fixtures, 0, 10_808);
    assert.ok(first.counts.subscriptionTemplates >= 3);
  });
});
