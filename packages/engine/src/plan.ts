// The plan of a run and its hash (ADR 0048, `Run.planHash`; docs/en/design/08-engine.md section 6).
//
// A plan is what the run will do, in order, computed before it starts and changing nothing. The hash is SHA-256 of a
// canonical text of the plan, so an approval that names a hash approves exactly this plan: change a parameter, a step, a
// resource or a planned change and the hash is another one.

import { createHash } from 'node:crypto';
import { lockKey, orderLocks, type ResourceRef } from './locks.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  /** Where in the value the problem is, as a JSON Pointer-like path. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path === '' ? 'the root' : path}).`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

const MAX_DEPTH = 64;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON with the keys of every object sorted by code unit and no white space: one value, one text. It is stricter than
 * `JSON.stringify`, because the text is hashed and approved: what JSON cannot say (`undefined`, a function, a symbol, a
 * bigint, `NaN` or an infinity, a class instance, a cycle) is an error, not a silent `null`. A key whose value is
 * `undefined` is left out, as JSON does, so an optional field that is not set is the same as one that is absent.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '', 0, new Set());
}

function write(value: unknown, path: string, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalJsonError(
      `The value is nested deeper than ${String(MAX_DEPTH)} levels`,
      path,
    );
  }
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('A number must be finite', path);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`A ${typeof value} cannot be part of a plan`, path);
  }
  const object = value;
  if (seen.has(object)) {
    throw new CanonicalJsonError('The value refers to itself', path);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // `Array.from` visits the holes of a sparse array as `undefined`, which `map` would skip and `join` would write as
      // nothing: `[1,,3]` is not JSON.
      return `[${Array.from(object as unknown[], (item, index) => {
        if (item === undefined) {
          throw new CanonicalJsonError(
            'An array cannot hold undefined',
            `${path}/${String(index)}`,
          );
        }
        return write(item, `${path}/${String(index)}`, depth + 1, seen);
      }).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Only plain objects can be part of a plan', path);
    }
    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareText(a, b));
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${write(item, `${path}/${key}`, depth + 1, seen)}`,
      )
      .join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** One change that a step will make, as the people who approve a run read it. */
export interface PlanItem {
  /** What kind of change: `file.write`, `panel.node.create`, `dns.record.create`. */
  readonly kind: string;
  /** What it changes: a path, a node name, a record. Never a secret. */
  readonly target: string;
  readonly summary: string;
  /** The change cannot be taken back by the undo of the run. */
  readonly irreversible?: boolean;
}

/** What a step says about itself when the run is planned. */
export interface StepPlanInput {
  readonly key: string;
  readonly title: string;
  readonly estimateSeconds: number;
  /** What the step is given when it runs: the parameters bound to it. JSON, and never a secret (a reference to one). */
  readonly input: JsonValue;
  readonly locks: readonly ResourceRef[];
  readonly items: readonly PlanItem[];
}

export interface PlannedStep {
  /** The place of the step in the run, from 0. The id of the step on a server is made from it. */
  readonly index: number;
  readonly key: string;
  readonly title: string;
  readonly estimateSeconds: number;
  readonly input: JsonValue;
  /** The locks of the step in the order they are taken, as `lockKey` writes them. */
  readonly locks: readonly string[];
  readonly items: readonly PlanItem[];
}

export interface RunPlan {
  readonly workflowKey: string;
  readonly params: JsonValue;
  readonly steps: readonly PlannedStep[];
  /** The locks of the whole run, in the order they are taken. */
  readonly locks: readonly string[];
  readonly estimateSeconds: number;
  /** The index of the first step that makes a change that cannot be taken back, or `null` when none does. */
  readonly irreversibleFrom: number | null;
}

export const MAX_PLAN_STEPS = 256;
export const MAX_ITEMS_PER_STEP = 512;

export class InvalidPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanError';
  }
}

const KEY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/u;

/** A key of a step or a workflow: lower-case words separated by dots, at least two, such as `node.install.nginx`. */
export const isKey = (value: string): boolean => value.length <= 80 && KEY.test(value);

/**
 * Puts the steps of a workflow in a plan: it numbers them, orders every lock set, joins them into the locks of the run and
 * adds up what a person wants to know before approving. `steps` is the list after the workflow's conditions were decided.
 */
export function buildPlan(input: {
  readonly workflowKey: string;
  readonly params: JsonValue;
  readonly steps: readonly StepPlanInput[];
}): RunPlan {
  if (!isKey(input.workflowKey)) {
    throw new InvalidPlanError(`"${input.workflowKey.slice(0, 60)}" is not a workflow key.`);
  }
  if (input.steps.length === 0) {
    throw new InvalidPlanError('A plan needs at least one step.');
  }
  if (input.steps.length > MAX_PLAN_STEPS) {
    throw new InvalidPlanError(`A plan has at most ${String(MAX_PLAN_STEPS)} steps.`);
  }
  const steps = input.steps.map((step, index): PlannedStep => {
    if (!isKey(step.key)) {
      throw new InvalidPlanError(
        `Step ${String(index)}: "${step.key.slice(0, 60)}" is not a step key.`,
      );
    }
    if (!Number.isFinite(step.estimateSeconds) || step.estimateSeconds < 0) {
      throw new InvalidPlanError(
        `Step ${String(index)} (${step.key}): the estimate must be zero or more seconds.`,
      );
    }
    if (step.items.length > MAX_ITEMS_PER_STEP) {
      throw new InvalidPlanError(
        `Step ${String(index)} (${step.key}) plans more than ${String(MAX_ITEMS_PER_STEP)} changes.`,
      );
    }
    // An input that cannot be hashed is refused here, with the same reason as for the parameters.
    canonicalJson(step.input);
    return {
      index,
      key: step.key,
      title: step.title,
      estimateSeconds: step.estimateSeconds,
      input: step.input,
      locks: orderLocks(step.locks).map(lockKey),
      // `irreversible: false` and no `irreversible` say the same, so they are written the same (and hash the same).
      items: step.items.map((item): PlanItem => ({
        kind: item.kind,
        target: item.target,
        summary: item.summary,
        ...(item.irreversible === true ? { irreversible: true } : {}),
      })),
    };
  });
  // A plan whose parameters cannot be hashed is refused here, when it is made, and not when somebody asks to approve it.
  canonicalJson(input.params);
  const runLocks = orderLocks(input.steps.flatMap((step) => step.locks)).map(lockKey);
  const firstIrreversible = steps.find((step) =>
    step.items.some((item) => item.irreversible === true),
  );
  return {
    workflowKey: input.workflowKey,
    params: input.params,
    steps,
    locks: runLocks,
    estimateSeconds: steps.reduce((sum, step) => sum + step.estimateSeconds, 0),
    irreversibleFrom: firstIrreversible?.index ?? null,
  };
}

/**
 * The hash that an approval is bound to. It covers what the run will do: the workflow, its parameters, the steps in
 * order, what each is given, their locks and their planned changes. It does not cover the title and the estimate of a
 * step, which only describe it: a better estimate from the history is not a different plan.
 */
export function planHash(plan: RunPlan): string {
  return sha256Hex(
    canonicalJson({
      workflowKey: plan.workflowKey,
      params: plan.params,
      steps: plan.steps.map((step) => ({
        index: step.index,
        key: step.key,
        input: step.input,
        locks: step.locks,
        items: step.items,
      })),
    }),
  );
}
