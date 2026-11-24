// The order of an undo and its verdict (ADR 0048, "Stopping, pausing, resuming and undoing"; design 08 section 5).
//
// A step writes its undo records in the transaction that records its success. Undoing a run goes through them in reverse,
// each as a step of its own, against the world as it is now. A rollback that was interrupted is resumed, so a record that
// is done is not done again and a record that failed is tried again.

export const UNDO_STATES = ['pending', 'done', 'failed'] as const;
export type UndoState = (typeof UNDO_STATES)[number];

/** The part of an undo record that the order depends on. */
export interface UndoRecordRef {
  /** The index of the step that wrote the record. */
  readonly stepIndex: number;
  /** The place of the record among the records of its step, from 0, in the order they were written. */
  readonly seq: number;
  readonly state: UndoState;
}

/**
 * The records still to be undone, in the order to undo them: the last step first and, inside a step, the last record
 * first, so what was made last is taken back first. Records that are done are left out, records that failed come back.
 * The input is not changed.
 */
export function undoOrder<T extends UndoRecordRef>(records: readonly T[]): T[] {
  return records
    .filter((record) => record.state !== 'done')
    .sort((a, b) => b.stepIndex - a.stepIndex || b.seq - a.seq);
}

export type RollbackVerdict =
  | { readonly state: 'rolled_back' }
  | {
      readonly state: 'rollback_partial';
      /** Records that were not tried yet. */
      readonly pending: number;
      /** Records whose undo failed. */
      readonly failed: number;
      /** What the check of the workflow still finds different from before the run. */
      readonly differences: readonly string[];
    };

/**
 * `rolled_back` only when every record is done and the check that the workflow declares finds no difference from the world
 * before the run; otherwise `rollback_partial` with what is left. `differences` is `null` for a workflow that declares no
 * check: then the records alone decide.
 */
export function rollbackVerdict(input: {
  readonly records: readonly Pick<UndoRecordRef, 'state'>[];
  readonly differences: readonly string[] | null;
}): RollbackVerdict {
  const pending = input.records.filter((record) => record.state === 'pending').length;
  const failed = input.records.filter((record) => record.state === 'failed').length;
  const differences = input.differences ?? [];
  if (pending === 0 && failed === 0 && differences.length === 0) {
    return { state: 'rolled_back' };
  }
  return { state: 'rollback_partial', pending, failed, differences: [...differences] };
}
