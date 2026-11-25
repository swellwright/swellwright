// What a store can keep (ADR 0048, "The stores keep the same rules"): the sizes of the columns of the tables of runs and the
// values that PostgreSQL refuses, written once so that the store in memory and the one over PostgreSQL refuse the same.
//
// A worker that did a step and then could not write its checkpoint does not fail the run: it is a crash from the point of view of
// the lease, and the step is looked at again. So a value that only the database refuses (a NUL in a text, a code longer than its
// column) would repeat a step on a server for ever. The worker checks every such value before it acts on the result, and
// the stores refuse it with `InvalidDataError` when someone else writes it.

import { CanonicalJsonError, canonicalJson, type JsonValue } from './plan.js';
import type { UndoRecordDraft } from './step.js';
import { InvalidDataError } from './store.js';

/** `error_code` of a step. */
export const MAX_ERROR_CODE = 80;
/** `kind` of an undo record. */
export const MAX_UNDO_KIND = 80;
/** `waiting` of a run: why it is not going on. */
export const MAX_WAITING = 300;
/** `error_message` of a step. */
export const MAX_ERROR_MESSAGE = 500;

/**
 * A text for a column that is a diagnostic and not a value to match on (an error message, the reason a run waits): the NUL
 * characters and lone surrogates that the database refuses are removed, and it is cut to the size of its column. A text that
 * a person reads is better cut than refused.
 */
export function cleanText(text: string, max: number): string {
  const wellFormed = text.replaceAll('\u0000', '').toWellFormed();
  // A cut can split a pair of surrogates in two; the half that is left is replaced.
  return (wellFormed.length > max ? wellFormed.slice(0, max) : wellFormed).toWellFormed();
}

/** Can this text be the code or the kind that is stored and matched on, as it is? */
export function isIdentifier(value: string, max: number): boolean {
  return (
    value.length > 0 && value.length <= max && !value.includes('\u0000') && value.isWellFormed()
  );
}

/** A code or a kind that does not fit its column is refused, not cut: a cut code would be another code. */
export function assertIdentifier(what: string, value: string, max: number): void {
  if (!isIdentifier(value, max)) {
    throw new InvalidDataError(
      `${what} must be from 1 to ${String(max)} characters, without a NUL or a lone surrogate.`,
    );
  }
}

/**
 * The JSON that a column holds for this value: the canonical text parsed back, so what is stored is what was hashed. A value
 * that JSON cannot say, or that the database cannot hold, is `InvalidDataError`.
 */
export function storableJson(what: string, value: unknown): JsonValue {
  try {
    return JSON.parse(canonicalJson(value)) as JsonValue;
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new InvalidDataError(`${what} cannot be stored: ${error.message}`);
    }
    throw error;
  }
}

/** What a checkpoint writes: the output and the undo records. */
export function assertStorableCheckpoint(output: unknown, undo: readonly UndoRecordDraft[]): void {
  storableJson('The output of a step', output);
  for (const draft of undo) {
    assertIdentifier('The kind of an undo record', draft.kind, MAX_UNDO_KIND);
    storableJson('The data of an undo record', draft.data);
  }
}
