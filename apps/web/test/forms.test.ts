import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CommandRunList,
  CommandRunListQuery,
  CommandRunSummary,
} from '@swellwright/contracts';

import { expectedVersionOf, nextDraft } from '../src/baseline/draft.js';
import { countRunsByState, mergeRunPages, nextRunOffset } from '../src/commands/run-pages.js';
import { expiryChange, expiryDateOf } from '../src/security/secret-form.js';

describe('the draft of the baseline editor', () => {
  it('keeps the revision the typing started from through a refetch', () => {
    // Editing version 3; someone saves 4; a refetch makes the editor read 4 under the draft.
    let draft = nextDraft(undefined, undefined, 'schema: 1\n', 3);
    draft = nextDraft(draft, undefined, 'schema: 1\n# mine\n', 4);
    assert.equal(draft?.base, 3);
    assert.equal(expectedVersionOf(draft, 4), 3, 'the save expects 3, so the server refuses it');
  });

  it('starts again for another version and when the text is dropped', () => {
    const draft = nextDraft(undefined, undefined, 'a', 3);
    assert.equal(nextDraft(draft, 2, 'b', 5)?.base, 5);
    assert.equal(nextDraft(draft, undefined, undefined, 5), undefined);
    assert.equal(expectedVersionOf(undefined, 5), 5);
  });
});

describe('the expiry of a secret in its form', () => {
  it('sends nothing when the date was not touched, so an exact time is kept', () => {
    const at = '2026-12-01T18:00:00.000Z';
    assert.deepEqual(expiryChange(at, expiryDateOf(at)), {});
    assert.deepEqual(expiryChange(null, ''), {});
  });

  it('sends midnight UTC of a new date, and null for a cleared one', () => {
    assert.deepEqual(expiryChange('2026-12-01T18:00:00.000Z', '2026-12-05'), {
      expiresAt: '2026-12-05T00:00:00.000Z',
    });
    assert.deepEqual(expiryChange('2026-12-01T18:00:00.000Z', ''), { expiresAt: null });
    assert.deepEqual(expiryChange(null, '2027-01-01'), { expiresAt: '2027-01-01T00:00:00.000Z' });
  });
});

function run(id: string, state: CommandRunSummary['state'] = 'succeeded'): CommandRunSummary {
  return { id, state } as CommandRunSummary;
}

describe('the pages of the runs list', () => {
  it('offers the older runs past the first page, and stops at the total', () => {
    const first: CommandRunList = { runs: [run('a'), run('b')], total: 3 };
    assert.equal(nextRunOffset([first]), 2);
    const second: CommandRunList = { runs: [run('c')], total: 3 };
    assert.equal(nextRunOffset([first, second]), undefined);
    assert.equal(nextRunOffset([{ runs: [], total: 5 }]), undefined);
  });

  it('shows a run once when a new run shifted the pages', () => {
    const merged = mergeRunPages([
      { runs: [run('new'), run('a')], total: 4 },
      { runs: [run('a'), run('b')], total: 4 },
    ]);
    assert.deepEqual(
      merged.map((r) => r.id),
      ['new', 'a', 'b'],
    );
  });

  it('counts the whole history by state, not the loaded page', async () => {
    const totals: Record<string, number> = {
      pending: 1,
      running: 2,
      succeeded: 250,
      failed: 3,
      partial: 4,
    };
    const asked: CommandRunListQuery[] = [];
    const counts = await countRunsByState((query) => {
      asked.push(query);
      return Promise.resolve({ runs: [], total: totals[query.state ?? ''] ?? 0 });
    });
    assert.deepEqual(counts, totals);
    assert.ok(asked.every((query) => query.limit === 1));
  });
});
