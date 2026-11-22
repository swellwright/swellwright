import {
  PANEL_SNAPSHOT_OBJECT_KINDS,
  type PanelDiff,
  type PanelDiffCounts,
  type PanelDiffNote,
  type PanelDiffObject,
  type PanelFieldChange,
  type PanelSnapshotObjectKind,
} from '@swellwright/contracts';

import { canonicalJson } from './mask.js';
import type { SnapshotContent, SnapshotItem } from './snapshot-content.js';

// The diff engine (ADR 0043): a pure function from two snapshot contents to the differences between them. Objects are
// matched by id; two objects with the same hash are the same; for the others the masked configurations are walked
// together and every difference becomes a field change with a path. The rules that keep the result readable:
//   - an array of objects is matched by its natural key (`tag`, `uuid`, `name`, `ruleTag`) when every element has a
//     unique one, so that adding an inbound is one change and not a shift of every index after it;
//   - an array that is a set (tags, uuids of nodes, server names...) is compared without regard to order;
//   - any other array is compared by its longest common subsequence, so that one inserted rule is one change;
//   - a list of clients, users, accounts or peers is never shown, only counted;
//   - a masked secret compares by its keyed fingerprint: a rotation is "changed, masked", and neither value can be read;
//   - a text of several lines (a YAML template) shows the lines that went and the lines that came;
//   - timestamps and runtime fields are not in the configuration to begin with, and the few that could appear at the top
//     of an object are ignored;
//   - a result is capped (objects, changes per object, the size of a value) and says so: the counts are always complete.

export interface DiffOptions {
  /** Objects listed in the result; the counts of the summary are complete whatever this is. */
  readonly maxObjects?: number;
  /** Field changes listed per object; `changeCount` is complete. */
  readonly maxChangesPerObject?: number;
  /** The size, as JSON, above which a `before` or `after` is replaced by a note on its size. */
  readonly maxValueBytes?: number;
  /** List the objects that did not change too. */
  readonly includeUnchanged?: boolean;
  /**
   * Compare `[masked:1a2b3c4d]` as `[masked]`. Set when the two sides were masked with different keys: the
   * fingerprints then differ for every secret and say nothing.
   */
  readonly ignoreMaskFingerprints?: boolean;
}

export const DIFF_DEFAULTS = {
  maxObjects: 1000,
  maxChangesPerObject: 200,
  maxValueBytes: 4096,
} as const;

/** Keys at the top of an object that are the clock's and not the configuration's. */
const IGNORED_TOP_KEYS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
  'lastStatusChange',
  'lastSeen',
  'lastSeenAt',
  'lastConnectedAt',
]);

/** Arrays whose order means nothing. Matched by the name of the key they sit under. */
const SET_ARRAY_KEYS: ReadonlySet<string> = new Set([
  'tags',
  'nodeUuids',
  'integrationUuids',
  'squadUuids',
  'excludeFromSubscriptionTypes',
  'includeInSrrRules',
  'serverNames',
  'destOverride',
  'alpn',
  'scopes',
  'inbounds',
  'activeInbounds',
]);

/** The keys that identify an element of an array of objects, most specific first. */
const NATURAL_KEYS = ['tag', 'uuid', 'ruleTag', 'name'] as const;

/** Lists of people: their ids and logins are masked, and what remains of them is not shown either. */
const PEOPLE_KEYS: ReadonlySet<string> = new Set([
  'clients',
  'users',
  'accounts',
  'peers',
  'proxies',
]);

const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/gu, '');

const FINGERPRINT = /\[masked:[0-9a-f]{8}\]/gu;
const MASKED = /\[masked(?::[0-9a-f]{8})?\]/u;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The most cells the dynamic programme of a subsequence may fill before a positional comparison is used. */
const LCS_CELLS = 2_000_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isScalar = (value: unknown): boolean => value === null || typeof value !== 'object';

/** A text for one value that is the same for equal values: the key of a comparison of elements. */
function canon(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return JSON.stringify(value === undefined ? null : value);
  }
}

function containsMask(value: unknown): boolean {
  if (typeof value === 'string') {
    return MASKED.test(value);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return MASKED.test(canon(value));
}

/** The value with every fingerprint of a mask replaced by the bare mask. */
function withoutFingerprints(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(FINGERPRINT, '[masked]');
  }
  if (Array.isArray(value)) {
    return value.map(withoutFingerprints);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutFingerprints(item)]),
    );
  }
  return value;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const keyPath = (parent: string, key: string): string =>
  IDENT.test(key)
    ? parent === ''
      ? key
      : `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;

/** An element of an array of objects that has a natural key: its name in a path. */
function naturalKeyOf(items: readonly unknown[]): (typeof NATURAL_KEYS)[number] | undefined {
  if (items.length === 0 || !items.every(isObject)) {
    return undefined;
  }
  for (const key of NATURAL_KEYS) {
    const seen = new Set<string>();
    let usable = true;
    for (const element of items as Record<string, unknown>[]) {
      const value = element[key];
      if ((typeof value !== 'string' && typeof value !== 'number') || seen.has(String(value))) {
        usable = false;
        break;
      }
      seen.add(String(value));
    }
    if (usable) {
      return key;
    }
  }
  return undefined;
}

/** A value about to be shown with its lists of people replaced by how many items they hold. */
function withoutPeople(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutPeople);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        PEOPLE_KEYS.has(norm(key)) && Array.isArray(item)
          ? { items: item.length }
          : withoutPeople(item),
      ]),
    );
  }
  return value;
}

/** One walk of a pair of values: collects the field changes, counts them all, keeps the first `cap`. */
class Walker {
  readonly changes: PanelFieldChange[] = [];
  total = 0;

  constructor(
    private readonly cap: number,
    private readonly maxValueBytes: number,
  ) {}

  /** A value for the result: as it is, or a note that says how large it was. */
  private show(value: unknown): { value: unknown; cut: boolean } {
    if (typeof value === 'string') {
      return value.length > this.maxValueBytes
        ? { value: `${value.slice(0, this.maxValueBytes)}…`, cut: true }
        : { value, cut: false };
    }
    if (value !== null && typeof value === 'object') {
      // The lists of people inside a value that is shown whole (an inbound that was added) are only counted.
      const shown = withoutPeople(value);
      const size = canon(shown).length;
      if (size > this.maxValueBytes) {
        return { value: `[a value of ${String(size)} characters, not shown]`, cut: true };
      }
      return { value: shown, cut: false };
    }
    return { value, cut: false };
  }

  private push(change: PanelFieldChange): void {
    this.total += 1;
    if (this.changes.length < this.cap) {
      this.changes.push(change);
    }
  }

  private emit(
    path: string,
    op: PanelFieldChange['op'],
    before: unknown,
    after: unknown,
    extra: Partial<PanelFieldChange> = {},
  ): void {
    const left = op === 'added' ? undefined : this.show(before);
    const right = op === 'removed' ? undefined : this.show(after);
    const masked =
      extra.masked ??
      ((left !== undefined && containsMask(before)) ||
        (right !== undefined && containsMask(after)));
    this.push({
      path,
      op,
      ...(left === undefined ? {} : { before: left.value }),
      ...(right === undefined ? {} : { after: right.value }),
      ...(masked ? { masked: true } : {}),
      ...(extra.hidden === true ? { hidden: true } : {}),
      ...(extra.lines === undefined ? {} : { lines: extra.lines }),
      ...((left?.cut ?? false) || (right?.cut ?? false) ? { valueTruncated: true } : {}),
    });
  }

  // ---- the walk ------------------------------------------------------------------------------------------------------

  walk(path: string, before: unknown, after: unknown, key: string, top: boolean): void {
    if (Array.isArray(before) && Array.isArray(after)) {
      this.arrays(path, before, after, key);
      return;
    }
    if (isObject(before) && isObject(after)) {
      this.objects(path, before, after, top);
      return;
    }
    if (typeof before === 'string' && typeof after === 'string') {
      if (before === after) {
        return;
      }
      if (before.includes('\n') || after.includes('\n')) {
        this.lines(path, before, after);
        return;
      }
    }
    if (before !== after && canon(before) !== canon(after)) {
      this.emit(path, 'changed', before, after);
    }
  }

  private objects(
    path: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    top: boolean,
  ): void {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      if (top && IGNORED_TOP_KEYS.has(key)) {
        continue;
      }
      const at = keyPath(path, key);
      const hasBefore = Object.hasOwn(before, key) && before[key] !== undefined;
      const hasAfter = Object.hasOwn(after, key) && after[key] !== undefined;
      const left = before[key];
      const right = after[key];
      if (!hasBefore && !hasAfter) {
        continue;
      }
      if (PEOPLE_KEYS.has(norm(key)) && (Array.isArray(left) || Array.isArray(right))) {
        this.people(at, hasBefore ? left : undefined, hasAfter ? right : undefined);
        continue;
      }
      if (hasBefore && !hasAfter) {
        this.emit(at, 'removed', left, undefined);
      } else if (!hasBefore && hasAfter) {
        this.emit(at, 'added', undefined, right);
      } else {
        this.walk(at, left, right, key, false);
      }
    }
  }

  /** A list of people: how many, and whether anything in it differs; never what. */
  private people(path: string, before: unknown, after: unknown): void {
    const count = (value: unknown): number | undefined =>
      Array.isArray(value) ? value.length : undefined;
    const left = count(before);
    const right = count(after);
    if (left !== undefined && right !== undefined && canon(before) === canon(after)) {
      return;
    }
    const op: PanelFieldChange['op'] =
      left === undefined ? 'added' : right === undefined ? 'removed' : 'changed';
    this.push({
      path,
      op,
      ...(left === undefined ? {} : { before: { items: left } }),
      ...(right === undefined ? {} : { after: { items: right } }),
      masked: true,
      hidden: true,
    });
  }

  private arrays(path: string, before: unknown[], after: unknown[], key: string): void {
    if (SET_ARRAY_KEYS.has(key) && before.every(isScalar) && after.every(isScalar)) {
      this.set(path, before, after);
      return;
    }
    // An empty side takes the key of the other; two non-empty sides must agree on one.
    const keyBefore = naturalKeyOf(before);
    const keyAfter = naturalKeyOf(after);
    const keyName =
      before.length === 0
        ? keyAfter
        : after.length === 0
          ? keyBefore
          : keyBefore === keyAfter
            ? keyBefore
            : undefined;
    if (keyName !== undefined) {
      this.keyed(
        path,
        before as Record<string, unknown>[],
        after as Record<string, unknown>[],
        keyName,
        key,
      );
      return;
    }
    this.sequence(path, before, after);
  }

  /** An array that is a set of scalars: members that came and members that went. */
  private set(path: string, before: unknown[], after: unknown[]): void {
    const left = new Map(before.map((value) => [canon(value), value]));
    const right = new Map(after.map((value) => [canon(value), value]));
    for (const [text, value] of [...left].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!right.has(text)) {
        this.emit(path, 'removed', value, undefined);
      }
    }
    for (const [text, value] of [...right].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!left.has(text)) {
        this.emit(path, 'added', undefined, value);
      }
    }
  }

  /** An array of objects with a natural key: matched by it, compared pair by pair. */
  private keyed(
    path: string,
    before: Record<string, unknown>[],
    after: Record<string, unknown>[],
    keyName: string,
    arrayKey: string,
  ): void {
    const left = new Map(before.map((element) => [String(element[keyName]), element]));
    const right = new Map(after.map((element) => [String(element[keyName]), element]));
    const names = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const name of names) {
      const at = `${path}[${keyName}=${name}]`;
      const old = left.get(name);
      const next = right.get(name);
      if (old !== undefined && next === undefined) {
        this.emit(at, 'removed', old, undefined);
      } else if (old === undefined && next !== undefined) {
        this.emit(at, 'added', undefined, next);
      } else if (old !== undefined && next !== undefined) {
        this.walk(at, old, next, arrayKey, false);
      }
    }
    // The order of the elements that are in both: for a set of objects it means nothing, for the others it may (the
    // first outbound is the default one, rules are tried in turn).
    if (!SET_ARRAY_KEYS.has(arrayKey)) {
      const common = (list: Record<string, unknown>[], other: Map<string, unknown>): string[] =>
        list.map((element) => String(element[keyName])).filter((name) => other.has(name));
      const order = common(before, right);
      const reordered = common(after, left);
      if (order.length > 1 && canon(order) !== canon(reordered)) {
        this.push({ path, op: 'changed', before: order, after: reordered });
      }
    }
  }

  /** Any other array: the longest common subsequence stays, what is between is removed, added or changed in place. */
  private sequence(path: string, before: unknown[], after: unknown[]): void {
    const left = before.map(canon);
    const right = after.map(canon);
    const steps = align(left, right);
    let index = 0;
    while (index < steps.length) {
      const step = steps[index];
      if (step === undefined || step.kind === 'keep') {
        index += 1;
        continue;
      }
      // A gap: a run of removals and additions between two kept elements.
      const removed: number[] = [];
      const added: number[] = [];
      while (index < steps.length && steps[index]?.kind !== 'keep') {
        const gap = steps[index];
        if (gap?.kind === 'del') {
          removed.push(gap.a);
        } else if (gap?.kind === 'add') {
          added.push(gap.b);
        }
        index += 1;
      }
      const pairs = Math.min(removed.length, added.length);
      for (let i = 0; i < pairs; i += 1) {
        const a = removed[i] ?? 0;
        const b = added[i] ?? 0;
        this.walk(`${path}[${String(b)}]`, before[a], after[b], '', false);
      }
      for (const a of removed.slice(pairs)) {
        this.emit(`${path}[${String(a)}]`, 'removed', before[a], undefined);
      }
      for (const b of added.slice(pairs)) {
        this.emit(`${path}[${String(b)}]`, 'added', undefined, after[b]);
      }
    }
  }

  /** A text of several lines: the lines that went and the lines that came. */
  private lines(path: string, before: string, after: string): void {
    const left = before.split('\n');
    const right = after.split('\n');
    const steps = align(left, right);
    const removed: string[] = [];
    const added: string[] = [];
    for (const step of steps) {
      if (step.kind === 'del') {
        removed.push(left[step.a] ?? '');
      } else if (step.kind === 'add') {
        added.push(right[step.b] ?? '');
      }
    }
    const masked = containsMask(before) || containsMask(after);
    this.emit(path, 'changed', removed.join('\n'), added.join('\n'), {
      lines: { removed: removed.length, added: added.length },
      masked,
    });
  }
}

interface Step {
  readonly kind: 'keep' | 'del' | 'add';
  readonly a: number;
  readonly b: number;
}

/**
 * The edit script between two lists of comparable texts: the longest common subsequence is kept and the rest is removed
 * from the first or added from the second. A pair of lists too large for the table is compared position by position.
 */
function align(left: readonly string[], right: readonly string[]): Step[] {
  const n = left.length;
  const m = right.length;
  const steps: Step[] = [];
  // Whatever the two lists share at the start and at the end is kept without any table.
  let head = 0;
  while (head < n && head < m && left[head] === right[head]) {
    steps.push({ kind: 'keep', a: head, b: head });
    head += 1;
  }
  let tail = 0;
  while (tail < n - head && tail < m - head && left[n - 1 - tail] === right[m - 1 - tail]) {
    tail += 1;
  }
  const rows = n - head - tail;
  const cols = m - head - tail;
  if (rows * cols > LCS_CELLS) {
    for (let i = 0; i < rows; i += 1) {
      steps.push({ kind: 'del', a: head + i, b: head });
    }
    for (let j = 0; j < cols; j += 1) {
      steps.push({ kind: 'add', a: head, b: head + j });
    }
  } else if (rows === 0 || cols === 0) {
    for (let i = 0; i < rows; i += 1) {
      steps.push({ kind: 'del', a: head + i, b: head });
    }
    for (let j = 0; j < cols; j += 1) {
      steps.push({ kind: 'add', a: head, b: head + j });
    }
  } else {
    const width = cols + 1;
    const table = new Int32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          left[head + i] === right[head + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (left[head + i] === right[head + j]) {
        steps.push({ kind: 'keep', a: head + i, b: head + j });
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        steps.push({ kind: 'del', a: head + i, b: head + j });
        i += 1;
      } else {
        steps.push({ kind: 'add', a: head + i, b: head + j });
        j += 1;
      }
    }
    for (; i < rows; i += 1) {
      steps.push({ kind: 'del', a: head + i, b: head + j });
    }
    for (; j < cols; j += 1) {
      steps.push({ kind: 'add', a: head + i, b: head + j });
    }
  }
  for (let t = 0; t < tail; t += 1) {
    steps.push({ kind: 'keep', a: n - tail + t, b: m - tail + t });
  }
  return steps;
}

/** The field changes between two configurations, for the tests and for the objects of a diff. */
export function diffValues(
  before: unknown,
  after: unknown,
  options: Pick<
    DiffOptions,
    'maxChangesPerObject' | 'maxValueBytes' | 'ignoreMaskFingerprints'
  > = {},
): { changes: PanelFieldChange[]; total: number } {
  const walker = new Walker(
    options.maxChangesPerObject ?? DIFF_DEFAULTS.maxChangesPerObject,
    options.maxValueBytes ?? DIFF_DEFAULTS.maxValueBytes,
  );
  const [left, right] =
    options.ignoreMaskFingerprints === true
      ? [withoutFingerprints(before), withoutFingerprints(after)]
      : [before, after];
  walker.walk('', left, right, '', true);
  return { changes: walker.changes, total: walker.total };
}

// ---- the diff of two snapshot contents ------------------------------------------------------------------------------

export type DiffOutcome = Pick<PanelDiff, 'identical' | 'summary' | 'objects' | 'notes' | 'labels'>;

const empty = (): PanelDiffCounts => ({ added: 0, removed: 0, changed: 0, unchanged: 0 });
const code = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byName = (a: PanelDiffObject, b: PanelDiffObject): number =>
  code(a.name, b.name) || code(a.id, b.id);

/** Collects the names of the objects and the tags of the inbounds, so that a uuid in a value can be read. */
function nameIndex(...contents: SnapshotContent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const content of contents) {
    for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
      for (const entry of content.kinds[kind] ?? []) {
        if (WHOLE_UUID.test(entry.id)) {
          names.set(entry.id.toLowerCase(), entry.name);
        }
        if (kind === 'configProfiles' && isObject(entry.config)) {
          const inbounds = entry.config['inbounds'];
          if (Array.isArray(inbounds)) {
            for (const inbound of inbounds) {
              if (
                isObject(inbound) &&
                typeof inbound['uuid'] === 'string' &&
                typeof inbound['tag'] === 'string'
              ) {
                names.set(inbound['uuid'].toLowerCase(), `${entry.name} / ${inbound['tag']}`);
              }
            }
          }
        }
      }
    }
  }
  return names;
}

function labelsFor(
  objects: readonly PanelDiffObject[],
  names: ReadonlyMap<string, string>,
): Record<string, string> {
  const labels: Record<string, string> = {};
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const found of value.match(UUID) ?? []) {
        const name = names.get(found.toLowerCase());
        if (name !== undefined) {
          labels[found] = name;
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (isObject(value)) {
      Object.values(value).forEach(scan);
    }
  };
  for (const object of objects) {
    for (const change of object.changes) {
      scan(change.before);
      scan(change.after);
    }
  }
  return labels;
}

function compareItem(
  kind: PanelSnapshotObjectKind,
  from: SnapshotItem,
  to: SnapshotItem,
  options: DiffOptions,
): { object: PanelDiffObject; noiseOnly: boolean } {
  const ignore = options.ignoreMaskFingerprints === true;
  if (!ignore && from.hash === to.hash) {
    return {
      object: {
        kind,
        id: to.id,
        name: to.name,
        status: 'unchanged',
        changes: [],
        changeCount: 0,
        truncated: false,
        fromHash: from.hash,
        toHash: to.hash,
      },
      noiseOnly: false,
    };
  }
  const { changes, total } = diffValues(from.config, to.config, options);
  return {
    object: {
      kind,
      id: to.id,
      name: to.name,
      status: total === 0 ? 'unchanged' : 'changed',
      changes,
      changeCount: total,
      truncated: changes.length < total,
      fromHash: from.hash,
      toHash: to.hash,
    },
    // The hashes differ and nothing in the compared fields does: a timestamp, or a fingerprint that was set aside.
    noiseOnly: total === 0 && from.hash !== to.hash && !ignore,
  };
}

/**
 * What differs between two snapshot contents, seen from `from` to `to`. A kind that only one side holds is not
 * compared and is named in a note. When the two were masked with different keys the fingerprints are set aside.
 */
export function diffSnapshotContents(
  from: SnapshotContent,
  to: SnapshotContent,
  options: DiffOptions = {},
): DiffOutcome {
  const maxObjects = options.maxObjects ?? DIFF_DEFAULTS.maxObjects;
  const effective: DiffOptions = {
    ...options,
    ignoreMaskFingerprints: options.ignoreMaskFingerprints ?? from.maskKeyId !== to.maskKeyId,
  };
  const notes: PanelDiffNote[] = [];
  if (from.maskKeyId !== to.maskKeyId) {
    notes.push({ code: 'mask_key_differs' });
  }

  const total = empty();
  const byKind: Partial<Record<PanelSnapshotObjectKind, PanelDiffCounts>> = {};
  const listed: PanelDiffObject[] = [];
  const onlyOneSide: PanelSnapshotObjectKind[] = [];
  let omitted = 0;
  let fieldChanges = 0;
  let noiseOnly = 0;

  const list = (object: PanelDiffObject): void => {
    if (object.status === 'unchanged' && options.includeUnchanged !== true) {
      return;
    }
    if (listed.length < maxObjects) {
      listed.push(object);
    } else {
      omitted += 1;
    }
  };

  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    const before = from.kinds[kind];
    const after = to.kinds[kind];
    if (before === undefined || after === undefined) {
      if (before !== undefined || after !== undefined) {
        onlyOneSide.push(kind);
      }
      continue;
    }
    const counts = empty();
    const left = new Map(before.map((entry) => [entry.id, entry]));
    const right = new Map(after.map((entry) => [entry.id, entry]));
    const objects: PanelDiffObject[] = [];
    for (const [id, entry] of right) {
      const old = left.get(id);
      if (old === undefined) {
        counts.added += 1;
        objects.push({
          kind,
          id,
          name: entry.name,
          status: 'added',
          changes: [],
          changeCount: 0,
          truncated: false,
          fromHash: null,
          toHash: entry.hash,
        });
        continue;
      }
      const compared = compareItem(kind, old, entry, effective);
      counts[compared.object.status === 'unchanged' ? 'unchanged' : 'changed'] += 1;
      fieldChanges += compared.object.changeCount;
      if (compared.noiseOnly) {
        noiseOnly += 1;
      }
      objects.push(compared.object);
    }
    for (const [id, entry] of left) {
      if (!right.has(id)) {
        counts.removed += 1;
        objects.push({
          kind,
          id,
          name: entry.name,
          status: 'removed',
          changes: [],
          changeCount: 0,
          truncated: false,
          fromHash: entry.hash,
          toHash: null,
        });
      }
    }
    byKind[kind] = counts;
    total.added += counts.added;
    total.removed += counts.removed;
    total.changed += counts.changed;
    total.unchanged += counts.unchanged;
    objects.sort(byName).forEach(list);
  }

  if (onlyOneSide.length > 0) {
    notes.push({ code: 'kind_not_covered', kinds: onlyOneSide });
  }
  if (noiseOnly > 0) {
    notes.push({ code: 'noise_only', count: noiseOnly });
  }
  if (omitted > 0) {
    notes.push({ code: 'objects_cut', count: omitted });
  }
  return {
    identical: total.added === 0 && total.removed === 0 && total.changed === 0,
    summary: { objects: total, byKind, fieldChanges },
    objects: listed,
    notes,
    labels: labelsFor(listed, nameIndex(from, to)),
  };
}
