import 'reflect-metadata';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiErrorSchema } from '@swellwright/contracts';

import { CONSOLE_CSP, consoleHeaders, createApp } from './bootstrap.js';
import { loadConfig } from './config.js';
import {
  auditEvents,
  createOwner,
  databaseUrl,
  found,
  type Instance,
  PASSWORD,
  start,
  stop,
} from './test-support.js';

it('requires an explicit proxy trust choice in compose and supplies one in CI', async () => {
  const compose = await readFile(
    new URL('../../../deploy/compose/docker-compose.yml', import.meta.url),
    'utf8',
  );
  assert.match(compose, /^\s*SW_TRUSTED_PROXIES:.*\$\{SW_TRUSTED_PROXIES:\?/mu);
  const ci = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /^\s*SW_TRUSTED_PROXIES: "false"$/mu);
  assert.equal(loadConfig({ SW_TRUSTED_PROXIES: 'false' }, 'v').trustProxy, false);
});

it('warns once, without logging forwarded values, when an untrusted private peer sends the header', async () => {
  const matched: string[] = [];
  const warning = mock.method(Logger.prototype, 'warn', (message: unknown) => {
    if (typeof message === 'string' && message.includes('X-Forwarded-For')) {
      matched.push(message);
    }
  });
  try {
    for (const trust of ['loopback', 'false']) {
      const app = await createApp(
        loadConfig({ NODE_ENV: 'test', SW_TRUSTED_PROXIES: trust }, 'test'),
        {
          readinessChecks: [],
        },
      );
      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as { port: number };
      try {
        for (const addr of ['203.0.113.5', '203.0.113.6']) {
          const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`, {
            headers: { 'x-forwarded-for': addr },
          });
          assert.equal(response.status, 200);
          await response.text();
        }
      } finally {
        await app.close();
      }
      assert.equal(matched.length, trust === 'false' ? 1 : 0);
      assert.ok(matched.every((message) => !message.includes('203.0.113.')));
    }
  } finally {
    warning.mock.restore();
  }
});

describe('serving the console from the API', () => {
  let dir: string;
  let app: NestExpressApplication;
  let base: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sw-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(dir, 'assets', 'app.1a2b3c.js'), 'console.log(1);');
    await writeFile(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const config = loadConfig(
      { SW_LOG_LEVEL: 'silent', NODE_ENV: 'test', SW_WEB_DIR: dir },
      '0.0.0-test',
    );
    app = await createApp(config, { readinessChecks: [] });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${String((app.getHttpServer().address() as { port: number }).port)}`;
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the page at the root, never cached, with the headers that keep it safe', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/u);
    assert.equal(await res.text(), '<!doctype html><div id="root"></div>');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    // Present and forbidding framing. The exact policy is checked below, not on the wire: a content filter on
    // the machine running the tests may add its own hosts to it.
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
  });

  it('sets the page headers exactly: the policy, no caching of the page, long caching of hashed assets', () => {
    const headersFor = (filePath: string): Map<string, string> => {
      const set = new Map<string, string>();
      consoleHeaders(
        {
          setHeader(name: string, value: string) {
            set.set(name, value);
          },
        },
        filePath,
      );
      return set;
    };
    const page = headersFor(join('web', 'index.html'));
    assert.equal(page.get('content-security-policy'), CONSOLE_CSP);
    assert.equal(page.get('cache-control'), 'no-cache');
    assert.equal(page.get('x-frame-options'), 'DENY');
    assert.equal(page.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(
      headersFor(join('web', 'assets', 'a.js')).get('cache-control'),
      'public, max-age=31536000, immutable',
    );
    assert.equal(headersFor(join('web', 'logo.svg')).get('cache-control'), 'public, max-age=3600');
  });

  it('forbids what the console never needs', () => {
    for (const rule of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ]) {
      assert.ok(CONSOLE_CSP.includes(rule), rule);
    }
    assert.ok(!/script-src[^;]*unsafe/u.test(CONSOLE_CSP), 'no inline or eval scripts');
  });

  it('lets the browser keep hashed assets for good and other files for an hour', async () => {
    const asset = await fetch(`${base}/assets/app.1a2b3c.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const icon = await fetch(`${base}/favicon.svg`);
    assert.equal(icon.headers.get('cache-control'), 'public, max-age=3600');
  });

  it('leaves the API alone: its answers are JSON, uncached, without the page headers', async () => {
    const res = await fetch(`${base}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('answers an unknown API path with the error envelope, never with the page', async () => {
    const res = await fetch(`${base}/api/v1/nope`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 404);
    assert.equal(ApiErrorSchema.parse(await res.json()).error.code, 'not_found');
  });
});

describe('deep links of the console (real URLs, ADR 0019)', () => {
  let dir: string;
  let app: NestExpressApplication;
  let base: string;
  const PAGE = '<!doctype html><div id="root"></div>';

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sw-spa-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), PAGE);
    await writeFile(join(dir, 'assets', 'app.1a2b3c.js'), 'console.log(1);');
    const config = loadConfig(
      { SW_LOG_LEVEL: 'silent', NODE_ENV: 'test', SW_WEB_DIR: dir },
      '0.0.0-test',
    );
    app = await createApp(config, { readinessChecks: [] });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${String((app.getHttpServer().address() as { port: number }).port)}`;
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const page = (path: string, accept = 'text/html', method = 'GET'): Promise<Response> =>
    fetch(`${base}${path}`, { method, headers: { accept } });

  it('opens the page at a deep link, with the headers of the root page', async () => {
    for (const path of ['/dashboard/security/users', '/dashboard', '/nope', '/a/b/c/']) {
      const res = await page(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/u, path);
      assert.equal(await res.text(), PAGE, path);
      assert.equal(res.headers.get('cache-control'), 'no-cache', path);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      // Present and forbidding framing; the exact policy is checked on the function (a content filter on the
      // machine running the tests may add hosts to it on the wire).
      assert.match(
        res.headers.get('content-security-policy') ?? '',
        /frame-ancestors 'none'/u,
        path,
      );
    }
  });

  it('keeps the query string out of the decision and answers HEAD without a body', async () => {
    const withQuery = await page('/dashboard/audit?cursor=5&filter=a.b');
    assert.equal(withQuery.status, 200);
    assert.equal(await withQuery.text(), PAGE);
    const head = await page('/dashboard/security/users', 'text/html', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'no-cache');
    assert.equal(await head.text(), '');
  });

  it('is the page for a client that sends no preference, and not for one that wants JSON', async () => {
    // `*/*` is what a plain `curl` or `fetch` sends: HTML is acceptable.
    assert.equal((await page('/dashboard/security/users', '*/*')).status, 200);
    const json = await page('/dashboard/security/users', 'application/json');
    assert.equal(json.status, 404);
    assert.doesNotMatch(await json.text(), /id="root"/u);
  });

  it('leaves the API alone: its unknown paths stay the JSON 404', async () => {
    for (const path of ['/api/v1/nothing', '/api/v1/auth/nothing']) {
      const res = await page(path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/u, path);
      assert.equal(ApiErrorSchema.parse(await res.json()).error.code, 'not_found');
    }
    // Outside the versioned prefix there is nothing of the API either, and no page.
    for (const path of ['/api', '/api/', '/api/other']) {
      const res = await page(path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /id="root"/u, path);
    }
    const health = await page('/api/v1/health', 'text/html');
    assert.deepEqual(await health.json(), { status: 'ok' });
  });

  it('does not make a page of a missing file or of the folder of the assets', async () => {
    for (const path of [
      '/assets/missing.js',
      '/assets/',
      '/assets/missing',
      '/missing.svg',
      '/a/b.txt',
    ]) {
      const res = await page(path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /id="root"/u, path);
    }
  });

  it('does not make a page of a path that leaves the folder or is not a path', async () => {
    const { port } = app.getHttpServer().address() as { port: number };
    for (const path of [
      '/%2e%2e/%2e%2e/etc/passwd',
      '/a/%2e%2e/b',
      '/%E0%A4%A',
      '/a%5Cb',
      '/a%00b',
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.ok(status === 403 || status === 404 || status === 400, `${path}: ${String(status)}`);
    }
  });

  it('answers only GET and HEAD with the page: another method on an unknown path is a 404', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/dashboard/security/users`, {
        method,
        headers: { accept: 'text/html' },
      });
      assert.equal(res.status, 404, method);
      assert.doesNotMatch(await res.text(), /id="root"/u, method);
    }
  });

  it('still serves a real file as itself', async () => {
    const res = await page('/assets/app.1a2b3c.js', '*/*');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'console.log(1);');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
});

describe('serving the console from the API: more', () => {
  let dir: string;
  let app: NestExpressApplication;
  let port: number;
  let base: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sw-web2-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(dir, '.secret'), 'not for the web');
    const config = loadConfig(
      { SW_LOG_LEVEL: 'silent', NODE_ENV: 'test', SW_WEB_DIR: dir },
      '0.0.0-test',
    );
    app = await createApp(config, { readinessChecks: [] });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as { port: number }).port;
    base = `http://127.0.0.1:${String(port)}`;
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not serve dotfiles, and does not leave the directory', async () => {
    assert.equal((await fetch(`${base}/.secret`)).status, 404);
    // fetch tidies `..` away, so the raw request is made by hand.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/%2e%2e/%2e%2e/etc/passwd', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(status === 403 || status === 404, `got ${String(status)}`);
  });
});

describe('serving the console: misconfiguration', () => {
  it('refuses to start when the directory has no page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-empty-'));
    try {
      const config = loadConfig(
        { SW_LOG_LEVEL: 'silent', NODE_ENV: 'test', SW_WEB_DIR: dir },
        '0.0.0-test',
      );
      await assert.rejects(
        createApp(config, { readinessChecks: [] }),
        /SW_WEB_DIR has no index\.html/u,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves no page when no directory is set', async () => {
    const config = loadConfig({ SW_LOG_LEVEL: 'silent', NODE_ENV: 'test' }, '0.0.0-test');
    assert.equal(config.webDir, undefined);
    const app = await createApp(config, { readinessChecks: [] });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    try {
      assert.equal((await fetch(`http://127.0.0.1:${String(port)}/`)).status, 404);
    } finally {
      await app.close();
    }
  });
});

describe('trusted proxies in the configuration', () => {
  const trust = (value: string): unknown =>
    loadConfig({ SW_TRUSTED_PROXIES: value }, 'v').trustProxy;

  it('trusts nobody by default', () => {
    assert.equal(loadConfig({}, 'v').trustProxy, false);
    assert.equal(trust('false'), false);
  });

  it('takes a number of hops, or names, addresses and ranges', () => {
    assert.equal(trust('1'), 1);
    assert.equal(trust(' 2 '), 2);
    assert.deepEqual(trust('loopback, uniquelocal'), ['loopback', 'uniquelocal']);
    assert.deepEqual(trust('10.0.0.0/8,172.16.0.1,fd00::/8'), [
      '10.0.0.0/8',
      '172.16.0.1',
      'fd00::/8',
    ]);
    assert.deepEqual(trust('loopback,'), ['loopback']);
    assert.deepEqual(trust('192.0.2.5'), ['192.0.2.5']);
    assert.deepEqual(trust('192.0.2.0/28'), ['192.0.2.0/28']);
  });

  it('refuses what looks like a typo, instead of trusting more than was meant', () => {
    for (const bad of [
      '',
      ' ',
      '0',
      '11',
      'everyone',
      'loopback,everyone',
      'true',
      '300.1.1.1',
      ',',
      '192.0.2.1/33',
    ]) {
      assert.throws(() => trust(bad), /SW_TRUSTED_PROXIES/u, bad);
    }
  });
});

describe('the address of the client behind a proxy', { skip: !databaseUrl }, () => {
  let trusting: Instance;
  let plain: Instance;

  before(async () => {
    trusting = await start({ SW_TRUSTED_PROXIES: 'loopback' });
    plain = await start();
  });
  after(async () => {
    await stop(trusting);
    await stop(plain);
  });

  const failedLoginAddress = async (instance: Instance): Promise<string | null> => {
    const reply = await instance
      .client()
      .post(
        '/auth/login',
        { username: 'nobody', password: 'x' },
        { 'x-forwarded-for': '203.0.113.9' },
      );
    assert.equal(reply.status, 401);
    const event = found(
      (await auditEvents(instance)).find((e) => e.action === 'auth.login.failed'),
      'the failed sign-in event',
    );
    return event.ip;
  };

  it('is read from X-Forwarded-For when the proxy is trusted', async () => {
    assert.equal(await failedLoginAddress(trusting), '203.0.113.9');
  });

  it('is the address of the connection when nobody is trusted, whatever the header says', async () => {
    const address = await failedLoginAddress(plain);
    assert.notEqual(address, '203.0.113.9');
    assert.match(address ?? '', /127\.0\.0\.1$/u);
  });

  it('counts six different forwarded addresses as one source when proxy trust is explicitly off', async () => {
    const direct = await start({ SW_TRUSTED_PROXIES: 'false' });
    try {
      await createOwner(direct);
      const client = direct.client();
      const login = (i: number, password: string) =>
        client.post(
          '/auth/login',
          { username: 'owner', password },
          { 'x-forwarded-for': `192.0.2.${String(i)}` },
        );
      for (let i = 1; i <= 6; i += 1) {
        assert.equal((await login(i, 'wrong-password')).status, i <= 5 ? 401 : 429);
      }
      assert.equal((await login(7, PASSWORD)).status, 429);
      const rows = await direct.isolated.database.client.passwordSourceFailure.findMany();
      assert.deepEqual(
        rows.map((row) => [row.sourceBucket, row.failures]),
        [['127.0.0.1', 5]],
      );
    } finally {
      await stop(direct);
    }
  });
});
