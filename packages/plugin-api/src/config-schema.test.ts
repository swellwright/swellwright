import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigSchemaFileSchema, secretFields, validateConfig } from './config-schema.js';

const SCHEMA = ConfigSchemaFileSchema.parse({
  type: 'object',
  properties: {
    zone: { type: 'string', title: 'Zone', minLength: 3, maxLength: 20 },
    mode: { type: 'string', enum: ['fast', 'safe'], default: 'safe' },
    ttl: { type: 'integer', minimum: 60, maximum: 86400, default: 300 },
    ratio: { type: 'number', minimum: 0, maximum: 1 },
    dryRun: { type: 'boolean', default: false },
    credentials: { type: 'string', 'x-sw-secret': 'dns-oauth', title: 'Credentials' },
  },
  required: ['zone'],
  additionalProperties: false,
});

const ID = '018f0000-0000-7000-8000-000000000001';

describe('the settings schema of a plugin', () => {
  it('accepts fields of the four kinds, a closed list and a reference to a secret', () => {
    assert.deepEqual(Object.keys(SCHEMA.properties), [
      'zone',
      'mode',
      'ttl',
      'ratio',
      'dryRun',
      'credentials',
    ]);
    assert.deepEqual(secretFields(SCHEMA), [{ field: 'credentials', kind: 'dns-oauth' }]);
  });

  it('refuses what it does not know: an unknown keyword, type or key, a bad name, a pattern', () => {
    const bad = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ConfigSchemaFileSchema.safeParse({ type: 'object', properties, ...extra }).success;
    assert.equal(bad({ a: { type: 'string' } }), true);
    assert.equal(bad({ a: { type: 'array' } }), false);
    assert.equal(
      bad({ a: { type: 'string', format: 'email' } }),
      false,
      'a keyword that does nothing is an error',
    );
    assert.equal(
      bad({ a: { type: 'string', pattern: '(a+)+$' } }),
      false,
      'no patterns: they could hang the core',
    );
    assert.equal(bad({ 'bad name': { type: 'string' } }), false);
    assert.equal(bad({ Upper: { type: 'string' } }), false);
    assert.equal(bad({ a: { type: 'string' } }, { required: ['b'] }), false);
    assert.equal(bad({ a: { type: 'string' } }, { $schema: 'x' }), false);
    assert.equal(bad({ a: { type: 'string' } }, { additionalProperties: true }), false);
    assert.equal(bad({ a: { type: 'string', 'x-sw-secret': 'Bad Kind' } }), false);
    assert.equal(
      bad({ a: { type: 'string', 'x-sw-secret': 'dns-oauth', default: 'x' } }),
      false,
      'a secret has no default',
    );
    assert.equal(bad({ a: { type: 'string', 'x-sw-secret': 'dns-oauth', enum: ['x'] } }), false);
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`f${String(i)}`, { type: 'string' }]),
    );
    assert.equal(bad(many), false, 'at most 32 fields');
  });
});

describe('checking what an administrator entered', () => {
  const check = (input: Record<string, unknown>) => validateConfig(SCHEMA, input);

  it('applies defaults, keeps what is valid and leaves a secret field empty until one is chosen', () => {
    const { values, problems } = check({ zone: 'example.org' });
    assert.deepEqual(problems, []);
    assert.deepEqual(values, {
      zone: 'example.org',
      mode: 'safe',
      ttl: 300,
      dryRun: false,
      credentials: null,
    });
  });

  it('does not take what every object has for a setting', () => {
    // Names every object has are not settings of the schema...
    assert.deepEqual(
      check({ zone: 'example.org', constructor: 'x', toString: 'y' }).problems.map((p) => p.field),
      ['constructor', 'toString'],
    );
    // ...and a setting with such a name that was not entered is not filled from the prototype.
    const schema = ConfigSchemaFileSchema.parse({
      type: 'object',
      properties: { toString: { type: 'string' } },
    });
    assert.deepEqual(validateConfig(schema, {}), { values: {}, problems: [] });
  });

  it('asks for what is required and says what is wrong with each field', () => {
    assert.deepEqual(check({}).problems, [{ field: 'zone', message: 'is required' }]);
    assert.deepEqual(check({ zone: '' }).problems, [{ field: 'zone', message: 'is required' }]);
    const wrong = check({
      zone: 'ab',
      mode: 'turbo',
      ttl: 10,
      ratio: 2,
      dryRun: 'yes',
      credentials: 'not-an-id',
    });
    assert.deepEqual(Object.fromEntries(wrong.problems.map((p) => [p.field, p.message])), {
      zone: 'must be at least 3 characters',
      mode: 'must be one of: fast, safe',
      ttl: 'must be at least 60',
      ratio: 'must be at most 1',
      dryRun: 'must be true or false',
      credentials: 'must be the id of a secret',
    });
    assert.equal(
      check({ zone: 'x'.repeat(21) }).problems[0]?.message,
      'must be at most 20 characters',
    );
    assert.equal(
      check({ zone: 'example.org', ttl: 100.5 }).problems[0]?.message,
      'must be a whole number',
    );
    assert.equal(
      check({ zone: 'example.org', ttl: '100' }).problems[0]?.message,
      'must be a number',
    );
    assert.equal(check({ zone: 5 }).problems[0]?.message, 'must be text');
  });

  it('refuses a field the schema does not name, so a typo is an error', () => {
    assert.deepEqual(check({ zone: 'example.org', zoneName: 'x' }).problems, [
      { field: 'zoneName', message: 'is not a setting of this plugin' },
    ]);
  });

  it('takes the id of a secret, and null to clear it', () => {
    assert.equal(check({ zone: 'example.org', credentials: ID }).values['credentials'], ID);
    assert.equal(check({ zone: 'example.org', credentials: null }).values['credentials'], null);
  });
});
