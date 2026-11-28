import { z } from 'zod';

import { type ConfigSchemaFile, type ConfigValues, secretFields } from './config-schema.js';
import { DECLARATIVE_KINDS, type PluginManifest } from './manifest.js';

/**
 * Declarative drivers (ADR 0030): a plugin for a REST service described in data (`driver.yaml`, parsed by the
 * core), so that it needs no code of its own and runs none. The core makes the requests, through the same gateway
 * and under the same approvals as a plugin's code would. There are no loops, no conditions, no functions: only
 * values taken from known places and put into requests and results.
 *
 * Where values come from, and where each may be used:
 *   `params.x`        what the caller of the operation passed (checked against the declared `params`)
 *   `config.x`        a setting the administrator entered (not a secret)
 *   `secret.x`        the secret bound to a settings field (requests only, never a result)
 *   `steps.id.…`      an earlier step's answer: `status`, `headers.name`, `text`, `json.a.b[0]` (not in a request
 *                     of the same step)
 *   the `as` name of an `each`, inside its `map` (results only)
 */

export const DRIVER_LIMITS = {
  operations: 32,
  steps: 8,
  templateChars: 2000,
  nodes: 500,
  depth: 8,
  fileBytes: 128 * 1024,
  resultBytes: 1024 * 1024,
  /** The parts a result or a request body may be built of once `each` loops are run. */
  renderNodes: 20_000,
} as const;

const NAME = /^[a-z][A-Za-z0-9]{0,39}$/u;
const HEADER = /^[A-Za-z0-9-]{1,64}$/u;

// ------------------------------------------------------------------ templates

export type Token = string | number;

interface Expression {
  readonly path: readonly Token[];
  readonly filters: readonly string[];
}

type Segment = string | Expression;

/** `raw` turns off the encoding a value gets in a URL (a token that must stay as it is). */
const FILTERS = new Set(['json', 'urlencode', 'base64', 'raw']);

/** Splits `text {{ params.a | json }} text` into text and expressions. Throws on anything it cannot read. */
export function parseTemplate(template: string): Segment[] {
  if (template.length > DRIVER_LIMITS.templateChars) {
    throw new DriverError(
      `a template is at most ${String(DRIVER_LIMITS.templateChars)} characters`,
    );
  }
  const segments: Segment[] = [];
  let at = 0;
  for (;;) {
    const open = template.indexOf('{{', at);
    if (open === -1) {
      if (at < template.length) {
        segments.push(template.slice(at));
      }
      return segments;
    }
    if (open > at) {
      segments.push(template.slice(at, open));
    }
    const close = template.indexOf('}}', open + 2);
    if (close === -1) {
      throw new DriverError('a "{{" is not closed');
    }
    segments.push(parseExpression(template.slice(open + 2, close)));
    at = close + 2;
  }
}

function parseExpression(source: string): Expression {
  const [pathText = '', ...filterTexts] = source.split('|').map((part) => part.trim());
  const filters: string[] = [];
  for (const filter of filterTexts) {
    if (!FILTERS.has(filter)) {
      throw new DriverError(`"${filter}" is not a filter (${[...FILTERS].join(', ')})`);
    }
    filters.push(filter);
  }
  const path: Token[] = [];
  const pattern =
    /^([A-Za-z][A-Za-z0-9]*)|\.([A-Za-z0-9_][A-Za-z0-9_-]*)|\[(\d{1,4})\]|\["([^"\\]{1,64})"\]/uy;
  let at = 0;
  while (at < pathText.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(pathText);
    if (match === null) {
      throw new DriverError(
        `"${pathText}" is not a path like params.name or steps.list.json.items[0]`,
      );
    }
    const [whole, root, key, index, quoted] = match;
    path.push(root ?? key ?? quoted ?? Number(index));
    at += whole.length;
  }
  if (path.length === 0 || typeof path[0] !== 'string') {
    throw new DriverError('an expression is empty');
  }
  return { path, filters };
}

/** The expressions of a template, to check where they point. */
function expressionsOf(template: string): Expression[] {
  return parseTemplate(template).filter((s): s is Expression => typeof s !== 'string');
}

// ------------------------------------------------------------------ the driver

export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverError';
  }
}

const Template = z.string().max(DRIVER_LIMITS.templateChars);

const ParamDef = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    required: z.boolean().optional(),
    default: z.string().max(65536).optional(),
    maxLength: z.number().int().min(1).max(65536).optional(),
    enum: z.array(z.string().max(200)).min(1).max(64).optional(),
  }),
  z.strictObject({
    type: z.literal('integer'),
    required: z.boolean().optional(),
    default: z.number().int().optional(),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
  }),
  z.strictObject({
    type: z.literal('number'),
    required: z.boolean().optional(),
    default: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal('boolean'),
    required: z.boolean().optional(),
    default: z.boolean().optional(),
  }),
]);
export type ParamDef = z.infer<typeof ParamDef>;

const StepSchema = z.strictObject({
  id: z.string().regex(NAME),
  request: z.strictObject({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    url: Template,
    headers: z.record(z.string().regex(HEADER), Template).optional(),
    /** A text template, or a JSON value whose strings are templates. */
    body: z.unknown().optional(),
  }),
  expect: z
    .strictObject({
      /** Statuses that count as success; by default any 2xx. */
      status: z.array(z.number().int().min(100).max(599)).min(1).max(10).optional(),
      /** What to say when it is not one of them, if the service says it in its answer. */
      error: Template.optional(),
    })
    .optional(),
});
export type Step = z.infer<typeof StepSchema>;

const OperationSchema = z.strictObject({
  description: z.string().max(200).optional(),
  params: z.record(z.string().regex(NAME), ParamDef).optional(),
  steps: z.array(StepSchema).min(1).max(DRIVER_LIMITS.steps),
  /** The value the operation returns: templates in a JSON shape, with `each` for lists. */
  result: z.unknown().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const DriverSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(DECLARATIVE_KINDS),
  operations: z.record(z.string().regex(NAME), OperationSchema),
});
export type Driver = z.infer<typeof DriverSchema>;

interface Place {
  readonly params: ReadonlySet<string>;
  readonly steps: ReadonlySet<string>;
  readonly secretsAllowed: boolean;
  readonly extra: ReadonlySet<string>;
}

/** Checks that a template reads only from places that exist where it is used. */
function checkTemplate(template: string, place: Place, where: string, problems: string[]): void {
  let expressions: Expression[];
  try {
    expressions = expressionsOf(template);
  } catch (error) {
    problems.push(
      `${where}: ${error instanceof Error ? error.message : 'a template cannot be read'}`,
    );
    return;
  }
  for (const { path } of expressions) {
    const [root, name] = path;
    if (root === 'params') {
      if (typeof name !== 'string' || !place.params.has(name)) {
        problems.push(`${where}: "params.${String(name ?? '')}" is not a declared parameter`);
      }
    } else if (root === 'config') {
      if (typeof name !== 'string') {
        problems.push(`${where}: "config" needs a setting name`);
      }
    } else if (root === 'secret') {
      if (!place.secretsAllowed) {
        problems.push(`${where}: a secret may be used in a request only`);
      } else if (typeof name !== 'string') {
        problems.push(`${where}: "secret" needs a setting name`);
      }
    } else if (root === 'steps') {
      if (typeof name !== 'string' || !place.steps.has(name)) {
        problems.push(`${where}: "steps.${String(name ?? '')}" is not an earlier step`);
      }
    } else if (typeof root === 'string' && place.extra.has(root)) {
      // The variable of an `each`.
    } else {
      problems.push(`${where}: "${String(root)}" is not a place a value can come from`);
    }
  }
}

/** Walks a JSON shape whose strings are templates. `each` nodes add their variable to the places. */
function checkShape(
  value: unknown,
  place: Place,
  where: string,
  problems: string[],
  budget: { nodes: number },
  depth: number,
  allowEach: boolean,
): void {
  budget.nodes += 1;
  if (budget.nodes > DRIVER_LIMITS.nodes) {
    problems.push(`${where}: more than ${String(DRIVER_LIMITS.nodes)} parts`);
    return;
  }
  if (depth > DRIVER_LIMITS.depth) {
    problems.push(`${where}: nested more than ${String(DRIVER_LIMITS.depth)} levels`);
    return;
  }
  if (typeof value === 'string') {
    checkTemplate(value, place, where, problems);
  } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    // Literals need no check.
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      checkShape(item, place, `${where}[${String(i)}]`, problems, budget, depth + 1, allowEach);
    });
  } else if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (allowEach && Object.hasOwn(record, 'each')) {
      const keys = Object.keys(record).sort().join(',');
      if (
        keys !== 'as,each,map' ||
        typeof record['each'] !== 'string' ||
        typeof record['as'] !== 'string'
      ) {
        problems.push(`${where}: an "each" has exactly "each" (a path), "as" (a name) and "map"`);
        return;
      }
      if (!NAME.test(record['as'])) {
        problems.push(`${where}: "as" is a name like item`);
        return;
      }
      checkTemplate(`{{ ${record['each']} }}`, place, `${where}.each`, problems);
      checkShape(
        record['map'],
        { ...place, extra: new Set([...place.extra, record['as']]) },
        `${where}.map`,
        problems,
        budget,
        depth + 1,
        allowEach,
      );
      return;
    }
    for (const [key, item] of Object.entries(record)) {
      checkShape(item, place, `${where}.${key}`, problems, budget, depth + 1, allowEach);
    }
  } else {
    problems.push(`${where}: only text, numbers, booleans, lists and objects`);
  }
}

/** Parses and checks a driver that was read from a file. Every problem is reported, not only the first. */
export function parseDriver(value: unknown): { driver: Driver | undefined; problems: string[] } {
  const parsed = DriverSchema.safeParse(value);
  if (!parsed.success) {
    return {
      driver: undefined,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'driver'}: ${i.message}`),
    };
  }
  const driver = parsed.data;
  const problems: string[] = [];
  const names = Object.keys(driver.operations);
  if (names.length === 0 || names.length > DRIVER_LIMITS.operations) {
    problems.push(`a driver has 1 to ${String(DRIVER_LIMITS.operations)} operations`);
  }
  for (const [name, operation] of Object.entries(driver.operations)) {
    const params = new Set(Object.keys(operation.params ?? {}));
    const seen = new Set<string>();
    operation.steps.forEach((step, index) => {
      const where = `${name}.steps[${String(index)}]`;
      if (seen.has(step.id)) {
        problems.push(`${where}: the step id "${step.id}" is used twice`);
      }
      const place: Place = { params, steps: new Set(seen), secretsAllowed: true, extra: new Set() };
      checkTemplate(step.request.url, place, `${where}.url`, problems);
      for (const [header, template] of Object.entries(step.request.headers ?? {})) {
        checkTemplate(template, place, `${where}.headers.${header}`, problems);
      }
      if (step.request.body !== undefined) {
        checkShape(step.request.body, place, `${where}.body`, problems, { nodes: 0 }, 0, false);
      }
      if (step.expect?.error !== undefined) {
        // The answer of this very step may be read to say what went wrong.
        checkTemplate(
          step.expect.error,
          { ...place, steps: new Set([...seen, step.id]), secretsAllowed: false },
          `${where}.expect.error`,
          problems,
        );
      }
      seen.add(step.id);
    });
    if (operation.result !== undefined) {
      checkShape(
        operation.result,
        { params, steps: seen, secretsAllowed: false, extra: new Set() },
        `${name}.result`,
        problems,
        { nodes: 0 },
        0,
        true,
      );
    }
  }
  return { driver: problems.length === 0 ? driver : undefined, problems };
}

/** `host:port` of the literal host a URL template starts with, or why there is none. */
function hostOf(template: string): { target: string } | { problem: string } {
  const match = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#]|$)/iu.exec(template);
  if (match?.[1] === undefined) {
    return { problem: 'must start with https:// and a host written out (no template in the host)' };
  }
  return { target: `${match[1].toLowerCase()}:${match[2] ?? '443'}` };
}

/** The `host:port` pairs a driver calls: every one must be among the manifest's `permissions.network`. */
export function driverHosts(driver: Driver): { hosts: string[]; problems: string[] } {
  const hosts = new Set<string>();
  const problems: string[] = [];
  for (const [name, operation] of Object.entries(driver.operations)) {
    operation.steps.forEach((step, index) => {
      const found = hostOf(step.request.url);
      if ('problem' in found) {
        problems.push(`${name}.steps[${String(index)}].url ${found.problem}`);
      } else {
        hosts.add(found.target);
      }
    });
  }
  return { hosts: [...hosts].sort(), problems };
}

/**
 * Everything that ties a driver to its plugin: the kind it provides, the hosts it calls against what the manifest
 * asks for, and the settings and secrets it reads against what the plugin declares.
 */
export function checkDriverAgainstPlugin(
  driver: Driver,
  manifest: PluginManifest,
  schema: ConfigSchemaFile | undefined,
): string[] {
  const problems: string[] = [];
  if (!manifest.provides.some((p) => p.driver !== undefined && p.kind === driver.kind)) {
    problems.push(
      `the driver is for ${driver.kind}, which the manifest does not give a driver for`,
    );
  }
  const { hosts, problems: hostProblems } = driverHosts(driver);
  problems.push(...hostProblems);
  for (const host of hosts) {
    if (!manifest.permissions.network.includes(host)) {
      problems.push(
        `the driver calls ${host}, which the manifest does not ask for in permissions.network`,
      );
    }
  }
  const secrets = new Map((schema ? secretFields(schema) : []).map((f) => [f.field, f.kind]));
  const plain = new Set(Object.keys(schema?.properties ?? {}).filter((name) => !secrets.has(name)));
  for (const [name, operation] of Object.entries(driver.operations)) {
    for (const text of collectTemplates(operation)) {
      for (const { path } of safeExpressions(text)) {
        const [root, field] = path;
        if (root === 'config' && typeof field === 'string' && !plain.has(field)) {
          problems.push(
            `${name}: "config.${field}" is not a setting of the plugin that is not a secret`,
          );
        }
        if (root === 'secret' && typeof field === 'string' && !secrets.has(field)) {
          problems.push(
            `${name}: "secret.${field}" is not a setting of the plugin that holds a secret`,
          );
        }
      }
    }
  }
  return [...new Set(problems)];
}

function safeExpressions(text: string): Expression[] {
  try {
    return expressionsOf(text);
  } catch {
    return [];
  }
}

/** Every template string of an operation, wherever it is. */
function collectTemplates(operation: Operation): string[] {
  const out: string[] = [];
  const walk = (value: unknown, allowEach: boolean): void => {
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, allowEach);
      }
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (allowEach && Object.hasOwn(record, 'each') && typeof record['each'] === 'string') {
        out.push(`{{ ${record['each']} }}`);
        walk(record['map'], allowEach);
        return;
      }
      for (const item of Object.values(record)) {
        walk(item, allowEach);
      }
    }
  };
  for (const step of operation.steps) {
    out.push(step.request.url, ...Object.values(step.request.headers ?? {}));
    walk(step.request.body, false);
    if (step.expect?.error !== undefined) {
      out.push(step.expect.error);
    }
  }
  walk(operation.result, true);
  return out;
}

// ------------------------------------------------------------------ running an operation

export interface DriverResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What the core offers to a driver; the same services a plugin's code is given. */
export interface DriverServices {
  settings(): Promise<ConfigValues>;
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<DriverResponse>;
  secret(field: string): Promise<string>;
}

interface StepResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly json: unknown;
}

interface Scope {
  readonly params: Record<string, unknown>;
  readonly config: ConfigValues;
  readonly steps: Record<string, StepResult>;
  readonly vars: Record<string, unknown>;
  readonly secret: ((field: string) => Promise<string>) | undefined;
}

function lookup(root: unknown, path: readonly Token[], label: string): unknown {
  let value = root;
  for (const token of path) {
    if (value === null || value === undefined || typeof value !== 'object') {
      throw new DriverError(`"${label}" has no value`);
    }
    const next: unknown =
      typeof token === 'number'
        ? Array.isArray(value)
          ? (value as unknown[])[token]
          : undefined
        : Object.hasOwn(value, token)
          ? (value as Record<string, unknown>)[token]
          : undefined;
    value = next;
  }
  if (value === undefined) {
    throw new DriverError(`"${label}" has no value`);
  }
  return value;
}

function show(path: readonly Token[]): string {
  return path
    .map((t, i) => (typeof t === 'number' ? `[${String(t)}]` : i === 0 ? t : `.${t}`))
    .join('');
}

async function evaluate(expression: Expression, scope: Scope): Promise<unknown> {
  const [root, ...rest] = expression.path;
  const label = show(expression.path);
  let value: unknown;
  if (root === 'secret') {
    const field = rest[0];
    if (scope.secret === undefined || typeof field !== 'string') {
      throw new DriverError('a secret cannot be used here');
    }
    value = await scope.secret(field);
  } else if (root === 'params') {
    value = lookup(scope.params, rest, label);
  } else if (root === 'config') {
    value = lookup(scope.config, rest, label);
  } else if (root === 'steps') {
    value = lookup(scope.steps, rest, label);
  } else if (typeof root === 'string' && Object.hasOwn(scope.vars, root)) {
    value = lookup(scope.vars[root], rest, label);
  } else {
    throw new DriverError(`"${label}" is not a place a value can come from`);
  }
  for (const filter of expression.filters) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (filter === 'json') {
      value = JSON.stringify(value);
    } else if (filter === 'urlencode') {
      value = encodeURIComponent(text);
    } else if (filter === 'base64') {
      value = Buffer.from(text, 'utf8').toString('base64');
    }
  }
  return value;
}

/** A template as a value: one expression alone keeps its type; anything else is text. */
async function render(template: string, scope: Scope): Promise<unknown> {
  const segments = parseTemplate(template);
  const [only] = segments;
  if (segments.length === 1 && only !== undefined && typeof only !== 'string') {
    return evaluate(only, scope);
  }
  let text = '';
  for (const segment of segments) {
    if (typeof segment === 'string') {
      text += segment;
    } else {
      const value = await evaluate(segment, scope);
      text += typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return text;
}

/**
 * A URL template. What is put into a URL is encoded as a path or query part, so a value cannot add a segment, a
 * query or a fragment of its own: `a/../b` stays one piece. `| raw` leaves a value as it is.
 */
async function renderUrl(template: string, scope: Scope): Promise<string> {
  let text = '';
  for (const segment of parseTemplate(template)) {
    if (typeof segment === 'string') {
      text += segment;
    } else {
      const value = await evaluate(segment, scope);
      const plain = typeof value === 'string' ? value : JSON.stringify(value);
      text +=
        segment.filters.includes('raw') || segment.filters.includes('urlencode')
          ? plain
          : encodeURIComponent(plain);
    }
  }
  return text;
}

/**
 * What building one shape may cost, whatever the data it is built from: `each` over a long list, nested, or a
 * large answer put into many places would otherwise make far more than the result may hold before its size is
 * checked at the end.
 */
interface RenderBudget {
  nodes: number;
  chars: number;
  readonly signal: AbortSignal | undefined;
}

function charge(budget: RenderBudget, nodes: number, chars: number): void {
  budget.signal?.throwIfAborted();
  budget.nodes += nodes;
  budget.chars += chars;
  if (budget.nodes > DRIVER_LIMITS.renderNodes) {
    throw new DriverError(
      `The result would have more than ${String(DRIVER_LIMITS.renderNodes)} parts.`,
    );
  }
  if (budget.chars > DRIVER_LIMITS.resultBytes) {
    throw new DriverError('The result is too large.');
  }
}

/** How much text a value adds to a shape. Its JSON is measured once; the budget stops it before it adds up. */
function sizeOf(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  return (JSON.stringify(value) as string | undefined)?.length ?? 0;
}

/**
 * Builds a JSON shape whose strings are templates, one part after the other within the budget. `each` makes a loop
 * only where the driver was checked with loops allowed (the result); elsewhere (a request body) it is a key like
 * any other, as the check took it.
 */
async function renderShape(
  value: unknown,
  scope: Scope,
  budget: RenderBudget,
  allowEach: boolean,
): Promise<unknown> {
  charge(budget, 1, 0);
  if (typeof value === 'string') {
    const rendered = await render(value, scope);
    charge(budget, 0, sizeOf(rendered));
    return rendered;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await renderShape(item, scope, budget, allowEach));
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (allowEach && Object.hasOwn(record, 'each')) {
      const list = await render(`{{ ${String(record['each'])} }}`, scope);
      if (!Array.isArray(list)) {
        throw new DriverError(`"${String(record['each'])}" is not a list`);
      }
      // The whole loop is paid for before any of it is built.
      charge(budget, list.length, 0);
      const name = String(record['as']);
      const out: unknown[] = [];
      for (const item of list as unknown[]) {
        out.push(
          await renderShape(
            record['map'],
            { ...scope, vars: { ...scope.vars, [name]: item } },
            budget,
            allowEach,
          ),
        );
      }
      return out;
    }
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(record)) {
      // The name is part of what is built, with its quotes and colon, each time the object is built.
      charge(budget, 0, key.length + 3);
      entries.push([key, await renderShape(item, scope, budget, allowEach)]);
    }
    // Own properties only, whatever the keys are called (`__proto__` included).
    return Object.fromEntries(entries);
  }
  return value;
}

function newBudget(signal: AbortSignal | undefined): RenderBudget {
  return { nodes: 0, chars: 0, signal };
}

function checkParams(declared: Operation['params'], given: unknown): Record<string, unknown> {
  const input = given ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new DriverError('the parameters are an object');
  }
  const record = input as Record<string, unknown>;
  const defs = declared ?? {};
  for (const name of Object.keys(record)) {
    if (!Object.hasOwn(defs, name)) {
      throw new DriverError(`"${name}" is not a parameter of this operation`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(defs)) {
    // Own properties only: `constructor` or `toString` are not parameters that were given.
    let value = Object.hasOwn(record, name) ? (record[name] ?? undefined) : undefined;
    value ??= 'default' in def ? def.default : undefined;
    if (value === undefined) {
      if (def.required === true) {
        throw new DriverError(`the parameter "${name}" is required`);
      }
      continue;
    }
    const problem = checkParam(def, value);
    if (problem !== undefined) {
      throw new DriverError(`the parameter "${name}" ${problem}`);
    }
    out[name] = value;
  }
  return out;
}

function checkParam(def: ParamDef, value: unknown): string | undefined {
  switch (def.type) {
    case 'string':
      if (typeof value !== 'string') {
        return 'must be text';
      }
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        return `is at most ${String(def.maxLength)} characters`;
      }
      return def.enum !== undefined && !def.enum.includes(value)
        ? `must be one of: ${def.enum.join(', ')}`
        : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'must be a number';
      }
      if (def.type === 'integer' && !Number.isInteger(value)) {
        return 'must be a whole number';
      }
      if (def.minimum !== undefined && value < def.minimum) {
        return `is at least ${String(def.minimum)}`;
      }
      return def.maximum !== undefined && value > def.maximum
        ? `is at most ${String(def.maximum)}`
        : undefined;
  }
}

function parseJson(response: DriverResponse): unknown {
  const type = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  if (type?.includes('json') !== true && !/^\s*[[{]/u.test(response.body)) {
    return undefined;
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Runs one operation of a driver: checks the parameters, makes each step's request through the core, checks
 * the answer and builds the result. The driver was checked when it was loaded; what can still fail is the data.
 */
export async function runOperation(
  driver: Driver,
  name: string,
  given: unknown,
  services: DriverServices,
  /** Ends the operation: no step is started, and no part built, once it is aborted. */
  signal?: AbortSignal,
): Promise<unknown> {
  const operation = Object.hasOwn(driver.operations, name) ? driver.operations[name] : undefined;
  if (operation === undefined) {
    throw new DriverError(`The driver has no operation "${name}".`);
  }
  const params = checkParams(operation.params, given);
  const config = await services.settings();
  const steps: Record<string, StepResult> = {};
  const scope = (secret: boolean): Scope => ({
    params,
    config,
    steps,
    vars: {},
    secret: secret ? (field) => services.secret(field) : undefined,
  });
  for (const step of operation.steps) {
    signal?.throwIfAborted();
    const url = await renderUrl(step.request.url, scope(true));
    const headers: Record<string, string> = {};
    for (const [header, template] of Object.entries(step.request.headers ?? {})) {
      const value = await render(template, scope(true));
      headers[header.toLowerCase()] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    let body: string | undefined;
    if (typeof step.request.body === 'string') {
      const rendered = await render(step.request.body, scope(true));
      body = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
    } else if (step.request.body !== undefined) {
      body = JSON.stringify(
        await renderShape(step.request.body, scope(true), newBudget(signal), false),
      );
      headers['content-type'] ??= 'application/json';
    }
    // The last moment to stop: after this the request is sent, and may have its effect whatever happens next.
    signal?.throwIfAborted();
    const response = await services.fetch(url, {
      method: step.request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const result: StepResult = {
      status: response.status,
      headers: response.headers,
      text: response.body,
      json: parseJson(response),
    };
    steps[step.id] = result;
    const accepted = step.expect?.status ?? null;
    const ok =
      accepted === null
        ? response.status >= 200 && response.status < 300
        : accepted.includes(response.status);
    if (!ok) {
      let said = '';
      if (step.expect?.error !== undefined) {
        try {
          const text = await render(step.expect.error, scope(false));
          said = `: ${(typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 200)}`;
        } catch {
          said = '';
        }
      }
      throw new DriverError(`The service answered ${String(response.status)}${said}`);
    }
  }
  const last = operation.steps.at(-1);
  const value =
    operation.result === undefined
      ? { status: last === undefined ? 0 : (steps[last.id]?.status ?? 0) }
      : await renderShape(operation.result, scope(false), newBudget(signal), true);
  const text = JSON.stringify(value) as string | undefined;
  if (text !== undefined && Buffer.byteLength(text) > DRIVER_LIMITS.resultBytes) {
    throw new DriverError('The result is too large.');
  }
  return value;
}
