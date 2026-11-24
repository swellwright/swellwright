import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rollbackVerdict, undoOrder, type UndoRecordRef, type UndoState } from './undo.js';

const record = (
  stepIndex: number,
  seq: number,
  state: UndoState = 'pending',
): UndoRecordRef & { id: string } => ({
  id: `${String(stepIndex)}.${String(seq)}`,
  stepIndex,
  seq,
  state,
});

describe('the order of an undo', () => {
  it('goes from the last step to the first and, inside a step, from the last record to the first', () => {
    const records = [record(0, 0), record(1, 0), record(1, 1), record(2, 0), record(0, 1)];
    assert.deepEqual(
      undoOrder(records).map((r) => r.id),
      ['2.0', '1.1', '1.0', '0.1', '0.0'],
    );
  });

  it('is the same whatever order the records are read from the database in', () => {
    const records = [record(0, 0), record(0, 1), record(1, 0), record(2, 0), record(2, 1)];
    const reference = undoOrder(records).map((r) => r.id);
    assert.deepEqual(
      undoOrder([...records].reverse()).map((r) => r.id),
      reference,
    );
    assert.deepEqual(
      undoOrder([records[3], records[0], records[4], records[2], records[1]] as typeof records).map(
        (r) => r.id,
      ),
      reference,
    );
  });

  it('leaves out what is done, and brings back what failed: a rollback that was interrupted goes on', () => {
    const records = [
      record(0, 0, 'done'),
      record(1, 0, 'failed'),
      record(2, 0, 'pending'),
      record(3, 0, 'done'),
    ];
    assert.deepEqual(
      undoOrder(records).map((r) => r.id),
      ['2.0', '1.0'],
    );
  });

  it('does not change what it was given', () => {
    const records = [record(0, 0), record(1, 0)];
    undoOrder(records);
    assert.deepEqual(
      records.map((r) => r.id),
      ['0.0', '1.0'],
    );
  });

  it('gives nothing for nothing to undo', () => {
    assert.deepEqual(undoOrder([]), []);
    assert.deepEqual(undoOrder([record(0, 0, 'done')]), []);
  });
});

describe('the verdict of a rollback', () => {
  it('is `rolled_back` when every record is done and the check finds nothing', () => {
    assert.deepEqual(
      rollbackVerdict({ records: [record(0, 0, 'done'), record(1, 0, 'done')], differences: [] }),
      { state: 'rolled_back' },
    );
  });

  it('is `rolled_back` by the records alone when the workflow declares no check', () => {
    assert.deepEqual(rollbackVerdict({ records: [record(0, 0, 'done')], differences: null }), {
      state: 'rolled_back',
    });
    assert.deepEqual(rollbackVerdict({ records: [], differences: null }), { state: 'rolled_back' });
  });

  it('is `rollback_partial` with the list when the check still finds a difference, even with every record done', () => {
    assert.deepEqual(
      rollbackVerdict({ records: [record(0, 0, 'done')], differences: ['/hosts/3 differs'] }),
      { state: 'rollback_partial', pending: 0, failed: 0, differences: ['/hosts/3 differs'] },
    );
  });

  it('is `rollback_partial` with the counts when a record is not done', () => {
    assert.deepEqual(
      rollbackVerdict({
        records: [
          record(0, 0, 'done'),
          record(1, 0, 'pending'),
          record(1, 1, 'failed'),
          record(2, 0, 'failed'),
        ],
        differences: [],
      }),
      { state: 'rollback_partial', pending: 1, failed: 2, differences: [] },
    );
  });

  it('does not hand out the list of the caller', () => {
    const differences = ['a'];
    const verdict = rollbackVerdict({ records: [], differences });
    differences.push('b');
    assert.deepEqual(verdict, {
      state: 'rollback_partial',
      pending: 0,
      failed: 0,
      differences: ['a'],
    });
  });
});
