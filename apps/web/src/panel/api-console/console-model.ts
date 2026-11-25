// New in Swellwright (the Remnawave panel has no API console of its own, ADR 0046). The small logic of the console page
// that is not drawing: the form values of an operation, the request they make, the equivalent curl command, the colour
// of a status, and the history and the named samples the browser keeps. Nothing here talks to the server.
import type {
  PanelConsoleOperation,
  PanelConsoleParam,
  PanelConsoleRequest,
  PanelConsoleResult,
} from '@swellwright/contracts';

import type { StatusKind } from '@swellwright/ui';

export const paramKey = (param: PanelConsoleParam): string => `${param.in}:${param.name}`;

/** The values of the form, by `in:name`. A value is text until it is sent: the server checks it against its type. */
export type FormValues = Readonly<Record<string, string>>;

/** The request an operation and a form make. Empty values and structured parameters are not sent. */
export function buildRequest(
  operation: PanelConsoleOperation,
  values: FormValues,
): PanelConsoleRequest {
  const pathParams: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const param of operation.parameters) {
    const value = values[paramKey(param)]?.trim();
    if (value === undefined || value === '' || param.kind === 'structured') {
      continue;
    }
    (param.in === 'path' ? pathParams : query)[param.name] = value;
  }
  return {
    operationId: operation.operationId,
    ...(Object.keys(pathParams).length === 0 ? {} : { pathParams }),
    ...(Object.keys(query).length === 0 ? {} : { query }),
  };
}

/** The values a request fills in, for the form: the other way round of `buildRequest`. */
export function valuesOf(
  operation: PanelConsoleOperation,
  request: PanelConsoleRequest,
): FormValues {
  const out: Record<string, string> = {};
  for (const param of operation.parameters) {
    const given = (param.in === 'path' ? request.pathParams : request.query)?.[param.name];
    if (given !== undefined) {
      out[paramKey(param)] = String(given);
    }
  }
  return out;
}

/** Whether every required parameter has a value: the Send button waits for it. */
export function missingRequired(operation: PanelConsoleOperation, values: FormValues): string[] {
  return operation.parameters
    .filter(
      (p) => p.required && p.kind !== 'structured' && (values[paramKey(p)] ?? '').trim() === '',
    )
    .map((p) => p.name);
}

/** A POSIX shell word that stands for `value` exactly: single quotes, each quote inside written as `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The curl command that does the same thing, with the token left out: the person puts their own in `$PANEL_TOKEN`.
 * The address is the connected panel's when it is known. The whole URL is one single-quoted shell word, so nothing in
 * the panel's address or in a value can end it, expand a variable or start a command. Only the header with the token
 * is double-quoted, so that `$PANEL_TOKEN` expands.
 */
export function curlOf(
  operation: PanelConsoleOperation,
  request: PanelConsoleRequest,
  baseUrl: string | null,
): string {
  const path = operation.path.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, name: string) => {
    const value = request.pathParams?.[name];
    return value === undefined ? whole : encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const param of operation.parameters) {
    const value = param.in === 'query' ? request.query?.[param.name] : undefined;
    if (value !== undefined) {
      search.append(param.name, String(value));
    }
  }
  const query = search.toString();
  let base = baseUrl ?? 'https://panel.example.com';
  while (base.endsWith('/')) {
    base = base.slice(0, -1);
  }
  const url = `${base}${path}${query === '' ? '' : `?${query}`}`;
  return `curl -sS -H "Authorization: Bearer $PANEL_TOKEN" -H 'Accept: application/json' ${shellQuote(url)}`;
}

/** The colour of a status, as the panel's chips: green for success, blue for a redirect, orange for 4xx, red for 5xx. */
export function statusKind(status: number): StatusKind {
  if (status >= 500) {
    return 'err';
  }
  if (status >= 400) {
    return 'warn';
  }
  if (status >= 300) {
    return 'info';
  }
  return 'ok';
}

// ---- what was sent --------------------------------------------------------------------------------------------------

/**
 * A request as it was sent: the operation, its class and the values are taken when Send is pressed, so that an answer
 * that comes back after the person chose another operation is still recorded (and kept or not) as what was asked.
 */
export interface Submission {
  /** Which view sent it: an answer is shown only while that view is still on screen. */
  readonly view: number;
  readonly operationId: string;
  readonly path: string;
  readonly availability: PanelConsoleOperation['availability'];
  readonly request: PanelConsoleRequest;
}

export function submissionOf(
  operation: PanelConsoleOperation,
  request: PanelConsoleRequest,
  view: number,
): Submission {
  return {
    view,
    operationId: operation.operationId,
    path: operation.path,
    availability: operation.availability,
    request,
  };
}

/** The history entry of a sent request. The values of a request about people are never kept (ADR 0046). */
export function historyEntryOf(
  submission: Submission,
  outcome:
    | { readonly answer: PanelConsoleResult }
    | { readonly errorCode: string | null; readonly at: string },
  id: string,
): HistoryEntry {
  const common = {
    id,
    operationId: submission.operationId,
    path: submission.path,
    request: submission.availability === 'user_data' ? null : submission.request,
  };
  return 'answer' in outcome
    ? {
        ...common,
        at: outcome.answer.sentAt,
        status: outcome.answer.status,
        durationMs: outcome.answer.durationMs,
        bytes: outcome.answer.bodyBytes,
        errorCode: null,
      }
    : {
        ...common,
        at: outcome.at,
        status: null,
        durationMs: null,
        bytes: null,
        errorCode: outcome.errorCode,
      };
}

/** Whether an answer may be kept as a sample: only a standard answer to a request that is not about people. */
export const canKeepSample = (submission: Submission, result: PanelConsoleResult): boolean =>
  submission.availability !== 'user_data' &&
  result.maskProfile === 'standard' &&
  result.body.length <= SAMPLE_BODY_MAX;

// ---- what the browser keeps -----------------------------------------------------------------------------------------
// Only localStorage of this browser: nothing is stored on the server (ADR 0046). Every read and write is guarded, since
// the storage can be missing, full or blocked, and the page has to work without it. The history and the samples are
// kept under the account's id, so a person who signs in after another in the same browser does not see theirs.

/** The keys before they were kept per account. What is under them cannot be told apart by account: it is removed. */
export const LEGACY_KEYS = ['sw-api-console:history:v1', 'sw-api-console:samples:v1'] as const;
export const historyKey = (userId: string): string => `sw-api-console:history:v2:${userId}`;
export const samplesKey = (userId: string): string => `sw-api-console:samples:v2:${userId}`;
export const LAST_OPERATION_KEY = 'sw-api-console:last-operation:v1';
export const HISTORY_MAX = 20;
export const SAMPLES_MAX = 20;
/** A sample larger than this is not kept: localStorage has a few megabytes for the whole site. */
export const SAMPLE_BODY_MAX = 256 * 1024;

export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly operationId: string;
  readonly path: string;
  /** The HTTP status the panel answered with, or null when the request did not get an answer. */
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly bytes: number | null;
  /** The error code of a request that got no answer. */
  readonly errorCode: string | null;
  /** What was asked. Null for an operation about people: values like a short UUID are not kept. */
  readonly request: PanelConsoleRequest | null;
}

export interface Sample {
  readonly id: string;
  readonly name: string;
  readonly savedAt: string;
  readonly operationId: string;
  readonly path: string;
  readonly request: PanelConsoleRequest;
  readonly result: Pick<
    PanelConsoleResult,
    'status' | 'bodyFormat' | 'body' | 'bodyBytes' | 'truncated' | 'maskedCount' | 'durationMs'
  >;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRequest = (value: unknown): value is PanelConsoleRequest =>
  isRecord(value) && typeof value['operationId'] === 'string';

const isHistoryEntry = (value: unknown): value is HistoryEntry =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['at'] === 'string' &&
  typeof value['operationId'] === 'string' &&
  typeof value['path'] === 'string' &&
  (value['request'] === null || isRequest(value['request']));

const isSample = (value: unknown): value is Sample =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['name'] === 'string' &&
  typeof value['operationId'] === 'string' &&
  isRequest(value['request']) &&
  isRecord(value['result']) &&
  typeof value['result']['body'] === 'string';

function readList<T>(key: string, valid: (value: unknown) => value is T): T[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, items: readonly unknown[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

/** Removes what was kept before the history and the samples were per account. */
export function forgetLegacyStorage(): void {
  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // The page works without the storage.
    }
  }
}

export const readHistory = (userId: string): HistoryEntry[] =>
  readList(historyKey(userId), isHistoryEntry);
export const readSamples = (userId: string): Sample[] => readList(samplesKey(userId), isSample);

/** Puts an entry (made by `historyEntryOf`) first and keeps the newest `HISTORY_MAX`. Returns the list as it is now. */
export function addHistory(userId: string, entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...readHistory(userId)].slice(0, HISTORY_MAX);
  writeList(historyKey(userId), next);
  return next;
}

export function clearHistory(userId: string): void {
  writeList(historyKey(userId), []);
}

/** Keeps a sample. False when it is too large or the storage refuses it. The oldest sample goes at the limit. */
export function addSample(userId: string, sample: Sample): { ok: boolean; samples: Sample[] } {
  if (sample.result.body.length > SAMPLE_BODY_MAX) {
    return { ok: false, samples: readSamples(userId) };
  }
  const next = [sample, ...readSamples(userId)].slice(0, SAMPLES_MAX);
  return { ok: writeList(samplesKey(userId), next), samples: next };
}

export function removeSample(userId: string, id: string): Sample[] {
  const next = readSamples(userId).filter((sample) => sample.id !== id);
  writeList(samplesKey(userId), next);
  return next;
}

export function readLastOperation(): string | null {
  try {
    return localStorage.getItem(LAST_OPERATION_KEY);
  } catch {
    return null;
  }
}

export function writeLastOperation(id: string): void {
  try {
    localStorage.setItem(LAST_OPERATION_KEY, id);
  } catch {
    // The page works without it.
  }
}

/** A short identifier for a history entry or a sample. */
export const newId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A file name that is safe on every system for a download of an answer. */
export function fileNameOf(operationId: string, extension: 'json' | 'txt'): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return `${operationId.replace(/[^A-Za-z0-9_-]/gu, '_')}-${stamp}.${extension}`;
}
