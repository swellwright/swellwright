// What the next worker does with a step that a crash left `running` (ADR 0048, "A checkpoint is one transaction"), and
// where a run goes on when it is taken up again.
//
// A step goes `pending → running` in one transaction, `apply` runs, and `running → succeeded` is another transaction. A crash
// between them leaves a `running` step in a run whose lease has expired. These functions decide, from what the step declares
// and not from the world, what to do about it; looking at the world is `reconcile` or `apply` itself.

import type { StepState } from './step-state.js';

export interface StepDeclaration {
  /** `apply` can be run again with the same result. The default for a step is `true`. */
  readonly idempotent: boolean;
  /** The step can look at the world and say whether its effect is there. */
  readonly hasReconcile: boolean;
}

export type RecoveryAction =
  /** Ask the step (`reconcile`) before doing anything. */
  | 'reconcile'
  /** Run `apply` again; on a server that is attaching to the detached step by its id. */
  | 'rerun'
  /** Stop and wait for a person: retry, mark the step done, or roll the run back. */
  | 'ask_person';

/**
 * What to do about an interrupted step. A person's choice to retry wins over everything, because the person took the
 * decision. Otherwise a step that can look at the world is asked first, whether or not it is idempotent: for a change on
 * the panel or in DNS "again" is not free. A step that cannot look is run again only when it is idempotent, and is never
 * retried by itself when it is not.
 */
export function decideRecovery(
  step: StepDeclaration,
  options: { readonly personChoseRetry?: boolean } = {},
): RecoveryAction {
  if (options.personChoseRetry === true) {
    return 'rerun';
  }
  if (step.hasReconcile) {
    return 'reconcile';
  }
  return step.idempotent ? 'rerun' : 'ask_person';
}

export const RECONCILE_ANSWERS = ['done', 'not_done', 'partial'] as const;
export type ReconcileAnswer = (typeof RECONCILE_ANSWERS)[number];

export type AfterReconcile =
  /** The effect is there: record the success (with the output the step gave), do not run `apply`. */
  'record_success' | 'rerun' | 'ask_person';

/**
 * What to do with the answer of `reconcile`. `done` records the success; `not_done` is safe to run again, even for a step
 * that is not idempotent, because nothing was done; `partial` is run again only by a step that is idempotent.
 */
export function afterReconcile(
  step: Pick<StepDeclaration, 'idempotent'>,
  answer: ReconcileAnswer,
): AfterReconcile {
  switch (answer) {
    case 'done':
      return 'record_success';
    case 'not_done':
      return 'rerun';
    case 'partial':
      return step.idempotent ? 'rerun' : 'ask_person';
  }
}

export type ResumePoint =
  | {
      readonly kind: 'step';
      readonly index: number;
      readonly state: 'pending' | 'running' | 'failed';
    }
  | { readonly kind: 'done' };

/**
 * Where a run goes on: the first step that is neither `succeeded` nor `skipped`. A step that was undone is never met by a
 * run that goes forward (a rollback has no way back to `running`), so meeting one is an error in the data, not a case.
 */
export function resumePoint(steps: readonly { readonly state: StepState }[]): ResumePoint {
  for (const [index, step] of steps.entries()) {
    switch (step.state) {
      case 'succeeded':
      case 'skipped':
        break;
      case 'pending':
      case 'running':
      case 'failed':
        return { kind: 'step', index, state: step.state };
      case 'undone':
      case 'undo_failed':
        throw new RangeError(
          `Step ${String(index)} is ${step.state}: a run that goes forward cannot meet it.`,
        );
    }
  }
  return { kind: 'done' };
}
