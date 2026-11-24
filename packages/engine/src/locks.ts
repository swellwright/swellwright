// Resource locks (ADR 0048, "Locks"): what a step may name, the one fixed order in which a run takes them, and the decision
// whether a run may take them now.
//
// The decision is a pure function over the rows that are held at the moment. The database layer takes the rows in the same
// statement and in the same order; it is the row, with its fence, that makes the decision true, not this function.

export const RESOURCE_KINDS = ['panel', 'dns-zone', 'server', 'node'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** A resource that a step changes. The panel is one resource and has no name; every other kind needs one. */
export interface ResourceRef {
  readonly kind: ResourceKind;
  readonly id: string | null;
}

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class InvalidResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResourceError';
  }
}

const isKind = (value: string): value is ResourceKind =>
  (RESOURCE_KINDS as readonly string[]).includes(value);

/** The resource `kind` named `id`; `panel` takes no id and every other kind needs one. */
export function resource(kind: ResourceKind, id?: string): ResourceRef {
  if (!isKind(kind)) {
    throw new InvalidResourceError(`"${String(kind).slice(0, 40)}" is not a kind of resource.`);
  }
  if (kind === 'panel') {
    if (id !== undefined) {
      throw new InvalidResourceError('The panel is one resource and has no id.');
    }
    return Object.freeze({ kind, id: null });
  }
  if (id === undefined || !RESOURCE_ID.test(id)) {
    throw new InvalidResourceError(
      `A ${kind} lock needs an id of 1 to 128 letters, digits, dots, dashes and underscores (it starts with a letter or a digit).`,
    );
  }
  return Object.freeze({ kind, id });
}

export const panelResource = (): ResourceRef => resource('panel');
export const serverResource = (id: string): ResourceRef => resource('server', id);
export const nodeResource = (name: string): ResourceRef => resource('node', name);
export const dnsZoneResource = (zone: string): ResourceRef => resource('dns-zone', zone);

/** The text under which a lock is stored: `panel`, `server:<id>`, `node:<name>`, `dns-zone:<zone>`. */
export function lockKey(ref: ResourceRef): string {
  return ref.id === null ? ref.kind : `${ref.kind}:${ref.id}`;
}

export function parseLockKey(text: string): ResourceRef {
  const colon = text.indexOf(':');
  if (colon === -1) {
    return resource(text as ResourceKind);
  }
  return resource(text.slice(0, colon) as ResourceKind, text.slice(colon + 1));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one order in which locks are taken: by kind (the order of `RESOURCE_KINDS`), then by id in the order of the code
 * units. A resource named twice is taken once. Two runs that each need two of the same resources take them in the same
 * order, so neither can hold what the other waits for.
 */
export function orderLocks(refs: readonly ResourceRef[]): ResourceRef[] {
  const byKey = new Map<string, ResourceRef>();
  for (const ref of refs) {
    byKey.set(lockKey(ref), ref);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      RESOURCE_KINDS.indexOf(a.kind) - RESOURCE_KINDS.indexOf(b.kind) ||
      compareText(a.id ?? '', b.id ?? ''),
  );
}

/** A lock row as the database holds it. Times are milliseconds since the epoch. */
export interface HeldLock {
  readonly key: string;
  readonly holder: string;
  readonly fence: number;
  readonly expiresAt: number;
}

export type Acquisition =
  | {
      readonly ok: true;
      /** No row exists: insert it. */
      readonly take: readonly string[];
      /** The run holds it already (a new worker of the same run, a renewal): set the new fence and expiry. */
      readonly renew: readonly string[];
      /** Another run holds it but let it expire: take it over with the new fence. */
      readonly supersede: readonly string[];
    }
  | {
      readonly ok: false;
      /** The first resource, in the order of the locks, that another run holds. */
      readonly blockedKey: string;
      readonly heldBy: string;
      readonly expiresAt: number;
    };

/**
 * May `run` take all of `wanted` at `now`? All or nothing: a run that is blocked on one resource takes none, so it does not
 * keep a resource from another run while it waits.
 */
export function planAcquisition(input: {
  readonly run: string;
  readonly wanted: readonly ResourceRef[];
  readonly held: readonly HeldLock[];
  readonly now: number;
}): Acquisition {
  const heldByKey = new Map(input.held.map((lock) => [lock.key, lock]));
  const take: string[] = [];
  const renew: string[] = [];
  const supersede: string[] = [];
  for (const ref of orderLocks(input.wanted)) {
    const key = lockKey(ref);
    const lock = heldByKey.get(key);
    if (lock === undefined) {
      take.push(key);
    } else if (lock.holder === input.run) {
      renew.push(key);
    } else if (lock.expiresAt <= input.now) {
      supersede.push(key);
    } else {
      return { ok: false, blockedKey: key, heldBy: lock.holder, expiresAt: lock.expiresAt };
    }
  }
  return { ok: true, take, renew, supersede };
}

/** The reason a run waits, as it is shown on the run: `lock server:42 held by <run>`. */
export function waitingReason(blocked: Extract<Acquisition, { ok: false }>): string {
  return `lock ${blocked.blockedKey} held by ${blocked.heldBy}`;
}
