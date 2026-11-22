import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compilePattern,
  PATTERN_LIMITS,
  patternProblem,
  UnsafePatternError,
} from './safe-pattern.js';

const matches = (pattern: string, value: string): boolean => compilePattern(pattern).matches(value);

describe('safe patterns: what they match', () => {
  it('matches the whole value, never a part of it', () => {
    assert.equal(matches('abc', 'abc'), true);
    assert.equal(matches('abc', 'abcd'), false);
    assert.equal(matches('abc', 'xabc'), false);
  });

  it('accepts a leading ^ and a trailing $ and treats them as no-ops', () => {
    assert.equal(matches('^abc$', 'abc'), true);
    assert.equal(matches('^abc$', 'abcd'), false);
    assert.equal(matches('a\\$', 'a$'), true, 'an escaped dollar is a literal');
    assert.equal(matches('a\\\\$', 'a\\'), true, 'an escaped backslash before the anchor');
  });

  it('handles alternation and groups, with or without capture syntax', () => {
    assert.equal(matches('(a|b)c', 'ac'), true);
    assert.equal(matches('(?:a|b)c', 'bc'), true);
    assert.equal(matches('(?<flag>a|b)c', 'bc'), true);
    assert.equal(matches('a|b|c', 'c'), true);
    assert.equal(matches('a|b|c', 'd'), false);
    assert.equal(matches('(|a)b', 'b'), true, 'an empty branch');
  });

  it('handles every quantifier', () => {
    assert.equal(matches('a*', ''), true);
    assert.equal(matches('a*', 'aaaa'), true);
    assert.equal(matches('a+', ''), false);
    assert.equal(matches('a+', 'aaa'), true);
    assert.equal(matches('ab?c', 'ac'), true);
    assert.equal(matches('ab?c', 'abc'), true);
    assert.equal(matches('ab?c', 'abbc'), false);
    assert.equal(matches('a{3}', 'aaa'), true);
    assert.equal(matches('a{3}', 'aa'), false);
    assert.equal(matches('a{2,}', 'a'), false);
    assert.equal(matches('a{2,}', 'aaaaa'), true);
    assert.equal(matches('a{2,4}', 'aa'), true);
    assert.equal(matches('a{2,4}', 'aaaa'), true);
    assert.equal(matches('a{2,4}', 'aaaaa'), false);
    assert.equal(matches('(ab){2}', 'abab'), true);
    assert.equal(matches('(ab){2}', 'ab'), false);
    assert.equal(matches('a*?b', 'aab'), true, 'a lazy marker is accepted');
  });

  it('handles classes and shorthands', () => {
    assert.equal(matches('[A-Z]{2}-\\d{2}', 'NL-01'), true);
    assert.equal(matches('[A-Z]{2}-\\d{2}', 'nl-01'), false);
    assert.equal(matches('[^0-9]+', 'abc'), true);
    assert.equal(matches('[^0-9]+', 'a1c'), false);
    assert.equal(matches('\\w+\\s\\S+', 'ab cd'), true);
    assert.equal(matches('\\D\\W', 'a-'), true);
    assert.equal(matches('[\\]x]+', ']x]'), true, 'an escaped bracket inside a class');
    assert.equal(matches('[a\\-z]+', 'a-z'), true);
  });

  it('takes any character with a dot, but not a line break', () => {
    assert.equal(matches('a.c', 'abc'), true);
    assert.equal(matches('a.c', 'a\nc'), false);
    assert.equal(matches('.*', 'anything at all'), true);
  });

  it('works on whole characters, emoji and scripts included', () => {
    assert.equal(
      matches('\\p{Regional_Indicator}{2} (🎯|🌐) [A-Z]{2}-\\d{2} - .+', '🇳🇱 🎯 NL-01 - selective'),
      true,
    );
    assert.equal(matches('\\p{Regional_Indicator}{2}', '🇳🇱'), true);
    assert.equal(matches('.', '🎯'), true, 'one emoji is one character');
    assert.equal(matches('.', '🇳🇱'), false, 'a flag is two characters');
    assert.equal(matches('\\p{L}+', 'Привет'), true);
    assert.equal(matches('\\P{L}+', 'abc'), false);
    assert.equal(matches('\\u{1F3AF}', '🎯'), true);
    assert.equal(matches('\\u0041\\x42', 'AB'), true);
  });

  it('knows the plain escapes', () => {
    assert.equal(matches('a\\nb', 'a\nb'), true);
    assert.equal(matches('a\\tb', 'a\tb'), true);
    assert.equal(matches('\\.\\*\\(\\)', '.*()'), true);
    assert.equal(matches('\\-\\/', '-/'), true);
  });

  it('treats a brace that is not a quantifier as a character', () => {
    assert.equal(matches('a{b', 'a{b'), true);
    assert.equal(matches('a{,3}', 'a{,3}'), true);
    assert.equal(matches('a}', 'a}'), true);
  });

  it('does not match a value longer than the cap, and says so only by not matching', () => {
    const long = 'a'.repeat(PATTERN_LIMITS.valueChars + 1);
    assert.equal(matches('a*', long), false);
    assert.equal(matches('a*', 'a'.repeat(PATTERN_LIMITS.valueChars)), true);
  });
});

describe('safe patterns: what is refused', () => {
  const refused: readonly [string, RegExp][] = [
    ['', /empty/u],
    ['(?=a)a', /Lookahead/u],
    ['(?!a)a', /Lookahead/u],
    ['(?<=a)b', /Lookahead/u],
    ['(?<!a)b', /Lookahead/u],
    ['(a)\\1', /Back-references/u],
    ['(?<n>a)\\k<n>', /Back-references/u],
    ['\\bfoo\\b', /boundaries/u],
    ['*a', /nothing to repeat/u],
    ['a**', /follows a quantifier/u],
    ['a+*', /follows a quantifier/u],
    ['a++', /Possessive/u],
    ['a{65}', /above 64/u],
    ['a{2,65}', /above 64/u],
    ['a{3,2}', /maximum below/u],
    ['(abc', /not closed/u],
    ['abc)', /Unbalanced/u],
    ['[abc', /not closed/u],
    ['[]', /empty/u],
    ['[[:alpha:]]', /Nested/u],
    ['a^b', /anchor/u],
    ['a$b', /anchor/u],
    ['a\\', /backslash/u],
    ['\\a', /not supported/u],
    ['\\p', /needs a property/u],
    ['\\p{NoSuchProperty}', /valid/u],
    ['\\u12', /valid/u],
    ['\\xZZ', /valid/u],
    ['[z-a]', /valid/u],
  ];
  for (const [pattern, why] of refused) {
    it(`refuses ${JSON.stringify(pattern)}`, () => {
      assert.throws(
        () => compilePattern(pattern),
        (error: unknown) => {
          assert.ok(error instanceof UnsafePatternError);
          assert.match(error.message, why);
          return true;
        },
      );
      assert.notEqual(patternProblem(pattern), null);
    });
  }

  it('refuses a pattern that is too long', () => {
    assert.throws(() => compilePattern('a'.repeat(PATTERN_LIMITS.sourceChars + 1)), /longer than/u);
    compilePattern('a'.repeat(PATTERN_LIMITS.sourceChars));
  });

  it('refuses a pattern that would need too many states once repeats are written out', () => {
    assert.throws(() => compilePattern('((((a{64}){64}){64}){64})'), /too large/u);
    assert.throws(() => compilePattern('((.{64}){64}){2}'), /too large/u);
    // 4096 states are within the budget.
    assert.equal(matches('(.{64}){64}', 'x'.repeat(100)), false);
  });

  it('refuses groups nested too deeply', () => {
    assert.throws(
      () => compilePattern(`${'('.repeat(40)}a${')'.repeat(40)}`),
      /nested too deeply/u,
    );
  });

  it('answers null for a good pattern', () => {
    assert.equal(patternProblem('[A-Z]+'), null);
  });
});

describe('safe patterns: the patterns that stop other engines', () => {
  // `(a+)+$`, `(a|aa)+$`, `(.*a){20}` and the like take exponential time in a backtracking engine. Here they take
  // time in proportion to the length, so the tests would hang if the guarantee were lost; each is run on the
  // worst input of the longest allowed length and must finish at once.
  const hostile = [
    '(a+)+$',
    '(a*)*$',
    '(a|aa)+$',
    '(a|a)*$',
    '(.*a){20}',
    '(a?){30}a{30}',
    '(x+x+)+y',
    '([a-z]+)*\\d',
  ];
  for (const pattern of hostile) {
    it(`finishes ${JSON.stringify(pattern)} on its worst input`, () => {
      const compiled = compilePattern(pattern);
      const input = `${'a'.repeat(PATTERN_LIMITS.valueChars - 1)}!`;
      const started = performance.now();
      compiled.matches(input);
      compiled.matches('a'.repeat(PATTERN_LIMITS.valueChars));
      compiled.matches(`${'x'.repeat(PATTERN_LIMITS.valueChars - 1)}z`);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1500, `${pattern} took ${String(Math.round(elapsed))} ms`);
    });
  }

  it('still gives the right answer for those patterns', () => {
    assert.equal(matches('(a+)+$', 'aaaa'), true);
    assert.equal(matches('(a+)+$', 'aaaa!'), false);
    assert.equal(matches('(a|aa)+', 'aaaaaaaaaaaaaaaa'), true);
    assert.equal(matches('(a?){3}a{3}', 'aaa'), true);
    assert.equal(matches('(a?){3}a{3}', 'aa'), false);
  });
});
