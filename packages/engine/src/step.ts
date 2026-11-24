// What a step is (ADR 0048, "The step contract"; design 08 section 2).
//
// The contract of the design with what the core needs on top of it: the declarations that decide how an interrupted step is
// recovered, a context that carries the fence, the cancellation signal, the clock and the ports, and a schema for the input
// and one for the output.
// A step never reads the database and never holds a secret: a secret is a reference that a port opens.

import { isKey, type JsonValue, type PlanItem } from './plan.js';
import type { ResourceRef } from './locks.js';

/** The part of a Zod schema that the engine uses, so the engine does not depend on a validation library. */
export interface Schema<T> {
  parse(input: unknown): T;
}

/** How to undo one thing a step did. `data` holds no secret. */
export interface UndoRecordDraft {
  readonly kind: string;
  readonly data: JsonValue;
}

/** What `reconcile` found when it looked at the world. */
export type ReconcileResult<R> =
  | { readonly status: 'done'; readonly output: R }
  | { readonly status: 'not_done' }
  | { readonly status: 'partial'; readonly detail?: string };

/** What a step may use while a run is planned: the ports (read only), the clock and a signal that says "stop". */
export interface PlanContext<Ports> {
  readonly ports: Ports;
  readonly signal: AbortSignal;
  /** Milliseconds since the epoch. A test supplies a fake one. */
  now(): number;
}

/** What a step gets while it runs. */
export interface StepContext<Ports> extends PlanContext<Ports> {
  readonly runId: string;
  readonly stepIndex: number;
  /** How many times the step has been started, from 1. */
  readonly attempt: number;
  /** The fence of the worker that runs the step. */
  readonly fence: number;
  /** The id of the step on a server, so a second worker attaches to it instead of starting it again. */
  readonly remoteId: string;
}

/**
 * The contract of design 08 section 2. It differs from the text there in what the functions are given: `title`,
 * `estimateSeconds` and `locks` get the parameters too, because what a step locks and how long it takes depend on them.
 * A step is a plain object whose members are functions; none of them uses `this`.
 */
export interface Step<P, R, Ports = unknown> {
  /** `node.install.nginx`: lower-case words separated by dots. */
  readonly key: string;
  readonly title: (ctx: PlanContext<Ports>, params: P) => string;
  readonly estimateSeconds: (ctx: PlanContext<Ports>, params: P) => number;
  readonly locks: (ctx: PlanContext<Ports>, params: P) => readonly ResourceRef[];
  /** What the step will change. Read only. */
  readonly plan: (ctx: PlanContext<Ports>, params: P) => Promise<readonly PlanItem[]>;
  readonly apply: (ctx: StepContext<Ports>, params: P) => Promise<R>;
  readonly verify?: (ctx: StepContext<Ports>, output: R) => Promise<void>;
  /** The undo records, written in the same transaction as the success of the step. */
  readonly undo?: (ctx: StepContext<Ports>, output: R) => Promise<readonly UndoRecordDraft[]>;
  /** `apply` can be run again with the same result. Default `true`. */
  readonly idempotent?: boolean;
  /** Looks at the world and says whether the effect of an interrupted `apply` is there. */
  readonly reconcile?: (ctx: StepContext<Ports>, params: P) => Promise<ReconcileResult<R>>;
  /** What the plan stores for the step is checked against it before the step uses it: the row is not trusted. */
  readonly input: Schema<P>;
  /** What `apply` returns is checked against it before it is written. */
  readonly output: Schema<R>;
}

/**
 * What a step throws to fail with a code that people and the API can rely on (the codes of docs/en/api.md). Any other
 * error ends the step as `step_error`, with a message that is cut short and never read as a code.
 */
export class StepFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StepFailure';
    this.code = code;
  }
}

/**
 * What a step throws when it cannot go on now and has done nothing yet (the vault is sealed, a port is not ready): the step
 * goes back to waiting and the run waits with the reason. It is only for the time before the first effect; after it the
 * step must finish, fail, or leave the decision to its recovery.
 */
export class StepDeferredError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The step cannot go on now: ${reason}`);
    this.name = 'StepDeferredError';
    this.reason = reason;
  }
}

/** A step as the engine holds it: the defaults are filled in and the declarations are the ones recovery reads. */
export type DefinedStep<P, R, Ports = unknown> = Step<P, R, Ports> & {
  readonly idempotent: boolean;
};

export class InvalidStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStepError';
  }
}

/** Checks a step once, when it is defined, and fills in the default (`idempotent: true`). */
export function defineStep<P, R, Ports = unknown>(
  step: Step<P, R, Ports>,
): DefinedStep<P, R, Ports> {
  if (!isKey(step.key)) {
    throw new InvalidStepError(
      `"${step.key.slice(0, 60)}" is not a step key: use lower-case words separated by dots.`,
    );
  }
  return Object.freeze({ ...step, idempotent: step.idempotent ?? true });
}

const REMOTE_ID = /^[a-z0-9-]{1,64}$/u;

/**
 * The id of a step on a server: the run and the place of the step in it. Both workers that run the same step make the same
 * id, so the second attaches to the first one's process. It has the shape that the detached steps of `packages/ssh` accept.
 */
export function remoteId(runId: string, stepIndex: number): string {
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    throw new RangeError('The index of a step is a whole number from 0.');
  }
  const id = `${runId}-${String(stepIndex)}`;
  if (!REMOTE_ID.test(id)) {
    throw new RangeError(
      'The id of a step on a server is lower-case letters, digits and dashes, at most 64 characters.',
    );
  }
  return id;
}
