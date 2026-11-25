import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ApiErrorSchema,
  buildOpenApi,
  HealthResponseSchema,
  ReadyResponseSchema,
  VersionResponseSchema,
} from '@swellwright/contracts';

import { createApp } from './bootstrap.js';
import { type AppConfig, loadConfig } from './config.js';
import type { ReadinessCheck } from './readiness.js';

const config: AppConfig = loadConfig(
  { SW_LOG_LEVEL: 'silent', NODE_ENV: 'test', SW_HTTP_PORT: '0' },
  '0.0.0-test',
);

const up: ReadinessCheck = { name: 'fake-up', run: () => Promise.resolve() };
const down: ReadinessCheck = {
  name: 'fake-down',
  run: () =>
    Promise.reject(Object.assign(new Error('secret host 10.0.0.1'), { code: 'ECONNREFUSED' })),
};

async function start(
  checks: readonly ReadinessCheck[],
): Promise<{ app: NestExpressApplication; base: string }> {
  const app = await createApp(config, { readinessChecks: checks });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${String(address.port)}/api/v1` };
}

describe('API, every dependency up', () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  before(async () => {
    ctx = await start([up]);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('answers the liveness probe in the contract shape with request and safety headers', async () => {
    const res = await fetch(`${ctx.base}/health`);
    assert.equal(res.status, 200);
    assert.ok(HealthResponseSchema.safeParse(await res.json()).success);
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/u);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('keeps a valid incoming request id and replaces an invalid one', async () => {
    const kept = await fetch(`${ctx.base}/health`, { headers: { 'x-request-id': 'trace-123' } });
    assert.equal(kept.headers.get('x-request-id'), 'trace-123');
    const replaced = await fetch(`${ctx.base}/health`, {
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    assert.notEqual(replaced.headers.get('x-request-id'), 'bad id with spaces');
  });

  it('reports ready with one entry per check', async () => {
    const res = await fetch(`${ctx.base}/ready`);
    assert.equal(res.status, 200);
    const body = ReadyResponseSchema.parse(await res.json());
    assert.equal(body.status, 'ready');
    assert.equal(body.checks['fake-up']?.status, 'up');
  });

  it('reports the version', async () => {
    const body = VersionResponseSchema.parse(await (await fetch(`${ctx.base}/version`)).json());
    assert.equal(body.name, 'swellwright');
    assert.equal(body.version, '0.0.0-test');
    assert.equal(body.apiVersion, 'v1');
    // A build that recorded nothing says so with nulls, never with made-up values.
    assert.deepEqual(body.build, { time: null, number: null });
    assert.deepEqual(body.git, { branch: null, commit: null, commitUrl: null });
  });

  it('serves exactly the generated OpenAPI document', async () => {
    const res = await fetch(`${ctx.base}/openapi.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), buildOpenApi());
  });

  it('answers an unknown path with the error envelope and the same request id', async () => {
    const res = await fetch(`${ctx.base}/nope`);
    assert.equal(res.status, 404);
    const body = ApiErrorSchema.parse(await res.json());
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.error.requestId, res.headers.get('x-request-id'));
  });

  it('answers a body that cannot be read with a fixed envelope, never with what the parser saw', async () => {
    const marker = 'SECRET-MARKER-7f3a';
    const logged: string[] = [];
    const writes = [process.stdout, process.stderr].map((stream) => {
      const original = stream.write.bind(stream);
      stream.write = (chunk: unknown, ...rest: unknown[]) => {
        logged.push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      };
      return () => {
        stream.write = original;
      };
    });
    const post = (body: string | Uint8Array, headers: Record<string, string>) =>
      fetch(`${ctx.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'parse-1', ...headers },
        body,
      });
    try {
      const cases: [Response, number, string][] = [
        [await post(`{"username":"${marker}", "password": ${marker}`, {}), 400, 'not valid JSON'],
        [await post(`{"p":"${marker}${'x'.repeat(3 * 1024 * 1024)}"}`, {}), 413, 'too large'],
        [await post(`{"p":"${marker}"}`, { 'content-encoding': 'br-unknown' }), 415, 'encoding'],
        // A compressed body: its stream has ended before it is parsed, which is not a client that went away.
        [
          await post(gzipSync(`{"username":"${marker}", bad`), { 'content-encoding': 'gzip' }),
          400,
          'not valid JSON',
        ],
        // Declared as gzip but not gzip: the client's mistake, answered as such.
        [await post(`{"p":"${marker}"}`, { 'content-encoding': 'gzip' }), 400, 'could not be read'],
        [
          await post(gzipSync(`{"p":"${marker}${'x'.repeat(4 * 1024 * 1024)}"}`), {
            'content-encoding': 'gzip',
          }),
          413,
          'too large',
        ],
        [
          await post(`{"p":"${marker}"}`, { 'content-type': 'application/json; charset=koi8-r' }),
          415,
          'character set',
        ],
      ];
      for (const [res, status, text] of cases) {
        assert.equal(res.status, status, text);
        const raw = await res.text();
        assert.ok(!raw.includes(marker), `the answer quotes nothing of the body (${text})`);
        const body = ApiErrorSchema.parse(JSON.parse(raw));
        assert.equal(body.error.code, 'bad_request');
        assert.match(body.error.message, new RegExp(text, 'u'));
        assert.equal(body.error.details, undefined);
        assert.equal(body.error.requestId, 'parse-1');
        assert.equal(res.headers.get('x-request-id'), 'parse-1');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }
    } finally {
      for (const restore of writes) {
        restore();
      }
    }
    assert.ok(!logged.join('').includes(marker), 'nothing of the body reaches the log');
  });
});

describe('API, a dependency down', () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  before(async () => {
    ctx = await start([up, down]);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('answers 503 with the readiness shape and no secrets in the reason', async () => {
    const res = await fetch(`${ctx.base}/ready`);
    assert.equal(res.status, 503);
    const text = await res.text();
    const body = ReadyResponseSchema.parse(JSON.parse(text));
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks['fake-down']?.status, 'down');
    assert.equal(body.checks['fake-down'].error, 'ECONNREFUSED'); // narrowed by the assertion above
    assert.ok(!text.includes('10.0.0.1'));
  });

  it('still answers liveness', async () => {
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200);
  });
});
