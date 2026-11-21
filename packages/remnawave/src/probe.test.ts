import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { PanelClient } from './client.js';
import {
  PanelAuthError,
  PanelContractError,
  PanelUnavailableError,
  PanelVersionError,
} from './errors.js';
import { probePanel } from './probe.js';
import { FakePanel, must } from './test-support/index.js';
import { assessPanelVersion, parsePanelVersion, SUPPORTED_PANEL_RANGE } from './version.js';

describe('the version window', () => {
  it('reads version numbers and refuses what is not one', () => {
    assert.deepEqual(parsePanelVersion('3.4.11'), {
      major: 3,
      minor: 4,
      patch: 11,
      prerelease: null,
    });
    assert.deepEqual(parsePanelVersion('v3.4.12-beta.1'), {
      major: 3,
      minor: 4,
      patch: 12,
      prerelease: 'beta.1',
    });
    assert.equal(parsePanelVersion('3.4.12+build.5')?.patch, 12);
    for (const bad of [
      '',
      'latest',
      '3.4',
      '3.4.x',
      '3.4.11.1',
      'v',
      '3..4',
      '-3.4.1',
      '3.4.11; drop',
    ]) {
      assert.equal(parsePanelVersion(bad), null, bad);
    }
  });

  it('supports every patch of the 3.4 line and reports the rest with a reason', () => {
    assert.equal(SUPPORTED_PANEL_RANGE, '3.4.x');
    for (const good of ['3.4.0', '3.4.11', '3.4.20', '3.4.99', '3.4.12-beta.1']) {
      assert.deepEqual(
        assessPanelVersion(good),
        { status: 'supported', range: '3.4.x', reason: null },
        good,
      );
    }
    const newer = assessPanelVersion('3.5.0');
    assert.equal(newer.status, 'unsupported');
    assert.match(newer.reason ?? '', /newer than/u);
    assert.match(assessPanelVersion('4.0.1').reason ?? '', /newer than/u);
    assert.match(assessPanelVersion('3.3.3').reason ?? '', /older than/u);
    assert.match(assessPanelVersion('2.9.33').reason ?? '', /older than/u);
    assert.match(assessPanelVersion('nonsense').reason ?? '', /not a version/u);
    assert.match(assessPanelVersion(null).reason ?? '', /did not report/u);
  });
});

describe('probing a panel', () => {
  let panel: FakePanel;
  let client: PanelClient;
  const make = (overrides: { token?: string; timeoutMs?: number } = {}): PanelClient => {
    client = new PanelClient({
      baseUrl: panel.url,
      token: overrides.token ?? panel.token,
      allowInsecureHttp: true,
      sleep: () => Promise.resolve(),
      timeoutMs: overrides.timeoutMs ?? 5000,
    });
    return client;
  };

  before(async () => {
    panel = await FakePanel.start();
  });
  afterEach(() => {
    client.close();
    panel.clearInjections();
    panel.requests.length = 0;
    panel.setVersion('3.4.11');
    panel.setToken(panel.token);
  });
  after(async () => {
    await panel.close();
  });

  it('finds the version, what the token can read, and keeps what it read', async () => {
    const probe = await probePanel(make());
    assert.equal(probe.fatal, null);
    assert.equal(probe.version?.version, '3.4.11');
    assert.equal(probe.support?.status, 'supported');
    // The panel lets an API token read everything but the list of API tokens.
    for (const resource of [
      'system',
      'nodes',
      'hosts',
      'configProfiles',
      'internalSquads',
      'externalSquads',
      'subscriptionTemplates',
      'subscriptionSettings',
      'snippets',
      'nodePlugins',
      'infra',
    ] as const) {
      assert.equal(probe.capabilities[resource], 'ok', resource);
    }
    assert.equal(probe.capabilities.apiTokens, 'denied');
    assert.equal(probe.data.nodes?.length, 3);
    assert.equal(probe.data.hosts?.length, 4);
    assert.equal(probe.system.health?.instances, 2);
    assert.equal(probe.system.userCounts?.total, 46);
    assert.deepEqual(probe.failures, {});
  });

  it('lets an administrator session read the API tokens', async () => {
    await panel.close();
    panel = await FakePanel.start({ adminSession: true });
    const probe = await probePanel(make());
    assert.equal(probe.capabilities.apiTokens, 'ok');
    assert.equal(probe.data.apiTokens?.length, 1);
  });

  it('marks a resource the token has no scope for as denied, and the rest stays usable', async () => {
    panel.forbid('/api/hosts', '/api/system/stats');
    const probe = await probePanel(make());
    assert.equal(probe.fatal, null);
    assert.equal(probe.capabilities.hosts, 'denied');
    assert.equal(
      probe.capabilities.system,
      'denied',
      'one denied system read denies the capability',
    );
    assert.equal(probe.capabilities.nodes, 'ok');
    assert.equal(probe.data.hosts, undefined);
    assert.ok(probe.data.nodes);
  });

  it('marks a resource that fails in another way as failed, with the code, and goes on', async () => {
    panel.inject('/api/snippets', { kind: 'status', status: 500 });
    panel.inject('/api/node-plugins', {
      kind: 'replace',
      body: { response: { nodePlugins: [{ uuid: 'bad' }] } },
    });
    const probe = await probePanel(make());
    assert.equal(probe.fatal, null);
    assert.equal(probe.capabilities.snippets, 'failed');
    assert.equal(probe.failures.snippets?.code, 'panel_unreachable');
    assert.equal(probe.capabilities.nodePlugins, 'failed');
    assert.equal(probe.failures.nodePlugins?.code, 'panel_contract_changed');
    assert.match(must(probe.failures.nodePlugins).message, /node-plugins|nodePlugins/u);
    assert.equal(probe.capabilities.nodes, 'ok');
  });

  it('is fatal for a token the panel refuses, with no capabilities', async () => {
    const probe = await probePanel(make({ token: 'a-token-the-panel-does-not-know-000000' }));
    assert.ok(probe.fatal instanceof PanelAuthError);
    assert.equal(probe.version, null);
    assert.deepEqual(probe.capabilities, {});
    assert.equal(panel.requests.length, 1, 'only the first request was made');
  });

  it('is fatal for a panel that is not there or answers in an unknown shape', async () => {
    panel.inject('/api/system/metadata', {
      kind: 'replace',
      body: { response: { ver: '3.4.11' } },
    });
    const drift = await probePanel(make());
    assert.ok(drift.fatal instanceof PanelContractError);
    panel.clearInjections();

    panel.inject('/api/system/metadata', { kind: 'status', status: 503 });
    const down = await probePanel(make());
    assert.ok(down.fatal instanceof PanelUnavailableError);
  });

  it('is fatal for a version outside the window and reads nothing more', async () => {
    for (const version of ['3.5.0', '3.3.9', '4.0.0', 'unknown']) {
      panel.setVersion(version);
      const probe = await probePanel(make());
      assert.ok(probe.fatal instanceof PanelVersionError, version);
      assert.equal(probe.version?.version, version);
      assert.equal(probe.support?.status, 'unsupported');
      assert.equal(panel.requests.length, 1, `${version}: only the version was asked`);
      assert.match(probe.fatal.message, /\S/u);
      assert.deepEqual(probe.capabilities, {});
      panel.requests.length = 0;
    }
  });

  it('notices a token that is revoked while the probe runs', async () => {
    // The version answer is allowed, then every later request is refused.
    const original = panel.token;
    const probeClient = make();
    const reads = probePanel({
      baseUrl: probeClient.baseUrl,
      version: async () => {
        const result = await probeClient.version();
        panel.setToken('rotated-token-0000000000000000000000');
        return result;
      },
      health: () => probeClient.health(),
      configuration: () => probeClient.configuration(),
      userCounts: () => probeClient.userCounts(),
      nodes: () => probeClient.nodes(),
      hosts: () => probeClient.hosts(),
      configProfiles: () => probeClient.configProfiles(),
      configProfile: (uuid) => probeClient.configProfile(uuid),
      computedConfig: (uuid) => probeClient.computedConfig(uuid),
      internalSquads: () => probeClient.internalSquads(),
      externalSquads: () => probeClient.externalSquads(),
      subscriptionTemplates: () => probeClient.subscriptionTemplates(),
      subscriptionSettings: () => probeClient.subscriptionSettings(),
      snippets: () => probeClient.snippets(),
      nodePlugins: () => probeClient.nodePlugins(),
      infra: () => probeClient.infra(),
      apiTokens: () => probeClient.apiTokens(),
      billingHistory: (max) => probeClient.billingHistory(max),
      close: () => undefined,
    });
    const probe = await reads;
    assert.ok(probe.fatal instanceof PanelAuthError);
    panel.setToken(original);
  });
});
