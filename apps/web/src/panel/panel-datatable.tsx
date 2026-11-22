// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/widgets/dashboard/hosts/hosts-datatable/
// hosts-datatable.widget.tsx and src/widgets/dashboard/nodes/nodes-datatable/nodes-datatable.widget.tsx, the two page-level
// lists, which differ only in their columns and filters. Changes: one component for both (the pages of the connected
// panel are read-only lists of objects with a uuid): it holds the sort, the stored column widths, order and visibility,
// the table, and the controls under it; a click on a row opens the object; the texts come from the console's catalogue.
import { Box, Stack, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiEmpty } from 'react-icons/pi';

import {
  DataTable,
  type DataTableColumn,
  DataTableControls,
  type DataTableSortStatus,
  panelDataTableProps,
  sortRecords,
  useDataTableColumns,
  usePreventTableBackScroll,
} from '@swellwright/ui';

export interface PanelDataTableProps<T extends { uuid: string }> {
  /** Bump the number in the key when the columns change: a width or an order kept for other columns would not fit. */
  cacheKey: string;
  columns: DataTableColumn<T>[];
  /** The rows to show, after the filters of the page. */
  records: T[];
  defaultSort: DataTableSortStatus<T>;
  onOpen: (record: T) => void;
  /** What the table says when there is no row. */
  emptyText: string;
  /** The height of the table: the panel's Hosts table is 65vh, its Nodes table 55vh. */
  height?: string;
  /** The names of columns that have no title in the head (an icon column) for the list of columns. */
  extraLabels?: Record<string, string>;
}

/** The panel's page-level list: columns that can be sorted, filtered, resized, dragged and hidden, with a reset menu under it. */
export function PanelDataTable<T extends { uuid: string }>({
  cacheKey,
  columns,
  records,
  defaultSort,
  onOpen,
  emptyText,
  height = '65vh',
  extraLabels,
}: PanelDataTableProps<T>) {
  const { t } = useTranslation('common');
  usePreventTableBackScroll();
  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<T>>(defaultSort);

  const withDefaults = columns.map((column) => ({
    draggable: true,
    resizable: true,
    toggleable: true,
    ...column,
  }));
  const {
    effectiveColumns,
    resetColumnsWidth,
    resetColumnsOrder,
    resetColumnsToggle,
    columnsToggle,
    setColumnsToggle,
  } = useDataTableColumns({ key: cacheKey, columns: withDefaults });

  const labelByAccessor: Record<string, string> = {
    ...Object.fromEntries(
      withDefaults
        .filter((column) => typeof column.title === 'string' && column.title !== '')
        .map((column) => [String(column.accessor), column.title as string]),
    ),
    ...extraLabels,
  };

  const sorted = useMemo(() => sortRecords(records, sortStatus), [records, sortStatus]);

  return (
    <>
      <DataTable
        {...panelDataTableProps}
        columns={effectiveColumns}
        emptyState={
          <Stack align="center" gap="xs">
            <Box mb={4} p={4}>
              <PiEmpty aria-hidden size={36} strokeWidth={1.5} />
            </Box>
            <Text c="dimmed" size="sm">
              {emptyText}
            </Text>
          </Stack>
        }
        height={height}
        idAccessor="uuid"
        onRowClick={({ record }) => {
          onOpen(record);
        }}
        onSortStatusChange={setSortStatus}
        records={sorted}
        sortStatus={sortStatus}
        storeColumnsKey={cacheKey}
      />
      <DataTableControls
        columnsToggle={columnsToggle}
        labelByAccessor={labelByAccessor}
        labels={{
          reset: t('datatable.reset'),
          resetSort: t('datatable.resetSort'),
          columnWidth: t('datatable.columnWidth'),
          columnOrder: t('datatable.columnOrder'),
          columnToggle: t('datatable.columnToggle'),
          showAll: t('datatable.showAll'),
          hideAll: t('datatable.hideAll'),
          columns: t('datatable.columns'),
        }}
        onResetColumnsOrder={resetColumnsOrder}
        onResetColumnsToggle={resetColumnsToggle}
        onResetColumnsWidth={resetColumnsWidth}
        onResetSort={() => {
          setSortStatus(defaultSort);
        }}
        setColumnsToggle={setColumnsToggle}
        sortResetDisabled={
          sortStatus.columnAccessor === defaultSort.columnAccessor &&
          sortStatus.direction === defaultSort.direction
        }
      />
    </>
  );
}
