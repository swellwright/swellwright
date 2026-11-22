import { readFileSync } from 'node:fs';

import { type ParsedBaseline, parseBaselineSource } from './document.js';

/** A baseline that ships with Swellwright (ADR 0045): a YAML file in `builtin/`, kept current by name at start. */
export interface BuiltinBaseline {
  readonly name: string;
  readonly description: string;
  /** The file as it is, with its comments: what the console shows. */
  readonly source: string;
  readonly parsed: ParsedBaseline;
}

const FILES: readonly { readonly name: string; readonly file: string }[] = [
  { name: 'linux-generic', file: 'linux-generic.yaml' },
  { name: 'node-selfsteal', file: 'node-selfsteal.yaml' },
];

let loaded: readonly BuiltinBaseline[] | undefined;

/**
 * Reads and validates the built-in baselines. A file that is not valid is a defect of this build and stops the start with
 * the first problem named, rather than being found when somebody runs a check.
 */
export function loadBuiltinBaselines(): readonly BuiltinBaseline[] {
  if (loaded) {
    return loaded;
  }
  loaded = FILES.map(({ name, file }) => {
    const source = readFileSync(new URL(`./builtin/${file}`, import.meta.url), 'utf8').replaceAll(
      '\r\n',
      '\n',
    );
    const result = parseBaselineSource(source);
    if (!result.ok) {
      const first = result.issues[0];
      throw new Error(
        `The built-in baseline ${name} is not valid: ${first?.path ?? ''} ${first?.message ?? ''} (line ${String(first?.line ?? 0)}).`,
      );
    }
    return {
      name,
      description: result.parsed.document.description ?? name,
      source,
      parsed: result.parsed,
    };
  });
  return loaded;
}
