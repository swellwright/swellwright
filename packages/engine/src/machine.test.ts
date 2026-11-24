import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMachine, InvalidTransitionError } from './machine.js';

const STATES = ['a', 'b', 'c'] as const;
const EVENTS = ['go', 'back', 'stop'] as const;

const toy = () =>
  createMachine({
    name: 'toy',
    states: STATES,
    events: EVENTS,
    table: { a: { go: 'b', stop: 'c' }, b: { back: 'a', go: 'c' }, c: {} },
  });

describe('createMachine', () => {
  it('moves along the table and says where each state can go', () => {
    const machine = toy();
    assert.equal(machine.transition('a', 'go'), 'b');
    assert.equal(machine.transition('b', 'go'), 'c');
    assert.equal(machine.canApply('a', 'back'), false);
    assert.equal(machine.canApply('a', 'go'), true);
    // In the order of the events of the machine, not of the table.
    assert.deepEqual(machine.legalEvents('b'), ['go', 'back']);
    assert.deepEqual(machine.legalEvents('c'), []);
    assert.equal(machine.isFinal('c'), true);
    assert.equal(machine.isFinal('a'), false);
  });

  it('lists every edge in the order of the states and then of the events', () => {
    assert.deepEqual(toy().edges(), [
      { from: 'a', event: 'go', to: 'b' },
      { from: 'a', event: 'stop', to: 'c' },
      { from: 'b', event: 'go', to: 'c' },
      { from: 'b', event: 'back', to: 'a' },
    ]);
  });

  it('recognises its own states and events and nothing else', () => {
    const machine = toy();
    assert.equal(machine.isState('a'), true);
    assert.equal(machine.isState('go'), false);
    assert.equal(machine.isState(1), false);
    assert.equal(machine.isEvent('go'), true);
    assert.equal(machine.isEvent('toString'), false);
    assert.equal(machine.isEvent(undefined), false);
  });

  it('is frozen, so nothing can change it after it was checked', () => {
    const machine = toy();
    assert.ok(Object.isFrozen(machine));
    assert.ok(Object.isFrozen(machine.states));
    assert.ok(Object.isFrozen(machine.events));
    assert.ok(Object.isFrozen(machine.edges()));
  });

  it('refuses a table with a mistake when it is built', () => {
    const base = { name: 'bad', states: STATES, events: EVENTS };
    assert.throws(
      () => createMachine({ ...base, table: { a: {}, b: {} } as never }),
      /no row for the state "c"/u,
    );
    assert.throws(
      () => createMachine({ ...base, table: { a: { go: 'b' }, b: {}, c: {}, d: {} } as never }),
      /row for "d", which is not a state/u,
    );
    assert.throws(
      () => createMachine({ ...base, table: { a: { jump: 'b' }, b: {}, c: {} } as never }),
      /"a" takes "jump", which is not an event/u,
    );
    assert.throws(
      () => createMachine({ ...base, table: { a: { go: 'z' }, b: {}, c: {} } as never }),
      /leads to "z", which is not a state/u,
    );
    assert.throws(
      () => createMachine({ ...base, states: ['a', 'b', 'a'], table: { a: {}, b: {} } }),
      /a state is listed twice/u,
    );
    assert.throws(
      () => createMachine({ ...base, events: ['go', 'go'], table: { a: {}, b: {}, c: {} } }),
      /an event is listed twice/u,
    );
  });
});

describe('InvalidTransitionError', () => {
  it('names the state, the event and what the state would have taken', () => {
    const machine = toy();
    assert.throws(
      () => machine.transition('a', 'back'),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTransitionError);
        assert.equal(error.name, 'InvalidTransitionError');
        assert.equal(error.machine, 'toy');
        assert.equal(error.state, 'a');
        assert.equal(error.event, 'back');
        assert.equal(error.reason, 'not_allowed');
        assert.deepEqual(error.allowed, ['go', 'stop']);
        assert.match(error.message, /"a" cannot take the event "back": it takes go, stop/u);
        return true;
      },
    );
  });

  it('says that a final state is final', () => {
    assert.throws(() => toy().transition('c', 'go'), /the state is final/u);
  });

  it('tells an unknown state and an unknown event apart', () => {
    const machine = toy();
    assert.throws(
      () => machine.transition('x' as never, 'go'),
      (error: unknown) =>
        error instanceof InvalidTransitionError && error.reason === 'unknown_state',
    );
    assert.throws(
      () => machine.transition('a', 'x' as never),
      (error: unknown) =>
        error instanceof InvalidTransitionError && error.reason === 'unknown_event',
    );
  });

  it('is not fooled by the names that every object has', () => {
    const machine = toy();
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.throws(() => machine.transition(name as never, 'go'), InvalidTransitionError);
      assert.throws(() => machine.transition('a', name as never), InvalidTransitionError);
      assert.equal(machine.canApply(name as never, 'go'), false);
      assert.deepEqual(machine.legalEvents(name as never), []);
    }
  });

  it('cuts a long name from a row that is not what the code expects', () => {
    assert.throws(
      () => toy().transition('x'.repeat(500) as never, 'go'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length < 200);
        return true;
      },
    );
  });
});
