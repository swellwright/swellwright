import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BaselineCheck, ObservedValue } from '@swellwright/contracts';

import { boundObserved, compare, countOf, evaluateCheck } from './evaluate.js';
import type { ParsedObservation } from './parse.js';

const make = (
  kind: string,
  field: string,
  expect: Record<string, unknown>,
  severity: 'high' | 'medium' | 'low' = 'medium',
  params?: Record<string, string | number>,
): BaselineCheck => ({
  id: 'a.b',
  title: 'A check',
  category: 'system',
  severity,
  observe: { kind, field, ...(params ? { params } : {}) },
  expect,
});

const observed = (
  fields: Record<string, ObservedValue>,
  status: ParsedObservation['status'] = 'ok',
): ParsedObservation => ({
  index: 1,
  kind: 'x',
  status,
  fields: status === 'ok' ? fields : null,
});

describe('the comparators', () => {
  it('equals and notEquals compare the value exactly', () => {
    assert.equal(compare('equals', 'no', 'no').ok, true);
    assert.equal(compare('equals', 'No', 'no').ok, false);
    assert.equal(compare('equals', false, false).ok, true);
    assert.equal(compare('equals', 0, false).ok, false);
    assert.equal(compare('equals', 404, 404).ok, true);
    assert.equal(compare('notEquals', 'yes', 'no').ok, true);
    assert.equal(compare('notEquals', 'no', 'no').ok, false);
  });

  it('in is a membership test, and for a list every entry must be allowed', () => {
    assert.equal(compare('in', 'chrony', ['chrony', 'ntpd']).ok, true);
    assert.equal(compare('in', 'none', ['chrony', 'ntpd']).ok, false);
    assert.equal(compare('in', ['tcp/22', 'tcp/443'], ['tcp/22', 'tcp/443', 'tcp/80']).ok, true);
    const stray = compare('in', ['tcp/22', 'tcp/3306'], ['tcp/22']);
    assert.equal(stray.ok, false);
    assert.match(stray.expected, /tcp\/3306/u);
    assert.equal(compare('in', [], ['tcp/22']).ok, true);
  });

  it('matches searches the text with a regular expression, line by line', () => {
    assert.equal(compare('matches', '6', '^[1-6]$').ok, true);
    assert.equal(compare('matches', '7', '^[1-6]$').ok, false);
    assert.equal(compare('matches', 'a;b;c', '(^|;)b(;|$)').ok, true);
    assert.equal(compare('matches', 5, '5').ok, false);
    // A pattern that cannot be compiled never matches.
    assert.equal(compare('matches', 'x', '(').ok, false);
  });

  it('atLeast and atMost need a number and are inclusive', () => {
    assert.equal(compare('atLeast', 10, 10).ok, true);
    assert.equal(compare('atLeast', 9, 10).ok, false);
    assert.equal(compare('atMost', 10, 10).ok, true);
    assert.equal(compare('atMost', 11, 10).ok, false);
    assert.equal(compare('atMost', null, 10).ok, false);
    assert.equal(compare('atLeast', '12', 10).ok, false);
  });

  it('contains and notContains work on lists (an entry) and on text (a substring)', () => {
    assert.equal(compare('contains', ['a', 'b'], 'b').ok, true);
    assert.equal(compare('contains', ['ab'], 'b').ok, false);
    assert.equal(compare('contains', 'abc', 'b').ok, true);
    assert.equal(compare('notContains', ['a'], 'b').ok, true);
    assert.equal(compare('notContains', ['a', 'b'], 'b').ok, false);
    assert.equal(compare('notContains', 'abc', 'x').ok, true);
  });

  it('absent and present: nothing, an empty text and an empty list are absent; false and 0 are values', () => {
    for (const value of [null, '', []] as ObservedValue[]) {
      assert.equal(compare('absent', value, true).ok, true, JSON.stringify(value));
      assert.equal(compare('present', value, true).ok, false, JSON.stringify(value));
    }
    for (const value of [false, 0, 'x', ['a']] as ObservedValue[]) {
      assert.equal(compare('absent', value, true).ok, false, JSON.stringify(value));
      assert.equal(compare('present', value, true).ok, true, JSON.stringify(value));
    }
  });

  it('versionAtLeast compares the numbers part by part', () => {
    assert.equal(compare('versionAtLeast', '24.04', '22.04').ok, true);
    assert.equal(compare('versionAtLeast', '22.04', '22.04').ok, true);
    assert.equal(compare('versionAtLeast', '20.04', '22.04').ok, false);
    assert.equal(compare('versionAtLeast', '6.8.0-36-generic', '6.8').ok, true);
    assert.equal(compare('versionAtLeast', '3.4.10', '3.4.6').ok, true);
    assert.equal(compare('versionAtLeast', '3.4.6', '3.4.10').ok, false);
    assert.equal(compare('versionAtLeast', '3.2.27-1ppa1~noble', '3.2').ok, true);
    assert.equal(compare('versionAtLeast', 'latest', '3.2').ok, false);
    assert.equal(compare('versionAtLeast', 3, '3').ok, false);
  });

  it('ageLessThan compares seconds with a duration', () => {
    assert.equal(compare('ageLessThan', 3599, '1h').ok, true);
    assert.equal(compare('ageLessThan', 3600, '1h').ok, false);
    assert.equal(compare('ageLessThan', 86_399, '1d').ok, true);
    assert.equal(compare('ageLessThan', null, '1d').ok, false);
  });
});

describe('the status of a check', () => {
  it('passes when the expectation is met', () => {
    const outcome = evaluateCheck(
      make('sshd.effective', 'permitrootlogin', { equals: 'no' }),
      observed({ permitrootlogin: 'no' }),
    );
    assert.deepEqual(outcome, { status: 'pass', observed: 'no', message: null });
  });

  it('is a fail for a high severity and a warn for the others, with a sentence that shows both sides', () => {
    const high = evaluateCheck(
      make('sshd.effective', 'permitrootlogin', { equals: 'no' }, 'high'),
      observed({ permitrootlogin: 'yes' }),
    );
    assert.equal(high.status, 'fail');
    assert.equal(high.message, 'Observed "yes", expected "no".');
    for (const severity of ['medium', 'low'] as const) {
      assert.equal(
        evaluateCheck(
          make('sshd.effective', 'permitrootlogin', { equals: 'no' }, severity),
          observed({ permitrootlogin: 'yes' }),
        ).status,
        'warn',
      );
    }
  });

  it('is an error, never a pass, for what could not be observed', () => {
    const check = make('ufw.status', 'active', { equals: true }, 'high');
    for (const status of ['denied', 'error', 'timeout'] as const) {
      const outcome = evaluateCheck(check, observed({}, status));
      assert.equal(outcome.status, 'error', status);
      assert.equal(outcome.observed, null);
    }
    assert.match(evaluateCheck(check, observed({}, 'denied')).message ?? '', /not root/u);
    assert.equal(evaluateCheck(check, undefined).status, 'error');
    assert.equal(evaluateCheck(check, observed({}, 'unsupported')).status, 'skipped');
    // A field the script did not report is an error as well.
    assert.equal(
      evaluateCheck(make('sshd.effective', 'port', { equals: '22' }), observed({ port: null }))
        .status,
      'error',
    );
  });

  it('never passes absent or present on a field the server could not look at', () => {
    // `emptyPassword` is null when the login cannot read /etc/shadow: that is "unknown", not "no account".
    for (const expect of [{ absent: true }, { present: true }]) {
      for (const severity of ['high', 'low'] as const) {
        const outcome = evaluateCheck(
          make('users.login', 'emptyPassword', expect, severity),
          observed({ emptyPassword: null, count: 2 }),
        );
        assert.equal(outcome.status, 'error', JSON.stringify(expect));
        assert.equal(outcome.observed, null);
        assert.match(outcome.message ?? '', /could not observe/u);
      }
    }
    // Looked and found none is still a pass, and a name found is still a miss.
    assert.equal(
      evaluateCheck(
        make('users.login', 'emptyPassword', { absent: true }, 'high'),
        observed({ emptyPassword: [] }),
      ).status,
      'pass',
    );
    assert.equal(
      evaluateCheck(
        make('users.login', 'emptyPassword', { absent: true }, 'high'),
        observed({ emptyPassword: ['ghost'] }),
      ).status,
      'fail',
    );
    // A field that is null because there is nothing (no verify run yet) keeps the meaning of absent.
    assert.equal(
      evaluateCheck(
        make('installer.journal', 'verifyAgeSeconds', { absent: true }),
        observed({ exists: true, verifyAgeSeconds: null }),
      ).status,
      'pass',
    );
  });

  it('reports regex input over the defensive limit as unobserved, not a mismatch', () => {
    let matches = 0;
    const test = (): boolean => {
      matches += 1;
      return true;
    };
    const check = make('iptables.chain', 'text', { matches: '^x+$' }, 'high');
    assert.equal(evaluateCheck(check, observed({ text: 'x'.repeat(1000) }), test).status, 'pass');
    const result = evaluateCheck(check, observed({ text: 'x'.repeat(1001) }), test);
    assert.equal(result.status, 'error');
    assert.equal(result.observed, null);
    assert.equal(matches, 1);
  });

  it('does not run a stored pattern that could backtrack for long, and says why', () => {
    // Saved under older rules: a version of a baseline is immutable, so the evaluator asks again. The patterns are built
    // from parts so that no analyser takes them for patterns this test runs.
    const started = performance.now();
    const outcome = evaluateCheck(
      make('sshd.effective', 'allowusers', { matches: ['.*', '.*', '.*x'].join('') }, 'high'),
      observed({ allowusers: 'a'.repeat(590) }),
    );
    assert.ok(performance.now() - started < 1000);
    assert.equal(outcome.status, 'error');
    assert.match(outcome.message ?? '', /refused/u);
    assert.equal(
      evaluateCheck(
        make('sshd.effective', 'allowusers', { matches: ['(a|', 'a)*b'].join('') }),
        observed({ allowusers: 'a'.repeat(40) }),
      ).status,
      'error',
    );
    // A pattern that passes the estimate but is stopped at its deadline is an error, with no observed value in it.
    const stopped = evaluateCheck(
      make('sshd.effective', 'allowusers', { matches: '^deploy$' }, 'high'),
      observed({ allowusers: 'SECRET-LOOKING-VALUE' }),
      () => 'timeout',
    );
    assert.equal(stopped.status, 'error');
    assert.equal(stopped.observed, null);
    assert.match(stopped.message ?? '', /too slow/u);
    assert.ok(!(stopped.message ?? '').includes('SECRET-LOOKING-VALUE'));
    // The real runner: a slow pattern on the worker never blocks this process for long.
    const started2 = performance.now();
    assert.equal(
      compare('matches', `${'a'.repeat(999)}!`, ['(?:a{0,9}', '){2}a{900}$'].join('')).ok,
      false,
    );
    assert.ok(performance.now() - started2 < 2000);
    // An ordinary pattern still decides.
    assert.equal(
      evaluateCheck(
        make('sshd.effective', 'maxauthtries', { matches: '^[1-6]$' }, 'high'),
        observed({ maxauthtries: '9' }),
      ).status,
      'fail',
    );
  });

  it('says a thing that is not there is a miss, not an error', () => {
    const missing = observed({ exists: false, state: null, envNames: [] });
    const running = evaluateCheck(
      make('docker.container', 'state', { equals: 'running' }, 'high', { name: 'x' }),
      missing,
    );
    assert.equal(running.status, 'fail');
    assert.match(running.message ?? '', /not present/u);
    // Also for a list that defaults to empty.
    assert.equal(
      evaluateCheck(
        make('docker.container', 'envNames', { contains: 'SECRET_KEY' }, 'high', { name: 'x' }),
        missing,
      ).status,
      'fail',
    );
    // The presence field itself is compared as usual.
    assert.equal(
      evaluateCheck(
        make('docker.container', 'exists', { equals: false }, 'low', { name: 'x' }),
        missing,
      ).status,
      'pass',
    );
  });

  it('bounds what it stores', () => {
    assert.equal((boundObserved('x'.repeat(1000)) as string).length, 403);
    const list = boundObserved(Array.from({ length: 80 }, (_, index) => `entry ${String(index)}`));
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 51);
    assert.equal(list[50], '... 30 more');
    assert.equal(boundObserved(5), 5);
    assert.equal(boundObserved(null), null);
  });

  it('counts statuses', () => {
    assert.deepEqual(countOf(['pass', 'pass', 'warn', 'fail', 'error', 'skipped', 'pass']), {
      pass: 3,
      warn: 1,
      fail: 1,
      error: 1,
      skipped: 1,
    });
  });
});
