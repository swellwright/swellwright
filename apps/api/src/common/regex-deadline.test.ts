import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { beforeEach, describe, it } from 'node:test';

import type { BaselineCheck } from '@swellwright/contracts';

import { evaluateCheck } from '../baseline/evaluate.js';
import {
  deadlineBudget,
  REGEX_DEADLINE_MS,
  resetDeadlineMemory,
  RUN_BUDGET_MS,
  testWithDeadline,
  useWorkerModeForTests,
} from './regex-deadline.js';

// The slow patterns are built from parts, so that no analyser takes them for patterns this test runs in its process;
// they only ever run on the worker, under the deadline.
const pattern = (...parts: string[]): RegExp => new RegExp(parts.join(''), 'mu');
/** Passes the estimate (few choices) and is slow against `'a'.repeat(399) + '!'`; `n` makes each one distinct. */
const slowPattern = (n: number): RegExp => pattern('(?:a{0,9}', `){3}a{${String(200 + n)}}$`);
const hostile = `${'a'.repeat(399)}!`;

describe('a pattern under a deadline', () => {
  beforeEach(() => {
    resetDeadlineMemory();
  });

  it('emits one process-budget exhaustion event per saturation period', (t) => {
    const metric = channel('swellwright.regex_deadline.process_budget_exhausted');
    const events: unknown[] = [];
    const collect = (event: unknown): void => {
      events.push(event);
    };
    let duration = 0;
    let epoch = 0;
    let waits = 0;
    t.mock.method(Date, 'now', () => epoch);
    t.mock.method(performance, 'now', () => duration);
    t.mock.method(
      Atomics,
      'wait',
      (_cell: Int32Array, index: number, _expected: number, limit: number) => {
        if (index === 1) return 'ok';
        waits += 1;
        duration += limit;
        return 'timed-out';
      },
    );
    const spend = (group: number): void => {
      for (let index = 0; index < 25; index += 1) {
        assert.equal(
          testWithDeadline(new RegExp(`^${String(group)}:${String(index)}$`, 'u'), 'fixture'),
          'timeout',
        );
      }
    };
    useWorkerModeForTests('never-answers');
    metric.subscribe(collect);
    try {
      spend(1);
      assert.equal(waits, 20);
      assert.deepEqual(events, [1]);
      epoch = 60_001;
      spend(2);
      assert.equal(waits, 40);
      assert.deepEqual(events, [1, 1]);
    } finally {
      metric.unsubscribe(collect);
      useWorkerModeForTests('normal');
    }
  });

  it('starts at most one run budget of unanswered comparisons', (t) => {
    useWorkerModeForTests('never-answers');
    let time = 0;
    const waits: number[] = [];
    t.mock.method(performance, 'now', () => time);
    t.mock.method(
      Atomics,
      'wait',
      (_cell: Int32Array, index: number, _expected: number, limit: number) => {
        if (index === 1) return 'ok';
        waits.push(limit);
        time += limit;
        return 'timed-out';
      },
    );
    try {
      const budget = deadlineBudget();
      const test = (regex: RegExp, text: string): boolean | 'timeout' =>
        testWithDeadline(regex, text, REGEX_DEADLINE_MS, budget);
      const statuses = Array.from({ length: 300 }, (_unused, index) => {
        const check: BaselineCheck = {
          id: `slow.n${String(index)}`,
          title: 'An unanswered check',
          category: 'system',
          severity: 'high',
          observe: { kind: 'sshd.effective', field: 'allowusers' },
          expect: { matches: `^user${String(index)}$` },
        };
        return evaluateCheck(
          check,
          { index: 1, kind: 'sshd.effective', status: 'ok', fields: { allowusers: 'user' } },
          test,
        ).status;
      });
      assert.ok(statuses.every((status) => status === 'error'));
      assert.deepEqual(
        waits,
        Array<unknown>(RUN_BUDGET_MS / REGEX_DEADLINE_MS).fill(REGEX_DEADLINE_MS),
      );
      assert.equal(budget.remainingMs, 0);
      // A new run with a different pattern can still submit a comparison.
      assert.equal(
        testWithDeadline(/^new$/u, 'new', REGEX_DEADLINE_MS, deadlineBudget()),
        'timeout',
      );
      assert.equal(waits.length, RUN_BUDGET_MS / REGEX_DEADLINE_MS + 1);
    } finally {
      useWorkerModeForTests('normal');
    }
  });

  it('never takes a late wake-up of one request for the answer to the next (thousands of back-to-back calls)', () => {
    const verdicts = new Map<string, number>();
    for (let index = 0; index < 4000; index += 1) {
      // A new text every time, so no answer comes from the memory of answers.
      const verdict = String(testWithDeadline(/^[0-9]+$/u, String(index)));
      verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    }
    assert.deepEqual([...verdicts], [['true', 4000]]);
    // And the pattern was not taken for a slow one.
    assert.equal(testWithDeadline(/^[0-9]+$/u, 'x'), false);
  });

  it('charges a failed start to the budgets and does not try again at once', () => {
    useWorkerModeForTests('never-ready');
    try {
      const budget = deadlineBudget();
      let started = performance.now();
      assert.equal(testWithDeadline(/^a$/u, 'a', REGEX_DEADLINE_MS, budget), 'timeout');
      const first = performance.now() - started;
      assert.ok(first < 600, `the failed start blocked for ${first.toFixed(0)} ms`);
      assert.ok(budget.remainingMs <= 1, `the budget kept ${budget.remainingMs.toFixed(0)} ms`);
      started = performance.now();
      assert.equal(testWithDeadline(/^b$/u, 'b'), 'timeout');
      assert.equal(testWithDeadline(/^c$/u, 'c', REGEX_DEADLINE_MS, deadlineBudget()), 'timeout');
      assert.ok(performance.now() - started < 20, 'a start was tried again at once');
    } finally {
      useWorkerModeForTests('normal');
      resetDeadlineMemory();
    }
    assert.equal(testWithDeadline(/^a$/u, 'a'), true);
  });

  it('does not spend the match budget on a successful cold start', (t) => {
    useWorkerModeForTests('normal');
    let ticks = 0;
    let starts = 0;
    t.mock.method(performance, 'now', () => ticks++);
    const wait = Atomics.wait;
    t.mock.method(
      Atomics,
      'wait',
      (cell: Int32Array, index: number, expected: number, timeout?: number) => {
        if (index === 1) {
          starts += 1;
          ticks += 100;
        }
        return wait(cell, index, expected, timeout);
      },
    );
    const budget = deadlineBudget();
    assert.equal(testWithDeadline(/^first$/u, 'first', REGEX_DEADLINE_MS, budget), true);
    assert.equal(starts, 1);
    assert.ok(budget.remainingMs > 250, 'the synthetic startup delay used the match budget');
  });

  it('answers a pattern that was stopped once at once afterwards', () => {
    assert.equal(testWithDeadline(slowPattern(0), hostile), 'timeout');
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      assert.equal(testWithDeadline(slowPattern(0), hostile), 'timeout');
    }
    assert.ok(performance.now() - started < 50, 'a remembered pattern was run again');
  });

  it('past the process budget runs nothing new, only answers already known for the same pattern and text', () => {
    assert.equal(testWithDeadline(/^[1-6]$/mu, '5'), true);
    // More than a second of stopped matches within the minute.
    for (let index = 0; index < 30; index += 1) {
      testWithDeadline(slowPattern(index), hostile);
    }
    const started = performance.now();
    assert.equal(testWithDeadline(slowPattern(500), hostile), 'timeout');
    assert.equal(testWithDeadline(/^[a-z]+$/mu, 'new'), 'timeout', 'a pattern not seen before');
    assert.equal(testWithDeadline(/^[1-6]$/mu, '6'), 'timeout', 'a known pattern on a new text');
    assert.ok(performance.now() - started < 20);
    assert.equal(testWithDeadline(/^[1-6]$/mu, '5'), true, 'the same pattern on the same text');
  });

  it('gives a pattern that was fast once no pass to run on a hostile text after the budget is spent', () => {
    // Warm 40 patterns on a harmless text: they all finish.
    const warmed = Array.from({ length: 40 }, (_unused, index) => slowPattern(1000 + index));
    for (const regex of warmed) {
      assert.equal(testWithDeadline(regex, ''), false);
    }
    // Spend the process budget with other slow patterns.
    for (let index = 0; index < 30; index += 1) {
      testWithDeadline(slowPattern(index), hostile);
    }
    // The warmed patterns against the hostile text, across several runs with budgets of their own.
    const started = performance.now();
    let timeouts = 0;
    for (let run = 0; run < 4; run += 1) {
      const budget = deadlineBudget();
      for (const regex of warmed.slice(run * 10, run * 10 + 10)) {
        if (testWithDeadline(regex, hostile, REGEX_DEADLINE_MS, budget) === 'timeout') {
          timeouts += 1;
        }
      }
    }
    const took = performance.now() - started;
    assert.equal(timeouts, 40);
    assert.ok(took < 100, `the warmed patterns blocked for ${took.toFixed(0)} ms`);
  });
  it('stops a catastrophic match and says so, then answers the next call', () => {
    for (const [regex, text] of [
      [pattern('(a+', ')+b'), 'a'.repeat(40)],
      [pattern('(?:a{0,9}', '){4}a{900}$'), `${'a'.repeat(999)}!`],
      [pattern('(?:a{0,9}', '){7}a{900}$'), `${'a'.repeat(999)}!`],
    ] as const) {
      const started = performance.now();
      const result = testWithDeadline(regex, text, 50);
      const took = performance.now() - started;
      assert.notEqual(result, true, regex.source);
      assert.ok(took < 2_000, `${regex.source} took ${took.toFixed(0)} ms`);
    }
    assert.equal(testWithDeadline(pattern('(a+', ')+b'), 'a'.repeat(40), 50), 'timeout');
    // A new worker took over.
    assert.equal(testWithDeadline(/^[1-6]$/mu, '5'), true);
    assert.equal(testWithDeadline(/^[1-6]$/mu, '7'), false);
  });

  it('decides ordinary patterns as the engine does, at a small cost per call', () => {
    assert.equal(
      testWithDeadline(
        /--ctorigdstport 62050 .*-j DROP/mu,
        '-A x --ctorigdstport 62050 -m y -j DROP',
      ),
      true,
    );
    assert.equal(testWithDeadline(/(^|;)b(;|$)/mu, 'a;b;c'), true);
    // A global pattern does not carry its position from one call to the next.
    const global = /a/gu;
    assert.equal(testWithDeadline(global, 'a'), true);
    assert.equal(testWithDeadline(global, 'a'), true);
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      testWithDeadline(/^[1-6]$/mu, String(index % 9));
    }
    const took = performance.now() - started;
    assert.ok(took < 1_000, `10,000 calls took ${took.toFixed(0)} ms`);
  });
});
