/** A value that has to be there, or a failed test; keeps the lines after it free of `?.` on what is known to exist. */
export function must<T>(value: T | null | undefined, what = 'a value'): T {
  if (value === undefined || value === null) {
    throw new Error(`${what} is missing`);
  }
  return value;
}
