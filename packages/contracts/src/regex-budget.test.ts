import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkParameterValues,
  parameterDefinitionIssues,
  parameterWriteIssues,
  ScriptParametersSchema,
  parameterPatternIssue,
  type ScriptParameter,
} from './commands.js';
import { REGEX_INPUT_LIMIT, regexBudgetIssue } from './regex-budget.js';

// Patterns that could run away are built from parts, so that no analyser takes them for patterns this test runs.
const join = (...parts: string[]): string => parts.join('');

describe('the bound on a regular expression', () => {
  it('rejects an unfinished regex construct without scanning it again', (t) => {
    const unfinished = ['(?<', String.raw`\p{`, String.raw`\k<`];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- preserves the receiver via call()
    const indexOf = String.prototype.indexOf;
    let scans = 0;
    t.mock.method(
      String.prototype,
      'indexOf',
      function (this: string, needle: string, from?: number): number {
        if (unfinished.includes(this)) {
          scans += 1;
          assert.ok(scans <= 3, 'the reader reset its position and scanned again');
        }
        return indexOf.call(this, needle, from);
      },
    );
    for (const pattern of unfinished) assert.ok(regexBudgetIssue(pattern) !== undefined);
  });

  it('refuses lookbehind', () => {
    assert.match(regexBudgetIssue('(?<=prefix)suffix') ?? '', /lookbehind/iu);
  });
  it('refuses a repetition of a part that has choices of its own', () => {
    for (const source of [
      join('(a|', 'a)*b'),
      join('(a+', ')+$'),
      join('(a?', ')*b'),
      join('(?:x', '|xy)+z'),
      join('^/(?:[a-z]+', '/?)*$'),
    ]) {
      assert.match(regexBudgetIssue(source) ?? '', /repeats a part/u, source);
    }
  });

  it('refuses a huge count at once, without counting up to it', () => {
    for (const source of [
      'a{99999999999999999999}',
      'a{1000000000000}',
      'a{1,1000000000000}',
      'a{1000000000000,}',
      join('(?:ab)', '{5000}'),
    ]) {
      const started = performance.now();
      const issue = regexBudgetIssue(source);
      assert.ok(performance.now() - started < 50, `${source} took too long to estimate`);
      assert.match(issue ?? '', /count in braces/u, source);
    }
    // A fixed count within the limit is estimated without a loop over it, and stays fine.
    assert.equal(regexBudgetIssue('^a{1000}$'), undefined);
    assert.match(regexBudgetIssue(join('(?:a|ab)', '{999}c')) ?? '', /too long/u);
  });

  it('reads a surrogate pair as one character, escaped or not, so a repeated pair is still a repetition', () => {
    for (const source of [
      join('^(\\uD83D\\uDE00', '+)+$'),
      join('^(\\uD83D\\uDE00', '{1,50}){1,50}$'),
      join('^(\u{1F600}', '+)+$'),
      join('^(\u{1F600}', '{1,50}){1,50}$'),
      join('^(\\u{1F600}', '+)+$'),
      join('^([\\uD83D\\uDE00]', '+)+$'),
    ]) {
      assert.match(regexBudgetIssue(source) ?? '', /repeats a part/u, source);
    }
    // A pair repeated alone is an ordinary repetition.
    assert.equal(regexBudgetIssue('^\\uD83D\\uDE00+$'), undefined);
  });

  it('treats a property, its negation and a class it cannot model as any character, never as none', () => {
    // `^([^\p{L}]+)+$` on 30 digits and a letter takes seconds in the engine: the negation of an approximated set must
    // not become the empty set, which would look unambiguous. The slow patterns are never run here.
    for (const source of [
      join('^([^\\p{L}]', '+)+$'),
      join('^([\\P{L}]', '+)+$'),
      join('^(\\p{L}', '+)+$'),
      join('^([^\\P{L}]', '+)+$'),
      join('^((?i:[^a])', '+)+$'),
    ]) {
      const started = performance.now();
      const issue = regexBudgetIssue(source);
      assert.ok(performance.now() - started < 50, `${source} took too long to estimate`);
      assert.match(issue ?? '', /repeats a part/u, source);
    }
    // A class that matches nothing is refused outright.
    for (const source of [join('^([^\\d\\D]', '+)+$'), '[^\\s\\S]']) {
      assert.match(regexBudgetIssue(source) ?? '', /matches no character/u);
    }
  });

  it('counts the work every failed choice repeats over the text, not only the choices', () => {
    // Against `'a'.repeat(999) + '!'` these took seconds: few choices, each followed by a 900-character suffix.
    for (const source of [join('(?:a{0,9})', '{4}a{900}$'), join('(?:a{0,9})', '{7}a{900}')]) {
      assert.match(regexBudgetIssue(source) ?? '', /too long/u, source);
    }
  });

  it('refuses open-ended repetitions that compete for the same characters', () => {
    for (const source of [
      join('.*', '.*', '.*x'),
      join('a*', 'a*', 'a*', 'b'),
      join('.*a', '.*b'),
    ]) {
      assert.match(regexBudgetIssue(source) ?? '', /too long/u, source);
    }
  });

  it('accepts what is decided by the next character, and ordinary patterns', () => {
    for (const source of [
      '^[1-6]$',
      '--ctorigdstport 62050 .*-j DROP',
      '(^|;)b(;|$)',
      '^\\d+\\.\\d+(?:\\.\\d+)?$',
      '^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+){1,6}$',
      '^/(?:[A-Za-z0-9._@+=,:-]+/)*[A-Za-z0-9._@+=,:-]*$',
      'PermitRootLogin\\s+no',
      '^(?:yes|no)$',
      '\\p{L}+',
    ]) {
      assert.equal(regexBudgetIssue(source), undefined, source);
    }
  });

  it('keeps every accepted pattern fast on the longest input it is run on', () => {
    // Inputs chosen to make a backtracking engine work: a long run of what the pattern repeats, then a miss.
    const cases: [string, string][] = [
      ['--ctorigdstport 62050 .*-j DROP', '-j '.repeat(REGEX_INPUT_LIMIT / 3)],
      ['^\\d+\\.\\d+$', `${'1'.repeat(REGEX_INPUT_LIMIT - 1)}x`],
      ['PermitRootLogin\\s+no', `PermitRootLogin${' '.repeat(REGEX_INPUT_LIMIT - 20)}x`],
      ['(^|;)b(;|$)', ';'.repeat(REGEX_INPUT_LIMIT)],
    ];
    for (const [source, input] of cases) {
      assert.equal(regexBudgetIssue(source), undefined, source);
      const regex = new RegExp(source, 'mu');
      const started = performance.now();
      regex.test(input);
      assert.ok(performance.now() - started < 100, source);
    }
  });
});

describe('the pattern of a script parameter', () => {
  const parameter = (
    pattern: string,
  ): Extract<ScriptParameter, { type: 'string' }> & {
    pattern: string;
  } => ({
    name: 'p',
    label: 'P',
    type: 'string',
    required: true,
    maxLength: 1000,
    pattern,
  });

  it('does not match script patterns that use back references or lookbehind', () => {
    for (const pattern of [String.raw`(a)\1`, String.raw`(?<letter>a)\k<letter>`, 'a(?<=a)']) {
      assert.ok(parameterPatternIssue(pattern) !== undefined);
      assert.ok(parameterWriteIssues([parameter(pattern)]).length > 0);
      assert.equal(checkParameterValues([parameter(pattern)], { p: 'aa' }).ok, false);
    }
  });

  it('is refused when matching a value could take long', () => {
    const slow = join('(a|', 'a)*');
    assert.ok(parameterPatternIssue(slow) !== undefined);
    // Writing it is refused; a stored definition with it is still read (the schema keeps the old rules).
    assert.ok(parameterWriteIssues([parameter(slow)]).length > 0);
    assert.deepEqual(parameterDefinitionIssues([parameter(slow)]), []);
    assert.deepEqual(parameterWriteIssues([parameter(slow)], [parameter(slow)]), []);
    // A script stored before the bound: its values are refused, the pattern is never run.
    const started = performance.now();
    const check = checkParameterValues([parameter(slow)], { p: `${'a'.repeat(40)}b` });
    assert.ok(performance.now() - started < 100);
    assert.ok(!check.ok);
    assert.match(check.issues[0]?.message ?? '', /refused and is not run/u);
  });

  it('rejects patterns with unbalanced groups before anchoring them', () => {
    const invalid = parameter('left)(right');
    // A definition previously accepted by the schema is still readable, but it cannot be written or run.
    assert.equal(ScriptParametersSchema.safeParse([invalid]).success, true);
    assert.match(parameterPatternIssue(invalid.pattern) ?? '', /not a valid/u);
    assert.equal(parameterWriteIssues([invalid]).length, 1);
    assert.equal(checkParameterValues([invalid], { p: 'leftright' }).ok, false);
    // These parentheses are data, not groups.
    for (const pattern of ['[()]+', '\\(abc\\)', '(?<word>[a-z]+)']) {
      assert.equal(parameterPatternIssue(pattern), undefined);
    }
  });

  it('refuses a new default when the unchanged legacy pattern cannot run', () => {
    const stored = { ...parameter(join('(a|', 'a)*')), default: 'a' };
    assert.deepEqual(parameterWriteIssues([stored], [stored]), []);
    const updated = { ...stored, default: 'aa' };
    assert.match(parameterWriteIssues([updated], [stored])[0]?.message ?? '', /repeats a part/u);
  });

  it('reads stored definitions without matching and validates a changed default', () => {
    const withDefault: ScriptParameter = {
      name: 'p',
      label: 'P',
      type: 'string',
      required: false,
      maxLength: 10,
      pattern: '[a-z]+',
      default: 'abc',
    };
    const stored = { ...withDefault, default: '123' };
    assert.equal(ScriptParametersSchema.safeParse([stored]).success, true);
    assert.deepEqual(parameterDefinitionIssues([stored]), []);
    assert.deepEqual(parameterWriteIssues([stored], [stored]), []);
    assert.deepEqual(parameterWriteIssues([withDefault], [stored]), []);
    assert.match(
      parameterWriteIssues([{ ...withDefault, default: '123' }])[0]?.message ?? '',
      /does not match/u,
    );
  });

  it('keeps the patterns of the built-in scripts and common shapes', () => {
    for (const pattern of [
      '/|(?:/[A-Za-z0-9._-]+){1,8}',
      '[a-z0-9@.-]+\\.service',
      '[a-z][a-z0-9@.-]{0,40}\\.service',
    ]) {
      assert.equal(parameterPatternIssue(pattern), undefined, pattern);
    }
    const check = checkParameterValues([parameter('[a-z0-9@.-]+\\.service')], {
      p: 'nginx.service',
    });
    assert.equal(check.ok, true);
  });

  it('uses whole-value Unicode matching and rejects malformed Unicode syntax', () => {
    const smile = parameter(String.raw`\uD83D\uDE00+`);
    assert.equal(checkParameterValues([smile], { p: '😀😀' }).ok, true);
    assert.equal(checkParameterValues([smile], { p: 'x😀' }).ok, false);
    assert.equal(checkParameterValues([parameter('x{1000}')], { p: 'x'.repeat(1000) }).ok, true);
    for (const pattern of ['a{', 'a]', String.raw`\-`, String.raw`\00`]) {
      assert.ok(parameterPatternIssue(pattern) !== undefined);
    }
  });
});
