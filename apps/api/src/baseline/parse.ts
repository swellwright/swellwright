import {
  type ObservationFieldDef,
  type ObservationStatus,
  type ObservedValue,
  observationKind,
} from '@swellwright/contracts';

import type { PlannedObservation } from './plan.js';

/** What the script made of one observation. */
export interface ParsedObservation {
  readonly index: number;
  readonly kind: string;
  readonly status: ObservationStatus;
  /** Every field of the kind, null where the script did not report it; null for an observation that did not succeed. */
  readonly fields: Readonly<Record<string, ObservedValue>> | null;
}

export interface ParsedOutput {
  /** The output is the output of the script (it has its first marker). A false here is "answered, but not with this". */
  readonly recognised: boolean;
  /** The clock of the server in epoch seconds when the script began, when it said. */
  readonly serverEpoch: number | null;
  readonly uid: number | null;
  /** The script reached its last line. */
  readonly complete: boolean;
  readonly observations: ReadonlyMap<number, ParsedObservation>;
  /** Things that are wrong with the output itself (a repeated index, an observation that never ended). */
  readonly warnings: readonly string[];
}

export interface ParseOptions {
  /** The output was cut at the limit of the reader. */
  readonly truncated?: boolean;
  /**
   * The moment the controller thinks the server read its clock, in epoch milliseconds. Used for `time.sync.skewSeconds`,
   * the one field that is made here and not on the server.
   */
  readonly controllerEpochMs?: number;
}

const MAX_LINES_PER_OBSERVATION = 2000;
const MAX_LINE_CHARS = 600;
const MAX_LIST_ENTRIES = 200;

/** A line of the output that is a marker. A value that looks like one is always behind `| `, so it never is. */
const MARKER = /^@@swb (\S+)(?: (.*))?$/u;

const decoder = new TextDecoder('utf-8', { fatal: false });
const BOM = String.fromCharCode(0xfeff);

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

function statusOf(code: number): ObservationStatus {
  if (code === 0) {
    return 'ok';
  }
  if (code === 11) {
    return 'denied';
  }
  if (code === 99) {
    return 'unsupported';
  }
  if (code === 124) {
    return 'timeout';
  }
  return 'error';
}

function booleanOf(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (value === 'yes' || value === 'true' || value === '1') {
    return true;
  }
  if (value === 'no' || value === 'false' || value === '0') {
    return false;
  }
  return null;
}

function numberOf(text: string): number | null {
  return /^-?[0-9]{1,15}(?:\.[0-9]{1,9})?$/u.test(text.trim()) ? Number(text.trim()) : null;
}

/** The `key=value` lines of an observation, grouped by key in the order they came. */
function groupLines(lines: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const list = grouped.get(key) ?? [];
    list.push(line.slice(separator + 1));
    grouped.set(key, list);
  }
  return grouped;
}

function fieldValue(def: ObservationFieldDef, lines: readonly string[] | undefined): ObservedValue {
  if (def.type === 'list') {
    if (lines === undefined) {
      return def.optional === true ? null : [];
    }
    return lines.filter((line) => line.length > 0);
  }
  const first = lines?.[0];
  if (first === undefined) {
    return null;
  }
  if (def.type === 'string') {
    return first;
  }
  return def.type === 'number' ? numberOf(first) : booleanOf(first);
}

/**
 * Entries of a list that must have a fixed form, whatever the script printed: a container's variables are reported by
 * name only (ADR 0045), so an entry that is not a variable name (a fragment of a value) is dropped here as well as on
 * the server, and the four flags must be a known name with a plain word.
 */
const ENTRY_FORMS: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'docker.container': {
    envNames: /^[A-Za-z_][A-Za-z0-9_.-]*$/u,
    envFlags: /^(?:SNI_VERIFICATION|NODE_PORT|NODE_ENV|TZ)=[A-Za-z0-9._:/+-]*$/u,
  },
};

/** Reads the fields of one observation of the catalogue. Keys the catalogue does not know are ignored. */
function fieldsOf(kind: string, lines: readonly string[]): Record<string, ObservedValue> | null {
  const def = observationKind(kind);
  const grouped = groupLines(lines);
  if (grouped.has('truncated')) {
    return null;
  }
  const forms = ENTRY_FORMS[kind];
  const fields: Record<string, ObservedValue> = {};
  for (const field of def?.fields ?? []) {
    const form = forms?.[field.name];
    const raw = grouped.get(field.name);
    if (
      field.type === 'list' &&
      (raw?.filter((entry) => entry !== '').length ?? 0) > MAX_LIST_ENTRIES
    ) {
      return null;
    }
    fields[field.name] = fieldValue(
      field,
      form === undefined || raw === undefined ? raw : raw.filter((entry) => form.test(entry)),
    );
  }
  return fields;
}

interface Open {
  readonly index: number;
  readonly kind: string;
  readonly lines: string[];
  truncated: boolean;
}

/**
 * Reads the output of `observe.sh` strictly (ADR 0045). Only a line that begins with `@@swb ` is a marker, and the
 * script puts `| ` in front of every line of a value, so what a file or a command printed cannot be taken for a marker.
 * Everything that is not understood is ignored: an unknown marker, a line without `| `, a field the catalogue lacks.
 * An observation that is announced twice, or that never ends, is an error and not a guess.
 */
export function parseObservations(
  stdout: Buffer,
  planned: readonly PlannedObservation[],
  options: ParseOptions = {},
): ParsedOutput {
  const decoded = decoder.decode(stdout);
  // A byte order mark in front of the output (a login banner of some shells) is not output.
  const text = decoded.startsWith(BOM) ? decoded.slice(1) : decoded;
  const warnings: string[] = [];
  const kindOf = new Map(planned.map((observation) => [observation.index, observation.kind]));
  const done = new Map<number, ParsedObservation>();
  const seenBegin = new Set<number>();
  const duplicates = new Set<number>();
  let recognised = false;
  let complete = false;
  let serverEpoch: number | null = null;
  let uid: number | null = null;
  let open: Open | undefined;

  const finish = (index: number, code: number): void => {
    if (open?.index !== index) {
      warnings.push(`The end of observation ${String(index)} came without its beginning.`);
      return;
    }
    const kind = open.kind;
    const result = duplicates.has(index) ? 'error' : statusOf(code);
    const fields = result === 'ok' && !open.truncated ? fieldsOf(kind, open.lines) : null;
    const status = result === 'ok' && fields === null ? 'error' : result;
    done.set(index, {
      index,
      kind,
      status,
      fields,
    });
    open = undefined;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('| ')) {
      if (open) {
        if (open.lines.length >= MAX_LINES_PER_OBSERVATION || line.length - 2 > MAX_LINE_CHARS) {
          open.truncated = true;
        } else {
          open.lines.push(line.slice(2).replaceAll(CONTROL, ''));
        }
      }
      continue;
    }
    const marker = MARKER.exec(line);
    if (!marker) {
      continue;
    }
    const [, word, rest = ''] = marker;
    if (word === 'v1') {
      recognised = true;
    } else if (word === 'epoch') {
      const value = numberOf(rest);
      serverEpoch = value !== null && Number.isInteger(value) && value > 0 ? value : null;
    } else if (word === 'uid') {
      const value = numberOf(rest);
      uid = value !== null && Number.isInteger(value) && value >= 0 ? value : null;
    } else if (word === 'begin') {
      const [indexText = '', kind = ''] = rest.split(' ');
      const index = Number(indexText);
      if (!Number.isInteger(index) || !kindOf.has(index)) {
        warnings.push(`An observation began that was not asked for: ${indexText.slice(0, 20)}.`);
        open = undefined;
        continue;
      }
      if (open) {
        warnings.push(`Observation ${String(open.index)} never ended.`);
        done.set(open.index, { index: open.index, kind: open.kind, status: 'error', fields: null });
      }
      if (seenBegin.has(index)) {
        // Neither of the two can be trusted.
        warnings.push(`Observation ${String(index)} was announced twice.`);
        duplicates.add(index);
      }
      seenBegin.add(index);
      open = { index, kind: kindOf.get(index) ?? kind, lines: [], truncated: false };
    } else if (word === 'end') {
      const [indexText = '', codeText = ''] = rest.split(' ');
      const index = Number(indexText);
      const code = Number(codeText);
      if (!Number.isInteger(index) || !Number.isInteger(code)) {
        warnings.push('An end marker was not understood.');
        continue;
      }
      finish(index, code);
    } else if (word === 'done') {
      complete = true;
    }
  }

  if (open) {
    warnings.push(`Observation ${String(open.index)} never ended.`);
    done.set(open.index, { index: open.index, kind: open.kind, status: 'error', fields: null });
  }

  // The skew between the server's clock and ours is made here: the script cannot know our clock.
  if (serverEpoch !== null && options.controllerEpochMs !== undefined) {
    const skew = Math.abs(serverEpoch - options.controllerEpochMs / 1000);
    for (const [index, observation] of done) {
      if (observation.kind === 'time.sync' && observation.fields) {
        done.set(index, {
          ...observation,
          fields: { ...observation.fields, skewSeconds: Math.round(skew * 10) / 10 },
        });
      }
    }
  }
  if (options.truncated === true) {
    warnings.push('The output was longer than the limit and was cut.');
  }
  return { recognised, serverEpoch, uid, complete, observations: done, warnings };
}
