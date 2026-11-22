import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { inspect } from 'node:util';

import { PanelClient, type PanelClientOptions } from './client.js';
import {
  PanelAuthError,
  PanelContractError,
  PanelError,
  PanelForbiddenError,
  PanelNotFoundError,
  PanelRateLimitedError,
  PanelTimeoutError,
  PanelUnavailableError,
  PanelUrlError,
} from './errors.js';
import { parseRetryAfter } from './http.js';
import { FakePanel, FAKE_SECRETS, must } from './test-support/index.js';

/** The character a URL with credentials has before its host; kept out of the literals. */
const AT = '@';
const sleeps: number[] = [];

function clientFor(panel: FakePanel, overrides: Partial<PanelClientOptions> = {}): PanelClient {
  return new PanelClient({
    baseUrl: panel.url,
    token: panel.token,
    allowInsecureHttp: true,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    ...overrides,
  });
}

/** Runs a read that must fail and returns the error, so the tests can look at its class and its text. */
async function failure(read: () => Promise<unknown>): Promise<PanelError> {
  try {
    await read();
  } catch (error) {
    assert.ok(error instanceof PanelError, `a PanelError, got ${String(error)}`);
    return error;
  }
  assert.fail('the read should have failed');
}

/** Like `failure`, for the reads that must fail with a contract error. */
async function contractFailure(read: () => Promise<unknown>): Promise<PanelContractError> {
  const error = await failure(read);
  assert.ok(error instanceof PanelContractError, error.message);
  return error;
}

describe('the panel client against a fake panel', () => {
  let panel: FakePanel;
  const clients: PanelClient[] = [];
  const make = (overrides: Partial<PanelClientOptions> = {}): PanelClient => {
    const client = clientFor(panel, overrides);
    clients.push(client);
    return client;
  };

  before(async () => {
    panel = await FakePanel.start({ extraNodes: 2 });
  });
  afterEach(() => {
    panel.clearInjections();
    panel.requests.length = 0;
    sleeps.length = 0;
    panel.setToken(panel.token);
    panel.setVersion('3.4.11');
  });
  after(async () => {
    for (const client of clients) {
      client.close();
    }
    await panel.close();
  });

  describe('reading', () => {
    it('reads every kind of object and sends only GET requests with the token', async () => {
      const client = make();
      const nodes = await client.nodes();
      assert.equal(nodes.length, 5);
      assert.equal((await client.hosts()).length, 4);
      const profiles = await client.configProfiles();
      assert.equal(profiles.length, 2);
      assert.equal((await client.configProfile(profiles[0]?.uuid ?? '')).name, 'Profile One');
      assert.equal((await client.computedConfig(profiles[0]?.uuid ?? '')).name, 'Profile One');
      assert.equal((await client.internalSquads()).length, 2);
      assert.equal((await client.externalSquads()).length, 1);
      assert.equal((await client.subscriptionTemplates()).length, 3);
      assert.equal((await client.subscriptionTemplatesWithBodies()).length, 3);
      assert.equal((await client.subscriptionSettings()).isShowCustomRemarks, true);
      assert.equal((await client.snippets()).length, 2);
      assert.equal((await client.nodePlugins()).length, 1);
      assert.equal((await client.infra()).providers.length, 1);
      assert.equal((await client.version()).version, '3.4.11');
      assert.equal((await client.health()).instances, 2);
      assert.equal((await client.userCounts()).total, 46);
      assert.equal((await client.configuration()).shortUuidLength, 16);
      assert.ok(panel.requests.length >= 14);
      assert.ok(panel.requests.every((r) => r.method === 'GET'));
      assert.ok(panel.requests.every((r) => r.authorization === 'valid'));
    });

    it('normalises a node: state, versions, profile and inbound, tags and flags', async () => {
      const nodes = await make().nodes();
      const first = must(nodes[0]);
      const offline = must(nodes[2]);
      assert.equal(first.state, 'online');
      assert.equal(first.xrayVersion, '26.0.0-fake');
      assert.equal(first.nodeVersion, '3.4.6-fake');
      assert.deepEqual(
        first.configProfile.inbounds.map((i) => i.tag),
        ['VLESS_REALITY_MAIN'],
      );
      assert.deepEqual(first.tags, ['PRIMARY']);
      assert.equal(offline.state, 'offline');
      assert.equal(offline.lastStatusMessage, 'connection lost');
      assert.equal(first.system?.memoryTotal, 4_000_000_000);
    });

    it('pages through the billing history by the panel paging, up to a limit', async () => {
      const client = make();
      assert.equal((await client.billingHistory()).length, 5);
      assert.equal((await client.billingHistory(3)).length, 3);
      assert.ok(panel.countRequests('/api/infra-billing/history') >= 2);
    });

    it('ignores fields it does not know, and does not keep them', async () => {
      const real = (panel.fixtures.hosts[0] ?? {}) as Record<string, unknown>;
      panel.inject('/api/hosts', {
        kind: 'replace',
        body: {
          response: [{ ...real, somethingNew: { secretLooking: 'FAKE-NEW-FIELD' } }],
          newTopLevel: true,
        },
      });
      const [host] = await make().hosts();
      assert.equal(host?.remark, 'Host 1');
      assert.ok(!JSON.stringify(host).includes('FAKE-NEW-FIELD'));
    });

    it('gives the same hash on every read, and a node hash that ignores what changes by itself', async () => {
      const client = make();
      const first = await client.nodes();
      const second = await client.nodes();
      assert.deepEqual(
        first.map((n) => n.hash),
        second.map((n) => n.hash),
      );
      const hosts = await client.hosts();
      assert.deepEqual(
        hosts.map((h) => h.hash),
        (await client.hosts()).map((h) => h.hash),
      );

      const node = panel.fixtures.nodes[0] as Record<string, unknown>;
      const saved = { ...node };
      try {
        Object.assign(node, {
          usersOnline: 99,
          isConnected: false,
          xrayUptime: 1,
          trafficUsedBytes: 1,
          lastStatusMessage: 'x',
          versions: { xray: '1', node: '1' },
        });
        assert.equal(
          (await client.nodes())[0]?.hash,
          first[0]?.hash,
          'runtime state is not configuration',
        );
        Object.assign(node, { name: 'Renamed' });
        assert.notEqual((await client.nodes())[0]?.hash, first[0]?.hash, 'a rename is');
      } finally {
        Object.assign(node, saved);
      }
    });

    it('keeps a hash of a profile that covers its masked configuration, and the list does not carry the configuration', async () => {
      const client = make({ maskKey: 'hash-test-key' });
      const [summary] = await client.configProfiles();
      assert.ok(summary && !('config' in summary));
      const detail = await client.configProfile(summary.uuid);
      assert.equal(detail.hash, summary.hash);
      const original = panel.fixtures.configProfiles[0] as {
        config: { inbounds: { streamSettings: { realitySettings: { privateKey: string } } }[] };
      };
      const reality = must(original.config.inbounds[0]).streamSettings.realitySettings;
      const key = reality.privateKey;
      try {
        reality.privateKey = 'FAKE-ROTATED-KEY';
        const rotated = await client.configProfile(summary.uuid);
        assert.notEqual(rotated.hash, detail.hash, 'a rotated key changes the hash');
        assert.ok(!JSON.stringify(rotated).includes('FAKE-ROTATED-KEY'));
      } finally {
        reality.privateKey = key;
      }
    });
  });

  describe('errors', () => {
    it('401 is a PanelAuthError, 403 a PanelForbiddenError, 404 a PanelNotFoundError, with stable codes', async () => {
      const wrong = make({ token: 'another-token-entirely-0123456789' });
      const auth = await failure(() => wrong.nodes());
      assert.ok(auth instanceof PanelAuthError);
      assert.equal(auth.code, 'panel_unauthorized');
      assert.equal(panel.countRequests('/api/nodes'), 1, 'a refused token is not retried');

      panel.forbid('/api/hosts');
      const forbidden = await failure(() => make().hosts());
      assert.ok(forbidden instanceof PanelForbiddenError);
      assert.equal(forbidden.code, 'panel_forbidden');

      const missing = await failure(() =>
        make().configProfile('00000000-0000-4000-8000-0000000000ff'),
      );
      assert.ok(missing instanceof PanelNotFoundError);
      assert.equal(missing.code, 'panel_not_found');
    });

    it('refuses an identifier that is not a UUID before sending anything', async () => {
      const client = make();
      const before = panel.requests.length;
      for (const bad of ['../nodes', 'x', '00000000-0000-4000-8000-000000000001/../../x', '']) {
        const error = await failure(() => client.configProfile(bad));
        assert.ok(error instanceof PanelUrlError, bad);
      }
      assert.equal(panel.requests.length, before);
    });

    it('retries a 5xx with a growing wait and gives up with PanelUnavailableError', async () => {
      panel.inject('/api/nodes', { kind: 'status', status: 503, body: { message: 'down' } });
      const error = await failure(() =>
        make({ maxAttempts: 4, backoffBaseMs: 100, backoffMaxMs: 10_000 }).nodes(),
      );
      assert.ok(error instanceof PanelUnavailableError);
      assert.equal(error.code, 'panel_unreachable');
      assert.equal(error.reason, 'http_5xx');
      assert.equal(error.status, 503);
      assert.equal(panel.countRequests('/api/nodes'), 4);
      // random() is 1: the full wait each time, doubling.
      assert.deepEqual(sleeps, [100, 200, 400]);
    });

    it('succeeds when a 5xx or a hang-up passes within the attempts', async () => {
      panel.inject('/api/nodes', { kind: 'status', status: 502 }, 1);
      panel.inject('/api/nodes', { kind: 'drop' }, 1);
      assert.equal((await make().nodes()).length, 5);
      assert.equal(panel.countRequests('/api/nodes'), 3);
      assert.equal(sleeps.length, 2);
    });

    it('obeys Retry-After on 429, and reports a wait it will not sit through', async () => {
      panel.inject(
        '/api/hosts',
        { kind: 'status', status: 429, headers: { 'retry-after': '2' } },
        1,
      );
      assert.equal((await make().hosts()).length, 4);
      assert.ok((sleeps[0] ?? 0) >= 2000, `waited ${String(sleeps[0])} ms`);

      sleeps.length = 0;
      panel.inject('/api/hosts', {
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '120' },
      });
      const error = await failure(() => make().hosts());
      assert.ok(error instanceof PanelRateLimitedError);
      assert.equal(error.code, 'panel_rate_limited');
      assert.equal(error.retryAfterSeconds, 120);
      assert.deepEqual(sleeps, [], 'it did not wait for two minutes');
    });

    it('does not retry other client errors: a 400 or 418 means this release does not match the panel', async () => {
      panel.inject('/api/hosts', { kind: 'status', status: 418 });
      const error = await failure(() => make().hosts());
      assert.ok(error instanceof PanelContractError);
      assert.equal(panel.countRequests('/api/hosts'), 1);
    });

    it('times out with PanelTimeoutError and does not retry a slow panel', async () => {
      panel.inject('/api/nodes', { kind: 'hang' });
      const error = await failure(() => make({ timeoutMs: 150 }).nodes());
      assert.ok(error instanceof PanelTimeoutError);
      assert.equal(error.code, 'panel_timeout');
      assert.equal(error.phase, 'response');
      assert.equal(panel.countRequests('/api/nodes'), 1);

      panel.clearInjections();
      panel.inject('/api/hosts', { kind: 'delay', ms: 400 });
      assert.ok(
        (await failure(() => make({ timeoutMs: 100 }).hosts())) instanceof PanelTimeoutError,
      );
      assert.equal((await make({ timeoutMs: 3000 }).hosts()).length, 4);
    });

    it('reports a closed port as unreachable after retrying', async () => {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      await new Promise<void>((resolve) =>
        probe.close(() => {
          resolve();
        }),
      );
      const client = clientFor(panel, {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        backoffBaseMs: 10,
      });
      const error = await failure(() => client.nodes());
      assert.ok(error instanceof PanelUnavailableError);
      assert.equal(error.reason, 'refused');
      assert.equal(sleeps.length, 2, 'three attempts, two waits');
      client.close();
    });

    it('is a contract error when the body is not JSON, is a web page, or is empty', async () => {
      panel.inject('/api/nodes', { kind: 'raw', body: 'this is not json' });
      let error = await failure(() => make().nodes());
      assert.ok(
        error instanceof PanelContractError && error.message.includes('not JSON'),
        error.message,
      );

      panel.clearInjections();
      panel.inject('/api/nodes', {
        kind: 'raw',
        body: '<html><body>Sign in</body></html>',
        contentType: 'text/html',
      });
      error = await failure(() => make().nodes());
      assert.ok(
        error instanceof PanelContractError && error.message.includes('web page'),
        error.message,
      );

      panel.clearInjections();
      panel.inject('/api/nodes', { kind: 'raw', body: '' });
      error = await failure(() => make().nodes());
      assert.ok(error instanceof PanelContractError);
    });

    it('names the endpoint and the field when the shape is not the known one', async () => {
      const first = panel.fixtures.nodes[0] as Record<string, unknown>;
      panel.inject('/api/nodes', {
        kind: 'replace',
        body: { response: [first, { ...first, uuid: 'not-a-uuid' }, { ...first, port: 'sixty' }] },
      });
      const error = await failure(() => make().nodes());
      assert.ok(error instanceof PanelContractError);
      assert.equal(error.code, 'panel_contract_changed');
      assert.equal(error.endpoint, 'nodes.list');
      assert.equal(error.fieldPath, 'response[1].uuid');
      assert.match(error.message, /nodes\.list/u);
      assert.match(error.message, /response\[1\]\.uuid/u);
      assert.ok(error.issues.length >= 2);
      assert.ok(
        !error.message.includes('not-a-uuid') && !error.message.includes('sixty'),
        'values are not repeated',
      );

      panel.clearInjections();
      panel.inject('/api/hosts', { kind: 'replace', body: { data: [] } });
      assert.equal((await contractFailure(() => make().hosts())).fieldPath, 'response');
      panel.clearInjections();
      panel.inject('/api/system/metadata', { kind: 'replace', body: { response: { version: 3 } } });
      assert.equal((await contractFailure(() => make().version())).fieldPath, 'response.version');
    });

    it('refuses a response above the size limit, declared or streamed, and a normal one still passes', async () => {
      for (const chunked of [false, true]) {
        panel.inject('/api/snippets', { kind: 'large', bytes: 2_000_000, chunked });
        const error = await failure(() => make({ maxResponseBytes: 1_000_000 }).snippets());
        assert.ok(error instanceof PanelContractError, String(chunked));
        assert.match(error.message, /larger than the limit/u);
        panel.clearInjections();
      }
      assert.equal((await make({ maxResponseBytes: 1_000_000 }).snippets()).length, 2);
    });

    it('follows a redirect inside the origin only, and a limited number of them', async () => {
      panel.inject('/api/nodes', { kind: 'redirect', location: '/api/hosts' }, 1);
      // The first hop goes to /api/hosts, whose shape is not that of /api/nodes: the redirect was followed.
      const followed = await failure(() => make().nodes());
      assert.ok(followed instanceof PanelContractError);
      assert.equal(panel.countRequests('/api/hosts'), 1);

      panel.clearInjections();
      panel.inject('/api/nodes', { kind: 'redirect', location: 'http://127.0.0.2:1/steal' });
      const away = await failure(() => make().nodes());
      assert.ok(away instanceof PanelUnavailableError);
      assert.equal(away.reason, 'redirect_refused');
      assert.equal(panel.requests.filter((r) => r.path.includes('steal')).length, 0);

      panel.clearInjections();
      panel.requests.length = 0;
      panel.inject('/api/nodes', { kind: 'redirect', location: '/api/nodes' });
      const loop = await failure(() => make().nodes());
      assert.ok(loop instanceof PanelUnavailableError && loop.reason === 'redirect_refused');
      assert.ok(panel.countRequests('/api/nodes') <= 5);
    });

    it('serves at most `concurrency` requests at the same time, and all of them finish', async () => {
      panel.peakConcurrency = 0;
      panel.inject('/api/hosts', { kind: 'delay', ms: 60 });
      const client = make({ concurrency: 2 });
      const reads = await Promise.all(Array.from({ length: 8 }, () => client.hosts()));
      assert.ok(reads.every((r) => r.length === 4));
      assert.ok(panel.peakConcurrency <= 2, `peak was ${String(panel.peakConcurrency)}`);
      assert.ok(panel.peakConcurrency >= 1);
    });

    it('never puts the token in an error, a stack, a property or the inspected client', async () => {
      const token = panel.token;
      const scenarios: [string, () => Promise<unknown>][] = [
        ['401', () => make({ token: 'a-wrong-token-that-is-long-enough-0001' }).nodes()],
        [
          '5xx',
          () => {
            panel.inject('/api/nodes', { kind: 'status', status: 500 });
            return make({ maxAttempts: 1 }).nodes();
          },
        ],
        [
          'contract',
          () => {
            panel.inject('/api/hosts', { kind: 'raw', body: `{"response":"${token}"}` });
            return make().hosts();
          },
        ],
        [
          'timeout',
          () => {
            panel.inject('/api/snippets', { kind: 'hang' });
            return make({ timeoutMs: 80 }).snippets();
          },
        ],
      ];
      for (const [name, run] of scenarios) {
        const error = await failure(run);
        const dump = `${error.message}\n${error.stack ?? ''}\n${inspect(error, { depth: 8, showHidden: true })}\n${JSON.stringify(error)}`;
        assert.ok(!dump.includes(token), `token in the ${name} error`);
        panel.clearInjections();
      }
      const client = make();
      await client.nodes();
      assert.ok(!inspect(client, { depth: 10, showHidden: true }).includes(token));
      assert.ok(!JSON.stringify(client).includes(token));
    });
  });

  describe('the address and the connection', () => {
    it('refuses a bad address or a bad token when the client is built', () => {
      assert.throws(
        () => new PanelClient({ baseUrl: 'http://127.0.0.1:1', token: 'x' }),
        PanelUrlError,
      );
      assert.throws(
        () => new PanelClient({ baseUrl: 'https://panel.example.com', token: '' }),
        PanelUrlError,
      );
      assert.throws(
        () => new PanelClient({ baseUrl: 'https://panel.example.com', token: 'a\r\nb' }),
        PanelUrlError,
      );
      assert.throws(
        () => new PanelClient({ baseUrl: `https://u:p${AT}panel.example.com`, token: 'x' }),
        PanelUrlError,
      );
    });

    it('applies the address guard to a literal address and to every answer for a name, before connecting', async () => {
      const seen: string[] = [];
      const guard = (address: string): string | null => {
        seen.push(address);
        return 'the policy says no';
      };
      const literal = clientFor(panel, { addressGuard: guard });
      const error = await failure(() => literal.nodes());
      assert.ok(error instanceof PanelUnavailableError);
      assert.equal(error.reason, 'address_not_allowed');
      assert.equal(panel.requests.length, 0, 'no connection was made');
      literal.close();

      const url = new URL(panel.url);
      const byName = clientFor(panel, {
        baseUrl: `http://localhost:${url.port}`,
        addressGuard: guard,
      });
      const refused = await failure(() => byName.nodes());
      assert.ok(
        refused instanceof PanelUnavailableError && refused.reason === 'address_not_allowed',
      );
      assert.ok(seen.some((a) => a === '127.0.0.1' || a === '::1'));
      assert.equal(panel.requests.length, 0);
      byName.close();
    });

    it('lets a name that resolves to a loopback address through for plain http when the guard allows it', async () => {
      const url = new URL(panel.url);
      const client = clientFor(panel, {
        baseUrl: `http://localhost:${url.port}`,
        addressGuard: () => null,
      });
      try {
        assert.equal((await client.nodes()).length, 5);
      } finally {
        client.close();
      }
    });
  });

  describe('parsing a Retry-After', () => {
    it('reads seconds and dates, and nothing else', () => {
      assert.equal(parseRetryAfter('5'), 5);
      assert.equal(parseRetryAfter(' 0 '), 0);
      assert.equal(parseRetryAfter(undefined), undefined);
      assert.equal(parseRetryAfter('soon'), undefined);
      assert.equal(parseRetryAfter('-4'), undefined);
      assert.equal(
        parseRetryAfter(
          'Wed, 21 Oct 2026 07:28:10 GMT',
          Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'),
        ),
        10,
      );
      assert.equal(
        parseRetryAfter(
          'Wed, 21 Oct 2026 07:28:00 GMT',
          Date.parse('Wed, 21 Oct 2026 08:00:00 GMT'),
        ),
        0,
      );
    });
  });

  it('keeps every fake secret out of everything the client returns', async () => {
    const client = make({ maskKey: 'a-key' });
    const everything = JSON.stringify([
      await client.nodes(),
      await client.hosts(),
      await Promise.all((await client.configProfiles()).map((p) => client.configProfile(p.uuid))),
      await client.configProfiles(),
      await client.internalSquads(),
      await client.externalSquads(),
      await client.subscriptionTemplates(),
      // The bodies come through the detail request: this is where a template's login and password would be read.
      await client.subscriptionTemplatesWithBodies(),
      await client.subscriptionSettings(),
      await client.snippets(),
      await client.nodePlugins(),
      await client.nodePluginsWithConfigs(),
      await client.infra(),
    ]);
    const secrets = Object.values(FAKE_SECRETS).flat();
    for (const secret of secrets) {
      assert.ok(!everything.includes(secret), `${secret} came through`);
    }
    // And the harmless neighbours of the secrets did.
    for (const visible of [
      'Profile One',
      'node-1.example.com',
      'VLESS_REALITY_MAIN',
      'xtls-rprx-vision',
      // From the bodies of the templates and the configuration of the plugin, which only the detail requests carry.
      'fake-proxy',
      'hooks.example.com',
    ]) {
      assert.ok(everything.includes(visible), visible);
    }
  });
});
