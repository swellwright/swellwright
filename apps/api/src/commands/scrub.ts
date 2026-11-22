import { runSecretMarker } from '@swellwright/contracts';

/** A secret of a run, as the scrubber needs it. */
export interface ScrubSecret {
  readonly name: string;
  readonly value: string;
}

interface Pattern {
  readonly name: string;
  readonly bytes: Buffer;
}

/** What one call to `scrub` made of the bytes it was given. */
export interface Scrubbed {
  /** What may be stored and shown: the input with every secret replaced by its marker, minus what is held back. */
  readonly out: Buffer;
  /** How many bytes of the input were dealt with. The rest (at most the longest secret minus one) is held back. */
  readonly consumed: number;
}

/**
 * Takes the values of the secrets of a run out of its output (ADR 0042): each is replaced by `[secret NAME]`, in the
 * stored output, in the tail of the run view and in everything that is read back, because nothing else is ever stored.
 *
 * What is looked for is the value without its trailing line break (a file of one line ends with one, and a script
 * that prints `$(cat file)` does not), so the line break after a printed value stays and the line goes on. It is a
 * literal match on the bytes: **best effort**. A script that transforms a value (base64, reversing, splitting it
 * over two lines, hashing) is not caught, and no program can promise that. The point is the ordinary accident: a script
 * that prints `cat "$NAME_FILE"` or `set -x`.
 *
 * Output arrives in pieces, and a value may straddle two of them. A piece therefore ends where the next one begins only
 * if its tail cannot be the beginning of a value: `scrub` holds back the longest such tail and says how many bytes it
 * dealt with, so the caller reads the held bytes again with the next piece. When no more output will come (`final`),
 * nothing is held back.
 */
export class OutputScrubber {
  private readonly patterns: readonly Pattern[];

  constructor(secrets: readonly ScrubSecret[]) {
    const patterns: Pattern[] = [];
    for (const secret of secrets) {
      const trimmed = secret.value.replace(/[\r\n]+$/u, '');
      // A value that is nothing but line breaks has nothing to hide that the line breaks do not show.
      const text = trimmed.length > 0 ? trimmed : secret.value;
      if (text.length > 0) {
        patterns.push({ name: secret.name, bytes: Buffer.from(text, 'utf8') });
      }
    }
    // Longest first: of two values that start at the same place the longer one is the secret.
    this.patterns = patterns.sort((a, b) => b.bytes.length - a.bytes.length);
  }

  /** Whether there is anything to look for. */
  get active(): boolean {
    return this.patterns.length > 0;
  }

  scrub(data: Buffer, options: { readonly final: boolean }): Scrubbed {
    const parts: Buffer[] = [];
    let position = 0;
    for (;;) {
      let best: { index: number; pattern: Pattern } | undefined;
      for (const pattern of this.patterns) {
        const index = data.indexOf(pattern.bytes, position);
        if (index < 0) {
          continue;
        }
        // The earliest match wins; patterns are longest first, so at the same place the longer one was found first.
        if (best === undefined || index < best.index) {
          best = { index, pattern };
        }
      }
      if (best === undefined) {
        break;
      }
      parts.push(
        data.subarray(position, best.index),
        Buffer.from(runSecretMarker(best.pattern.name)),
      );
      position = best.index + best.pattern.bytes.length;
    }
    const rest = data.subarray(position);
    const held = options.final ? 0 : this.heldBack(rest);
    parts.push(rest.subarray(0, rest.length - held));
    return { out: Buffer.concat(parts), consumed: data.length - held };
  }

  /** The longest tail of `rest` that is the beginning of a value (and not the whole of one). */
  private heldBack(rest: Buffer): number {
    let held = 0;
    for (const { bytes } of this.patterns) {
      const longest = Math.min(bytes.length - 1, rest.length);
      for (let length = longest; length > held; length -= 1) {
        if (rest.subarray(rest.length - length).equals(bytes.subarray(0, length))) {
          held = length;
          break;
        }
      }
    }
    return held;
  }
}
