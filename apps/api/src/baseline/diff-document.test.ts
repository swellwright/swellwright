import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { CheckStatus, ObservedValue } from '@swellwright/contracts';

import { loadBuiltinBaselines } from './builtin.js';
import { type ComparableResult, diffResults, trendOf } from './diff.js';
import {
  canonicalJson,
  documentHash,
  parseBaselineSource,
  validateBaselineSource,
} from './document.js';

const result = (
  checkId: string,
  status: CheckStatus,
  observed: ObservedValue = null,
): ComparableResult => ({
  checkId,
  title: checkId,
  category: 'system',
  severity: 'medium',
  status,
  observed,
  message: null,
});

describe('the drift between two runs', () => {
  it('is identical when nothing differs, and numbers that move while passing are not a change', () => {
    const from = [result('a', 'pass', 31), result('b', 'pass', 'no'), result('c', 'pass', ['x'])];
    const to = [result('a', 'pass', 32), result('b', 'pass', 'no'), result('c', 'pass', ['x'])];
    const drift = diffResults(from, to);
    assert.equal(drift.identical, true);
    assert.deepEqual(drift.counts, {
      regressed: 0,
      improved: 0,
      changed: 0,
      added: 0,
      removed: 0,
      unchanged: 3,
    });
  });

  it('finds a regression, an improvement, a change of value, an added and a removed check, worst first', () => {
    const from = [
      result('regress', 'pass'),
      result('improve', 'fail'),
      result('text', 'pass', 'a'),
      result('list', 'pass', ['tcp/22']),
      result('number', 'fail', 91),
      result('gone', 'pass'),
      result('same', 'warn', 5),
    ];
    const to = [
      result('regress', 'warn'),
      result('improve', 'pass'),
      result('text', 'pass', 'b'),
      result('list', 'pass', ['tcp/22', 'tcp/3306']),
      result('number', 'fail', 96),
      result('same', 'warn', 5),
      result('new', 'fail'),
    ];
    const drift = diffResults(from, to);
    assert.equal(drift.identical, false);
    assert.deepEqual(drift.counts, {
      regressed: 1,
      improved: 1,
      changed: 3,
      added: 1,
      removed: 1,
      unchanged: 1,
    });
    assert.deepEqual(
      drift.changes.map((change) => `${change.change}:${change.checkId}`),
      [
        'regressed:regress',
        'improved:improve',
        'changed:text',
        'changed:list',
        'changed:number',
        'added:new',
        'removed:gone',
      ],
    );
    assert.equal(drift.changes[0]?.from?.status, 'pass');
    assert.equal(drift.changes[0].to?.status, 'warn');
  });

  it('ranks an unobservable check between a warning and a failure, and a skipped check as good as a pass', () => {
    assert.equal(diffResults([result('a', 'pass')], [result('a', 'error')]).counts.regressed, 1);
    assert.equal(diffResults([result('a', 'warn')], [result('a', 'error')]).counts.regressed, 1);
    assert.equal(diffResults([result('a', 'fail')], [result('a', 'error')]).counts.improved, 1);
    assert.equal(diffResults([result('a', 'pass')], [result('a', 'skipped')]).counts.changed, 1);
  });

  it('gives a trend by failures first, then errors, then warnings', () => {
    const zero = { fail: 0, error: 0, warn: 0 };
    assert.equal(trendOf(zero, zero), 'same');
    assert.equal(trendOf({ ...zero, fail: 1 }, zero), 'worse');
    assert.equal(trendOf({ ...zero, warn: 9 }, { ...zero, fail: 1 }), 'better');
    assert.equal(trendOf({ ...zero, warn: 2 }, { ...zero, warn: 1 }), 'worse');
    assert.equal(trendOf({ ...zero, error: 1 }, { ...zero, warn: 5 }), 'worse');
  });
});

const GOOD = `
schema: 1
checks:
  - id: ssh.root-login
    title: Root cannot log in
    category: ssh
    severity: high
    observe: { kind: sshd.effective, field: permitrootlogin }
    expect: { equals: "no" }
`;

describe('reading a baseline from text', () => {
  it('reads YAML and JSON and hashes the canonical document, whatever the order of the keys', () => {
    const yaml = parseBaselineSource(GOOD);
    assert.ok(yaml.ok);
    const json = parseBaselineSource(
      JSON.stringify({
        checks: [
          {
            expect: { equals: 'no' },
            observe: { field: 'permitrootlogin', kind: 'sshd.effective' },
            severity: 'high',
            category: 'ssh',
            title: 'Root cannot log in',
            id: 'ssh.root-login',
          },
        ],
        schema: 1,
      }),
    );
    assert.ok(json.ok);
    assert.equal(yaml.parsed.sha256, json.parsed.sha256);
    assert.equal(yaml.parsed.sha256, documentHash(yaml.parsed.document));
    assert.equal(
      canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }),
      '{"a":[2,{"d":1}],"b":1}',
    );
  });

  it('says where a YAML error is, with a line and a column', () => {
    const result = parseBaselineSource('schema: 1\nchecks:\n  - id: a\n   title: bad indent\n');
    assert.ok(!result.ok);
    assert.ok(result.issues.length > 0);
    assert.ok((result.issues[0]?.line ?? 0) >= 3);
  });

  it('says where a schema problem is, by path and by line', () => {
    const result = parseBaselineSource(GOOD.replace('field: permitrootlogin', 'field: nope'));
    assert.ok(!result.ok);
    const issue = result.issues.find((entry) => entry.path === 'checks[0].observe.field');
    assert.ok(issue);
    assert.match(issue.message, /no field "nope"/u);
    assert.equal(issue.line, 8);
  });

  it('refuses aliases, duplicate keys and a document that is not a mapping', () => {
    assert.ok(!parseBaselineSource('schema: 1\nx: &a [1]\nchecks: *a\n').ok);
    assert.ok(!parseBaselineSource('schema: 1\nschema: 1\nchecks: []\n').ok);
    assert.ok(!parseBaselineSource('- 1\n- 2\n').ok);
    assert.ok(!parseBaselineSource('').ok);
    assert.ok(!parseBaselineSource('{"schema": 1, "checks": [').ok);
  });

  it('answers a validation with the counts per category', () => {
    const verdict = validateBaselineSource(GOOD);
    assert.equal(verdict.valid, true);
    assert.equal(verdict.checkCount, 1);
    assert.deepEqual(verdict.categories, [{ category: 'ssh', checks: 1 }]);
    assert.match(verdict.sha256 ?? '', /^[0-9a-f]{64}$/u);
    const bad = validateBaselineSource('schema: 1\nchecks: []\n');
    assert.equal(bad.valid, false);
    assert.equal(bad.sha256, null);
  });
});

describe('the built-in baselines', () => {
  const builtin = loadBuiltinBaselines();

  it('requires an active, enabled node startup unit instead of Docker autonomous restart', () => {
    const checks = builtin.find((entry) => entry.name === 'node-selfsteal')?.parsed.document.checks;
    const check = (id: string) => checks?.find((entry) => entry.id === `node.${id}`);
    assert.deepEqual(check('container-restart-policy')?.expect, { equals: 'no' });
    for (const [field, value] of [
      ['active', 'active'],
      ['enabled', 'enabled'],
    ] as const) {
      assert.deepEqual(check(`startup-${field}`)?.observe, {
        kind: 'service.state',
        params: { unit: 'sw-node.service' },
        field,
      });
      assert.deepEqual(check(`startup-${field}`)?.expect, { equals: value });
    }
  });

  it('are the generic one and the node one, valid, with the ids and titles of a reader', () => {
    assert.deepEqual(
      builtin.map((entry) => entry.name),
      ['linux-generic', 'node-selfsteal'],
    );
    for (const entry of builtin) {
      const ids = entry.parsed.document.checks.map((check) => check.id);
      assert.equal(new Set(ids).size, ids.length, entry.name);
      for (const check of entry.parsed.document.checks) {
        assert.ok(check.title.length > 10, `${entry.name}/${check.id} has a title`);
        assert.ok(
          check.remediationHint !== undefined && check.remediationHint.length > 10,
          `${entry.name}/${check.id} has a hint`,
        );
      }
    }
  });

  it('keep the node baseline a superset of the generic one, check for check', () => {
    const generic = builtin.find((entry) => entry.name === 'linux-generic');
    const node = builtin.find((entry) => entry.name === 'node-selfsteal');
    assert.ok(generic && node);
    const nodeById = new Map(node.parsed.document.checks.map((check) => [check.id, check]));
    for (const check of generic.parsed.document.checks) {
      assert.deepEqual(nodeById.get(check.id), check, check.id);
    }
    assert.ok(node.parsed.document.checks.length > generic.parsed.document.checks.length + 20);
  });

  it('use only kinds of the catalogue and only fields that exist (the schema checks it too)', () => {
    for (const entry of builtin) {
      assert.ok(validateBaselineSource(entry.source).valid, entry.name);
    }
  });
});

describe('the example baselines', () => {
  it('are valid, and hold no address or name of an installation', () => {
    const text = readFileSync(
      new URL('../../../../examples/baselines/fleet-node.example.yaml', import.meta.url),
      'utf8',
    );
    const verdict = validateBaselineSource(text);
    assert.deepEqual(verdict.issues, []);
    assert.equal(verdict.valid, true);
    assert.ok(verdict.checkCount >= 10);
    for (const address of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu) ?? []) {
      assert.ok(address.startsWith('192.0.2.') || address === '1.1.1.1', address);
    }
  });
});

describe('the repository holds no instance data in what ships', () => {
  const dir = new URL('./', import.meta.url);
  const files = [
    ...readdirSync(new URL('./builtin/', import.meta.url)).map((name) => `builtin/${name}`),
    'observe.sh',
    'fixtures.js',
  ];

  it('has no address outside the documentation ranges and no domain but the reserved ones', () => {
    for (const file of files) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      for (const address of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu) ?? []) {
        const allowed =
          address.startsWith('192.0.2.') ||
          address.startsWith('198.51.100.') ||
          address.startsWith('203.0.113.') ||
          address.startsWith('127.') ||
          address === '0.0.0.0' ||
          address === '1.1.1.1';
        assert.ok(allowed, `${file} has the address ${address}`);
      }
      for (const domain of text.match(
        /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ru|de|nl|dev)\b/gu,
      ) ?? []) {
        const ok =
          /(?:^|\.)example\.(?:com|org|net)$/u.test(domain) ||
          // vendor names that appear in prose
          domain === 'nginx.org' ||
          domain === 'download.docker.com';
        assert.ok(ok, `${file} has the domain ${domain}`);
      }
    }
  });
});
