import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  forgetTableFilters,
  persistedLayout,
  readLayout,
  TABLE_STORAGE_PREFIX,
} from '@swellwright/ui/table-state';

/** localStorage of a browser, in memory. */
class MemoryStorage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const AUDIT = `${TABLE_STORAGE_PREFIX}audit-v2`;
const aliceState = {
  columnFilters: [{ id: 'ip', value: '203.0.113.7' }],
  sorting: [{ id: 'at', desc: true }],
  pagination: { pageIndex: 0, pageSize: 50 },
};

describe('what a table keeps in the browser', () => {
  it('does not keep what Alice typed into a filter, so Bob gets neither the text nor the filtering', () => {
    const kept = JSON.stringify(persistedLayout(aliceState));
    assert.ok(!kept.includes('203.0.113.7'));
    // Bob's console opens the same table: what it reads back has no filter.
    const bob = readLayout(kept);
    assert.equal('columnFilters' in bob, false);
    assert.deepEqual(
      bob.sorting,
      aliceState.sorting,
      'the layout is a preference of the browser and stays',
    );
    assert.deepEqual(bob.pagination, aliceState.pagination);
  });

  it('ignores filters an older version kept, and removes them from the storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(AUDIT, JSON.stringify(aliceState));
    storage.setItem(
      `${TABLE_STORAGE_PREFIX}vault-secrets-v3`,
      JSON.stringify({ columnFilters: [{ id: 'name', value: 'prod-db' }] }),
    );
    storage.setItem('sw-language', 'ru');
    assert.equal('columnFilters' in readLayout(storage.getItem(AUDIT)), false);

    forgetTableFilters(storage);
    const all = JSON.stringify([...storage.items.values()]);
    assert.ok(!all.includes('203.0.113.7'));
    assert.ok(!all.includes('prod-db'));
    assert.deepEqual(JSON.parse(storage.getItem(AUDIT) ?? '{}'), {
      sorting: aliceState.sorting,
      pagination: aliceState.pagination,
    });
    assert.equal(storage.getItem('sw-language'), 'ru', 'other keys are left alone');
  });

  it('reads a value that does not parse as nothing', () => {
    assert.deepEqual(readLayout('{not json'), {});
    assert.deepEqual(readLayout(null), {});
    assert.deepEqual(readLayout('[1]'), {});
  });
});
