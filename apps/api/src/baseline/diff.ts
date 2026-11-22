import type { CheckRunDiff, CheckStatus, DriftItem, ObservedValue } from '@swellwright/contracts';

/** What a comparison of two runs needs to know about a result. */
export interface ComparableResult {
  readonly checkId: string;
  readonly title: string;
  readonly category: DriftItem['category'];
  readonly severity: DriftItem['severity'];
  readonly status: CheckStatus;
  readonly observed: ObservedValue;
  readonly message: string | null;
}

/**
 * How bad a status is. A check that could not be observed is worse than a warning (nobody knows) and better than a
 * failure (nobody knows it is wrong); a skipped check is as good as a passing one.
 */
const RANK: Readonly<Record<CheckStatus, number>> = {
  pass: 0,
  skipped: 0,
  warn: 1,
  error: 2,
  fail: 3,
};

const sameValue = (left: ObservedValue, right: ObservedValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export interface DriftResult {
  readonly counts: CheckRunDiff['counts'];
  readonly changes: readonly DriftItem[];
  readonly identical: boolean;
}

const side = (result: ComparableResult | undefined): DriftItem['from'] =>
  result ? { status: result.status, observed: result.observed, message: result.message } : null;

/**
 * What changed between two runs of one server: the checks whose status got worse or better, the checks whose observed
 * value changed (text, flags and lists always; a number only when the check is not passing, because the use of a disk or
 * a memory differs a little at every run and says nothing), and the checks that exist in one baseline only. Ordered with
 * the regressions first, then by the position in the later run.
 */
export function diffResults(
  from: readonly ComparableResult[],
  to: readonly ComparableResult[],
): DriftResult {
  const before = new Map(from.map((result) => [result.checkId, result]));
  const after = new Map(to.map((result) => [result.checkId, result]));
  const counts = { regressed: 0, improved: 0, changed: 0, added: 0, removed: 0, unchanged: 0 };
  const changes: DriftItem[] = [];
  for (const result of to) {
    const earlier = before.get(result.checkId);
    let change: DriftItem['change'] | undefined;
    if (!earlier) {
      change = 'added';
    } else if (RANK[result.status] > RANK[earlier.status]) {
      change = 'regressed';
    } else if (RANK[result.status] < RANK[earlier.status]) {
      change = 'improved';
    } else if (result.status !== earlier.status) {
      change = 'changed';
    } else if (!sameValue(earlier.observed, result.observed)) {
      const numbers = typeof earlier.observed === 'number' && typeof result.observed === 'number';
      if (!numbers || result.status !== 'pass') {
        change = 'changed';
      }
    }
    if (change === undefined) {
      counts.unchanged += 1;
      continue;
    }
    counts[change] += 1;
    changes.push({
      checkId: result.checkId,
      title: result.title,
      category: result.category,
      severity: result.severity,
      change,
      from: side(earlier),
      to: side(result),
    });
  }
  for (const result of from) {
    if (!after.has(result.checkId)) {
      counts.removed += 1;
      changes.push({
        checkId: result.checkId,
        title: result.title,
        category: result.category,
        severity: result.severity,
        change: 'removed',
        from: side(result),
        to: null,
      });
    }
  }
  const order = { regressed: 0, improved: 1, changed: 2, added: 3, removed: 4 } as const;
  changes.sort((a, b) => order[a.change] - order[b.change]);
  return {
    counts,
    changes,
    identical:
      counts.regressed + counts.improved + counts.changed + counts.added + counts.removed === 0,
  };
}

/**
 * Better or worse than the run before: by the number of failures first, then of errors and warnings. The same counts is
 * "same", whatever else moved.
 */
export function trendOf(
  now: { fail: number; error: number; warn: number },
  before: { fail: number; error: number; warn: number },
): 'better' | 'worse' | 'same' {
  for (const key of ['fail', 'error', 'warn'] as const) {
    if (now[key] !== before[key]) {
      return now[key] < before[key] ? 'better' : 'worse';
    }
  }
  return 'same';
}
