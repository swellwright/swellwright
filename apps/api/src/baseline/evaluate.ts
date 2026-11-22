import {
  type BaselineCheck,
  type CheckCounts,
  type CheckStatus,
  type Comparator,
  comparatorOf,
  durationSeconds,
  type ObservedValue,
  observationKind,
} from '@swellwright/contracts';

import type { ParsedObservation } from './parse.js';

/** The outcome of one check, before it is stored. */
export interface CheckOutcome {
  readonly status: CheckStatus;
  /** The field's value, bounded for storage; null when nothing was observed. */
  readonly observed: ObservedValue;
  readonly message: string | null;
}

/** At most this many entries of a list and characters of a text are kept with a result. */
const MAX_OBSERVED_LIST = 50;
const MAX_OBSERVED_TEXT = 400;

/** The value as it is stored and shown: bounded, so one long list cannot make a result large. */
export function boundObserved(value: ObservedValue): ObservedValue {
  if (typeof value === 'string') {
    return value.length > MAX_OBSERVED_TEXT ? `${value.slice(0, MAX_OBSERVED_TEXT)}...` : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_OBSERVED_LIST).map((entry) => String(boundObserved(entry)));
    return value.length > MAX_OBSERVED_LIST
      ? [...kept, `... ${String(value.length - MAX_OBSERVED_LIST)} more`]
      : kept;
  }
  return value;
}

/** A version as its numbers: "6.8.0-36-generic" is 6, 8, 0, 36. null when there is no number in it. */
function versionParts(text: string): number[] | null {
  const parts = text.match(/[0-9]+/gu);
  return parts === null ? null : parts.slice(0, 8).map(Number);
}

/** Negative, zero or positive, as the first number that differs says; a missing number is 0. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

const regexCache = new Map<string, RegExp | null>();
function regexOf(source: string): RegExp | null {
  const cached = regexCache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(source, 'mu');
  } catch {
    compiled = null;
  }
  if (regexCache.size > 500) {
    regexCache.clear();
  }
  regexCache.set(source, compiled);
  return compiled;
}

const isEmpty = (value: ObservedValue): boolean =>
  value === null || value === '' || (Array.isArray(value) && value.length === 0);

const show = (value: unknown): string => {
  if (typeof value === 'string') {
    return `"${value.length > 80 ? `${value.slice(0, 80)}...` : value}"`;
  }
  if (Array.isArray(value)) {
    const text = value.map((entry) => show(entry)).join(', ');
    return `[${text.length > 120 ? `${text.slice(0, 120)}...` : text}]`;
  }
  return String(value);
};

interface Verdict {
  readonly ok: boolean;
  /** Why not, in a clause that follows "Observed X, " (for example "expected X"). */
  readonly expected: string;
}

/** Does `observed` meet `comparator` with `argument`. The document was validated, so the types are right. */
export function compare(
  comparator: Comparator,
  observed: ObservedValue,
  argument: unknown,
): Verdict {
  switch (comparator) {
    case 'equals':
      return { ok: observed === argument, expected: `expected ${show(argument)}` };
    case 'notEquals':
      return { ok: observed !== argument, expected: `expected anything but ${show(argument)}` };
    case 'in': {
      const allowed = argument as readonly unknown[];
      const entries = Array.isArray(observed) ? observed : [observed];
      const outside = entries.filter((entry) => !allowed.includes(entry));
      return {
        ok: outside.length === 0,
        expected: Array.isArray(observed)
          ? `${show(outside)} not allowed, allowed: ${show(allowed)}`
          : `expected one of ${show(allowed)}`,
      };
    }
    case 'matches': {
      const regex = regexOf(argument as string);
      return {
        ok: typeof observed === 'string' && regex?.test(observed) === true,
        expected: `expected to match ${show(argument)}`,
      };
    }
    case 'atLeast':
      return {
        ok: typeof observed === 'number' && observed >= (argument as number),
        expected: `expected at least ${show(argument)}`,
      };
    case 'atMost':
      return {
        ok: typeof observed === 'number' && observed <= (argument as number),
        expected: `expected at most ${show(argument)}`,
      };
    case 'contains': {
      const wanted = argument as string;
      const has = Array.isArray(observed)
        ? observed.includes(wanted)
        : typeof observed === 'string' && observed.includes(wanted);
      return { ok: has, expected: `expected to contain ${show(wanted)}` };
    }
    case 'notContains': {
      const unwanted = argument as string;
      const has = Array.isArray(observed)
        ? observed.includes(unwanted)
        : typeof observed === 'string' && observed.includes(unwanted);
      return { ok: !has, expected: `expected not to contain ${show(unwanted)}` };
    }
    case 'absent':
      return { ok: isEmpty(observed), expected: 'expected nothing' };
    case 'present':
      return { ok: !isEmpty(observed), expected: 'expected a value' };
    case 'versionAtLeast': {
      const have = typeof observed === 'string' ? versionParts(observed) : null;
      const want = versionParts(argument as string) ?? [];
      return {
        ok: have !== null && compareVersions(have, want) >= 0,
        expected: `expected version ${show(argument)} or newer`,
      };
    }
    case 'ageLessThan': {
      const limit = durationSeconds(argument as string) ?? 0;
      return {
        ok: typeof observed === 'number' && observed < limit,
        expected: `expected less than ${show(argument)} (${String(limit)} seconds)`,
      };
    }
  }
}

const NOT_OBSERVED_NEEDS_ROOT =
  'The login of this server cannot read this: it is not root and has no working sudo.';

/**
 * Decides the status of one check from what the script made of its observation (ADR 0045). A missed expectation is a
 * `fail` for a high severity and a `warn` otherwise. What could not be observed is an `error`, and never a pass: an
 * unknown is not a good.
 */
export function evaluateCheck(
  check: BaselineCheck,
  observation: ParsedObservation | undefined,
): CheckOutcome {
  if (observation === undefined) {
    return {
      status: 'error',
      observed: null,
      message: 'The server did not report this observation (the output ended before it).',
    };
  }
  switch (observation.status) {
    case 'unsupported':
      return {
        status: 'skipped',
        observed: null,
        message: 'The observation script does not know this kind of observation.',
      };
    case 'denied':
      return { status: 'error', observed: null, message: NOT_OBSERVED_NEEDS_ROOT };
    case 'timeout':
      return {
        status: 'error',
        observed: null,
        message: 'The observation took too long on the server.',
      };
    case 'error':
      return {
        status: 'error',
        observed: null,
        message: 'The observation failed on the server (the tool is missing, refused or broke).',
      };
    case 'ok':
      break;
  }
  const value = observation.fields?.[check.observe.field] ?? null;
  const { comparator, argument } = comparatorOf(check.expect);
  const observed = boundObserved(value);
  const def = observationKind(check.observe.kind);
  if (
    def?.presence !== undefined &&
    def.presence !== check.observe.field &&
    observation.fields?.[def.presence] === false &&
    comparator !== 'absent' &&
    comparator !== 'present'
  ) {
    // The thing is not there: that is a miss of the expectation, not a failure to look.
    return {
      status: check.severity === 'high' ? 'fail' : 'warn',
      observed: null,
      message: `${def.title} is not present on the server.`,
    };
  }
  if (value === null && comparator !== 'absent' && comparator !== 'present') {
    // `false`, 0 and an empty list are values. null is "the script did not say" (the tool is missing, it needs root).
    return {
      status: 'error',
      observed: null,
      message: `The server did not report "${check.observe.field}" (the tool may be missing or need root).`,
    };
  }
  const verdict = compare(comparator, value, argument);
  if (verdict.ok) {
    return { status: 'pass', observed, message: null };
  }
  const status: CheckStatus = check.severity === 'high' ? 'fail' : 'warn';
  return {
    status,
    observed,
    message: `Observed ${value === null ? 'nothing' : show(value)}, ${verdict.expected}.`,
  };
}

export function countOf(statuses: Iterable<CheckStatus>): CheckCounts {
  const counts = { pass: 0, warn: 0, fail: 0, error: 0, skipped: 0 };
  for (const status of statuses) {
    counts[status] += 1;
  }
  return counts;
}
