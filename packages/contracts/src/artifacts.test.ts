import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ArtifactFileSchema,
  ArtifactManifestSchema,
  ArtifactNameSchema,
  artifactFileMode,
  ArtifactVersionSchema,
  buildOpenApi,
  PushArtifactRequestSchema,
  type RouteDef,
  routes,
} from './index.js';

type Json = Record<string, unknown>;

const realManifest = JSON.parse(
  readFileSync(new URL('../../../artifacts/node-installer/manifest.json', import.meta.url), 'utf8'),
) as Json;

const minimal = (): Json => ({
  manifestVersion: 1,
  name: 'demo',
  version: '1.0.0',
  description: 'A demo.',
  file: 'demo.sh',
  interpreter: 'sh',
  sha256: 'a'.repeat(64),
  size: 10,
  minOs: 'debian 12',
  steps: [],
  params: {},
});

describe('artifact manifests', () => {
  it('accepts the manifest of the node installer exactly as the generator writes it', () => {
    const parsed = ArtifactManifestSchema.safeParse(realManifest);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.name, 'node-installer');
    assert.ok(parsed.data.steps.length > 0);
  });

  it('accepts a minimal manifest and refuses a key it does not know', () => {
    assert.ok(ArtifactManifestSchema.safeParse(minimal()).success);
    assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), extra: 1 }).success);
    assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), manifestVersion: 2 }).success);
  });

  it('refuses a hash that is not 64 lower-case hex characters and a size of zero', () => {
    for (const sha256 of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
      assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), sha256 }).success, sha256);
    }
    assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), size: 0 }).success);
    assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), size: 1.5 }).success);
  });

  it('refuses a step that names a parameter the manifest does not declare, and a step declared twice', () => {
    const step = {
      id: 'one',
      title: 'One',
      readOnly: true,
      needsRoot: false,
      inFull: false,
      params: ['ABSENT'],
      requires: [],
    };
    assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), steps: [step] }).success);
    const ok = { ...step, params: [] };
    assert.ok(!ArtifactManifestSchema.safeParse({ ...minimal(), steps: [ok, ok] }).success);
  });

  it('refuses a parameter with a pattern that is not a regular expression, or with both a pattern and values', () => {
    const param = {
      group: 'node',
      description: 'x',
      required: false,
      secret: false,
      default: null,
    };
    const manifest = (extra: Json): Json => ({
      ...minimal(),
      params: { NAME: { ...param, ...extra } },
    });
    assert.ok(ArtifactManifestSchema.safeParse(manifest({ pattern: '^[a-z]+$' })).success);
    assert.ok(!ArtifactManifestSchema.safeParse(manifest({ pattern: '([' })).success);
    assert.ok(!ArtifactManifestSchema.safeParse(manifest({ pattern: '^a$', enum: ['a'] })).success);
  });
});

describe('artifact names, versions and files', () => {
  it('takes plain lower-case names', () => {
    for (const ok of ['a', 'node-installer', 'node-engine2', 'x'.repeat(64)]) {
      assert.ok(ArtifactNameSchema.safeParse(ok).success, ok);
    }
    for (const bad of ['', 'Node', '-a', 'a-', '1a', 'a_b', 'a/b', '..', 'x'.repeat(65)]) {
      assert.ok(!ArtifactNameSchema.safeParse(bad).success, bad);
    }
  });

  it('takes semantic versions', () => {
    for (const ok of ['0.0.1', '1.2.3', '10.20.30', '1.0.0-rc.1']) {
      assert.ok(ArtifactVersionSchema.safeParse(ok).success, ok);
    }
    for (const bad of ['1', '1.2', '01.2.3', '1.2.3.4.5', 'v1.2.3', '1.2.3+build', '1.2.3-', '']) {
      assert.ok(!ArtifactVersionSchema.safeParse(bad).success, bad);
    }
  });

  it('takes a file name that is one path segment and refuses every way out of a directory', () => {
    for (const ok of ['install.sh', 'node-engine.py', 'a', 'A_b-1.2.tar']) {
      assert.ok(ArtifactFileSchema.safeParse(ok).success, ok);
    }
    for (const bad of [
      '',
      '..',
      '.',
      '../x',
      'a/b',
      '/etc/passwd',
      'a\\b',
      '.hidden',
      'a..b',
      'a b',
      'a\nb',
      'a\0b',
      'x'.repeat(129),
    ]) {
      assert.ok(!ArtifactFileSchema.safeParse(bad).success, JSON.stringify(bad));
    }
  });

  it('gives scripts 0755 and data files 0644, never a writable bit for others', () => {
    assert.equal(artifactFileMode('sh'), 0o755);
    assert.equal(artifactFileMode('python3'), 0o755);
    assert.equal(artifactFileMode('none'), 0o644);
    for (const interpreter of ['sh', 'bash', 'python3', 'none'] as const) {
      assert.equal(artifactFileMode(interpreter) & 0o022, 0);
    }
  });

  it('asks for a name, and a version and a destination only when given', () => {
    assert.ok(PushArtifactRequestSchema.safeParse({ name: 'node-installer' }).success);
    assert.ok(
      PushArtifactRequestSchema.safeParse({
        name: 'node-installer',
        version: '1.0.0',
        destination: 'system',
      }).success,
    );
    assert.ok(
      !PushArtifactRequestSchema.safeParse({ name: 'node-installer', destination: '/' }).success,
    );
    assert.ok(!PushArtifactRequestSchema.safeParse({}).success);
  });
});

describe('artifact routes', () => {
  const doc = buildOpenApi() as { paths: Record<string, Json> };
  const byId = (id: string) => {
    const route = routes.find((candidate) => candidate.operationId === id) as RouteDef | undefined;
    assert.ok(route, id);
    return route;
  };

  it('needs servers:read to look and servers:write to change a server', () => {
    for (const id of [
      'listArtifacts',
      'getArtifact',
      'getArtifactVersion',
      'downloadArtifact',
      'downloadArtifactVersion',
      'listServerArtifacts',
    ]) {
      assert.equal(byId(id).permission, 'servers:read', id);
    }
    assert.equal(byId('verifyServerArtifact').permission, 'servers:write');
    // What is pushed is meant to be run: putting it there and taking it away need the exec permission and a code.
    for (const id of ['pushServerArtifact', 'removeServerArtifact']) {
      assert.equal(byId(id).permission, 'servers:exec', id);
      assert.equal(byId(id).stepUp, true, id);
    }
  });

  it('describes a download as a file with the two headers, not as JSON', () => {
    const op = (doc.paths['/artifacts/{name}/content']?.['get'] ?? {}) as Json;
    const ok = (op['responses'] as Json)['200'] as Json;
    assert.deepEqual(Object.keys(ok['headers'] as Json).sort(), [
      'Content-Disposition',
      'X-Content-SHA256',
    ]);
    assert.deepEqual(Object.keys(ok['content'] as Json), ['application/octet-stream']);
  });
});
