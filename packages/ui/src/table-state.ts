// Our addition to the panel's table stores: what of a table's state is kept in the browser. The panel keeps the column
// filters too; this console has accounts, and a filter is what a person typed (an address, a secret's name), so it is
// kept only while the page is open. The layout (columns, widths, order, pinning, sorting, page size) is a preference of
// the browser and is still kept.
import type { MrtTableState } from './mrt-table.js';

/** The prefix of the keys `useMrtTableState` keeps the layouts under. */
export const TABLE_STORAGE_PREFIX = 'sw-table:';

/** What of a table's state is kept in the browser: everything but what the person typed into the filters. */
export type PersistedTableState = Omit<MrtTableState, 'columnFilters'>;

/** The part of a table's state that may be kept. */
export function persistedLayout(state: Partial<MrtTableState>): Partial<PersistedTableState> {
  const layout: Partial<MrtTableState> = { ...state };
  delete layout.columnFilters;
  return layout;
}

/** A kept value read back: what does not parse is nothing, and filters kept by an older version are ignored. */
export function readLayout(raw: string | null | undefined): Partial<PersistedTableState> {
  if (raw === null || raw === undefined || raw === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? persistedLayout(parsed)
      : {};
  } catch {
    return {};
  }
}

/** The part of `Storage` this needs; a test passes its own. */
export interface TableStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Removes the filters older versions kept with every table's layout, so that what one person typed is not left in the
 * browser for the next. The layouts stay. Safe to call on every start: it only writes what still has filters.
 */
export function forgetTableFilters(storage: TableStorage | undefined = globalStorage()): void {
  if (storage === undefined) {
    return;
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(TABLE_STORAGE_PREFIX) === true) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      const raw = storage.getItem(key);
      if (raw?.includes('"columnFilters"') === true) {
        storage.setItem(key, JSON.stringify(readLayout(raw)));
      }
    }
  } catch {
    // The storage can be missing or blocked; the tables work without it.
  }
}

function globalStorage(): TableStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
