// The forms a masked value of the panel takes (ADR 0041). They are written by `@swellwright/remnawave` and read by
// everything that must tell a mask from a value (the impact calculator, the snapshot diff), so they are defined once.

/** What a text that is not one clean document becomes: none of it is shown. */
export const UNREADABLE_DOCUMENT = '[masked: unreadable document]';
/** A masking budget was exceeded: no prefix of the input is shown. */
export const MASK_TOO_LARGE = '[masked: too large]';

/**
 * Every form of a mask, as the source of a regular expression: `[masked]`, a fingerprint `[masked:1a2b3c4d]` and
 * `[masked: unreadable document]`, and `[masked: too large]`.
 */
export const MASK_PATTERN_SOURCE = String.raw`\[masked(?::[0-9a-f]{8}|: unreadable document|: too large)?\]`;

const WHOLE_MASK = new RegExp(`^${MASK_PATTERN_SOURCE}$`, 'u');
const ANY_MASK = new RegExp(MASK_PATTERN_SOURCE, 'u');

/** The value is a mask, whole. */
export const isMaskText = (value: unknown): boolean =>
  typeof value === 'string' && WHOLE_MASK.test(value);

/** The text holds a mask somewhere. */
export const containsMaskText = (text: string): boolean => ANY_MASK.test(text);
