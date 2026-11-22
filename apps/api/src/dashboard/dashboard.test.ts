import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  ATTENTION_KINDS,
  ATTENTION_SOURCES,
  type AttentionFeed,
  AttentionFeedSchema,
  type AttentionKind,
  type AttentionSource,
  ConventionRunSchema,
  ReconciliationLastSchema,
  CreatedTokenSchema,
  type FleetHealth,
  FleetHealthSchema,
  ServerViewSchema,
} from '@swellwright/contracts';
import { DnsQueryError, type DnsQuery } from '@swellwright/conventions';
import {
  applyChecksScenario,
  CHECKS_ZONE,
  FAKE_SECRETS,
  FakePanel,
} from '@swellwright/remnawave/test-support';

import { AuditService } from '../audit/audit.service.js';
import { Harness, LOGIN, OTHER, PASSPHRASE, SUDO } from '../commands/commands-test-support.js';
import { PANEL_ENV, connect, errorOf, tokenExpiringIn } from '../panel/panel-test-support.js';
import { type Client, createOwner, databaseUrl, signInAs, start, stop } from '../test-support.js';

const DAY = 86_400_000;

const dns: DnsQuery = (name, type) => {
  const records = CHECKS_ZONE[name];
  return type !== 'A' || records === undefined
    ? Promise.reject(new DnsQueryError('none'))
    : Promise.resolve({ records: [...records], ttl: 300 });
};

const feedOf = async (client: Client): Promise<AttentionFeed> => {
  const reply = await client.get('/dashboard/attention');
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return AttentionFeedSchema.parse(reply.body);
};

const fleetOf = async (client: Client, query = ''): Promise<FleetHealth> => {
  const reply = await client.get(`/dashboard/fleet${query}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return FleetHealthSchema.parse(reply.body);
};

const kindsOf = (feed: AttentionFeed): AttentionKind[] => feed.items.map((item) => item.kind);
const stateOf = (feed: AttentionFeed, source: AttentionSource): string | undefined =>
  feed.sources.find((entry) => entry.source === source)?.state;

/** What a bearer token sees: a call without the cookie. */
async function withToken(base: string, token: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

describe('the dashboard of an empty system', { skip: !databaseUrl }, () => {
  let instance: Awaited<ReturnType<typeof start>>;
  let owner: Client;
  before(async () => {
    instance = await start({ SW_DASHBOARD_CACHE_SECONDS: '0' });
    const { secret } = await createOwner(instance);
    owner = await signInAs(instance, 'owner', secret);
  });
  after(async () => {
    await stop(instance);
  });

  it('says that the vault is not set up and that no panel is connected, and nothing else', async () => {
    const feed = await feedOf(owner);
    assert.deepEqual(kindsOf(feed), ['vault.uninitialized', 'panel.not_connected']);
    assert.deepEqual(feed.counts, { critical: 0, warning: 0, info: 2 });
    assert.deepEqual(
      feed.sources.map((entry) => entry.source),
      [...ATTENTION_SOURCES],
      'every source is reported, in the order of the catalogue',
    );
    assert.ok(feed.sources.every((entry) => entry.state === 'ok'));
    for (const item of feed.items) {
      assert.ok(item.link !== null);
      assert.equal(item.since, null);
    }
  });

  it('has no reconciliation to report before one ran', async () => {
    const last = ReconciliationLastSchema.parse(
      (await owner.get('/panel/checks/reconciliation/last')).body,
    );
    assert.deepEqual(last, { ranAt: null, counts: null, inventoryCompared: null });
  });

  it('has no servers to show and answers an empty page', async () => {
    const fleet = await fleetOf(owner);
    assert.deepEqual(fleet.rows, []);
    assert.equal(fleet.total, 0);
    assert.deepEqual(fleet.totals, { servers: 0, critical: 0, warning: 0, ok: 0, unknown: 0 });
    assert.deepEqual(fleet.panel, { matched: false, asOf: null });
  });

  it('turns away a caller who is not signed in, and validates the query of the fleet', async () => {
    const stranger = instance.client();
    assert.equal((await stranger.get('/dashboard/attention')).status, 401);
    assert.equal((await stranger.get('/dashboard/fleet')).status, 401);
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?health=bogus',
      '?flag=bogus',
      '?sort=address',
      '?offset=-1',
    ]) {
      const reply = await owner.get(`/dashboard/fleet${query}`);
      assert.equal(reply.status, 400, query);
      assert.equal(errorOf(reply).code, 'validation_failed', query);
    }
  });

  it('is in the API description, with the permission of the fleet and none on the feed', async () => {
    const doc = (await instance.client().get('/openapi.json')).body as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    assert.equal(doc.paths['/dashboard/fleet']?.['get']?.['x-sw-permission'], 'servers:read');
    assert.equal(doc.paths['/dashboard/attention']?.['get']?.['x-sw-permission'], undefined);
  });
});

describe('the dashboard of a system with everything wrong', { skip: !databaseUrl }, () => {
  const h = new Harness();
  let fake: FakePanel;
  let github: Server;
  const ids: Record<string, string> = {};
  const hosts: { connections: number; commands: number }[] = [];
  let hostA: Awaited<ReturnType<Harness['host']>>;
  let hostB: Awaited<ReturnType<Harness['host']>>;

  const db = () => h.instance.isolated.database.client;

  before(async () => {
    // The update check asks a stand-in that has a newer release.
    github = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.url?.endsWith('/releases/latest') === true
          ? JSON.stringify({
              tag_name: 'v99.0.0',
              html_url: 'https://github.com/swellwright/swellwright/releases/tag/v99.0.0',
            })
          : JSON.stringify({ stargazers_count: 7 }),
      );
    });
    await new Promise<void>((resolve) => {
      github.listen(0, '127.0.0.1', resolve);
    });
    const apiBase = `http://127.0.0.1:${String((github.address() as AddressInfo).port)}`;

    fake = await FakePanel.start({ token: tokenExpiringIn(5) });
    applyChecksScenario(fake.fixtures);
    await h.open(
      {
        ...PANEL_ENV,
        SW_DASHBOARD_CACHE_SECONDS: '0',
        SW_DASHBOARD_RATE_LIMIT_PER_MINUTE: '600',
        SW_UPDATE_API_BASE: apiBase,
        SW_PANEL_SNAPSHOT_INTERVAL_HOURS: '24',
      },
      { dnsQuery: dns },
    );
    hostA = await h.host({});
    hostB = await h.host({});

    // The panel, connected with a token that expires in five days; what the checks found is kept in memory.
    const tokenId = await h.secret('panel token', 'panel_token', fake.token);
    assert.equal((await connect(h.owner, fake.url, tokenId)).status, 200);
    const run = ConventionRunSchema.parse((await h.owner.get('/panel/checks/convention')).body);
    assert.ok(run.summary.error + run.summary.warning > 0);
    assert.equal((await h.owner.get('/panel/checks/reconciliation')).status, 200);
    assert.equal((await h.owner.post('/panel/snapshots', {})).status, 201);

    // Servers: each is in a different state.
    const named = async (
      name: string,
      where: { readonly port: number },
      options: Parameters<Harness['server']>[1] = {},
    ): Promise<string> => {
      ids[name] = await h.server(where, { name, ...options });
      await db().server.update({ where: { id: ids[name] ?? '' }, data: { state: 'active' } });
      return ids[name] ?? '';
    };
    await named('fleet-ok', hostA);
    await named('fleet-fail', hostA);
    await named('fleet-mismatch', hostA);
    await named('fleet-nokey', hostB, { fingerprint: null });
    await named('fleet-noaccess', hostB, { access: false });
    const expiredSecret = await h.secret('expired login', 'ssh_password', LOGIN);
    await named('fleet-expired', hostB, { password: expiredSecret });
    // The node of the panel that the reconciliation matches by address.
    const made = await h.owner.post('/servers', {
      name: 'fleet-node',
      address: 'node-1.example.com',
      sshPort: 22,
      state: 'active',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    ids['fleet-node'] = ServerViewSchema.parse(made.body).id;
    assert.equal((await h.owner.get('/panel/checks/reconciliation')).status, 200);

    // Secrets that expire.
    await db().secret.update({
      where: { id: expiredSecret },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });
    const soon = await h.secret('renew soon', 'generic', 'a value nobody may see in a feed');
    await db().secret.update({
      where: { id: soon },
      data: { expiresAt: new Date(Date.now() + 3 * DAY) },
    });

    // Facts for the servers that are in order; baselines and what they found.
    const profile = await db().baselineProfile.findFirstOrThrow({
      where: { name: 'linux-generic' },
    });
    for (const name of [
      'fleet-ok',
      'fleet-fail',
      'fleet-mismatch',
      'fleet-nokey',
      'fleet-expired',
      'fleet-node',
      'fleet-noaccess',
    ]) {
      await db().baselineAssignment.create({
        data: { profileId: profile.id, serverId: ids[name] ?? '' },
      });
    }
    for (const name of ['fleet-ok', 'fleet-fail', 'fleet-mismatch', 'fleet-node']) {
      await db().serverFact.create({
        data: { serverId: ids[name] ?? '', facts: {}, collectedAt: new Date(), source: 'ssh' },
      });
    }
    const run1 = async (
      name: string,
      patch: { state: 'completed' | 'error'; fail?: number; warn?: number; errorCode?: string },
    ): Promise<void> => {
      await db().checkRun.create({
        data: {
          serverId: ids[name] ?? '',
          serverName: name,
          profileId: profile.id,
          baselineName: 'linux-generic',
          baselineVersion: 1,
          baselineSha256: 'a'.repeat(64),
          trigger: 'manual',
          state: patch.state,
          startedAt: new Date(),
          finishedAt: new Date(),
          passCount: 10,
          warnCount: patch.warn ?? 0,
          failCount: patch.fail ?? 0,
          errorCode: patch.errorCode ?? null,
        },
      });
    };
    await run1('fleet-ok', { state: 'completed' });
    await run1('fleet-node', { state: 'completed' });
    await run1('fleet-fail', { state: 'completed', fail: 2 });
    await run1('fleet-mismatch', { state: 'error', errorCode: 'host_key_mismatch' });

    // The newest snapshot is old and the panel has changed since it.
    await db().panelSnapshot.updateMany({
      data: {
        createdAt: new Date(Date.now() - 40 * DAY),
        checkedAt: new Date(Date.now() - 39 * DAY),
        changesSince: 3,
      },
    });
    // A failed run of commands, a plugin that was switched off because its files changed.
    await db().commandRun.create({
      data: {
        mode: 'inline',
        state: 'failed',
        label: 'uptime',
        body: 'uptime',
        bodySha256: 'b'.repeat(64),
        sudo: false,
        dangerLevel: 'read',
        timeoutSeconds: 30,
        createdByName: 'ops',
        finishedAt: new Date(),
      },
    });
    await db().pluginApproval.create({
      data: {
        pluginId: 'demo-plugin',
        enabled: false,
        version: '1.0.0',
        trust: 'local',
        digest: 'c'.repeat(64),
        permissions: '{}',
        approvedAt: new Date(),
        approvedBy: 'owner',
      },
    });
    await h.instance.app.get(AuditService).record({
      action: 'plugin.disabled',
      outcome: 'success',
      actor: null,
      object: { type: 'plugin', id: 'demo-plugin' },
      details: { reason: 'changed', version: '1.0.0' },
      meta: { ip: undefined, requestId: undefined },
    });
    // The update check has run once.
    assert.equal((await h.owner.get('/updates')).status, 200);
    hosts.push(
      { connections: hostA.server.connections, commands: hostA.commands.length },
      { connections: hostB.server.connections, commands: hostB.commands.length },
    );
  });
  after(async () => {
    github.closeAllConnections();
    await new Promise<void>((resolve) => {
      github.close(() => {
        resolve();
      });
    });
    await fake.close();
    await h.close();
  });

  it('lists what is wrong in every source, most severe first', async () => {
    const feed = await feedOf(h.owner);
    const kinds = kindsOf(feed);
    for (const kind of [
      'vault.secrets_expired',
      'vault.secrets_expiring',
      'panel.token_expiring',
      'conventions.errors',
      'reconciliation.drift',
      'snapshots.stale',
      'snapshots.changed',
      'baseline.host_key_mismatch',
      'baseline.failing',
      'baseline.never_checked',
      'servers.not_ready',
      'runs.failed',
      'plugins.switched_off',
      'updates.available',
    ] satisfies AttentionKind[]) {
      assert.ok(kinds.includes(kind), `${kind} is missing from ${JSON.stringify(kinds)}`);
    }
    assert.ok(feed.sources.every((entry) => entry.state === 'ok'));
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    const levels = feed.items.map((item) => rank[item.severity]);
    assert.deepEqual(
      levels,
      [...levels].sort((a, b) => a - b),
    );
    assert.equal(feed.items[0]?.severity, 'critical');
    assert.equal(feed.counts.critical + feed.counts.warning + feed.counts.info, feed.items.length);
    // Each kind is at most once, and every id is the kind: stable between calls.
    assert.equal(new Set(kinds).size, kinds.length);
    const again = await feedOf(h.owner);
    assert.deepEqual(
      again.items.map((item) => [item.id, item.fingerprint]),
      feed.items.map((item) => [item.id, item.fingerprint]),
    );
    for (const kind of kinds) {
      assert.ok((ATTENTION_KINDS as readonly string[]).includes(kind));
    }
  });

  it('carries the facts of each item and no more', async () => {
    const feed = await feedOf(h.owner);
    const item = (kind: AttentionKind) => {
      const found = feed.items.find((entry) => entry.kind === kind);
      assert.ok(found, kind);
      return found;
    };
    assert.equal(item('vault.secrets_expired').params['names'], 'expired login');
    assert.equal(item('vault.secrets_expiring').params['names'], 'renew soon');
    assert.equal(item('vault.secrets_expiring').params['soonestDays'], 3);
    assert.equal(
      item('panel.token_expiring').params['daysLeft'],
      4,
      'five days minus a moment, whole days, floor',
    );
    assert.equal(item('snapshots.changed').params['changes'], 3);
    assert.equal(item('baseline.failing').params['names'], 'fleet-fail');
    assert.equal(item('baseline.host_key_mismatch').params['names'], 'fleet-mismatch');
    assert.equal(item('runs.failed').params['count'], 1);
    assert.equal(item('plugins.switched_off').params['names'], 'demo-plugin');
    assert.equal(item('updates.available').params['latest'], '99.0.0');
    assert.equal(item('updates.available').link, null);
    const notReady = item('servers.not_ready');
    assert.equal(notReady.severity, 'warning');
    // The server without a key, the one without an entry, and the one that was added by its address alone.
    assert.deepEqual(
      [notReady.params['count'], notReady.params['noKey'], notReady.params['noAccess']],
      [3, 2, 2],
    );
  });

  it('never calls the panel or a server, and puts no secret, address or token in what it says', async () => {
    const beforePanel = fake.requests.length;
    const beforeHosts = hosts.map(() => 0);
    const texts: string[] = [];
    for (const client of [h.owner, h.operator, h.observer, h.auditor]) {
      for (let times = 0; times < 3; times += 1) {
        texts.push(JSON.stringify((await client.get('/dashboard/attention')).body));
        texts.push(JSON.stringify((await client.get('/dashboard/fleet')).body));
        texts.push(
          JSON.stringify(
            (await client.get('/dashboard/fleet?limit=1&offset=1&sort=lastCheck')).body,
          ),
        );
      }
    }
    assert.equal(fake.requests.length, beforePanel, 'the panel was asked something');
    assert.deepEqual(
      [hostA.server.connections, hostB.server.connections],
      hosts.map((entry) => entry.connections),
      'a server was connected to',
    );
    assert.deepEqual(
      [hostA.commands.length, hostB.commands.length],
      hosts.map((entry) => entry.commands),
      'a server was sent a command',
    );
    assert.equal(beforeHosts.length, 2);
    const forbidden = [
      fake.token,
      LOGIN,
      SUDO,
      OTHER,
      PASSPHRASE,
      'a value nobody may see in a feed',
      '127.0.0.1',
      'node-1.example.com',
      ...Object.values(FAKE_SECRETS).flat(),
    ];
    for (const text of texts) {
      for (const secret of forbidden) {
        assert.ok(!text.includes(secret), `a dashboard answer holds ${secret.slice(0, 12)}`);
      }
    }
  });

  it('keeps the counts of the last reconciliation and says nothing before one ran', async () => {
    const last = ReconciliationLastSchema.parse(
      (await h.observer.get('/panel/checks/reconciliation/last')).body,
    );
    assert.ok(last.ranAt !== null);
    assert.equal(last.inventoryCompared, true);
    assert.ok(
      (last.counts?.drift ?? 0) + (last.counts?.missing ?? 0) + (last.counts?.extra ?? 0) > 0,
    );
  });

  it('leaves out the audit for roles that may not read it, and nothing else', async () => {
    const owner = await feedOf(h.owner);
    const auditor = await feedOf(h.auditor);
    const operator = await feedOf(h.operator);
    const observer = await feedOf(h.observer);
    assert.deepEqual(auditor.items, owner.items);
    assert.equal(stateOf(auditor, 'audit'), 'ok');
    for (const feed of [operator, observer]) {
      assert.equal(stateOf(feed, 'audit'), 'not_permitted');
      assert.ok(
        feed.sources
          .filter((entry) => entry.source !== 'audit')
          .every((entry) => entry.state === 'ok'),
      );
      assert.deepEqual(
        feed.items,
        owner.items.filter((item) => item.source !== 'audit'),
      );
    }
  });

  it('shows a token only what its permissions open', async () => {
    const base = h.instance.base;
    const create = async (permissions: string[]): Promise<string> => {
      await h.stepUp(h.operator, 'ops');
      const reply = await h.operator.post('/tokens', { name: permissions.join('+'), permissions });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      return CreatedTokenSchema.parse(reply.body).token;
    };
    const servers = await create(['servers:read']);
    const feed = AttentionFeedSchema.parse(
      await (await withToken(base, servers, '/dashboard/attention')).json(),
    );
    const allowed = new Set<AttentionSource>(['baseline', 'servers', 'runs', 'updates']);
    for (const entry of feed.sources) {
      assert.equal(entry.state, allowed.has(entry.source) ? 'ok' : 'not_permitted', entry.source);
    }
    assert.ok(feed.items.length > 0 && feed.items.every((item) => allowed.has(item.source)));
    // The fleet needs `servers:read`; the node of the panel needs `panel:read` too, which this token lacks.
    const fleet = FleetHealthSchema.parse(
      await (await withToken(base, servers, '/dashboard/fleet')).json(),
    );
    assert.ok(fleet.rows.length > 0);
    assert.ok(fleet.rows.every((row) => row.panelNode === null));
    assert.deepEqual(fleet.panel, { matched: false, asOf: null });

    const plugins = await create(['plugins:read']);
    const only = AttentionFeedSchema.parse(
      await (await withToken(base, plugins, '/dashboard/attention')).json(),
    );
    assert.deepEqual([...new Set(only.items.map((item) => item.source))].sort(), [
      'plugins',
      'updates',
    ]);
    const refused = await withToken(base, plugins, '/dashboard/fleet');
    assert.equal(refused.status, 403);
    const none = await withToken(base, 'swt_not-a-token', '/dashboard/attention');
    assert.equal(none.status, 401);
  });

  it('rows the fleet by server with a health, flags and the node the reconciliation matched', async () => {
    const fleet = await fleetOf(h.owner, '?limit=100');
    assert.equal(fleet.total, 7);
    const row = (name: string) => {
      const found = fleet.rows.find((entry) => entry.server.name === name);
      assert.ok(found, name);
      return found;
    };
    assert.equal(row('fleet-ok').health, 'ok');
    assert.equal(row('fleet-fail').health, 'critical');
    assert.deepEqual(row('fleet-fail').flags, ['baseline_failing']);
    assert.equal(row('fleet-fail').baseline.counts?.fail, 2);
    assert.equal(row('fleet-mismatch').health, 'critical');
    assert.deepEqual(row('fleet-mismatch').flags, ['host_key_mismatch']);
    assert.equal(row('fleet-mismatch').baseline.errorCode, 'host_key_mismatch');
    assert.ok(row('fleet-nokey').flags.includes('no_host_key'));
    assert.equal(row('fleet-nokey').hostKey.pinned, false);
    assert.ok(row('fleet-noaccess').flags.includes('no_access'));
    assert.equal(row('fleet-expired').health, 'critical');
    assert.ok(row('fleet-expired').flags.includes('access_expired'));
    assert.equal(row('fleet-expired').access.usable, 0);
    assert.ok(
      fleet.rows.every((entry) => !('address' in entry.server)),
      'the address is not in a row',
    );
    // The reconciliation matched the server that has the name of a node.
    assert.equal(fleet.panel.matched, true);
    const node = row('fleet-node').panelNode;
    assert.ok(node, 'the node of the panel');
    assert.ok(['online', 'offline', 'connecting', 'disabled'].includes(node.state));
    assert.equal(node.name, 'Node 1', 'matched by the address it shares');
    assert.equal(row('fleet-ok').panelNode, null);
    assert.deepEqual(fleet.totals, {
      servers: 7,
      critical: fleet.rows.filter((entry) => entry.health === 'critical').length,
      warning: fleet.rows.filter((entry) => entry.health === 'warning').length,
      ok: fleet.rows.filter((entry) => entry.health === 'ok').length,
      unknown: fleet.rows.filter((entry) => entry.health === 'unknown').length,
    });
    // The role that sees servers but not the panel gets no node.
    const viewerFleet = await fleetOf(h.observer, '?limit=100');
    assert.ok(
      viewerFleet.rows.some((entry) => entry.panelNode !== null),
      'an observer may read the panel',
    );
  });

  it('pages, filters and sorts the fleet', async () => {
    const names = async (query: string): Promise<string[]> =>
      (await fleetOf(h.owner, query)).rows.map((row) => row.server.name);
    const worst = await names('?limit=100');
    assert.ok(
      ['fleet-expired', 'fleet-fail', 'fleet-mismatch'].includes(worst[0] ?? ''),
      'the worst first',
    );
    const critical = await names('?health=critical&sort=name');
    assert.deepEqual(critical, ['fleet-expired', 'fleet-fail', 'fleet-mismatch']);
    assert.deepEqual(await names('?flag=no_host_key'), ['fleet-node', 'fleet-nokey']);
    assert.deepEqual(
      await names('?q=FLEET-N&sort=name'),
      ['fleet-node', 'fleet-nokey', 'fleet-noaccess'].sort(),
    );
    assert.deepEqual(await names('?sort=name&order=desc&limit=2'), ['fleet-ok', 'fleet-nokey']);
    const second = await fleetOf(h.owner, '?sort=name&limit=3&offset=3');
    assert.equal(second.total, 7);
    assert.deepEqual(
      second.rows.map((row) => row.server.name),
      ['fleet-noaccess', 'fleet-node', 'fleet-nokey'],
    );
    assert.deepEqual(await names('?state=draft'), []);
    assert.deepEqual(await names('?tag=nothing'), []);
    assert.deepEqual(await names('?offset=50'), []);
  });
});

describe(
  'the dashboard: the cache, the rate limit and a source that fails',
  { skip: !databaseUrl },
  () => {
    it('reuses the feed for the seconds it is told to and then reads again', async () => {
      const instance = await start({ SW_DASHBOARD_CACHE_SECONDS: '60' });
      try {
        const { secret } = await createOwner(instance);
        const owner = await signInAs(instance, 'owner', secret);
        const first = await feedOf(owner);
        await instance.isolated.database.client.pluginApproval.create({
          data: {
            pluginId: 'late',
            enabled: false,
            version: '1.0.0',
            trust: 'local',
            digest: 'd'.repeat(64),
            permissions: '{}',
            approvedAt: new Date(),
            approvedBy: 'owner',
          },
        });
        const second = await feedOf(owner);
        assert.equal(second.generatedAt, first.generatedAt, 'the same answer');
      } finally {
        await stop(instance);
      }
    });

    it('answers 429 with the time to wait when a user reads more than the limit', async () => {
      const instance = await start({ SW_DASHBOARD_RATE_LIMIT_PER_MINUTE: '3' });
      try {
        const { secret } = await createOwner(instance);
        const owner = await signInAs(instance, 'owner', secret);
        for (let times = 0; times < 3; times += 1) {
          assert.equal((await owner.get('/dashboard/attention')).status, 200);
        }
        const refused = await owner.get('/dashboard/fleet');
        assert.equal(refused.status, 429);
        assert.ok(Number(refused.headers.get('retry-after')) > 0);
      } finally {
        await stop(instance);
      }
    });

    it('reminds to verify the audit chain when the clock has moved past the days of the knob', async () => {
      const offset = { ms: 0 };
      const instance = await start(
        { SW_DASHBOARD_CACHE_SECONDS: '0', SW_DASHBOARD_AUDIT_VERIFY_DAYS: '30' },
        { clock: () => Date.now() + offset.ms },
      );
      try {
        const { secret } = await createOwner(instance);
        const owner = await signInAs(instance, 'owner', secret);
        assert.ok(!kindsOf(await feedOf(owner)).includes('audit.verify_overdue'));
        offset.ms = 31 * DAY;
        const never = (await feedOf(owner)).items.find(
          (item) => item.kind === 'audit.verify_overdue',
        );
        assert.equal(never?.params['neverVerified'], true);
        // The record of a verification is dated by the real clock, so the verification is made before the clock moves.
        offset.ms = 0;
        assert.equal((await owner.post('/audit/verify-chain')).status, 200);
        assert.ok(
          !kindsOf(await feedOf(owner)).includes('audit.verify_overdue'),
          'verified just now',
        );
        offset.ms = 62 * DAY;
        const overdue = (await feedOf(owner)).items.find(
          (item) => item.kind === 'audit.verify_overdue',
        );
        assert.equal(overdue?.params['neverVerified'], false);
        assert.equal(overdue.params['days'], 62);
        assert.equal(overdue.severity, 'info');
      } finally {
        await stop(instance);
      }
    });

    it('reports a source that cannot be read as failed and still answers with the others', async () => {
      const instance = await start({ SW_DASHBOARD_CACHE_SECONDS: '0' });
      try {
        const { secret } = await createOwner(instance);
        const owner = await signInAs(instance, 'owner', secret);
        // Take the table of command runs away: that one source has nothing to read, the rest are untouched.
        await instance.isolated.database.client.$executeRawUnsafe(
          `ALTER TABLE "${instance.isolated.schema}"."command_runs" RENAME TO "command_runs_gone"`,
        );
        const feed = await feedOf(owner);
        assert.equal(stateOf(feed, 'runs'), 'failed');
        assert.equal(stateOf(feed, 'vault'), 'ok');
        assert.ok(
          kindsOf(feed).includes('vault.uninitialized'),
          'the other sources still say what they know',
        );
      } finally {
        await stop(instance);
      }
    });
  },
);
