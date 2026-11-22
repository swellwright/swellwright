import type {
  CheckFixHint,
  CheckObjectKind,
  CheckObjectRef,
  CheckParams,
  CheckSeverity,
  PanelResource,
  RuleParamInfo,
} from '@swellwright/contracts';
import { z } from 'zod';

import { type ModelIndex, type PanelModel, type Subject } from '../model.js';
import { type CompiledPattern } from '../safe-pattern.js';

// The shape of a rule, and what a rule is handed. A rule is a function of the model and of its own parameters that says
// what it found through `emit`; it never reads a clock, a network or a file, and it never writes. The engine decides
// whether a finding is within the scope of the pack, what severity it has, and how it reads.

export interface FindingInput {
  /** The kind of finding within the rule (`invalid`, `duplicate`, ...). */
  readonly code: string;
  /** The object the finding is about; the scope of the rule is judged on it. */
  readonly subject: Subject;
  /** The severity of this kind of finding; the pack can replace it for the whole rule. */
  readonly severity?: CheckSeverity;
  readonly related?: readonly CheckObjectRef[];
  /** Values for the message. Only what is not secret: the views are masked already. */
  readonly params?: CheckParams;
  /** JSON Pointers of the fields involved, into the editable form of the object. */
  readonly fields?: readonly string[];
  readonly fix?: CheckFixHint | null;
  /** Tells apart two findings of one code on one object (for example the two ends of a clash). */
  readonly key?: string;
}

export interface RuleContext {
  readonly model: PanelModel;
  readonly index: ModelIndex;
  readonly emit: (finding: FindingInput) => void;
  /** A pattern of the pack, compiled once (the safe subset of regular expressions). */
  readonly pattern: (source: string) => CompiledPattern;
}

/** A rule as the engine sees it, whatever its parameters are. */
export interface Rule {
  readonly id: string;
  readonly kind: CheckObjectKind;
  readonly defaultSeverity: CheckSeverity;
  readonly needs: readonly PanelResource[];
  readonly codes: readonly string[];
  readonly paramInfo: readonly RuleParamInfo[];
  /** The parameters that hold a pattern: checked when the pack is read. */
  readonly patternParams: readonly string[];
  /** Parameters that must be set (not null) for the rule to have anything to check. */
  readonly requires: readonly string[];
  /** The parameters with their defaults filled in, or the reasons they are not acceptable. */
  parseParams(
    input: unknown,
  ):
    | { ok: true; params: Record<string, unknown> }
    | { ok: false; issues: { path: string; message: string }[] };
  run(context: RuleContext, params: Record<string, unknown>): void;
}

interface RuleDefinition<S extends z.ZodObject> {
  readonly id: string;
  readonly kind: CheckObjectKind;
  readonly defaultSeverity: CheckSeverity;
  readonly needs: readonly PanelResource[];
  readonly codes: readonly string[];
  /** The parameters: a strict object in which every key has a default (or is nullable with a null default). */
  readonly params: S;
  readonly patternParams?: readonly string[];
  readonly requires?: readonly (keyof z.output<S> & string)[];
  run(context: RuleContext, params: z.output<S>): void;
}

/** What a JSON Schema property says, as the kind of control the console shows for it. */
function paramInfoOf(schema: z.ZodObject): RuleParamInfo[] {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, Record<string, unknown>>;
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => {
    const choose = (candidates: readonly unknown[]): Record<string, unknown> | undefined =>
      candidates.find(
        (c): c is Record<string, unknown> =>
          typeof c === 'object' && c !== null && (c as { type?: unknown }).type !== 'null',
      );
    const alternatives = Array.isArray(property['anyOf'])
      ? choose(property['anyOf'] as unknown[])
      : undefined;
    const shape: Record<string, unknown> = alternatives ?? property;
    const marker = property['x-sw-type'] ?? shape['x-sw-type'];
    const enumValues = shape['enum'];
    let type: RuleParamInfo['type'] = 'string';
    if (marker === 'pattern' || marker === 'ranges') {
      type = marker;
    } else if (Array.isArray(enumValues)) {
      type = 'enum';
    } else if (shape['type'] === 'boolean') {
      type = 'boolean';
    } else if (shape['type'] === 'number' || shape['type'] === 'integer') {
      type = 'number';
    } else if (shape['type'] === 'array') {
      type = 'string-list';
    }
    const description = property['description'];
    return {
      name,
      type,
      description: typeof description === 'string' ? description : '',
      default: property['default'] ?? null,
      values: Array.isArray(enumValues)
        ? enumValues.filter((v): v is string => typeof v === 'string')
        : null,
    };
  });
}

/** Turns what a rule says about itself into the value the engine handles; the cast is here and nowhere else. */
export function defineRule<S extends z.ZodObject>(definition: RuleDefinition<S>): Rule {
  return {
    id: definition.id,
    kind: definition.kind,
    defaultSeverity: definition.defaultSeverity,
    needs: definition.needs,
    codes: definition.codes,
    paramInfo: paramInfoOf(definition.params),
    patternParams: definition.patternParams ?? [],
    requires: definition.requires ?? [],
    parseParams: (input) => {
      const parsed = definition.params.safeParse(input ?? {});
      if (parsed.success) {
        return { ok: true, params: parsed.data };
      }
      return {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      };
    },
    run: (context, params) => {
      definition.run(context, params as z.output<S>);
    },
  };
}

// ---- parameter schemas ------------------------------------------------------------------------------------------

/** A pattern parameter: unset by default, which switches the rule off until the pack gives it one. */
export const patternParam = (description: string) =>
  z
    .string()
    .min(1)
    .max(256)
    .nullable()
    .default(null)
    .describe(description)
    .meta({ 'x-sw-type': 'pattern' });

export const RangeSchema = z.strictObject({
  from: z.number().int().min(0).max(1_000_000),
  to: z.number().int().min(0).max(1_000_000),
  reason: z.string().max(200).optional(),
});

/** Whole-number ranges, for the reserved values of a convention. */
export const rangesParam = (
  description: string,
  fallback: readonly { from: number; to: number; reason?: string }[],
) =>
  z
    .array(RangeSchema)
    .max(50)
    .default(fallback.map((range) => ({ ...range })))
    .describe(description)
    .meta({ 'x-sw-type': 'ranges' });

// ---- fix hints --------------------------------------------------------------------------------------------------

export const replaceHint = (
  path: string,
  from: string | number | boolean | null,
  to: string | number | boolean | null,
  note?: string,
): CheckFixHint => ({ op: 'replace', path, from, to, ...(note === undefined ? {} : { note }) });

export const addHint = (
  path: string,
  to: string | number | boolean | string[] | null,
  note?: string,
): CheckFixHint => ({ op: 'add', path, from: null, to, ...(note === undefined ? {} : { note }) });

export const removeHint = (
  path: string,
  from: string | number | boolean | string[] | null,
  note?: string,
): CheckFixHint => ({
  op: 'remove',
  path,
  from,
  to: null,
  ...(note === undefined ? {} : { note }),
});

/** Shortens a value that goes into a message, so that one long remark does not make a long line. */
export const clip = (text: string, width = 100): string =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`;
