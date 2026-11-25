// The steps that the loop can run, by key (ADR 0048). A run row names a step by its key and holds its input as JSON, so the
// loop meets every step without knowing its types: the registry wraps a typed step in functions over `unknown` that parse
// the input and the output with the step's own schemas, and nothing else is cast.
//
// The registry is also the one place that plans a step. A workflow says which step it wants and with which parameters
// (`StepCall`), never what the step locks or changes: the plan is made here, from the same definition and the same parsed
// input that the loop runs, so a plan cannot lock one resource and a run touch another.

import { canonicalJson, type JsonValue, type StepPlanInput } from './plan.js';
import {
  InvalidStepInputError,
  type DefinedStep,
  type PlanContext,
  type StepContext,
  type UndoRecordDraft,
} from './step.js';

/**
 * What a step gave, after its schema accepted it: the value that is stored, and `verify` and `undo` with that same value bound
 * to them. The schema is applied once, so what the step is verified against and what its undo records are made from is what the
 * checkpoint holds, even for a schema that changes what it parses.
 */
export interface CheckedOutput<Ports> {
  readonly value: unknown;
  /** Does nothing when the step has no `verify`. */
  readonly verify: (ctx: StepContext<Ports>) => Promise<void>;
  /** Gives no records when the step has no `undo`. */
  readonly undo: (ctx: StepContext<Ports>) => Promise<readonly UndoRecordDraft[]>;
}

/** What `reconcile` found, with the output already checked when the effect is there. */
export type RegisteredReconcileResult<Ports> =
  | { readonly status: 'done'; readonly checked: CheckedOutput<Ports> }
  | { readonly status: 'not_done' }
  | { readonly status: 'partial'; readonly detail?: string };

export interface RegisteredStep<Ports> {
  readonly key: string;
  readonly idempotent: boolean;
  /**
   * What the step says about itself in a plan, for these parameters (as a caller gave them). It throws
   * `InvalidStepInputError` when the parameters are not JSON or do not fit the step's schema.
   */
  readonly plan: (ctx: PlanContext<Ports>, rawParams: unknown) => Promise<StepPlanInput>;
  readonly apply: (ctx: StepContext<Ports>, rawInput: unknown) => Promise<unknown>;
  /** Checks what `apply` gave (or `reconcile` found) against the step's schema. Throws when it does not fit. */
  readonly check: (raw: unknown) => CheckedOutput<Ports>;
  readonly reconcile:
    | ((ctx: StepContext<Ports>, rawInput: unknown) => Promise<RegisteredReconcileResult<Ports>>)
    | null;
}

const toJson = (value: unknown): JsonValue => JSON.parse(canonicalJson(value)) as JsonValue;

export class StepRegistry<Ports> {
  private readonly steps = new Map<string, RegisteredStep<Ports>>();

  register<P, R>(step: DefinedStep<P, R, Ports>): this {
    if (this.steps.has(step.key)) {
      throw new Error(`The step ${step.key} is registered twice.`);
    }
    const { verify, undo, reconcile } = step;
    const check = (raw: unknown): CheckedOutput<Ports> => {
      const value = step.output.parse(raw);
      return {
        value,
        verify: async (ctx) => {
          await verify?.(ctx, value);
        },
        undo: async (ctx) => (undo === undefined ? [] : undo(ctx, value)),
      };
    };
    this.steps.set(step.key, {
      key: step.key,
      idempotent: step.idempotent,
      plan: async (ctx, rawParams) => {
        // What is stored for the step is the parameters as JSON, and what the step runs on is that JSON parsed by its schema.
        // Planning parses the same thing, not what the caller held: a schema that tells "not set" from "absent" must see what
        // the run will see, or the plan would lock one resource and the step would change another.
        let stored: JsonValue;
        let params: P;
        try {
          stored = toJson(rawParams);
          params = step.input.parse(stored);
        } catch (error) {
          throw new InvalidStepInputError(
            step.key,
            error instanceof Error ? error.message : 'the input does not fit',
          );
        }
        return {
          key: step.key,
          title: step.title(ctx, params),
          estimateSeconds: step.estimateSeconds(ctx, params),
          input: stored,
          locks: step.locks(ctx, params),
          items: await step.plan(ctx, params),
        };
      },
      apply: (ctx, rawInput) => step.apply(ctx, step.input.parse(rawInput)),
      check,
      reconcile:
        reconcile === undefined
          ? null
          : async (ctx, rawInput) => {
              const found = await reconcile(ctx, step.input.parse(rawInput));
              return found.status === 'done'
                ? { status: 'done', checked: check(found.output) }
                : found;
            },
    });
    return this;
  }

  get(key: string): RegisteredStep<Ports> | undefined {
    return this.steps.get(key);
  }

  has(key: string): boolean {
    return this.steps.has(key);
  }

  keys(): readonly string[] {
    return [...this.steps.keys()].sort();
  }
}
