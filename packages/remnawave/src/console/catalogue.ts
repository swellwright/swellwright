import { readFileSync } from 'node:fs';

import {
  BLOCKED_OPERATIONS,
  type ConsoleAvailability,
  type ConsoleBlockedReason,
  USER_DATA_OPERATIONS,
} from './policy.js';

// The operation catalogue of the API console (ADR 0046): every operation of the frozen description of the panel
// (`spec/remnawave-api-3.4.11.json`, OpenAPI 3.0), with its parameters typed, its group, whether it needs an
// administrator session instead of a token, and what the console may do with it. Built once, when it is first asked for,
// from the file that ships with the server; nothing is fetched from the panel to learn what can be asked of it.

export const CONSOLE_SPEC_FILE = 'remnawave-api-3.4.11.json';

export type ConsoleParamKind = 'string' | 'number' | 'boolean' | 'structured';
export type ConsoleParamFormat = 'uuid' | 'date' | 'date-time' | 'email';

export interface ConsoleParam {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly description: string | null;
  /** `structured` is an array or an object (the table state of the panel's own pages): the console does not send those. */
  readonly kind: ConsoleParamKind;
  readonly format: ConsoleParamFormat | null;
  readonly enum: readonly string[] | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly default: string | number | boolean | null;
}

export interface ConsoleOperation {
  /** The panel's own identifier, for example `NodesController_getNodes`. */
  readonly operationId: string;
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** As the description writes it: `/api/nodes/{uuid}`. */
  readonly path: string;
  /** The tag of the description without its "Controller": `Nodes`. */
  readonly group: string;
  readonly summary: string;
  readonly description: string | null;
  readonly availability: ConsoleAvailability;
  readonly blockedReason: ConsoleBlockedReason | null;
  /** The description says an API token may not call it: only an administrator session can. */
  readonly adminOnly: boolean;
  /** The description lists no security for it: the panel answers without a token. */
  readonly publicEndpoint: boolean;
  /** The scopes the description names for it (it names none today: the panel keeps them in `/api/tokens/scopes`). */
  readonly scopes: readonly string[];
  readonly deprecated: boolean;
  readonly parameters: readonly ConsoleParam[];
  readonly hasRequestBody: boolean;
  /** The content types of the successful answer. */
  readonly responseContentTypes: readonly string[];
}

export interface ConsoleOperationDetail extends ConsoleOperation {
  /** The schema of the request body (JSON Schema of OpenAPI 3.0, references followed), for the operations that have one. */
  readonly requestBodySchema: unknown;
  /** The schema of the successful answer, references followed. */
  readonly responseSchema: unknown;
}

export interface ConsoleCatalogue {
  /** The version of the panel the description was made for. */
  readonly specVersion: string;
  readonly operations: readonly ConsoleOperation[];
  find(operationId: string): ConsoleOperation | undefined;
  detail(operationId: string): ConsoleOperationDetail | undefined;
  readonly counts: {
    readonly total: number;
    readonly get: number;
    readonly open: number;
    readonly userData: number;
    readonly blocked: number;
    readonly write: number;
  };
}

type Json = Record<string, unknown>;

interface RawParameter {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  description?: unknown;
  style?: unknown;
  schema?: Json;
}

interface RawOperation {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  tags?: unknown;
  deprecated?: unknown;
  security?: unknown;
  parameters?: unknown;
  requestBody?: Json;
  responses?: Record<string, Json>;
}

export interface RawSpec {
  info?: { version?: unknown };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, Json> };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ADMIN_ONLY = /admin(?:istrator)?[ -]?JWT/iu;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

/** `Nodes Controller` is `Nodes`; `[Public] Subscription Controller` is `Subscription (public)`. */
export function groupOf(tag: string | null): string {
  if (tag === null) {
    return 'Other';
  }
  // Plain string operations: a pattern that backtracks over a run of spaces is quadratic on a long one.
  const trimmed = tag.trim();
  let name = trimmed;
  let kind: string | null = null;
  for (const prefix of ['[Public]', '[Protected]']) {
    if (trimmed.startsWith(prefix)) {
      kind = prefix.slice(1, -1).toLowerCase();
      name = trimmed.slice(prefix.length).trim();
    }
  }
  if (name.endsWith('Controller')) {
    name = name.slice(0, -'Controller'.length).trim();
  }
  return kind === null ? name : `${name} (${kind})`;
}

/** `NodesController_getNodes` read as words, for the operations the description gives no summary. */
function summaryFromId(operationId: string, method: string, path: string): string {
  const action = operationId.split('_').pop() ?? operationId;
  const words = action
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .trim()
    .toLowerCase();
  return words === ''
    ? `${method.toUpperCase()} ${path}`
    : words.charAt(0).toUpperCase() + words.slice(1);
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parameterOf(raw: RawParameter): ConsoleParam | undefined {
  const name = text(raw.name);
  const where = raw.in === 'path' || raw.in === 'query' ? raw.in : undefined;
  if (name === null || where === undefined) {
    return undefined;
  }
  const schema = raw.schema ?? {};
  const type = schema['type'];
  let kind: ConsoleParamKind = 'structured';
  if (type === 'string') {
    kind = 'string';
  } else if (type === 'number' || type === 'integer') {
    kind = 'number';
  } else if (type === 'boolean') {
    kind = 'boolean';
  }
  // An object in the query is written in the deep-object style of the panel's tables; the console does not send it.
  if (raw.style === 'deepObject') {
    kind = 'structured';
  }
  const format = schema['format'];
  const known =
    format === 'uuid' || format === 'date' || format === 'date-time' || format === 'email'
      ? format
      : null;
  const values = schema['enum'];
  const fallback = schema['default'];
  return {
    name,
    in: where,
    required: where === 'path' || raw.required === true,
    description: text(raw.description),
    kind,
    format: kind === 'string' ? known : null,
    enum: Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : null,
    minimum: numberOf(schema['minimum']),
    maximum: numberOf(schema['maximum']),
    default:
      typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean'
        ? fallback
        : null,
  };
}

function availabilityOf(
  method: string,
  operationId: string,
): { availability: ConsoleAvailability; reason: ConsoleBlockedReason | null } {
  if (method !== 'get') {
    return { availability: 'write', reason: null };
  }
  const reason = Object.hasOwn(BLOCKED_OPERATIONS, operationId)
    ? (BLOCKED_OPERATIONS[operationId] ?? null)
    : null;
  if (reason !== null) {
    return { availability: 'blocked', reason };
  }
  return {
    availability: USER_DATA_OPERATIONS.has(operationId) ? 'user_data' : 'open',
    reason: null,
  };
}

function scopesOf(security: unknown): string[] {
  const scopes = new Set<string>();
  if (Array.isArray(security)) {
    for (const requirement of security) {
      for (const list of Object.values(asObject(requirement) ?? {})) {
        if (Array.isArray(list)) {
          for (const scope of list) {
            if (typeof scope === 'string') {
              scopes.add(scope);
            }
          }
        }
      }
    }
  }
  return [...scopes];
}

function operationOf(
  path: string,
  method: (typeof METHODS)[number],
  raw: RawOperation,
  shared: readonly RawParameter[],
): ConsoleOperation | undefined {
  const operationId = text(raw.operationId);
  if (operationId === null) {
    return undefined;
  }
  const own = Array.isArray(raw.parameters) ? (raw.parameters as RawParameter[]) : [];
  const parameters = [...shared, ...own]
    .map(parameterOf)
    .filter((p): p is ConsoleParam => p !== undefined);
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const { availability, reason } = availabilityOf(method, operationId);
  const description = text(raw.description);
  const ok = raw.responses?.['200'] ?? raw.responses?.['201'];
  const content = asObject(ok?.['content']);
  return {
    operationId,
    method,
    path,
    group: groupOf(text(tags[0])),
    summary: text(raw.summary) ?? summaryFromId(operationId, method, path),
    description,
    availability,
    blockedReason: reason,
    adminOnly: description !== null && ADMIN_ONLY.test(description),
    publicEndpoint: !Array.isArray(raw.security) || raw.security.length === 0,
    scopes: scopesOf(raw.security),
    deprecated: raw.deprecated === true,
    parameters,
    hasRequestBody: raw.requestBody !== undefined,
    responseContentTypes: content === undefined ? [] : Object.keys(content),
  };
}

// ---- schemas with their references followed -------------------------------------------------------------------------

/** How many nodes a resolved schema may have before the rest is cut: a few schemas are very large. */
const SCHEMA_BUDGET = 6000;
const SCHEMA_DEPTH = 14;

function resolver(spec: RawSpec): (schema: unknown) => unknown {
  const schemas = spec.components?.schemas ?? {};
  return (root) => {
    let budget = SCHEMA_BUDGET;
    const walk = (value: unknown, stack: readonly string[], depth: number): unknown => {
      budget -= 1;
      if (budget < 0 || depth > SCHEMA_DEPTH) {
        return { truncated: true };
      }
      if (Array.isArray(value)) {
        return value.map((item) => walk(item, stack, depth + 1));
      }
      const object = asObject(value);
      if (object === undefined) {
        return value;
      }
      const ref = object['$ref'];
      if (typeof ref === 'string') {
        const name = ref.replace('#/components/schemas/', '');
        if (stack.includes(name)) {
          return { $ref: name, circular: true };
        }
        const target = schemas[name];
        return target === undefined
          ? { $ref: name, missing: true }
          : { title: name, ...(walk(target, [...stack, name], depth + 1) as Json) };
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => [key, walk(item, stack, depth + 1)]),
      );
    };
    return walk(root, [], 0);
  };
}

/** The description of the panel, the part the catalogue reads. */
export function buildConsoleCatalogue(spec: RawSpec): ConsoleCatalogue {
  const operations: ConsoleOperation[] = [];
  const raws = new Map<string, RawOperation>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = Array.isArray(item['parameters']) ? (item['parameters'] as RawParameter[]) : [];
    for (const method of METHODS) {
      const raw = asObject(item[method]) as RawOperation | undefined;
      if (raw === undefined) {
        continue;
      }
      const operation = operationOf(path, method, raw, shared);
      if (operation !== undefined) {
        operations.push(operation);
        raws.set(operation.operationId, raw);
      }
    }
  }
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  if (byId.size !== operations.length) {
    throw new Error('The API description of the panel has two operations with the same id.');
  }
  const resolve = resolver(spec);
  const details = new Map<string, ConsoleOperationDetail>();
  const count = (availability: ConsoleAvailability): number =>
    operations.filter((operation) => operation.availability === availability).length;
  return {
    specVersion: typeof spec.info?.version === 'string' ? spec.info.version : 'unknown',
    operations,
    find: (id) => byId.get(id),
    detail(id) {
      const found = details.get(id);
      if (found) {
        return found;
      }
      const operation = byId.get(id);
      const raw = raws.get(id);
      if (!operation || !raw) {
        return undefined;
      }
      const body = asObject(asObject(raw.requestBody?.['content'])?.['application/json']);
      const ok = raw.responses?.['200'] ?? raw.responses?.['201'];
      const answer = asObject(asObject(ok?.['content'])?.['application/json']);
      const detail: ConsoleOperationDetail = {
        ...operation,
        requestBodySchema: body === undefined ? null : resolve(body['schema']),
        responseSchema: answer === undefined ? null : resolve(answer['schema']),
      };
      details.set(id, detail);
      return detail;
    },
    counts: {
      total: operations.length,
      get: operations.filter((operation) => operation.method === 'get').length,
      open: count('open'),
      userData: count('user_data'),
      blocked: count('blocked'),
      write: count('write'),
    },
  };
}

let cached: ConsoleCatalogue | undefined;

/**
 * The catalogue of the frozen description that ships with this package (`spec/` next to `dist/`; the image copies it).
 * Read and built on first use, kept after that.
 */
export function consoleCatalogue(): ConsoleCatalogue {
  cached ??= buildConsoleCatalogue(
    JSON.parse(
      readFileSync(new URL(`../../spec/${CONSOLE_SPEC_FILE}`, import.meta.url), 'utf8'),
    ) as RawSpec,
  );
  return cached;
}
