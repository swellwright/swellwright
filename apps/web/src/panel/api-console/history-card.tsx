// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/widgets/dashboard/users/users-table/
// user-table.widget.tsx (a titled card that holds a `@kastov/mantine-react-table-open` table with its tools in the title)
// and the row actions of the panel's tables (soft icon buttons with a tooltip). Changes: two small lists of this
// browser's own calls (the last 20, and the named samples), kept in localStorage and never on the server; a click on a
// row of the history asks the same again.
import { ActionIcon, Group, Tabs, Text, Tooltip } from '@mantine/core';
import { IconEye, IconPlayerPlay, IconRestore, IconTrash } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { TbHistory } from 'react-icons/tb';

import {
  DataTableCard,
  HeaderAction,
  HeaderActionGroup,
  MantineReactTable,
  type MRT_ColumnDef,
  panelTableOptions,
  StatusBadge,
  useMantineReactTable,
} from '@swellwright/ui';

import { useBytes } from '../../format.js';
import { useTimeFirst } from '../../security/time-first.js';
import { useTableLocalization } from '../../tables.js';
import { type HistoryEntry, type Sample, statusKind } from './console-model.js';
import { MethodBadge } from './console-parts.js';

/** The method and the path of an operation in a cell. A component of its own, so that the columns that use it stay the same. */
function PathCell({ path }: { path: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <MethodBadge method="get" />
      <Text ff="monospace" fz="xs" truncate="end">
        {path}
      </Text>
    </Group>
  );
}

function HistoryTable({
  entries,
  onReplay,
}: {
  entries: readonly HistoryEntry[];
  onReplay: (entry: HistoryEntry) => void;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  const formatTime = useTimeFirst();
  const bytes = useBytes();
  const localization = useTableLocalization(t('apiConsole:history.empty'));
  const data = useMemo(() => [...entries], [entries]);
  const columns = useMemo<MRT_ColumnDef<HistoryEntry>[]>(
    () => [
      {
        id: 'at',
        header: t('apiConsole:history.at'),
        accessorFn: (entry) => formatTime(entry.at),
        minSize: 220,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
      {
        id: 'operation',
        header: t('apiConsole:history.operation'),
        accessorFn: (entry) => entry.path,
        minSize: 260,
        Cell: ({ row }) => <PathCell path={row.original.path} />,
      },
      {
        id: 'status',
        header: t('apiConsole:history.status'),
        accessorFn: (entry) => entry.status ?? -1,
        size: 130,
        Cell: ({ row }) =>
          row.original.status === null ? (
            <StatusBadge kind="err">
              {row.original.errorCode ?? t('apiConsole:history.noAnswer')}
            </StatusBadge>
          ) : (
            <StatusBadge kind={statusKind(row.original.status)}>
              {String(row.original.status)}
            </StatusBadge>
          ),
      },
      {
        id: 'duration',
        header: t('apiConsole:history.duration'),
        accessorFn: (entry) => (entry.durationMs === null ? '–' : `${String(entry.durationMs)} ms`),
        size: 110,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
      {
        id: 'size',
        header: t('apiConsole:history.size'),
        accessorFn: (entry) => (entry.bytes === null ? '–' : bytes(entry.bytes)),
        size: 110,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
    ],
    [t, formatTime, bytes],
  );
  const table = useMantineReactTable<HistoryEntry>({
    ...panelTableOptions<HistoryEntry>(),
    columns,
    data,
    localization,
    enableColumnFilters: false,
    enableSorting: false,
    getRowId: (entry) => entry.id,
    enableRowActions: true,
    displayColumnDefOptions: { 'mrt-row-actions': { size: 90 } },
    renderRowActions: ({ row }) => (
      <Tooltip
        label={
          row.original.request === null
            ? t('apiConsole:history.openOperation')
            : t('apiConsole:history.again')
        }
        withArrow
      >
        <ActionIcon
          aria-label={t('apiConsole:history.againAria', { path: row.original.path })}
          color="cyan"
          onClick={() => {
            onReplay(row.original);
          }}
          size="input-sm"
          variant="soft"
        >
          <IconPlayerPlay size="1.5rem" />
        </ActionIcon>
      </Tooltip>
    ),
  });
  return <MantineReactTable table={table} />;
}

function SamplesTable({
  samples,
  onOpen,
  onRemove,
}: {
  samples: readonly Sample[];
  onOpen: (sample: Sample) => void;
  onRemove: (sample: Sample) => void;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  const formatTime = useTimeFirst();
  const bytes = useBytes();
  const localization = useTableLocalization(t('apiConsole:samples.empty'));
  const data = useMemo(() => [...samples], [samples]);
  const columns = useMemo<MRT_ColumnDef<Sample>[]>(
    () => [
      {
        id: 'name',
        header: t('apiConsole:samples.name'),
        accessorFn: (sample) => sample.name,
        minSize: 200,
        Cell: ({ row }) => (
          <Text fz="sm" truncate="end">
            {row.original.name}
          </Text>
        ),
      },
      {
        id: 'operation',
        header: t('apiConsole:history.operation'),
        accessorFn: (sample) => sample.path,
        minSize: 260,
        Cell: ({ row }) => <PathCell path={row.original.path} />,
      },
      {
        id: 'status',
        header: t('apiConsole:history.status'),
        accessorFn: (sample) => sample.result.status,
        size: 110,
        Cell: ({ row }) => (
          <StatusBadge kind={statusKind(row.original.result.status)}>
            {String(row.original.result.status)}
          </StatusBadge>
        ),
      },
      {
        id: 'size',
        header: t('apiConsole:history.size'),
        accessorFn: (sample) => bytes(sample.result.bodyBytes),
        size: 110,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
      {
        id: 'saved',
        header: t('apiConsole:samples.saved'),
        accessorFn: (sample) => formatTime(sample.savedAt),
        minSize: 220,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
    ],
    [t, formatTime, bytes],
  );
  const table = useMantineReactTable<Sample>({
    ...panelTableOptions<Sample>(),
    columns,
    data,
    localization,
    enableColumnFilters: false,
    enableSorting: false,
    getRowId: (sample) => sample.id,
    enableRowActions: true,
    displayColumnDefOptions: { 'mrt-row-actions': { size: 100 } },
    renderRowActions: ({ row }) => (
      <ActionIcon.Group>
        <Tooltip label={t('apiConsole:samples.open')} withArrow>
          <ActionIcon
            aria-label={t('apiConsole:samples.openAria', { name: row.original.name })}
            color="gray"
            onClick={() => {
              onOpen(row.original);
            }}
            size="input-sm"
            variant="soft"
          >
            <IconEye size="1.5rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('apiConsole:samples.remove')} withArrow>
          <ActionIcon
            aria-label={t('apiConsole:samples.removeAria', { name: row.original.name })}
            color="red"
            onClick={() => {
              onRemove(row.original);
            }}
            size="input-sm"
            variant="soft"
          >
            <IconTrash size="1.5rem" />
          </ActionIcon>
        </Tooltip>
      </ActionIcon.Group>
    ),
  });
  return <MantineReactTable table={table} />;
}

/** The last calls of this browser, and the samples it keeps: two tabs in a titled card with a table in each. */
export function HistoryCard({
  history,
  samples,
  onReplay,
  onClear,
  onOpenSample,
  onRemoveSample,
}: {
  history: readonly HistoryEntry[];
  samples: readonly Sample[];
  onReplay: (entry: HistoryEntry) => void;
  onClear: () => void;
  onOpenSample: (sample: Sample) => void;
  onRemoveSample: (sample: Sample) => void;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  return (
    <DataTableCard.Container>
      <DataTableCard.Title
        actions={
          <HeaderActionGroup>
            <HeaderAction
              color="gray"
              disabled={history.length === 0}
              grouped
              icon={IconRestore}
              label={t('apiConsole:history.clear')}
              onClick={onClear}
            />
          </HeaderActionGroup>
        }
        description={t('apiConsole:history.description')}
        icon={<TbHistory size={24} />}
        title={t('apiConsole:history.title')}
      />
      <DataTableCard.Content>
        <Tabs color="cyan" defaultValue="history" keepMounted={false}>
          <Tabs.List px="md">
            <Tabs.Tab value="history">
              {t('apiConsole:history.tabHistory', { n: history.length })}
            </Tabs.Tab>
            <Tabs.Tab value="samples">
              {t('apiConsole:history.tabSamples', { n: samples.length })}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="history">
            <HistoryTable entries={history} onReplay={onReplay} />
          </Tabs.Panel>
          <Tabs.Panel value="samples">
            <SamplesTable onOpen={onOpenSample} onRemove={onRemoveSample} samples={samples} />
          </Tabs.Panel>
        </Tabs>
      </DataTableCard.Content>
    </DataTableCard.Container>
  );
}
