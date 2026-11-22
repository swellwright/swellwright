import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONVENTION_PACK_FORMAT, CONVENTION_PACK_LIMITS } from '@swellwright/contracts';

import { RULES } from './catalogue.js';
import { describeRules, lint } from './lint.js';
import {
  builtInDocument,
  builtInPack,
  checkPack,
  checkPackValue,
  formatPath,
  loadPack,
  packHash,
  parsePackText,
  renderPackYaml,
  resolvePack,
} from './pack.js';
import { at, healthyFleet, host, must } from './test-model.js';

const minimal = { format: CONVENTION_PACK_FORMAT, name: 'p' };

describe('the built-in pack', () => {
  it('lists every rule, switched on, and is itself a valid pack', () => {
    const document = builtInDocument();
    assert.equal(Object.keys(document.rules ?? {}).length, RULES.length);
    const checked = checkPackValue(document);
    assert.equal(checked.result.valid, true, JSON.stringify(checked.result.issues));
    assert.equal(checked.result.hash, packHash(document));
  });

  it('names nothing that belongs to an installation: no domain, no address, no marker, no pattern', () => {
    const text = JSON.stringify(builtInDocument());
    assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+/u);
    assert.doesNotMatch(text, /🎯|🌐|🧪|🇳/u);
    for (const rule of RULES) {
      for (const name of rule.patternParams) {
        assert.equal(
          builtInDocument().rules?.[rule.id]?.params?.[name],
          undefined,
          `${rule.id}.${name} must have no default pattern`,
        );
      }
    }
  });

  it('renders as YAML with a comment for every rule, and reads back as the same pack', () => {
    const text = renderPackYaml(builtInDocument());
    assert.match(text, /# Host address policy \(default severity: warning\)/u);
    assert.equal(text.match(/^ {2}# /gmu)?.length, RULES.length);
    const back = checkPack({ yaml: text });
    assert.equal(back.result.valid, true, JSON.stringify(back.result.issues));
    assert.equal(back.result.hash, packHash(builtInDocument()));
  });

  it('is the one that runs when none is saved, and is resolved only once', () => {
    assert.equal(builtInPack(), builtInPack());
    assert.equal(builtInPack().ref.source, 'built-in');
    assert.equal(builtInPack().ref.version, null);
    const catalog = describeRules(builtInPack());
    assert.equal(catalog.rules.length, RULES.length);
    assert.ok(catalog.rules.every((rule) => rule.title !== '' && rule.description !== ''));
    // Rules that need a pattern say so.
    const inactive = catalog.rules
      .filter((rule) => rule.effective.inactive === 'needs_params')
      .map((rule) => rule.id)
      .sort();
    assert.deepEqual(inactive, [
      'host.remark-pattern',
      'node.name-pattern',
      'profile.name-pattern',
      'squad.name-pattern',
      'template.name-pattern',
    ]);
  });

  it('describes the parameters of every rule with their defaults', () => {
    const catalog = describeRules(builtInPack());
    const route = catalog.rules.find((rule) => rule.id === 'host.vless-route-id');
    assert.deepEqual(
      route?.params.map((p) => [p.name, p.type]),
      [
        ['reserved', 'ranges'],
        ['max', 'number'],
        ['warnOnDuplicates', 'boolean'],
      ],
    );
    const policy = catalog.rules.find((rule) => rule.id === 'host.address-policy')?.params[0];
    assert.deepEqual(policy, {
      name: 'policy',
      type: 'enum',
      description: policy?.description,
      default: 'any',
      values: ['ip', 'domain', 'any'],
    });
    const remark = catalog.rules.find((rule) => rule.id === 'host.remark-pattern')?.params[0];
    assert.equal(remark?.type, 'pattern');
    assert.equal(must(remark).default, null);
    assert.ok(catalog.rules.every((rule) => rule.params.every((p) => p.description.length > 0)));
  });
});

describe('reading a pack from text', () => {
  it('reads YAML and JSON, with comments', () => {
    const yaml =
      '# my conventions\nformat: swellwright.conventions/v1\nname: Mine # trailing\nrules:\n  host.state:\n    enabled: false\n';
    const json = JSON.stringify({ ...minimal, rules: { 'host.state': { enabled: false } } });
    for (const text of [yaml, json]) {
      const checked = checkPack({ yaml: text });
      assert.equal(checked.result.valid, true, JSON.stringify(checked.result.issues));
      assert.equal(checked.document?.rules?.['host.state']?.enabled, false);
    }
  });

  it('says where a YAML syntax error is', () => {
    const read = parsePackText('format: x\nname: [unclosed\nrules: {}\n');
    assert.equal(read.value, undefined);
    assert.equal(at(read.issues, 0).severity, 'error');
    assert.ok((at(read.issues, 0).line ?? 0) >= 1);
    assert.ok((at(read.issues, 0).column ?? 0) >= 1);
  });

  it('refuses an empty text, text that is not an object, and a second document', () => {
    assert.equal(checkPack({ yaml: '' }).result.valid, false);
    assert.equal(checkPack({ yaml: '   \n' }).result.valid, false);
    for (const text of ['- a\n- b\n', '42', '"text"', 'null']) {
      assert.equal(checkPack({ yaml: text }).result.valid, false, text);
    }
    assert.equal(
      checkPack({ yaml: `${JSON.stringify(minimal)}\n---\n${JSON.stringify(minimal)}\n` }).result
        .valid,
      false,
    );
  });

  it('refuses duplicate keys, aliases, and a text that is too long', () => {
    assert.equal(
      checkPack({ yaml: 'format: swellwright.conventions/v1\nname: a\nname: b\n' }).result.valid,
      false,
    );
    const bomb =
      'format: swellwright.conventions/v1\nname: p\ndescription: &a lol\nrules:\n  x: *a\n';
    assert.equal(checkPack({ yaml: bomb }).result.valid, false);
    const huge = `${JSON.stringify(minimal)}\n# ${'x'.repeat(CONVENTION_PACK_LIMITS.textChars)}`;
    const checked = checkPack({ yaml: huge });
    assert.equal(checked.result.valid, false);
    assert.match(at(checked.result.issues, 0).message, /longer than/u);
  });

  it('refuses a document nested too deeply, and one with too many values', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`;
    assert.equal(
      checkPack({
        yaml: `format: swellwright.conventions/v1\nname: p\nrules:\n  x:\n    params:\n      a: ${deep}\n`,
      }).result.valid,
      false,
    );
    const wide = `{"format":"${CONVENTION_PACK_FORMAT}","name":"p","rules":{"host.state":{"params":{"report":[${Array.from({ length: 60_000 }, () => '1').join(',')}]}}}}`;
    const checked = checkPack({
      yaml: wide.length <= CONVENTION_PACK_LIMITS.textChars ? wide : minimalWide(),
    });
    assert.equal(checked.result.valid, false);
  });
});

/** Fewer characters, same many values: a flow sequence of single digits is two characters per value. */
function minimalWide(): string {
  return `{"format":"${CONVENTION_PACK_FORMAT}","name":"p","rules":{"host.state":{"params":{"report":[${Array.from({ length: 100_000 }, () => '1').join(',')}]}}}}`;
}

describe('checking the shape', () => {
  const issuesOf = (value: unknown): string[] =>
    checkPackValue(value).result.issues.map((issue) => `${issue.severity}:${issue.path}`);

  it('wants the format marker and a name', () => {
    assert.ok(issuesOf({ name: 'p' }).some((i) => i.includes('format')));
    assert.ok(issuesOf({ format: 'other/v9', name: 'p' }).some((i) => i.includes('format')));
    assert.ok(issuesOf({ format: CONVENTION_PACK_FORMAT }).some((i) => i.includes('name')));
    assert.ok(
      issuesOf({ format: CONVENTION_PACK_FORMAT, name: '   ' }).some((i) => i.includes('name')),
    );
    assert.ok(
      issuesOf({ format: CONVENTION_PACK_FORMAT, name: 'x'.repeat(101) }).some((i) =>
        i.includes('name'),
      ),
    );
  });

  it('refuses unknown keys everywhere, so a typo is not a setting', () => {
    assert.ok(issuesOf({ ...minimal, rulez: {} }).length > 0);
    assert.ok(issuesOf({ ...minimal, rules: { 'host.state': { severty: 'info' } } }).length > 0);
    assert.ok(issuesOf({ ...minimal, scope: { tag: ['x'] } }).length > 0);
    assert.ok(issuesOf({ ...minimal, reconciliation: { hostAdress: 'node' } }).length > 0);
    assert.ok(issuesOf({ ...minimal, impact: { highRisk: 1 } }).length > 0);
  });

  it('refuses wrong types and values', () => {
    for (const bad of [
      { ...minimal, rules: { 'host.state': { enabled: 'yes' } } },
      { ...minimal, rules: { 'host.state': { severity: 'fatal' } } },
      { ...minimal, rules: 'all' },
      { ...minimal, reconciliation: { hostAddress: 'both' } },
      { ...minimal, reconciliation: { dns: { maxTtlSeconds: -1 } } },
      { ...minimal, reconciliation: { inventory: { matchBy: [] } } },
      { ...minimal, reconciliation: { checks: { 'host.nothing': { enabled: false } } } },
      { ...minimal, impact: { highRiskRestartShare: 2 } },
      { ...minimal, impact: { highRiskRestartNodes: 0 } },
      { ...minimal, scope: { tags: Array.from({ length: 51 }, (_u, i) => `t${String(i)}`) } },
      { ...minimal, scope: { match: 'x'.repeat(257) } },
    ]) {
      assert.equal(checkPackValue(bad).result.valid, false, JSON.stringify(bad).slice(0, 80));
    }
  });

  it('refuses more rules than the limit', () => {
    const rules = Object.fromEntries(
      Array.from({ length: CONVENTION_PACK_LIMITS.rules + 1 }, (_u, i) => [`x.r${String(i)}`, {}]),
    );
    assert.equal(checkPackValue({ ...minimal, rules }).result.valid, false);
  });

  it('writes the path of a problem the way a person would look for it', () => {
    assert.equal(
      formatPath(['rules', 'host.remark-pattern', 'params', 'pattern']),
      'rules["host.remark-pattern"].params.pattern',
    );
    assert.equal(formatPath(['a', 0, 'b']), 'a[0].b');
    assert.equal(formatPath([]), '(document)');
    const issues = checkPackValue({ ...minimal, rules: { 'host.state': { severity: 'fatal' } } })
      .result.issues;
    assert.equal(at(issues, 0).path, 'rules["host.state"].severity');
  });
});

describe('checking rules and parameters', () => {
  it('warns about a rule id it does not know and still accepts the pack', () => {
    const checked = checkPackValue({
      ...minimal,
      rules: { 'host.from-the-future': { enabled: true } },
    });
    assert.equal(checked.result.valid, true);
    assert.equal(at(checked.result.issues, 0).severity, 'warning');
    assert.equal(checked.result.rules, 1);
    // The unknown rule changes nothing that runs.
    assert.equal(resolvePack(must(checked.document), 'custom', 1).rules.size, RULES.length);
  });

  it('reports every bad parameter, with its path, not only the first', () => {
    const checked = checkPackValue({
      ...minimal,
      rules: {
        'host.address-policy': { params: { policy: 'cname', extra: 1 } },
        'host.remark-unique': { params: { caseSensitive: 'no' } },
        'node.version-skew': { params: { sameLineAsPanel: 1 } },
      },
    });
    assert.equal(checked.result.valid, false);
    const paths = checked.result.issues.map((i) => i.path);
    assert.ok(paths.some((p) => p.includes('host.address-policy') && p.endsWith('params.policy')));
    assert.ok(paths.some((p) => p.includes('host.remark-unique')));
    assert.ok(paths.some((p) => p.includes('node.version-skew')));
    assert.equal(checked.result.hash, null);
  });

  it('refuses a pattern outside the safe subset, in a parameter and in every scope, naming it', () => {
    const checked = checkPackValue({
      ...minimal,
      scope: { match: '(?=x)x' },
      rules: {
        'host.remark-pattern': { params: { pattern: '(a)\\1' } },
        'host.state': { scope: { exclude: '\\bword' } },
      },
      reconciliation: { scope: { match: '[' } },
    });
    assert.equal(checked.result.valid, false);
    const paths = checked.result.issues.map((issue) => issue.path);
    assert.ok(paths.includes('scope.match'));
    assert.ok(paths.includes('rules["host.remark-pattern"].params.pattern'));
    assert.ok(paths.includes('rules["host.state"].scope.exclude'));
    assert.ok(paths.includes('reconciliation.scope.match'));
  });

  it('accepts the patterns that stop other engines, since they run in linear time here', () => {
    const checked = checkPackValue({
      ...minimal,
      rules: { 'host.remark-pattern': { params: { pattern: '(a+)+$' } } },
    });
    assert.equal(checked.result.valid, true);
    const started = performance.now();
    const model = { ...healthyFleet(), hosts: [host(1, `${'a'.repeat(500)}!`, null)] };
    const result = lint(model, resolvePack(must(checked.document), 'custom', 1));
    assert.ok(result.findings.some((f) => f.ruleId === 'host.remark-pattern'));
    assert.ok(performance.now() - started < 1000);
  });

  it('does not let a key called __proto__ reach any prototype', () => {
    const before = Object.keys(Object.prototype).length;
    const checked = checkPack({
      yaml: `format: ${CONVENTION_PACK_FORMAT}\nname: p\nrules:\n  "__proto__":\n    enabled: false\n  host.state:\n    params:\n      "__proto__": {polluted: true}\n`,
    });
    assert.equal(Object.keys(Object.prototype).length, before);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    // Whether the key is refused or dropped, it is not a setting, and nothing leaked.
    if (checked.document !== null) {
      const pack = resolvePack(checked.document, 'custom', 1);
      assert.deepEqual(pack.rules.get('host.state')?.params, { report: ['disabled', 'hidden'] });
    }
  });
});

describe('resolving a pack', () => {
  it('fills the defaults, marks a rule that is off or has nothing to check, and takes the scope of a rule as its own', () => {
    const checked = checkPackValue({
      ...minimal,
      scope: { excludeTags: ['TEST'] },
      rules: {
        'host.state': { enabled: false },
        'host.remark-pattern': { severity: 'error', scope: { tags: ['A'] }, note: 'because' },
        'node.version-skew': { scope: {} },
      },
    });
    const pack = resolvePack(must(checked.document), 'custom', 3);
    assert.equal(pack.ref.version, 3);
    assert.equal(pack.ref.source, 'custom');
    assert.equal(pack.rules.get('host.state')?.inactive, 'disabled');
    assert.equal(pack.rules.get('host.remark-pattern')?.inactive, 'needs_params');
    assert.equal(pack.rules.get('host.remark-pattern')?.severity, 'error');
    assert.equal(pack.rules.get('host.remark-pattern')?.note, 'because');
    assert.equal(pack.rules.get('host.remark-pattern')?.scope?.source.tags?.[0], 'A');
    assert.equal(
      pack.rules.get('node.version-skew')?.scope,
      null,
      'an empty scope means every object',
    );
    assert.equal(
      pack.rules.get('host.address-policy')?.scope,
      undefined,
      'no scope of its own: the pack scope applies',
    );
    assert.deepEqual(pack.rules.get('host.address-policy')?.params, { policy: 'any' });
  });

  it('gives the same hash to the same pack however it was written', () => {
    const a = checkPack({
      yaml: `format: ${CONVENTION_PACK_FORMAT}\nname: p\nrules:\n  host.state:\n    enabled: false\n    severity: info\n`,
    });
    const b = checkPack({
      yaml: `{"rules":{"host.state":{"severity":"info","enabled":false}},"name":"p","format":"${CONVENTION_PACK_FORMAT}"}`,
    });
    assert.equal(a.result.hash, b.result.hash);
    assert.match(a.result.hash ?? '', /^[0-9a-f]{64}$/u);
    const c = checkPack({
      yaml: `format: ${CONVENTION_PACK_FORMAT}\nname: p\nrules:\n  host.state:\n    enabled: false\n`,
    });
    assert.notEqual(a.result.hash, c.result.hash);
  });

  it('applies reconciliation and impact settings, with the defaults for what is not set', () => {
    const checked = checkPackValue({
      ...minimal,
      reconciliation: {
        hostAddress: 'node-ip',
        dns: { enabled: false },
        inventory: { reportExtra: false },
        checks: { 'host.port': { enabled: false } },
        scope: { excludeTags: ['T'] },
      },
      impact: { highRiskRestartNodes: 9 },
    });
    const pack = resolvePack(must(checked.document), 'custom', 1);
    assert.equal(pack.reconciliation.hostAddress, 'node-ip');
    assert.equal(pack.reconciliation.hostSni, 'none');
    assert.equal(pack.reconciliation.dnsEnabled, false);
    assert.equal(pack.reconciliation.maxTtlSeconds, 3600);
    assert.equal(pack.reconciliation.reportExtra, false);
    assert.equal(pack.reconciliation.reportUnmanaged, true);
    assert.ok(pack.reconciliation.disabledChecks.has('host.port'));
    assert.notEqual(pack.reconciliation.scope, null);
    assert.equal(pack.impact.highRiskRestartNodes, 9);
    assert.equal(pack.impact.highRiskRestartShare, 0.5);
  });

  it('loads a stored document, and refuses one that no longer passes the check', () => {
    assert.equal(loadPack({ ...minimal }, 4)?.ref.version, 4);
    assert.equal(loadPack({ ...minimal, rules: { 'host.state': { severity: 'fatal' } } }, 4), null);
    assert.equal(loadPack('garbage', 4), null);
    assert.equal(loadPack(null, 4), null);
  });
});
