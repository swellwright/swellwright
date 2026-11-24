// A finite state machine as data: a table of states and events, and one pure function over it (ADR 0048).
//
// Nothing here knows about a database or a clock. The database layer applies a result only as a compare-and-set on the
// state it read, so a transition that two workers race for is decided by the row, not by this function.

/** For every state the events it accepts and where each leads. A state with no events is final. */
export type TransitionTable<S extends string, E extends string> = Readonly<
  Record<S, Readonly<Partial<Record<E, S>>>>
>;

export type InvalidTransitionReason = 'unknown_state' | 'unknown_event' | 'not_allowed';

/** A name in an error message: quoted and cut, because it may come from a row that is not what the code expects. */
const quoted = (value: unknown): string => JSON.stringify(String(value).slice(0, 48));

/**
 * An event that the state does not take. It is an error that names both the state and the event, and what the state would
 * have taken: a transition that cannot happen is never a silent no-op.
 */
export class InvalidTransitionError extends Error {
  readonly machine: string;
  readonly state: string;
  readonly event: string;
  readonly reason: InvalidTransitionReason;
  /** The events the state accepts, in the order of the machine's events. Empty for a final state. */
  readonly allowed: readonly string[];

  constructor(
    machine: string,
    state: unknown,
    event: unknown,
    reason: InvalidTransitionReason,
    allowed: readonly string[],
  ) {
    const message =
      reason === 'unknown_state'
        ? `${quoted(state)} is not a state of a ${machine} (the event was ${quoted(event)}).`
        : reason === 'unknown_event'
          ? `${quoted(event)} is not an event of a ${machine} (the state was ${quoted(state)}).`
          : `A ${machine} in the state ${quoted(state)} cannot take the event ${quoted(event)}: ${
              allowed.length === 0 ? 'the state is final' : `it takes ${allowed.join(', ')}`
            }.`;
    super(message);
    this.name = 'InvalidTransitionError';
    this.machine = machine;
    this.state = String(state);
    this.event = String(event);
    this.reason = reason;
    this.allowed = allowed;
  }
}

/** One legal transition: the state, the event and the state it leads to. */
export interface Edge<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
}

export interface Machine<S extends string, E extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  // Members are function-valued properties, so they can be passed around (`const isRunState = machine.isState`) safely.
  /** The state the event leads to. Throws `InvalidTransitionError` when the state does not take the event. */
  readonly transition: (state: S, event: E) => S;
  readonly canApply: (state: S, event: E) => boolean;
  /** The events the state takes, in the order of `events`. */
  readonly legalEvents: (state: S) => readonly E[];
  /** No event leads out of it. */
  readonly isFinal: (state: S) => boolean;
  readonly isState: (value: unknown) => value is S;
  readonly isEvent: (value: unknown) => value is E;
  /** Every legal transition, in the order of the states and then of the events. */
  readonly edges: () => readonly Edge<S, E>[];
}

export interface MachineSpec<S extends string, E extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly table: TransitionTable<S, E>;
}

/**
 * Builds a machine and checks the table once, at load: a state twice, an event that is not declared and a target that is
 * not a state are mistakes in the table, so they fail when the module is loaded and not when the first run meets them.
 */
export function createMachine<const S extends string, const E extends string>(
  spec: MachineSpec<S, E>,
): Machine<S, E> {
  const states = new Set<string>(spec.states);
  const events = new Set<string>(spec.events);
  if (states.size !== spec.states.length) {
    throw new Error(`${spec.name}: a state is listed twice.`);
  }
  if (events.size !== spec.events.length) {
    throw new Error(`${spec.name}: an event is listed twice.`);
  }
  const legal = new Map<S, readonly E[]>();
  const edges: Edge<S, E>[] = [];
  const rows = new Map<S, ReadonlyMap<E, S>>();
  for (const state of spec.states) {
    if (!Object.hasOwn(spec.table, state)) {
      throw new Error(`${spec.name}: the table has no row for the state ${quoted(state)}.`);
    }
    const row = new Map<E, S>();
    for (const [name, target] of Object.entries(spec.table[state])) {
      if (!events.has(name)) {
        throw new Error(
          `${spec.name}: ${quoted(state)} takes ${quoted(name)}, which is not an event.`,
        );
      }
      if (typeof target !== 'string' || !states.has(target)) {
        throw new Error(
          `${spec.name}: ${quoted(state)} on ${quoted(name)} leads to ${quoted(target)}, which is not a state.`,
        );
      }
      row.set(name as E, target as S);
    }
    rows.set(state, row);
    const ordered: E[] = [];
    for (const event of spec.events) {
      const to = row.get(event);
      if (to !== undefined) {
        ordered.push(event);
        edges.push({ from: state, event, to });
      }
    }
    legal.set(state, Object.freeze(ordered));
  }
  for (const name of Object.keys(spec.table)) {
    if (!states.has(name)) {
      throw new Error(
        `${spec.name}: the table has a row for ${quoted(name)}, which is not a state.`,
      );
    }
  }
  const frozenEdges = Object.freeze(edges.map((edge) => Object.freeze(edge)));
  const isState = (value: unknown): value is S => typeof value === 'string' && states.has(value);
  const isEvent = (value: unknown): value is E => typeof value === 'string' && events.has(value);
  return Object.freeze({
    name: spec.name,
    states: Object.freeze([...spec.states]),
    events: Object.freeze([...spec.events]),
    transition(state: S, event: E): S {
      if (!isState(state)) {
        throw new InvalidTransitionError(spec.name, state, event, 'unknown_state', []);
      }
      if (!isEvent(event)) {
        throw new InvalidTransitionError(spec.name, state, event, 'unknown_event', []);
      }
      const target = rows.get(state)?.get(event);
      if (target === undefined) {
        throw new InvalidTransitionError(
          spec.name,
          state,
          event,
          'not_allowed',
          legal.get(state) ?? [],
        );
      }
      return target;
    },
    canApply(state: S, event: E): boolean {
      return rows.get(state)?.has(event) === true;
    },
    legalEvents(state: S): readonly E[] {
      return legal.get(state) ?? [];
    },
    isFinal(state: S): boolean {
      return (legal.get(state) ?? []).length === 0;
    },
    isState,
    isEvent,
    edges(): readonly Edge<S, E>[] {
      return frozenEdges;
    },
  });
}
