import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { PANEL_SNAPSHOT_OBJECT_KINDS } from '@swellwright/contracts';

import { PanelClient } from './client.js';
import { diffSnapshotContents } from './diff.js';
import { PanelAuthError, PanelVersionError } from './errors.js';
import { contentHash } from './mask.js';
import { type PanelState, readPanelState } from './panel-state.js';
import {
  buildSnapshotContent,
  countsOf,
  kindHashesOf,
  maskKeyIdOf,
  objectCountOf,
  overallHashOf,
  SNAPSHOT_CONTENT_FORMAT,
  SNAPSHOT_CONTENT_VERSION,
  type SnapshotContent,
  verifySnapshotContent,
} from './snapshot-content.js';
import {
  addClient,
  addProfileInbound,
  changeHostAddress,
  changeRuntimeOnly,
  changeTemplateBody,
  FAKE_SECRETS,
  FakePanel,
  must,
  removeNode,
  reorderNodeTags,
  ROTATED_SECRETS,
  rotateRealityKey,
} from './test-support/index.js';

const KEY = 'a key for the fingerprints of masks, made up for the tests';
const OTHER_KEY = 'another key for the fingerprints of masks, made up too';

describe('the content of a snapshot', () => {
  let panel: FakePanel;
  let client: PanelClient | undefined;

  const make = (maskKey: string = KEY): PanelClient => {
    client = new PanelClient({
      baseUrl: panel.url,
      token: panel.token,
      allowInsecureHttp: true,
      sleep: () => Promise.resolve(),
      timeoutMs: 15_000,
      maskKey,
    });
    return client;
  };
  const read = async (maskKey: string = KEY): Promise<PanelState> => readPanelState(make(maskKey));
  const snapshot = async (maskKey: string = KEY): Promise<SnapshotContent> =>
    buildSnapshotContent(await read(maskKey), maskKeyIdOf(maskKey));

  before(async () => {
    panel = await FakePanel.start();
  });
  afterEach(() => {
    client?.close();
    panel.clearInjections();
    panel.setVersion('3.4.11');
    panel.setToken(panel.token);
  });
  after(async () => {
    await panel.close();
  });

  it('reads every kind, with the configuration of every profile, and is complete', async () => {
    const state = await read();
    for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
      assert.equal(state.coverage[kind], 'ok', kind);
    }
    assert.equal(state.version.version, '3.4.11');
    assert.deepEqual(state.failures, {});
    // The list of profiles carries no configuration; the state has it for each.
    assert.equal(state.data.configProfiles?.length, 2);
    for (const profile of state.data.configProfiles ?? []) {
      assert.ok('config' in profile);
    }
    const content = buildSnapshotContent(state, maskKeyIdOf(KEY));
    assert.deepEqual(countsOf(content), {
      nodes: 3,
      hosts: 4,
      configProfiles: 2,
      internalSquads: 2,
      externalSquads: 1,
      subscriptionTemplates: 3,
      subscriptionSettings: 1,
      snippets: 2,
      nodePlugins: 1,
      infraProviders: 1,
      billingNodes: 1,
    });
    assert.equal(objectCountOf(content), 21);
  });

  it('gives each object the hash its view carries, so that a snapshot and the read pages agree', async () => {
    const state = await read();
    const content = buildSnapshotContent(state, maskKeyIdOf(KEY));
    const viewHashes = new Map<string, string>();
    const collect = (
      kind: string,
      views: readonly { hash: string }[],
      id: (v: never) => string,
    ) => {
      for (const view of views) {
        viewHashes.set(`${kind}:${id(view as never)}`, view.hash);
      }
    };
    collect('nodes', state.data.nodes ?? [], (v: { uuid: string }) => v.uuid);
    collect('hosts', state.data.hosts ?? [], (v: { uuid: string }) => v.uuid);
    collect('configProfiles', state.data.configProfiles ?? [], (v: { uuid: string }) => v.uuid);
    collect('internalSquads', state.data.internalSquads ?? [], (v: { uuid: string }) => v.uuid);
    collect('externalSquads', state.data.externalSquads ?? [], (v: { uuid: string }) => v.uuid);
    collect(
      'subscriptionTemplates',
      state.data.subscriptionTemplates ?? [],
      (v: { uuid: string }) => v.uuid,
    );
    collect('snippets', state.data.snippets ?? [], (v: { name: string }) => v.name);
    collect('nodePlugins', state.data.nodePlugins ?? [], (v: { uuid: string }) => v.uuid);
    collect('infraProviders', state.data.infra?.providers ?? [], (v: { uuid: string }) => v.uuid);
    collect('billingNodes', state.data.infra?.billingNodes ?? [], (v: { uuid: string }) => v.uuid);
    if (state.data.subscriptionSettings) {
      viewHashes.set(
        `subscriptionSettings:${state.data.subscriptionSettings.uuid}`,
        state.data.subscriptionSettings.hash,
      );
    }
    let checked = 0;
    for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
      for (const entry of content.kinds[kind] ?? []) {
        assert.equal(entry.hash, viewHashes.get(`${kind}:${entry.id}`), `${kind} ${entry.name}`);
        checked += 1;
      }
    }
    assert.equal(checked, viewHashes.size);
    assert.equal(verifySnapshotContent(content), null);
  });

  it('holds no secret and no runtime state', async () => {
    const text = JSON.stringify(await snapshot());
    for (const secret of Object.values(FAKE_SECRETS).flat()) {
      assert.ok(!text.includes(secret), `the content holds ${secret}`);
    }
    assert.match(text, /\[masked:[0-9a-f]{8}\]/u);
    for (const runtime of [
      'usersOnline',
      'xrayUptime',
      'trafficUsedBytes',
      'lastStatusChange',
      'isConnected',
    ]) {
      assert.ok(!text.includes(runtime), `the content holds ${runtime}`);
    }
  });

  it('has the same hashes on two reads and a different overall hash after an edit', async () => {
    const first = await snapshot();
    const second = await snapshot();
    assert.equal(overallHashOf(first), overallHashOf(second));
    assert.deepEqual(kindHashesOf(first), kindHashesOf(second));
    changeHostAddress(panel.fixtures, 0, '192.0.2.200');
    try {
      const third = await snapshot();
      assert.notEqual(overallHashOf(first), overallHashOf(third));
      const hashes = kindHashesOf(third);
      const before = kindHashesOf(first);
      assert.notEqual(hashes.hosts, before.hosts);
      assert.equal(hashes.nodes, before.nodes);
    } finally {
      changeHostAddress(panel.fixtures, 0, '192.0.2.11');
    }
  });

  it('does not change when only what a node does by itself changes', async () => {
    const first = await snapshot();
    changeRuntimeOnly(panel.fixtures);
    const second = await snapshot();
    assert.equal(overallHashOf(first), overallHashOf(second));
    const result = diffSnapshotContents(first, second);
    assert.equal(result.identical, true);
    assert.deepEqual(result.objects, []);
  });

  describe('against a panel that is edited', () => {
    it('finds a host whose address was changed', async () => {
      const first = await snapshot();
      const uuid = changeHostAddress(panel.fixtures, 1, '192.0.2.222');
      const result = diffSnapshotContents(first, await snapshot());
      assert.equal(result.summary.objects.changed, 1);
      const host = must(result.objects[0]);
      assert.equal(host.kind, 'hosts');
      assert.equal(host.id, uuid);
      assert.deepEqual(host.changes, [
        { path: 'address', op: 'changed', before: '192.0.2.12', after: '192.0.2.222' },
      ]);
    });

    it('finds an inbound that was added to a profile as one change in its list and one in its configuration', async () => {
      const first = await snapshot();
      addProfileInbound(panel.fixtures, 0, 'NEW_INBOUND', 9001);
      const result = diffSnapshotContents(first, await snapshot());
      const profile = must(result.objects[0]);
      assert.equal(profile.kind, 'configProfiles');
      assert.deepEqual(
        profile.changes.map((change) => `${change.path}:${change.op}`),
        ['config.inbounds[tag=NEW_INBOUND]:added', 'inbounds[tag=NEW_INBOUND]:added'],
      );
    });

    it('finds a node that was removed, and the profile and billing it was listed in stay as they are', async () => {
      const first = await snapshot();
      const uuid = removeNode(panel.fixtures, 2);
      const result = diffSnapshotContents(first, await snapshot());
      const removed = result.objects.filter((object) => object.status === 'removed');
      assert.deepEqual(
        removed.map((object) => [object.kind, object.id]),
        [['nodes', uuid]],
      );
    });

    it('finds a template whose body changed', async () => {
      const first = await snapshot();
      changeTemplateBody(panel.fixtures, 0, 20808);
      const result = diffSnapshotContents(first, await snapshot());
      const template = must(result.objects[0]);
      assert.equal(template.kind, 'subscriptionTemplates');
      assert.deepEqual(
        template.changes.map((change) => [change.path, change.before, change.after]),
        [['templateJson.inbounds[tag=socks].port', 10808, 20808]],
      );
    });

    it('shows a rotated secret as changed and masked and never as a value, whichever side holds it', async () => {
      const first = await snapshot();
      rotateRealityKey(panel.fixtures);
      const second = await snapshot();
      const result = diffSnapshotContents(first, second);
      const profile = must(result.objects[0]);
      assert.equal(profile.kind, 'configProfiles');
      assert.ok(profile.changes.length >= 1);
      for (const change of profile.changes) {
        assert.equal(change.masked, true);
        assert.match(String(change.before), /^\[masked:[0-9a-f]{8}\]$/u);
        assert.match(String(change.after), /^\[masked:[0-9a-f]{8}\]$/u);
        assert.notEqual(change.before, change.after);
      }
      const text = JSON.stringify([result, first, second]);
      assert.ok(!text.includes(ROTATED_SECRETS.realityPrivateKey));
      assert.ok(!text.includes(FAKE_SECRETS.realityPrivateKey));
    });

    it('counts a client that was added and shows nothing about it', async () => {
      const first = await snapshot();
      addClient(panel.fixtures);
      const result = diffSnapshotContents(first, await snapshot());
      const [profile] = result.objects;
      const hidden = profile?.changes.filter((change) => change.hidden === true) ?? [];
      assert.deepEqual(
        hidden.map((change) => [change.path, change.before, change.after]),
        [['config.inbounds[tag=VLESS_REALITY_MAIN].settings.clients', { items: 1 }, { items: 2 }]],
      );
      const text = JSON.stringify(result);
      assert.ok(!text.includes(ROTATED_SECRETS.newClientId));
      assert.ok(!text.includes('new@example.com'));
    });

    it('finds nothing in tags that were only put in another order', async () => {
      const node = must(panel.fixtures.nodes[0]);
      node['tags'] = ['ALPHA', 'BETA'];
      const first = await snapshot();
      reorderNodeTags(panel.fixtures, 0);
      const second = await snapshot();
      // The hash of the node moved with the order; no field did.
      assert.notEqual(overallHashOf(first), overallHashOf(second));
      const result = diffSnapshotContents(first, second);
      assert.equal(result.identical, true);
      assert.deepEqual(result.notes, [{ code: 'noise_only', count: 1 }]);
      node['tags'] = ['PRIMARY'];
    });

    it('does not tell a rotation from an unchanged secret when the key of the masks changed, and says so', async () => {
      const first = await snapshot(KEY);
      const second = await snapshot(OTHER_KEY);
      assert.notEqual(first.maskKeyId, second.maskKeyId);
      const result = diffSnapshotContents(first, second);
      assert.equal(result.identical, true);
      assert.deepEqual(result.notes, [{ code: 'mask_key_differs' }]);
      // A real change is still found in the same comparison.
      changeHostAddress(panel.fixtures, 0, '192.0.2.201');
      try {
        const third = await snapshot(OTHER_KEY);
        const found = diffSnapshotContents(first, third);
        assert.equal(found.summary.objects.changed, 1);
      } finally {
        changeHostAddress(panel.fixtures, 0, '192.0.2.11');
      }
    });
  });

  describe('against a panel that refuses', () => {
    it('leaves out a kind the token cannot read, and says it was denied', async () => {
      panel.forbid('/api/hosts');
      const state = await read();
      assert.equal(state.coverage.hosts, 'denied');
      assert.equal(state.coverage.nodes, 'ok');
      assert.equal(state.data.hosts, undefined);
      const content = buildSnapshotContent(state, maskKeyIdOf(KEY));
      assert.equal(content.kinds.hosts, undefined);
      assert.equal(countsOf(content).hosts, 0);
      // Both halves of the billing data come from the same read.
      panel.clearInjections();
      panel.forbid('/api/infra-billing/providers');
      const second = await read();
      assert.equal(second.coverage.infraProviders, 'denied');
      assert.equal(second.coverage.billingNodes, 'denied');
    });

    it('leaves out a kind the panel answers in a shape it does not know, with the endpoint named', async () => {
      panel.inject('/api/snippets', {
        kind: 'replace',
        body: { response: { snippets: 'not a list' } },
      });
      const state = await read();
      assert.equal(state.coverage.snippets, 'failed');
      const failure = must(state.failures.snippets);
      assert.equal(failure.code, 'panel_contract_changed');
      assert.match(failure.message, /snippets/u);
      assert.equal(state.coverage.nodes, 'ok');
    });

    it('fails as a whole when the token is refused, the panel is down, or the version is not supported', async () => {
      const used = new PanelClient({
        baseUrl: panel.url,
        token: panel.token,
        allowInsecureHttp: true,
        sleep: () => Promise.resolve(),
        timeoutMs: 15_000,
      });
      try {
        // The panel now accepts another token: the one in use has been revoked.
        const original = panel.token;
        panel.setToken('another token that the panel will accept instead of the one in use');
        await assert.rejects(readPanelState(used), PanelAuthError);
        panel.setToken(original);
      } finally {
        used.close();
      }
      panel.setVersion('3.5.1');
      await assert.rejects(read(), PanelVersionError);
    });

    it('does not compare a kind that one of the two could not read', async () => {
      const full = await snapshot();
      panel.forbid('/api/hosts');
      const partial = await snapshot();
      const result = diffSnapshotContents(full, partial);
      assert.equal(result.identical, true);
      assert.deepEqual(result.notes, [{ code: 'kind_not_covered', kinds: ['hosts'] }]);
      assert.notEqual(overallHashOf(full), overallHashOf(partial));
    });
  });

  it('reads and compares a large panel (800 nodes, 800 hosts) in a moment, and finds the one node that changed', async () => {
    const big = await FakePanel.start({ extraNodes: 800, extraHosts: 800 });
    try {
      const reader = new PanelClient({
        baseUrl: big.url,
        token: big.token,
        allowInsecureHttp: true,
        sleep: () => Promise.resolve(),
        timeoutMs: 15_000,
        maskKey: KEY,
      });
      const started = Date.now();
      const first = buildSnapshotContent(await readPanelState(reader), maskKeyIdOf(KEY));
      assert.equal(countsOf(first).nodes, 803);
      assert.equal(countsOf(first).hosts, 804);
      const target = big.fixtures.nodes[500];
      assert.ok(target);
      target['address'] = '203.0.113.77';
      const second = buildSnapshotContent(await readPanelState(reader), maskKeyIdOf(KEY));
      const result = diffSnapshotContents(first, second);
      assert.equal(result.summary.objects.changed, 1);
      assert.equal(result.objects[0]?.id, target['uuid']);
      assert.equal(diffSnapshotContents(first, structuredClone(first)).identical, true);
      assert.ok(Date.now() - started < 30_000, 'a large panel was read and compared in a moment');
      reader.close();
    } finally {
      await big.close();
    }
  });

  it('keeps one change for one insertion in a long list', () => {
    const rules = Array.from({ length: 400 }, (_unused, i) => ({
      type: 'field',
      ip: [`10.0.${String(i)}.1`],
    }));
    const inserted = [
      ...rules.slice(0, 200),
      { type: 'field', ip: ['203.0.113.1'] },
      ...rules.slice(200),
    ];
    const mk = (list: unknown[]): SnapshotContent => ({
      format: SNAPSHOT_CONTENT_FORMAT,
      schemaVersion: SNAPSHOT_CONTENT_VERSION,
      maskKeyId: 'k',
      kinds: {
        snippets: [
          { id: 'S', name: 'S', hash: contentHash({ rules: list }), config: { rules: list } },
        ],
      },
    });
    const result = diffSnapshotContents(mk(rules), mk(inserted));
    const object = must(result.objects[0]);
    assert.equal(object.changes.length, 1);
    assert.equal(must(object.changes[0]).path, 'rules[200]');
    assert.equal(must(object.changes[0]).op, 'added');
  });
});
