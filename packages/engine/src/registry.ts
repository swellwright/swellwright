// The steps that the loop can run, by key (ADR 0048). A run row names a step by its key and holds its input as JSON, so the
// loop meets every step without knowing its types: the registry wraps a typed step in functions over `unknown` that parse
// the input and the output with the step's own schemas, and nothing else is cast.

import type { DefinedStep, ReconcileResult, StepContext, UndoRecordDraft } from './step.js';

export interface RegisteredStep<Ports> {
  readonly key: string;
  readonly idempotent: boolean;
  readonly apply: (ctx: StepContext<Ports>, rawInput: unknown) => Promise<unknown>;
  /** Checks what `apply` gave (or `reconcile` found) against the step's schema. Throws when it does not fit. */
  readonly parseOutput: (raw: unknown) => unknown;
  readonly verify: ((ctx: StepContext<Ports>, output: unknown) => Promise<void>) | null;
  readonly undo:
    ((ctx: StepContext<Ports>, output: unknown) => Promise<readonly UndoRecordDraft[]>) | null;
  readonly reconcile:
    ((ctx: StepContext<Ports>, rawInput: unknown) => Promise<ReconcileResult<unknown>>) | null;
}

export class StepRegistry<Ports> {
  private readonly steps = new Map<string, RegisteredStep<Ports>>();

  register<P, R>(step: DefinedStep<P, R, Ports>): this {
    if (this.steps.has(step.key)) {
      throw new Error(`The step ${step.key} is registered twice.`);
    }
    const { verify, undo, reconcile } = step;
    this.steps.set(step.key, {
      key: step.key,
      idempotent: step.idempotent,
      apply: (ctx, rawInput) => step.apply(ctx, step.input.parse(rawInput)),
      parseOutput: (raw) => step.output.parse(raw),
      verify: verify === undefined ? null : (ctx, output) => verify(ctx, step.output.parse(output)),
      undo: undo === undefined ? null : (ctx, output) => undo(ctx, step.output.parse(output)),
      reconcile:
        reconcile === undefined
          ? null
          : async (ctx, rawInput) => {
              const found = await reconcile(ctx, step.input.parse(rawInput));
              return found.status === 'done'
                ? { status: 'done', output: step.output.parse(found.output) }
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
