import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOpenApi } from './openapi.js';
import { type RouteDef, routes } from './routes.js';
import { ApiErrorSchema, HealthResponseSchema, ReadyResponseSchema } from './index.js';

type Json = Record<string, unknown>;

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => collectRefs(n, out));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === '$ref' && typeof value === 'string') {
        out.push(value);
      } else {
        collectRefs(value, out);
      }
    }
  }
  return out;
}

describe('OpenAPI document', () => {
  const doc = buildOpenApi() as {
    openapi: string;
    paths: Record<string, Json>;
    components: { schemas: Json };
  };

  it('is OpenAPI 3.1 and deterministic', () => {
    assert.equal(doc.openapi, '3.1.0');
    assert.deepEqual(buildOpenApi(), doc);
  });

  it('describes every route of the registry exactly once', () => {
    const ids = new Set<string>();
    for (const route of routes) {
      const item = doc.paths[route.path];
      assert.ok(item, `missing path ${route.path}`);
      const op = item[route.method] as Json;
      assert.ok(op, `missing ${route.method} ${route.path}`);
      assert.equal(op['operationId'], route.operationId);
      assert.ok(!ids.has(route.operationId), `duplicate operationId ${route.operationId}`);
      ids.add(route.operationId);
    }
  });

  it('resolves every $ref inside components.schemas', () => {
    const names = new Set(Object.keys(doc.components.schemas));
    for (const ref of collectRefs(doc)) {
      assert.match(ref, /^#\/components\/schemas\//u);
      assert.ok(names.has(ref.slice('#/components/schemas/'.length)), `dangling ${ref}`);
    }
  });

  it('keeps component schemas free of per-schema $id and $schema', () => {
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      assert.ok(!('$id' in (schema as Json)) && !('$schema' in (schema as Json)), name);
    }
  });

  it('describes a request as it is read: a field with a default may be left out', () => {
    const create = doc.components.schemas['CreateTokenRequest'] as Json;
    assert.deepEqual([...(create['required'] as string[])].sort(), ['name', 'permissions']);
    const properties = create['properties'] as Record<string, Json>;
    assert.equal(properties['expiresInDays']?.['default'], 90);
    assert.deepEqual(properties['ipAllowlist']?.['default'], []);
    // Responses keep every field required that is always there.
    const view = doc.components.schemas['TokenView'] as Json;
    assert.ok((view['required'] as string[]).includes('ipAllowlist'));
  });

  it('declares the token of a sidecar on its gateway instead of calling the route public', () => {
    const gateway = doc.paths['/plugins/{id}/gateway']?.['post'] as Json;
    assert.deepEqual(gateway['security'], [{ sidecar: [] }]);
    const schemes = (doc as unknown as { components: { securitySchemes: Record<string, Json> } })
      .components.securitySchemes;
    const sidecar = schemes['sidecar'];
    assert.ok(sidecar);
    assert.equal(sidecar['type'], 'http');
    assert.equal(sidecar['scheme'], 'bearer');
    for (const route of routes as readonly RouteDef[]) {
      const op = doc.paths[route.path]?.[route.method] as Json;
      if (route.handlerAuth === undefined) {
        assert.ok(
          !JSON.stringify(op['security']).includes('sidecar'),
          `${route.operationId} does not take a sidecar token`,
        );
      }
    }
  });

  it('names the media type of every download as the server sends it', () => {
    const content = (path: string): string[] => {
      const responses = (doc.paths[path]?.['get'] as Json)['responses'] as Record<string, Json>;
      return Object.keys(responses['200']?.['content'] as Json);
    };
    assert.deepEqual(content('/panel/snapshots/{id}/export'), ['application/json']);
    assert.deepEqual(content('/artifacts/{name}/content'), ['application/octet-stream']);
  });

  it('marks probes as public and documents the error envelope', () => {
    const health = doc.paths['/health']?.['get'] as Json;
    assert.deepEqual(health['security'], []);
    assert.ok((health['responses'] as Json)['default']);
    assert.ok(doc.components.schemas['ApiError']);
  });
});

describe('system schemas', () => {
  it('accepts a health body and rejects an unknown status', () => {
    assert.ok(HealthResponseSchema.safeParse({ status: 'ok' }).success);
    assert.ok(!HealthResponseSchema.safeParse({ status: 'fine' }).success);
  });

  it('accepts a readiness body with checks', () => {
    const body = { status: 'ready', checks: { postgres: { status: 'up', latencyMs: 2 } } };
    assert.ok(ReadyResponseSchema.safeParse(body).success);
    assert.ok(
      !ReadyResponseSchema.safeParse({ status: 'ready', checks: { x: { status: 'up' } } }).success,
    );
  });

  it('accepts the error envelope only with a known code', () => {
    const ok = { error: { code: 'not_found', message: 'no such run', requestId: 'r1' } };
    assert.ok(ApiErrorSchema.safeParse(ok).success);
    assert.ok(!ApiErrorSchema.safeParse({ error: { ...ok.error, code: 'whoops' } }).success);
  });
});
