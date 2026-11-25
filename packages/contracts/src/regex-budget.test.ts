import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkParameterValues,
  configureParameterPatternTest,
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
  const parameter = (pattern: string): ScriptParameter => ({
    name: 'p',
    label: 'P',
    type: 'string',
    required: true,
    maxLength: 1000,
    pattern,
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

  it('treats a match stopped at the deadline as a value that does not match', () => {
    configureParameterPatternTest(() => 'timeout');
    try {
      assert.equal(
        checkParameterValues([parameter('[a-z0-9@.-]+\\.service')], { p: 'nginx.service' }).ok,
        false,
      );
    } finally {
      configureParameterPatternTest((regex, value) => regex.test(value));
    }
  });

  it('reads stored definitions without running a pattern; a write checks the default under the runner', () => {
    const withDefault: ScriptParameter = {
      name: 'p',
      label: 'P',
      type: 'string',
      required: false,
      maxLength: 10,
      pattern: '[a-z]+',
      default: 'abc',
    };
    let calls = 0;
    // As when the process's budget for patterns is spent: every run of a pattern answers `timeout`.
    configureParameterPatternTest(() => {
      calls += 1;
      return 'timeout';
    });
    try {
      // Reading: the schema never runs the pattern, so the definition is read whatever the runner says.
      assert.equal(ScriptParametersSchema.safeParse([withDefault]).success, true);
      assert.deepEqual(parameterDefinitionIssues([withDefault]), []);
      assert.equal(calls, 0, 'a read ran a pattern');
      // An unrelated save: the stored pattern and default are not checked again.
      assert.deepEqual(parameterWriteIssues([withDefault], [withDefault]), []);
      assert.equal(calls, 0);
      // A new default is checked, and a check that could not be decided is refused with a sentence that says so.
      const changed = parameterWriteIssues([{ ...withDefault, default: 'xyz' }], [withDefault]);
      assert.equal(calls, 1);
      assert.match(changed[0]?.message ?? '', /could not be checked against the pattern in time/u);
    } finally {
      configureParameterPatternTest((regex, value) => regex.test(value));
    }
    // With a runner that answers, a default that does not match is refused on a write.
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
});
