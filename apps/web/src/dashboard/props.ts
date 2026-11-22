// New in Swellwright (ADR 0047). The strict optional-property rule of this project means a card without a line under its
// value must not pass `subtitle={undefined}`; this spreads the prop only when there is a text.

/** The `subtitle` prop of a card, or nothing: a card without a line under its value has no such prop. */
export const sub = (text: string | undefined): { subtitle?: string } =>
  text === undefined ? {} : { subtitle: text };
