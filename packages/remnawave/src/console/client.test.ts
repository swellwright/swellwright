import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  PanelAuthError,
  PanelRateLimitedError,
  PanelResponseTooLargeError,
  PanelUnavailableError,
  PanelUnsupportedResponseError,
  PanelUrlError,
} from '../errors.js';
import { PanelHttp } from '../http.js';
import {
  fakeAccessTexts,
  FakePanel,
  FAKE_SECRETS,
  FAKE_TOKEN,
  fakePersonalTexts,
  must,
} from '../test-support/index.js';
import { consoleCatalogue } from './catalogue.js';
import { ConsoleClient, cutToBytes, allowedHeaders } from './client.js';
import { type ConsoleRequestInput, prepareConsoleRequest } from './request.js';

const catalogue = consoleCatalogue();
/** The character a URL with credentials has before its host; kept out of the literals. */
const AT = '@';
const KEY = 'a-test-key-for-console-fingerprints';
const noWait = async (): Promise<void> => {
  await Promise.resolve();
};

describe('the client of the API console', () => {
  let panel: FakePanel;
  before(async () => {
    panel = await FakePanel.start();
  });
  after(async () => {
    await panel.close();
  });
  beforeEach(() => {
    panel.clearInjections();
    panel.requests.length = 0;
  });

  const open = (maxBodyBytes = 1024 * 1024, extra: Record<string, unknown> = {}): ConsoleClient =>
    new ConsoleClient({
      baseUrl: panel.url,
      token: panel.token,
      allowInsecureHttp: true,
      maskKey: KEY,
      maxBodyBytes,
      sleep: noWait,
      backoffBaseMs: 1,
      ...extra,
    });

  const prepare = (id: string, input: ConsoleRequestInput = {}) =>
    prepareConsoleRequest(must(catalogue.find(id), id), input);

  it('sends a GET to the path of the operation, with the token in the one header, and returns the masked answer', async () => {
    const client = open();
    try {
      const profile = must(panel.fixtures.configProfiles[0]);
      const uuid = String(profile['uuid']);
      const result = await client.send(
        prepare('ConfigProfileController_getConfigProfileByUuid', { pathParams: { uuid } }),
      );
      assert.equal(result.status, 200);
      assert.equal(result.bodyFormat, 'json');
      assert.equal(result.contentType, 'application/json');
      assert.equal(result.attempts, 1);
      assert.ok(result.durationMs >= 0);
      assert.equal(result.truncated, false);
      assert.deepEqual(
        panel.requests.map((r) => [r.method, r.path, r.authorization]),
        [['GET', `/api/config-profiles/${uuid}`, 'valid']],
      );
      // The whole answer is one text the console shows; nothing in it is a secret of the panel, and nothing is the token.
      const everything = JSON.stringify(result);
      assert.ok(!everything.includes(panel.token));
      for (const secret of Object.values(FAKE_SECRETS).flat()) {
        assert.ok(!everything.includes(secret), `the answer holds ${secret}`);
      }
      assert.ok(
        result.maskedCount >= 4,
        'the REALITY keys, the short ids and the client id were masked',
      );
      assert.ok(result.body.includes('[masked:'));
      assert.ok(result.body.includes('VLESS_REALITY_MAIN'), 'what is not secret is readable');
    } finally {
      client.close();
    }
  });

  it('masks the access material of users in an answer of the open class, and the people too in the class for people', async () => {
    const client = open();
    try {
      const subscriptions = await client.send(
        prepare('SubscriptionsController_getAllSubscriptions'),
      );
      // The operation is about people: the profile for people applies.
      for (const text of fakePersonalTexts()) {
        assert.ok(!JSON.stringify(subscriptions).includes(text), `the answer holds ${text}`);
      }
      const users = await client.send(prepare('UsersController_getUsers'));
      for (const text of fakePersonalTexts()) {
        assert.ok(!JSON.stringify(users).includes(text), `the answer holds ${text}`);
      }
      const parsed = JSON.parse(users.body) as {
        response: { users: { id: number; status: string }[]; total: number };
      };
      assert.deepEqual(
        parsed.response.users.map((u) => u.id),
        [1, 2],
      );
      assert.equal(parsed.response.users[0]?.status, 'ACTIVE');
      // An operation that is not about people uses the standard profile, which hides only the access material.
      const settings = await client.send(prepare('RemnawaveSettingsController_getSettings'));
      for (const text of fakeAccessTexts()) {
        assert.ok(!settings.body.includes(text), `the settings hold ${text}`);
      }
      assert.ok(
        !settings.body.includes('fake.admin@example.com'),
        'the address of an administrator',
      );
      assert.ok(settings.body.includes('Fake panel'));
    } finally {
      client.close();
    }
  });

  it('returns the answer of the panel whatever its status: a 404 and a 403 are results', async () => {
    const client = open();
    try {
      const missing = await client.send(
        prepare('NodesController_getNode', {
          pathParams: { uuid: '00000000-0000-4000-8000-0000000fffff' },
        }),
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.bodyFormat, 'json');
      assert.match(missing.body, /not found/u);
      const admin = await client.send(prepare('ApiTokensController_getScopes'));
      assert.equal(admin.status, 403);
      assert.match(admin.body, /Forbidden/u);
      panel.inject('/api/system/health', {
        kind: 'status',
        status: 400,
        body: { message: ['bad'] },
      });
      const bad = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.equal(bad.status, 400);
    } finally {
      client.close();
    }
  });

  it('says a token the panel refuses is an error, as every read of the panel does', async () => {
    const client = open();
    try {
      panel.setToken('another-token-0000000000000000000000000000');
      await assert.rejects(client.send(prepare('NodesController_getNodes')), PanelAuthError);
      assert.equal(panel.requests.length, 1, 'a refused token is not tried again');
    } finally {
      panel.setToken(FAKE_TOKEN);
      client.close();
    }
  });

  it('retries a GET that fails in a way that may pass, and returns a 5xx that keeps coming as the answer it is', async () => {
    const client = open();
    try {
      panel.inject('/api/hosts', { kind: 'status', status: 503 }, 2);
      const recovered = await client.send(prepare('HostsController_getHosts'));
      assert.equal(recovered.status, 200);
      assert.equal(recovered.attempts, 3);
      panel.requests.length = 0;
      panel.inject('/api/nodes', { kind: 'status', status: 500, body: { message: 'broken' } });
      const broken = await client.send(prepare('NodesController_getNodes'));
      assert.equal(broken.status, 500);
      assert.equal(broken.attempts, 3);
      assert.match(broken.body, /broken/u);
      assert.equal(panel.requests.length, 3);
    } finally {
      client.close();
    }
  });

  it('obeys a short Retry-After and reports a long one, as a 429 error with the seconds', async () => {
    const client = open();
    try {
      panel.inject(
        '/api/snippets',
        { kind: 'status', status: 429, headers: { 'retry-after': '1' } },
        1,
      );
      const waited = await client.send(prepare('SnippetsController_getSnippets'));
      assert.equal(waited.status, 200);
      assert.equal(waited.attempts, 2);
      panel.inject('/api/nodes', {
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '600' },
      });
      await assert.rejects(client.send(prepare('NodesController_getNodes')), (error) => {
        assert.ok(error instanceof PanelRateLimitedError);
        assert.equal(error.retryAfterSeconds, 600);
        return true;
      });
    } finally {
      client.close();
    }
  });

  it('refuses a redirect that leaves the panel, and never sends the token to the place it points at', async () => {
    const client = open();
    try {
      panel.inject('/api/nodes', { kind: 'redirect', location: 'http://127.0.0.1:1/steal' });
      await assert.rejects(client.send(prepare('NodesController_getNodes')), (error) => {
        assert.ok(error instanceof PanelUnavailableError);
        assert.equal(error.reason, 'redirect_refused');
        return true;
      });
    } finally {
      client.close();
    }
  });

  it('follows no redirect at all, not even one inside the origin: the operation that was allowed is the one answered', async () => {
    const client = open();
    try {
      // An open operation redirected to an operation about people, and to a path outside the panel's API.
      for (const location of ['/api/users', `${panel.url}/api/users`, '/outside-the-api']) {
        panel.requests.length = 0;
        panel.inject('/api/nodes', { kind: 'redirect', location }, 1);
        await assert.rejects(client.send(prepare('NodesController_getNodes')), (error) => {
          assert.ok(error instanceof PanelUnavailableError);
          assert.equal(error.reason, 'redirect_refused');
          return true;
        });
        assert.deepEqual(
          panel.requests.map((r) => r.path),
          ['/api/nodes'],
          `the redirect to ${location} was not followed`,
        );
      }
    } finally {
      client.close();
    }
  });

  it('never returns the credentials in the base64 YAML of a subscription template', async () => {
    const client = open();
    try {
      const template = must(
        panel.fixtures.templates.find((entry) => entry['name'] === 'Template Yaml'),
      );
      const result = await client.send(
        prepare('SubscriptionTemplateController_getTemplateByUuid', {
          pathParams: { uuid: String(template['uuid']) },
        }),
      );
      assert.equal(result.status, 200);
      const parsed = JSON.parse(result.body) as { response: { encodedTemplateYaml: string } };
      const decoded = Buffer.from(parsed.response.encodedTemplateYaml, 'base64').toString('utf8');
      for (const secret of [
        FAKE_SECRETS.clientId,
        FAKE_SECRETS.yamlShortId,
        FAKE_SECRETS.yamlPassword,
      ]) {
        assert.ok(!decoded.includes(secret), `the template holds ${secret}`);
        assert.ok(!result.body.includes(secret));
      }
      assert.ok(decoded.includes('node-1.example.com'), 'what is not secret is readable');
      assert.ok(result.maskedCount >= 3);
    } finally {
      client.close();
    }
  });

  it('keeps only the headers that are allowed, and drops control characters from them', async () => {
    const client = open();
    try {
      panel.inject('/api/system/health', {
        kind: 'status',
        status: 200,
        body: { response: { runtimeMetrics: [] } },
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '59',
          'retry-after': '3',
          'set-cookie': 'session=SECRET-COOKIE',
          server: 'fake-server/1',
          'x-powered-by': 'fake',
          'x-forwarded-for': '203.0.113.9',
        },
      });
      const result = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.deepEqual(Object.keys(result.headers).sort(), [
        'content-length',
        'content-type',
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
      ]);
      assert.ok(!JSON.stringify(result).includes('SECRET-COOKIE'));
      assert.deepEqual(
        allowedHeaders({
          'Content-Type': 'text/plain',
          'X-RateLimit-Reset': 'a\u0001b',
          Cookie: 'x',
        }),
        { 'content-type': 'text/plain', 'x-ratelimit-reset': 'a b' },
      );
    } finally {
      client.close();
    }
  });

  it('cuts a long answer to the size, after masking, and says so', async () => {
    const client = open(2000);
    try {
      const result = await client.send(prepare('NodesController_getNodes'));
      assert.equal(result.truncated, true);
      assert.ok(Buffer.byteLength(result.body, 'utf8') <= 2000);
      assert.ok(result.bodyBytes > 2000, 'the size of the panel answer is told');
      assert.ok(result.body.startsWith('{'));
      for (const secret of Object.values(FAKE_SECRETS).flat()) {
        assert.ok(!result.body.includes(secret));
      }
      // The cut is made on the masked text: a secret that sits after the cut is masked too, so it cannot be found by
      // asking for a bigger window. (The masked text is what is cut; it has no secret in it to begin with.)
      const whole = await open().send(prepare('NodesController_getNodes'));
      assert.equal(whole.truncated, false);
      assert.ok(whole.body.startsWith(result.body.slice(0, 100)));
    } finally {
      client.close();
    }
  });

  it('cuts text at a line when there is one near the end, and never inside a character', () => {
    const lines = Array.from({ length: 200 }, (_u, i) => `line ${String(i)} é`).join('\n');
    const cut = cutToBytes(lines, 500);
    assert.equal(cut.truncated, true);
    assert.ok(Buffer.byteLength(cut.text, 'utf8') <= 500);
    assert.ok(!cut.text.includes('�'));
    assert.ok(cut.text.endsWith('é'), 'the cut is at the end of a line');
    assert.equal(cutToBytes('short', 500).truncated, false);
    const wide = 'é'.repeat(100);
    const odd = cutToBytes(wide, 51);
    assert.ok(!odd.text.includes('�'));
    assert.ok(Buffer.byteLength(odd.text, 'utf8') <= 51);
  });

  it('takes the token itself out of an answer that echoes it, whatever the name it sits under', async () => {
    const client = open();
    try {
      panel.inject(
        '/api/system/health',
        {
          kind: 'raw',
          contentType: 'application/json',
          body: JSON.stringify({ response: { echo: panel.token, nested: [`x-${panel.token}-y`] } }),
        },
        1,
      );
      const json = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.ok(!JSON.stringify(json).includes(panel.token));
      assert.equal(json.maskedCount, 2);
      panel.inject(
        '/api/system/health',
        { kind: 'raw', contentType: 'text/plain', body: `token=${panel.token}` },
        1,
      );
      const text = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.ok(!JSON.stringify(text).includes(panel.token));
    } finally {
      client.close();
    }
  });

  it('reads text that is not JSON and masks it by its values', async () => {
    const client = open();
    try {
      panel.inject('/api/system/health', {
        kind: 'raw',
        contentType: 'text/plain; charset=utf-8',
        body: `plain answer vless://00000000-0000-4000-8000-0000000091bb${AT}node.example.com:443`,
      });
      const result = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.equal(result.bodyFormat, 'text');
      assert.equal(result.contentType, 'text/plain');
      assert.ok(!result.body.includes('0000000091bb'));
      assert.ok(result.body.includes('plain answer'));
      assert.ok(result.maskedCount >= 1);
    } finally {
      client.close();
    }
  });

  it('takes the panel token out of decoded strings, names, encodings, the content type and errors', async () => {
    const client = open();
    const token = panel.token;
    // The token written with an escape: only decoding the JSON (or the YAML) writes it out.
    const escapedJson = `\\u${token.charCodeAt(0).toString(16).padStart(4, '0')}${token.slice(1)}`;
    const escapedYaml = `\\x${token.charCodeAt(0).toString(16).padStart(2, '0')}${token.slice(1)}`;
    try {
      for (const [contentType, body] of [
        ['application/json', `{"echo":"${escapedJson}"}`],
        ['application/json', `{"${escapedJson}":"as a name"}`],
        ['application/json', JSON.stringify({ b64: Buffer.from(token).toString('base64') })],
        ['application/json', JSON.stringify({ url: `x?t=${encodeURIComponent(token)}` })],
        ['application/yaml', `echo: "${escapedYaml}"\nother: 1\n`],
        [`text/${token}`, 'ok'],
      ] as const) {
        panel.inject('/api/system/health', { kind: 'raw', contentType, body }, 1);
        const result = await client.send(prepare('SystemController_getRemnawaveHealth'));
        assert.ok(!JSON.stringify(result).includes(token), `${contentType}: ${body}`);
        assert.ok(
          !JSON.stringify(result).includes(Buffer.from(token).toString('base64').slice(0, 40)),
        );
      }
      panel.inject(
        '/api/system/health',
        { kind: 'raw', contentType: `image/${token}`, body: 'x' },
        1,
      );
      await assert.rejects(client.send(prepare('SystemController_getRemnawaveHealth')), (error) => {
        assert.ok(error instanceof PanelUnsupportedResponseError);
        const everything = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
        assert.ok(!everything.includes(token), everything);
        return true;
      });
    } finally {
      client.close();
    }
  });

  it('shows a page that came in place of JSON as text, and an empty answer as empty', async () => {
    const client = open();
    try {
      panel.inject(
        '/api/system/health',
        { kind: 'raw', contentType: 'text/html', body: '<html><body>Sign in</body></html>' },
        1,
      );
      const page = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.equal(page.bodyFormat, 'text');
      assert.match(page.body, /Sign in/u);
      panel.inject(
        '/api/system/health',
        { kind: 'raw', contentType: 'application/json', body: '' },
        1,
      );
      const empty = await client.send(prepare('SystemController_getRemnawaveHealth'));
      assert.equal(empty.bodyFormat, 'empty');
      assert.equal(empty.body, '');
    } finally {
      client.close();
    }
  });

  it('refuses a binary answer, and one that is not text whatever it says it is', async () => {
    const client = open();
    try {
      panel.inject(
        '/api/system/health',
        { kind: 'raw', contentType: 'application/octet-stream', body: 'abc' },
        1,
      );
      await assert.rejects(
        client.send(prepare('SystemController_getRemnawaveHealth')),
        PanelUnsupportedResponseError,
      );
      panel.inject('/api/system/health', { kind: 'raw', contentType: 'image/png', body: 'x' }, 1);
      await assert.rejects(client.send(prepare('SystemController_getRemnawaveHealth')), (error) => {
        assert.ok(error instanceof PanelUnsupportedResponseError);
        assert.equal(error.contentType, 'image/png');
        return true;
      });
      panel.inject(
        '/api/system/health',
        {
          kind: 'raw',
          contentType: 'application/json',
          body: `{"a":"x${String.fromCharCode(0)}y"}`,
        },
        1,
      );
      await assert.rejects(
        client.send(prepare('SystemController_getRemnawaveHealth')),
        PanelUnsupportedResponseError,
      );
    } finally {
      client.close();
    }
  });

  it('reports an answer larger than the limit of the transport, and stops reading it', async () => {
    const client = open(1024 * 1024, { maxResponseBytes: 50_000 });
    try {
      panel.inject('/api/nodes', { kind: 'large', bytes: 200_000, chunked: true });
      await assert.rejects(
        client.send(prepare('NodesController_getNodes')),
        PanelResponseTooLargeError,
      );
      panel.inject('/api/hosts', { kind: 'large', bytes: 200_000 });
      await assert.rejects(client.send(prepare('HostsController_getHosts')), (error) => {
        assert.ok(error instanceof PanelResponseTooLargeError);
        assert.equal(error.limitBytes, 50_000);
        return true;
      });
    } finally {
      client.close();
    }
  });

  it('maps the failures of the network as every read does, and a timeout is not retried', async () => {
    const client = open(1024 * 1024, { timeoutMs: 100 });
    try {
      panel.inject('/api/nodes', { kind: 'hang' });
      await assert.rejects(
        client.send(prepare('NodesController_getNodes')),
        /did not answer within/u,
      );
      assert.equal(panel.requests.length, 1);
      panel.inject('/api/hosts', { kind: 'drop' });
      await assert.rejects(client.send(prepare('HostsController_getHosts')), PanelUnavailableError);
    } finally {
      client.close();
    }
  });
});

describe('the raw read of the HTTP layer', () => {
  const stub = (seen: URL[], status = 200) => ({
    get(request: { url: URL }) {
      seen.push(request.url);
      return Promise.resolve({
        status,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{}'),
      });
    },
    close() {
      // nothing is open
    },
  });

  it('refuses a path that does not stay under the address of the panel', async () => {
    const seen: URL[] = [];
    const http = new PanelHttp({
      baseUrl: 'https://panel.example.com',
      token: 'a-token-of-some-length',
      transport: stub(seen),
    });
    for (const bad of [
      `@evil.example.com/api/nodes`,
      'api/nodes',
      '//evil.example.com/api',
      '',
      `.evil.example.com/api`,
    ]) {
      await assert.rejects(async () => http.getRaw('x', bad), PanelUrlError, JSON.stringify(bad));
    }
    assert.equal(seen.length, 0, 'nothing was sent');
    await http.getRaw('x', '/api/nodes?a=1');
    assert.equal(must(seen[0]).href, 'https://panel.example.com/api/nodes?a=1');
    // A backslash is a path character to the URL parser of a browser or a server, and the host is still the panel.
    await http.getRaw('x', '/\\evil.example.com');
    assert.equal(must(seen[1]).host, 'panel.example.com');
  });

  it('keeps the prefix of a panel that is behind one, and refuses a path that climbs out of it', async () => {
    const seen: URL[] = [];
    const http = new PanelHttp({
      baseUrl: 'https://panel.example.com/remna',
      token: 'a-token-of-some-length',
      transport: stub(seen),
    });
    await http.getRaw('x', '/api/nodes');
    assert.equal(must(seen[0]).href, 'https://panel.example.com/remna/api/nodes');
    await assert.rejects(async () => http.getRaw('x', '/../other/api'), PanelUrlError);
    await assert.rejects(async () => http.getRaw('x', '/api/../../x'), PanelUrlError);
    assert.equal(seen.length, 1);
  });

  it('follows a redirect of a typed read only under the prefix of the panel', async () => {
    const seen: URL[] = [];
    const redirecting = (location: string) => ({
      get(request: { url: URL }) {
        seen.push(request.url);
        const first = seen.length === 1;
        return Promise.resolve({
          status: first ? 302 : 200,
          headers: first
            ? { location, 'content-type': 'application/json' }
            : { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"response":[]}'),
        });
      },
      close() {
        // nothing is open
      },
    });
    for (const outside of [
      '/other/api/users',
      '/api/users',
      'https://panel.example.com/remnax/api',
    ]) {
      seen.length = 0;
      const http = new PanelHttp({
        baseUrl: 'https://panel.example.com/remna',
        token: 'a-token-of-some-length',
        transport: redirecting(outside),
      });
      await assert.rejects(http.getJson('x', '/api/nodes'), (error) => {
        assert.ok(error instanceof PanelUnavailableError);
        assert.equal(error.reason, 'redirect_refused');
        return true;
      });
      assert.equal(seen.length, 1, `${outside} was not followed`);
    }
    seen.length = 0;
    const inside = new PanelHttp({
      baseUrl: 'https://panel.example.com/remna',
      token: 'a-token-of-some-length',
      transport: redirecting('/remna/api/nodes/'),
    });
    assert.deepEqual(await inside.getJson('x', '/api/nodes'), { response: [] });
    assert.equal(seen.length, 2);
  });

  it('does not put the token in an error or a result', async () => {
    const seen: URL[] = [];
    const token = 'SECRET-TOKEN-0123456789abcdef';
    const http = new PanelHttp({
      baseUrl: 'https://panel.example.com',
      token,
      transport: stub(seen, 401),
    });
    await assert.rejects(http.getRaw('x', '/api/nodes'), (error) => {
      assert.ok(error instanceof PanelAuthError);
      assert.ok(!error.message.includes(token));
      return true;
    });
  });
});
