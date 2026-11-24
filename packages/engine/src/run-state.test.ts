import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { InvalidTransitionError } from './machine.js';
import {
  LEASED_RUN_STATES,
  RUN_EVENTS,
  RUN_STATES,
  canApply,
  holdsLease,
  isFinalRunState,
  isRunEvent,
  isRunState,
  legalEvents,
  needsWorker,
  runEdges,
  transition,
  type RunEvent,
  type RunState,
} from './run-state.js';

/**
 * The oracle: every legal transition, written out once more and in another form than the table of the code. Changing the
 * lifecycle on purpose means changing it here, in the diagram of docs/en/architecture.md and in the table, and the three
 * must agree.
 */
const LEGAL: readonly (readonly [RunState, RunEvent, RunState])[] = [
  ['planned', 'request_approval', 'awaiting_approval'],
  ['planned', 'queue', 'queued'],
  ['planned', 'cancel', 'cancelled'],
  ['awaiting_approval', 'approve', 'queued'],
  ['awaiting_approval', 'reject', 'cancelled'],
  ['awaiting_approval', 'cancel', 'cancelled'],
  ['queued', 'claim', 'running'],
  ['queued', 'pause', 'paused'],
  ['queued', 'cancel', 'cancelled'],
  ['running', 'claim', 'running'],
  ['running', 'wait', 'queued'],
  ['running', 'pause', 'paused'],
  ['running', 'await_input', 'awaiting_input'],
  ['running', 'succeed', 'succeeded'],
  ['running', 'fail', 'failed'],
  ['running', 'cancel', 'cancelled'],
  ['paused', 'resume', 'queued'],
  ['paused', 'cancel', 'cancelled'],
  ['awaiting_input', 'retry', 'queued'],
  ['awaiting_input', 'mark_done', 'queued'],
  ['awaiting_input', 'request_rollback', 'rollback_requested'],
  ['awaiting_input', 'cancel', 'cancelled'],
  ['failed', 'retry', 'queued'],
  ['failed', 'request_rollback', 'rollback_requested'],
  ['cancelled', 'request_rollback', 'rollback_requested'],
  ['rollback_requested', 'claim', 'rolling_back'],
  ['rolling_back', 'claim', 'rolling_back'],
  ['rolling_back', 'rollback_done', 'rolled_back'],
  ['rolling_back', 'rollback_partial', 'rollback_partial'],
  ['rollback_partial', 'request_rollback', 'rollback_requested'],
];

const expected = (state: RunState, event: RunEvent): RunState | undefined =>
  LEGAL.find(([from, on]) => from === state && on === event)?.[2];

describe('the state of a run', () => {
  it('has the thirteen states of the design and the events that move them', () => {
    assert.equal(RUN_STATES.length, 13);
    assert.equal(RUN_EVENTS.length, 17);
    assert.equal(new Set(RUN_STATES).size, RUN_STATES.length);
    assert.equal(new Set(RUN_EVENTS).size, RUN_EVENTS.length);
  });

  it('answers every state against every event as the oracle does', () => {
    let legal = 0;
    for (const state of RUN_STATES) {
      for (const event of RUN_EVENTS) {
        const target = expected(state, event);
        if (target === undefined) {
          assert.equal(canApply(state, event), false, `${state} must not take ${event}`);
          assert.throws(
            () => transition(state, event),
            (error: unknown) =>
              error instanceof InvalidTransitionError &&
              error.reason === 'not_allowed' &&
              error.state === state &&
              error.event === event &&
              error.message.includes(`"${state}"`) &&
              error.message.includes(`"${event}"`),
            `${state} + ${event} must be an error that names both`,
          );
        } else {
          legal += 1;
          assert.equal(canApply(state, event), true, `${state} must take ${event}`);
          assert.equal(transition(state, event), target, `${state} + ${event}`);
        }
      }
    }
    assert.equal(legal, LEGAL.length);
    assert.equal(runEdges().length, LEGAL.length);
  });

  it('lists the events a state takes in the order of the events', () => {
    for (const state of RUN_STATES) {
      const events = legalEvents(state);
      assert.deepEqual(
        events,
        RUN_EVENTS.filter((event) => expected(state, event) !== undefined),
      );
    }
  });

  it('has exactly two final states, and no event leaves them', () => {
    const finals = RUN_STATES.filter(isFinalRunState);
    assert.deepEqual(finals, ['succeeded', 'rolled_back']);
    for (const state of finals) {
      for (const event of RUN_EVENTS) {
        assert.equal(canApply(state, event), false);
      }
    }
  });

  it('can reach every state from `planned`', () => {
    const seen = new Set<RunState>(['planned']);
    const queue: RunState[] = ['planned'];
    for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
      for (const [from, , to] of LEGAL) {
        if (from === state && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...RUN_STATES].sort());
  });

  it('can reach a final state from every state: no run is stuck for good', () => {
    for (const start of RUN_STATES) {
      const seen = new Set<RunState>([start]);
      const queue: RunState[] = [start];
      let reachesFinal = isFinalRunState(start);
      for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
        for (const [from, , to] of LEGAL) {
          if (from === state && !seen.has(to)) {
            seen.add(to);
            queue.push(to);
            reachesFinal ||= isFinalRunState(to);
          }
        }
      }
      assert.ok(reachesFinal, `${start} can never end`);
    }
  });

  it('never goes back to `planned`, and reaches `cancelled` only by `cancel` or `reject`', () => {
    assert.ok(LEGAL.every(([, , to]) => to !== 'planned'));
    assert.ok(
      LEGAL.filter(([, , to]) => to === 'cancelled').every(
        ([, event]) => event === 'cancel' || event === 'reject',
      ),
    );
  });

  it('lets only a claim start or continue the work of a worker', () => {
    assert.deepEqual(
      LEGAL.filter(([, event]) => event === 'claim').map(([, , to]) => to),
      ['running', 'running', 'rolling_back', 'rolling_back'],
    );
    assert.deepEqual(RUN_STATES.filter(needsWorker), [
      'queued',
      'running',
      'rollback_requested',
      'rolling_back',
    ]);
  });

  it('holds a lease in `running` and `rolling_back` only', () => {
    assert.deepEqual(LEASED_RUN_STATES, ['running', 'rolling_back']);
    assert.deepEqual(RUN_STATES.filter(holdsLease), ['running', 'rolling_back']);
  });

  it('refuses a state or an event that does not exist, and the names every object has', () => {
    assert.equal(isRunState('running'), true);
    assert.equal(isRunState('claim'), false);
    assert.equal(isRunEvent('claim'), true);
    assert.equal(isRunEvent('running'), false);
    for (const name of ['__proto__', 'constructor', 'toString']) {
      assert.equal(isRunState(name), false);
      assert.equal(isRunEvent(name), false);
      assert.throws(() => transition(name as RunState, 'claim'), InvalidTransitionError);
      assert.throws(() => transition('queued', name as RunEvent), InvalidTransitionError);
    }
  });
});

describe('the diagram in docs/en/architecture.md', () => {
  const document = readFileSync(
    new URL('../../../docs/en/architecture.md', import.meta.url),
    'utf8',
  );
  const block = /```mermaid\s+stateDiagram-v2\n([\s\S]*?)```/u.exec(document)?.[1] ?? '';
  const lines = block.split('\n').map((line) => line.trim());

  it('is there', () => {
    assert.ok(lines.length > 10, 'the state diagram of a run is not in the document');
  });

  it('draws every transition of the table, with its event, and no other', () => {
    const drawn = new Set<string>();
    for (const line of lines) {
      const [, from, to, labels] = /^(\w+)\s+-->\s+(\w+):\s*(.+)$/u.exec(line) ?? [];
      if (from === undefined || to === undefined || labels === undefined) {
        continue;
      }
      for (const event of labels.split(',')) {
        drawn.add(`${from} --${event.trim()}--> ${to}`);
      }
    }
    // The line from the start marker `[*]` is a note on how a run begins, not a transition: it does not match.
    // Compared with the table of the code itself, not with the oracle above: the document and the code must agree.
    const table = new Set(runEdges().map(({ from, event, to }) => `${from} --${event}--> ${to}`));
    assert.deepEqual([...drawn].sort(), [...table].sort());
  });

  it('marks as final the states that are final in the table', () => {
    const marked = lines
      .map((line) => /^(\w+)\s+-->\s+\[\*\]$/u.exec(line)?.[1])
      .filter((state): state is string => state !== undefined);
    assert.deepEqual(marked.sort(), RUN_STATES.filter(isFinalRunState).sort());
  });
});
