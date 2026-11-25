/**
 * The text a person types into the baseline editor, with the version it was typed for and the revision it started
 * from. The revision is taken at the first keystroke and kept through refetches: a save sends it as `expectedVersion`,
 * so a newer revision saved by someone else in the meantime makes the server refuse (409) instead of being overwritten.
 */
export interface Draft {
  /** The version picked in the editor; undefined is "the current one". */
  readonly version: number | undefined;
  /** The current revision of the baseline when the typing started. */
  readonly base: number;
  readonly text: string;
}

/** The draft after an edit. `text` undefined drops it; a draft for another version starts again. */
export function nextDraft(
  previous: Draft | undefined,
  version: number | undefined,
  text: string | undefined,
  currentVersion: number,
): Draft | undefined {
  if (text === undefined) {
    return undefined;
  }
  const base =
    previous !== undefined && previous.version === version ? previous.base : currentVersion;
  return { version, base, text };
}

/** The revision a save of `draft` expects: the one the typing started from, not the one the editor reads now. */
export const expectedVersionOf = (draft: Draft | undefined, currentVersion: number): number =>
  draft?.base ?? currentVersion;
