// The tables inside the cards of the Remnawave panel frontend 3.4.11 (AGPL-3.0-only) are `@kastov/mantine-react-table-open`
// (MIT), and this project uses the same package at the same version (ADR 0033). This file re-exports it and ports the
// option set the panel gives it in every such widget (src/widgets/dashboard/users/users-table/user-table.widget.tsx and
// src/widgets/dashboard/srh-inspector/srh-inspector-table/srh-inspector-table.widget.tsx) and the persisted table state
// (src/shared/lib/mrt-table-store/*). Changes: the persisted state is kept with Mantine's `useLocalStorage`, not with a
// zustand store; the panel's server-side paging, filtering and sorting is not set here (our lists are small and are
// filtered where they are loaded), so pages that need it turn `manual*` on themselves.
import {
  type MRT_ColumnFiltersState,
  type MRT_ColumnOrderState,
  type MRT_ColumnPinningState,
  type MRT_ColumnSizingState,
  type MRT_PaginationState,
  MRT_ShowHideColumnsButton,
  type MRT_SortingState,
  type MRT_TableInstance,
  type MRT_TableOptions,
  MRT_ToggleDensePaddingButton,
  MRT_ToggleFullScreenButton,
  type MRT_RowData,
  type MRT_VisibilityState,
} from '@kastov/mantine-react-table-open';
import { useLocalStorage } from '@mantine/hooks';
import { type CSSProperties, useCallback, useState } from 'react';

import {
  type PersistedTableState,
  persistedLayout,
  readLayout,
  TABLE_STORAGE_PREFIX,
} from './table-state.js';

export {
  MantineReactTable,
  type MRT_Cell,
  type MRT_ColumnDef,
  type MRT_ColumnFilterFnsState,
  type MRT_ColumnFiltersState,
  type MRT_DensityState,
  type MRT_PaginationState,
  type MRT_Row,
  type MRT_RowData,
  type MRT_SortingState,
  type MRT_TableInstance,
  type MRT_TableOptions,
  useMantineReactTable,
} from '@kastov/mantine-react-table-open';
export { MRT_Localization_EN } from '@kastov/mantine-react-table-open/locales/en/index.esm.mjs';
export { MRT_Localization_RU } from '@kastov/mantine-react-table-open/locales/ru/index.esm.mjs';

/** The panel's page size for a table (rows per page). */
export const DEFAULT_PAGINATION_STATE = { pageIndex: 0, pageSize: 25 } as const;

/** The background the panel gives the toolbars and the head of a table inside a card (a literal in its widgets). */
const TABLE_BACKGROUND = '#1b2027';

const surfaceStyle = { '--mrt-base-background-color': TABLE_BACKGROUND } as CSSProperties;

/**
 * The options the panel sets on every table inside a card: filters shown under the head, column ordering, resizing and
 * pinning, the density, full screen and column toggles, the card-coloured toolbars and a paper without a border.
 * Spread it first and add `columns`, `data`, `state` and the handlers after.
 */
export function panelTableOptions<TData extends MRT_RowData>(): Partial<MRT_TableOptions<TData>> {
  return {
    columnFilterDisplayMode: 'subheader',
    columnFilterModeOptions: ['contains'],
    enableColumnFilterModes: false,
    enableColumnOrdering: true,
    enableColumnPinning: true,
    enableColumnResizing: true,
    enableDensityToggle: true,
    enableFullScreenToggle: true,
    enableGlobalFilter: false,
    enableSortingRemoval: true,
    initialState: { density: 'xxs', pagination: { ...DEFAULT_PAGINATION_STATE } },
    mantineBottomToolbarProps: { style: surfaceStyle },
    mantinePaperProps: {
      style: { '--paper-radius': 'var(--mantine-radius-xs)' } as CSSProperties,
      withBorder: false,
    },
    mantineTableHeadProps: { style: surfaceStyle },
    mantineTopToolbarProps: { style: surfaceStyle },
    positionToolbarAlertBanner: 'top',
    renderToolbarInternalActions: ({ table }: { table: MRT_TableInstance<TData> }) => (
      <>
        <MRT_ToggleDensePaddingButton table={table} />
        <MRT_ToggleFullScreenButton table={table} />
        <MRT_ShowHideColumnsButton table={table} />
      </>
    ),
    selectAllMode: 'page',
  };
}

export interface MrtTableState {
  columnFilters: MRT_ColumnFiltersState;
  columnOrder: MRT_ColumnOrderState;
  columnPinning: MRT_ColumnPinningState;
  columnSizing: MRT_ColumnSizingState;
  columnVisibility: MRT_VisibilityState;
  pagination: MRT_PaginationState;
  showColumnFilters: boolean;
  sorting: MRT_SortingState;
}

type Updater<T> = ((previous: T) => T) | T;

function apply<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === 'function' ? (updater as (previous: T) => T)(previous) : updater;
}

function isEmptyFilterValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

const BASE_STATE: MrtTableState = {
  columnFilters: [],
  columnOrder: [],
  columnPinning: { left: [], right: [] },
  columnSizing: {},
  columnVisibility: {},
  pagination: { ...DEFAULT_PAGINATION_STATE },
  showColumnFilters: true,
  sorting: [],
};

export interface MrtTableBinding {
  /** Hand it to the table's `state`. */
  state: MrtTableState;
  /** Spread it into the table's options. */
  handlers: {
    onColumnFiltersChange: (updater: Updater<MRT_ColumnFiltersState>) => void;
    onColumnOrderChange: (updater: Updater<MRT_ColumnOrderState>) => void;
    onColumnPinningChange: (updater: Updater<MRT_ColumnPinningState>) => void;
    onColumnSizingChange: (updater: Updater<MRT_ColumnSizingState>) => void;
    onColumnVisibilityChange: (updater: Updater<MRT_VisibilityState>) => void;
    onPaginationChange: (updater: Updater<MRT_PaginationState>) => void;
    onShowColumnFiltersChange: (updater: Updater<boolean>) => void;
    onSortingChange: (updater: Updater<MRT_SortingState>) => void;
  };
  /** Back to the defaults (the panel's "reset table"). */
  reset: () => void;
}

/**
 * The state of a table (sorting, columns, page) kept in this browser under `key`, as the panel's table stores do. A
 * value in storage that does not parse, or a storage that is not there, gives the defaults. Bump the number in the key
 * when the columns change so that an old order or width is not applied to new columns. Unlike the panel, the column
 * filters are not kept: they are what a person typed, and the next account in this browser must not get them.
 */
export function useMrtTableState(
  key: string,
  defaults: Partial<MrtTableState> = {},
): MrtTableBinding {
  const initial: MrtTableState = { ...BASE_STATE, ...defaults };
  const [state, setState] = useLocalStorage<Partial<PersistedTableState>>({
    key: `${TABLE_STORAGE_PREFIX}${key}`,
    defaultValue: persistedLayout(initial),
    getInitialValueInEffect: false,
    serialize: (value) => JSON.stringify(persistedLayout(value)),
    deserialize: readLayout,
  });
  // The filters live as long as the page (and the session's console) does.
  const [columnFilters, setColumnFilters] = useState<MRT_ColumnFiltersState>(initial.columnFilters);

  // A value saved by another version may lack a field: fill it from the defaults.
  const complete: MrtTableState = { ...initial, ...persistedLayout(state), columnFilters };

  const patch = useCallback(
    <K extends keyof PersistedTableState>(field: K) =>
      (updater: Updater<PersistedTableState[K]>) => {
        setState((previous) => {
          const base = { ...persistedLayout(initial), ...previous } as PersistedTableState;
          return { ...base, [field]: apply(updater, base[field]) };
        });
      },
    // `initial` is rebuilt on every render from the same arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setState],
  );
  const onColumnFiltersChange = useCallback((updater: Updater<MRT_ColumnFiltersState>) => {
    setColumnFilters((previous) =>
      apply(updater, previous).filter((filter) => !isEmptyFilterValue(filter.value)),
    );
  }, []);

  return {
    state: complete,
    handlers: {
      onColumnFiltersChange,
      onColumnOrderChange: patch('columnOrder'),
      onColumnPinningChange: patch('columnPinning'),
      onColumnSizingChange: patch('columnSizing'),
      onColumnVisibilityChange: patch('columnVisibility'),
      onPaginationChange: patch('pagination'),
      onShowColumnFiltersChange: patch('showColumnFilters'),
      onSortingChange: patch('sorting'),
    },
    reset: () => {
      setState(persistedLayout(initial));
      setColumnFilters(initial.columnFilters);
    },
  };
}
