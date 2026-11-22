import type { ConsoleOperation, ConsoleParam } from './catalogue.js';

// From what a person typed to the path and query the panel is asked for (ADR 0046). The target is never a URL somebody
// gave: it is the path of a catalogue operation with its placeholders filled from values that were checked against what
// the description says that parameter is, and a query made only of the parameters the description lists.

export interface ConsoleIssue {
  /** `pathParams.userId`, `query.size`, `operationId`. */
  readonly path: string;
  readonly message: string;
}

/** The request cannot be made as written. `issues` says what is wrong, field by field; no value is repeated in it. */
export class ConsoleRequestError extends Error {
  constructor(readonly issues: readonly ConsoleIssue[]) {
    super(
      `The request does not fit the operation: ${issues
        .slice(0, 3)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ')}${issues.length > 3 ? ` (and ${String(issues.length - 3)} more)` : ''}.`,
    );
    this.name = 'ConsoleRequestError';
  }
}

export type ConsoleValue = string | number | boolean;

export interface ConsoleRequestInput {
  readonly pathParams?: Readonly<Record<string, unknown>> | undefined;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
}

export interface PreparedConsoleRequest {
  readonly operation: ConsoleOperation;
  /** `/api/users/123?size=25`: what is appended to the base address of the panel. */
  readonly pathAndQuery: string;
  /** The names of the query parameters that were sent: for the audit log, which never holds a value. */
  readonly queryKeys: readonly string[];
}

const MAX_TEXT = 256;
const MAX_QUERY = 2048;
// eslint-disable-next-line no-control-regex -- finding control characters is the point of it
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** A path segment from outside: letters, digits, dot, underscore, hyphen. Nothing that is a separator or an escape. */
const SEGMENT = /^[A-Za-z0-9._-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const NUMBER = /^-?\d{1,15}(?:\.\d{1,6})?$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/u;

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The text a value is sent as, or the reason it cannot be. A parameter given as nothing at all is `undefined`. */
function checked(param: ConsoleParam, given: unknown): string | undefined | { problem: string } {
  if (given === undefined || given === null || given === '') {
    return undefined;
  }
  if (typeof given !== 'string' && typeof given !== 'number' && typeof given !== 'boolean') {
    return { problem: 'must be a string, a number or a boolean' };
  }
  switch (param.kind) {
    case 'structured':
      return { problem: 'is a structured parameter, which the console does not send' };
    case 'boolean': {
      const value = String(given);
      return value === 'true' || value === 'false' ? value : { problem: 'must be true or false' };
    }
    case 'number': {
      const value = typeof given === 'number' ? String(given) : given;
      if (typeof value !== 'string' || !NUMBER.test(value)) {
        return { problem: 'must be a plain decimal number' };
      }
      // An identifier in the path is a whole positive number.
      if (param.in === 'path' && !/^\d{1,15}$/u.test(value)) {
        return { problem: 'must be a whole number' };
      }
      const number = Number(value);
      if (param.minimum !== null && number < param.minimum) {
        return { problem: `must be at least ${String(param.minimum)}` };
      }
      if (param.maximum !== null && number > param.maximum) {
        return { problem: `must be at most ${String(param.maximum)}` };
      }
      return value;
    }
    case 'string': {
      if (typeof given !== 'string') {
        return { problem: 'must be a string' };
      }
      if (given.length > MAX_TEXT) {
        return { problem: `is longer than ${String(MAX_TEXT)} characters` };
      }
      if (CONTROL.test(given)) {
        return { problem: 'holds a control character' };
      }
      if (param.enum !== null) {
        return param.enum.includes(given)
          ? given
          : { problem: `must be one of ${param.enum.join(', ')}` };
      }
      switch (param.format) {
        case 'uuid':
          return UUID.test(given) ? given : { problem: 'must be a UUID' };
        case 'date': {
          const match = DATE.exec(given);
          return match && validDate(Number(match[1]), Number(match[2]), Number(match[3]))
            ? given
            : { problem: 'must be a date, YYYY-MM-DD' };
        }
        case 'date-time':
          return DATE_TIME.test(given) && !Number.isNaN(Date.parse(given))
            ? given
            : { problem: 'must be a date and time, 2026-01-31T12:00:00Z' };
        case 'email':
          return EMAIL.test(given) && given.length <= 254
            ? given
            : { problem: 'must be an email address' };
        default:
          break;
      }
      if (param.in === 'path') {
        // Nothing that can start a second segment, a parent, an escape, a host or a scheme.
        if (!SEGMENT.test(given) || given === '.' || given.includes('..')) {
          return { problem: 'may hold only letters, digits, dots, hyphens and underscores' };
        }
      }
      return given;
    }
    default:
      return { problem: 'cannot be sent' };
  }
}

function ownKeys(value: Readonly<Record<string, unknown>> | undefined): string[] {
  return value === undefined ? [] : Object.keys(value);
}

/**
 * Checks the input against the parameters of the operation and builds the path and query. Throws `ConsoleRequestError`
 * with every problem found, so a form can mark all the fields at once. Only a GET is accepted; the policy of what a GET
 * may reach (blocked, user data) is the caller's, since it needs the settings of the installation.
 */
export function prepareConsoleRequest(
  operation: ConsoleOperation,
  input: ConsoleRequestInput,
): PreparedConsoleRequest {
  if (operation.method !== 'get') {
    throw new ConsoleRequestError([{ path: 'operationId', message: 'is not a read' }]);
  }
  const issues: ConsoleIssue[] = [];
  const declared = (where: 'path' | 'query'): ConsoleParam[] =>
    operation.parameters.filter((p) => p.in === where);
  const given = { path: input.pathParams, query: input.query } as const;
  for (const [where, label] of [
    ['path', 'pathParams'],
    ['query', 'query'],
  ] as const) {
    const names = new Set(declared(where).map((p) => p.name));
    for (const key of ownKeys(given[where])) {
      if (!names.has(key)) {
        issues.push({
          path: `${label}.${key.slice(0, 40)}`,
          message: 'is not a parameter of this operation',
        });
      }
    }
  }

  const values = new Map<string, string>();
  for (const param of operation.parameters) {
    const source = param.in === 'path' ? input.pathParams : input.query;
    const label = `${param.in === 'path' ? 'pathParams' : 'query'}.${param.name}`;
    const raw =
      source !== undefined && Object.hasOwn(source, param.name) ? source[param.name] : undefined;
    const result = checked(param, raw);
    if (result === undefined) {
      if (param.required) {
        issues.push({ path: label, message: 'is required' });
      }
      continue;
    }
    if (typeof result === 'object') {
      issues.push({ path: label, message: result.problem });
      continue;
    }
    values.set(`${param.in}:${param.name}`, result);
  }
  if (issues.length > 0) {
    throw new ConsoleRequestError(issues);
  }

  const path = operation.path.replace(/\{([A-Za-z0-9_]+)\}/gu, (_whole, name: string) =>
    encodeURIComponent(values.get(`path:${name}`) ?? ''),
  );
  const search = new URLSearchParams();
  const queryKeys: string[] = [];
  for (const param of declared('query')) {
    const value = values.get(`query:${param.name}`);
    if (value !== undefined) {
      search.append(param.name, value);
      queryKeys.push(param.name);
    }
  }
  const query = search.toString();
  if (query.length > MAX_QUERY) {
    throw new ConsoleRequestError([{ path: 'query', message: 'is too long' }]);
  }
  if (!path.startsWith('/api/') || path.includes('//')) {
    throw new ConsoleRequestError([
      { path: 'operationId', message: 'has a path the console cannot send' },
    ]);
  }
  return {
    operation,
    pathAndQuery: query === '' ? path : `${path}?${query}`,
    queryKeys,
  };
}
