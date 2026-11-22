import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASELINE_CATEGORIES,
  BaselineDocumentSchema,
  COMPARATORS,
  durationSeconds,
  ExpectationSchema,
  observationCatalogue,
  observationKind,
  OBSERVATION_KINDS,
  observationParamIssues,
  regexIssue,
  withParamDefaults,
} from './baselines.js';

const check = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ssh.root-login',
  title: 'Root cannot log in',
  category: 'ssh',
  severity: 'medium',
  observe: { kind: 'sshd.effective', field: 'permitrootlogin' },
  expect: { equals: 'no' },
  ...overrides,
});

const document = (...checks: Record<string, unknown>[]): unknown => ({ schema: 1, checks });

const issuesOf = (value: unknown): string[] => {
  const result = BaselineDocumentSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('the catalogue of observations', () => {
  it('names every kind once, in lower case with a dot', () => {
    const names = OBSERVATION_KINDS.map((def) => def.kind);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
      assert.match(name, /^[a-z0-9]+(?:\.[a-z0-9]+)?$/u, name);
    }
  });

  it('gives every kind fields with unique names, and a boolean presence field that exists', () => {
    for (const def of OBSERVATION_KINDS) {
      assert.ok(def.fields.length > 0, `${def.kind} has fields`);
      const fields = def.fields.map((field) => field.name);
      assert.equal(new Set(fields).size, fields.length, `${def.kind} fields are unique`);
      for (const field of def.fields) {
        assert.ok(field.description.length > 3, `${def.kind}.${field.name} is described`);
      }
      if (def.presence !== undefined) {
        assert.equal(
          def.fields.find((field) => field.name === def.presence)?.type,
          'boolean',
          `${def.kind} presence field`,
        );
      }
    }
  });

  it('describes every parameter with a pattern that compiles and a default that matches it', () => {
    for (const def of OBSERVATION_KINDS) {
      for (const param of def.params) {
        assert.ok(param.description.length > 5, `${def.kind}.${param.name} is described`);
        if (param.type === 'string') {
          const pattern = new RegExp(param.pattern, 'u');
          if (param.default !== undefined) {
            assert.ok(pattern.test(param.default), `${def.kind}.${param.name} default`);
          }
        }
        if (param.type === 'enum' && param.default !== undefined) {
          assert.ok(param.options.includes(param.default));
        }
      }
      // A kind that every parameter has a default for can be asked for with none.
      const defaults = withParamDefaults(def, {});
      const missing = def.params.filter((param) => param.required);
      assert.deepEqual(
        observationParamIssues(def, defaults).length > 0,
        missing.length > 0,
        def.kind,
      );
    }
  });

  it('is the same list the API sends', () => {
    const catalogue = observationCatalogue();
    assert.equal(catalogue.kinds.length, OBSERVATION_KINDS.length);
    assert.deepEqual(catalogue.categories, [...BASELINE_CATEGORIES]);
    assert.equal(catalogue.comparators.length, COMPARATORS.length);
  });

  it('refuses parameters that could carry shell syntax, path tricks or free text', () => {
    const path = observationKind('file.stat');
    assert.ok(path);
    const bad = [
      '/etc/passwd; rm -rf /',
      '/etc/$(id)',
      '/etc/`id`',
      '/etc/a b',
      "/etc/a'b",
      '/etc/a"b',
      '/etc/../shadow',
      'relative/path',
      '/etc/a\nb',
      '/etc/*',
      '/etc/a|b',
      `/${'a'.repeat(300)}`,
      '-rf',
      '',
    ];
    for (const value of bad) {
      assert.ok(observationParamIssues(path, { path: value }).length > 0, JSON.stringify(value));
    }
    assert.equal(observationParamIssues(path, { path: '/opt/certs/fullchain.cer' }).length, 0);
    const port = observationKind('port.listener');
    assert.ok(port);
    for (const value of [0, 65_536, 1.5, '443', -1, Number.NaN]) {
      assert.ok(observationParamIssues(port, { port: value as number }).length > 0, String(value));
    }
    const sysctl = observationKind('sysctl.value');
    assert.ok(sysctl);
    for (const value of [
      'net.ipv4.tcp_congestion_control; id',
      'net/ipv4/x',
      '..',
      'a',
      'Net.Ipv4.x',
    ]) {
      assert.ok(observationParamIssues(sysctl, { key: value }).length > 0, value);
    }
    const unit = observationKind('service.state');
    assert.ok(unit);
    for (const value of ['docker', 'docker.service; id', '-docker.service', 'a b.service']) {
      assert.ok(observationParamIssues(unit, { unit: value }).length > 0, value);
    }
    // Unknown parameters and missing required ones are said.
    assert.ok(observationParamIssues(path, {}).length > 0);
    assert.ok(observationParamIssues(path, { path: '/x', extra: 'y' }).length > 0);
  });
});

describe('the comparators', () => {
  it('takes exactly one per expectation', () => {
    assert.ok(ExpectationSchema.safeParse({ equals: 'no' }).success);
    assert.ok(!ExpectationSchema.safeParse({}).success);
    assert.ok(!ExpectationSchema.safeParse({ equals: 'no', atLeast: 1 }).success);
    assert.ok(!ExpectationSchema.safeParse({ unknownComparator: 1 }).success);
    assert.ok(!ExpectationSchema.safeParse({ absent: false }).success);
  });

  it('reads durations and refuses a pattern that could run away', () => {
    assert.equal(durationSeconds('30m'), 1800);
    assert.equal(durationSeconds('7d'), 604_800);
    assert.equal(durationSeconds('0d'), undefined);
    assert.equal(durationSeconds('7'), undefined);
    assert.equal(durationSeconds('1w'), undefined);
    assert.equal(regexIssue('^[1-6]$'), undefined);
    assert.ok(regexIssue('(') !== undefined);
    assert.ok(regexIssue('(a+)+$') !== undefined);
    assert.ok(regexIssue('(.*)*x') !== undefined);
    assert.ok(regexIssue('(a)\\1') !== undefined);
    assert.ok(regexIssue('a'.repeat(201)) !== undefined);
  });
});

describe('a baseline document', () => {
  it('accepts a correct check', () => {
    assert.deepEqual(issuesOf(document(check())), []);
  });

  it('refuses unknown keys, a wrong schema number and an empty list', () => {
    assert.ok(issuesOf({ schema: 2, checks: [check()] }).length > 0);
    assert.ok(issuesOf({ schema: 1, checks: [] }).length > 0);
    assert.ok(issuesOf({ schema: 1, checks: [check()], extra: 1 }).length > 0);
    assert.ok(issuesOf(document(check({ surprise: true }))).length > 0);
  });

  it('refuses a repeated id and says where the first one is', () => {
    const messages = issuesOf(document(check(), check({ title: 'Again' })));
    assert.ok(messages.some((message) => message.includes('check 1')));
  });

  it('refuses an unknown kind, an unknown field and a parameter the kind does not take', () => {
    assert.ok(
      issuesOf(document(check({ observe: { kind: 'bash.run', field: 'x' } }))).some((message) =>
        message.includes('not an observation kind'),
      ),
    );
    assert.ok(
      issuesOf(document(check({ observe: { kind: 'sshd.effective', field: 'nope' } }))).some(
        (message) => message.includes('has no field'),
      ),
    );
    assert.ok(
      issuesOf(
        document(
          check({
            observe: { kind: 'sshd.effective', field: 'permitrootlogin', params: { x: 1 } },
          }),
        ),
      ).some((message) => message.includes('takes no parameters')),
    );
    assert.ok(
      issuesOf(
        document(
          check({
            observe: {
              kind: 'file.stat',
              params: { path: '/etc/shadow; id' },
              field: 'mode',
            },
          }),
        ),
      ).length > 0,
    );
  });

  it('matches every comparator with the type of the field it is applied to', () => {
    const on = (kind: string, field: string, expect: unknown, params?: unknown): string[] =>
      issuesOf(
        document(check({ observe: { kind, field, ...(params ? { params } : {}) }, expect })),
      );
    // text
    assert.deepEqual(on('sshd.effective', 'maxauthtries', { matches: '^[1-6]$' }), []);
    assert.ok(on('sshd.effective', 'maxauthtries', { atLeast: 3 }).length > 0);
    assert.ok(on('sshd.effective', 'maxauthtries', { equals: 3 }).length > 0);
    assert.deepEqual(on('os.release', 'versionId', { versionAtLeast: '22.04' }), []);
    assert.ok(on('os.release', 'versionId', { versionAtLeast: 'new' }).length > 0);
    // numbers
    assert.deepEqual(on('memory', 'availablePercent', { atLeast: 10 }), []);
    assert.ok(on('memory', 'availablePercent', { matches: '1' }).length > 0);
    assert.deepEqual(on('updates.pending', 'listAgeSeconds', { ageLessThan: '7d' }), []);
    assert.ok(on('updates.pending', 'listAgeSeconds', { ageLessThan: '7' }).length > 0);
    assert.ok(on('os.release', 'id', { ageLessThan: '7d' }).length > 0);
    // booleans
    assert.deepEqual(on('kernel', 'rebootRequired', { equals: false }), []);
    assert.ok(on('kernel', 'rebootRequired', { equals: 'no' }).length > 0);
    assert.ok(on('kernel', 'rebootRequired', { contains: 'x' }).length > 0);
    // lists
    assert.deepEqual(on('ports.public', 'ports', { contains: 'tcp/443' }), []);
    assert.deepEqual(on('ports.public', 'ports', { in: ['tcp/22', 'tcp/443'] }), []);
    assert.ok(on('ports.public', 'ports', { in: [22] }).length > 0);
    assert.ok(on('ports.public', 'ports', { equals: 'tcp/22' }).length > 0);
    assert.ok(on('ports.public', 'ports', { matches: 'tcp' }).length > 0);
    assert.deepEqual(on('ports.public', 'ports', { absent: true }), []);
    // a pattern that could run away is refused
    assert.ok(on('sshd.effective', 'allowusers', { matches: '(a+)+$' }).length > 0);
  });

  it('is bounded in size', () => {
    const many = Array.from({ length: 301 }, (_, index) =>
      check({ id: `check.n${String(index)}` }),
    );
    assert.ok(issuesOf(document(...many)).length > 0);
  });
});
