import { createHash } from 'node:crypto';

import {
  BASELINE_CATEGORIES,
  type BaselineDocument,
  BaselineDocumentSchema,
  type BaselineIssue,
  baselineWriteIssues,
  type ValidateBaselineResult,
} from '@swellwright/contracts';
import { LineCounter, parseDocument } from 'yaml';
import type { z } from 'zod';

type Issue = z.core.$ZodIssue;

/** A document as the API keeps it: the parsed form, its canonical hash, and the text it was written as. */
export interface ParsedBaseline {
  readonly document: BaselineDocument;
  readonly sha256: string;
}

export type SourceResult =
  | { readonly ok: true; readonly parsed: ParsedBaseline }
  | { readonly ok: false; readonly issues: readonly BaselineIssue[] };

/** JSON with the keys of every object in order, so that the same document always has the same text and the same hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function documentHash(document: BaselineDocument): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

/** `checks[3].observe.field` for the path of an issue. */
function pathText(path: readonly PropertyKey[]): string {
  let text = '';
  for (const part of path) {
    text +=
      typeof part === 'number' ? `[${String(part)}]` : `${text === '' ? '' : '.'}${String(part)}`;
  }
  return text;
}

interface Located {
  readonly line: number | null;
  readonly column: number | null;
}

/**
 * The parser of a document that is WRITTEN (created, changed, validated, a built-in one): it applies the rules for
 * writing (`baselineWriteIssues`) on top of the schema. A stored version is read with the schema alone
 * (`BaselinesService.documentOf`), so a version saved under older rules stays readable and runnable.
 *
 * Parses YAML (JSON is YAML) and checks the document against the schema, the catalogue and the comparator rules. Every
 * problem comes with the line and column it was found at, so that an editor can underline it. Aliases are refused: a
 * baseline has no use for them and a few of them can expand to a very large document.
 */
export function parseBaselineSource(source: string): SourceResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
  });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.slice(0, 20).map((error) => {
        const [start] = error.pos;
        const where = lineCounter.linePos(start);
        return {
          path: '',
          message: error.message.split('\n')[0] ?? 'The text is not valid YAML.',
          line: where.line,
          column: where.col,
        };
      }),
    };
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: 'Aliases and anchors are not allowed in a baseline.',
          line: null,
          column: null,
        },
      ],
    };
  }
  const locate = (path: readonly PropertyKey[]): Located => {
    // The node of the path, or of the closest parent that exists in the text.
    for (let length = path.length; length >= 0; length -= 1) {
      const node = doc.getIn(path.slice(0, length) as (string | number)[], true) as
        { range?: [number, number, number] | null } | undefined;
      const start = node?.range?.[0];
      if (start !== undefined) {
        const where = lineCounter.linePos(start);
        return { line: where.line, column: where.col };
      }
    }
    return { line: null, column: null };
  };
  const result = BaselineDocumentSchema.safeParse(value);
  if (result.success) {
    // A document written now also meets the rules for writing (a stored version is read with the schema alone).
    const strict = baselineWriteIssues(result.data);
    if (strict.length > 0) {
      return {
        ok: false,
        issues: strict.slice(0, 50).map((issue) => ({
          path: pathText(issue.path),
          message: issue.message,
          ...locate(issue.path),
        })),
      };
    }
  }
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.slice(0, 50).map((issue: Issue) => ({
        path: pathText(issue.path),
        message: issueMessage(issue),
        ...locate(issue.path),
      })),
    };
  }
  return {
    ok: true,
    parsed: { document: result.data, sha256: documentHash(result.data) },
  };
}

/** A sentence for an issue of the schema that does not make the reader decode Zod. */
function issueMessage(issue: Issue): string {
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as Issue & { keys: string[] }).keys.join(', ');
    return `Unknown key: ${keys}.`;
  }
  if (issue.code === 'invalid_value' && 'values' in issue) {
    return `Use one of: ${(issue as Issue & { values: unknown[] }).values.map(String).join(', ')}.`;
  }
  return issue.message;
}

/** The answer of `POST /baselines/validate`. */
export function validateBaselineSource(source: string): ValidateBaselineResult {
  const result = parseBaselineSource(source);
  if (!result.ok) {
    return {
      valid: false,
      issues: [...result.issues],
      checkCount: 0,
      categories: [],
      sha256: null,
    };
  }
  const { document, sha256 } = result.parsed;
  return {
    valid: true,
    issues: [],
    checkCount: document.checks.length,
    categories: BASELINE_CATEGORIES.map((category) => ({
      category,
      checks: document.checks.filter((check) => check.category === category).length,
    })).filter((entry) => entry.checks > 0),
    sha256,
  };
}
