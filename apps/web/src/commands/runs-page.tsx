// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the list pages that put a table in a card under the
// metric cards (src/pages/dashboard/users/ui/components/users.page.component.tsx, src/widgets/dashboard/users/
// users-table/user-table.widget.tsx): `@kastov/mantine-react-table-open` with its filters under the head, a card with
// icon-only actions in its title, a row that opens the object in a drawer. Changes: the rows are runs of a script or a
// command; the list asks again by itself while a run is going, as the panel's live lists do.
import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconFilterOff, IconListCheck, IconRefresh, IconRestore } from '@tabler/icons-react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCheckCircleDuotone, PiPlayCircleDuotone, PiWarningCircleDuotone } from 'react-icons/pi';
import { useSearchParams } from 'react-router';

import {
  COMMAND_RUN_STATES,
  type CommandRunSummary,
  type Permission,
} from '@swellwright/contracts';
import {
  DataTableCard,
  HeaderAction,
  HeaderActionGroup,
  HeaderActions,
  MantineReactTable,
  type MRT_ColumnDef,
  MetricCard,
  panelTableOptions,
  StatusText,
  useMantineReactTable,
  useMrtTableState,
} from '@swellwright/ui';

import { listCommandRuns } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useNumber } from '../format.js';
import { useTimeFirst } from '../security/time-first.js';
import { useTableLocalization } from '../tables.js';
import { DangerBadge, isGoing, RUN_STATE_KIND } from './danger.js';
import { formatDuration, RunDrawer, spanOf, useNow } from './run-drawer.js';
import { countRunsByState, mergeRunPages, nextRunOffset, RUN_PAGE_SIZE } from './run-pages.js';
/** How often the list asks again: quickly while a run is going, slowly otherwise. */
const GOING_MS = 2000;
const IDLE_MS = 15_000;

/** The history of runs of scripts and commands. Reading needs `servers:read`; stopping a run needs `servers:exec`. */
export function RunsPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['commands', 'common', 'errors']);
  const formatNumber = useNumber();
  const formatDate = useTimeFirst();
  const [params, setParams] = useSearchParams();
  const openedRun = params.get('run') ?? undefined;
  const canExec = permissions.includes('servers:exec');

  // The newest page first; older pages when the person asks for them. The table filters and sorts what is loaded.
  const list = useInfiniteQuery({
    queryKey: ['command-runs'],
    queryFn: ({ pageParam }) => listCommandRuns({ limit: RUN_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextRunOffset(pages),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.runs.some((run) => isGoing(run.state)))
        ? GOING_MS
        : IDLE_MS,
    retry: false,
  });
  const runs = useMemo(() => mergeRunPages(list.data?.pages ?? []), [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  // The cards count the whole history, not only the pages that are loaded.
  const counts = useQuery({
    queryKey: ['command-runs', 'counts'],
    queryFn: () => countRunsByState(listCommandRuns),
    refetchInterval: (query) =>
      (query.state.data?.pending ?? 0) + (query.state.data?.running ?? 0) > 0 ? GOING_MS : IDLE_MS,
    retry: false,
  });

  const count = (pick: (data: NonNullable<typeof counts.data>) => number): string =>
    counts.data === undefined ? '–' : formatNumber(pick(counts.data));
  const metrics = [
    {
      id: 'total',
      icon: IconListCheck,
      color: 'blue',
      title: t('commands:runs.metrics.total'),
      value: list.isError ? '–' : formatNumber(total),
    },
    {
      id: 'going',
      icon: PiPlayCircleDuotone,
      color: 'cyan',
      title: t('commands:runs.metrics.going'),
      value: count((data) => data.pending + data.running),
    },
    {
      id: 'ok',
      icon: PiCheckCircleDuotone,
      color: 'teal',
      title: t('commands:runState.succeeded'),
      value: count((data) => data.succeeded),
    },
    {
      id: 'bad',
      icon: PiWarningCircleDuotone,
      color: 'red',
      title: t('commands:runs.metrics.problems'),
      value: count((data) => data.failed + data.partial),
    },
  ];

  const stateOptions = COMMAND_RUN_STATES.map((value) => ({
    value,
    label: t(`commands:runState.${value}`),
  }));
  const now = useNow(runs.some((run) => isGoing(run.state)));

  const columns = useMemo<MRT_ColumnDef<CommandRunSummary>[]>(
    () => [
      {
        accessorKey: 'state',
        header: t('commands:runs.table.state'),
        size: 250,
        filterVariant: 'select',
        mantineFilterSelectProps: { data: stateOptions },
        mantineTableBodyCellProps: { align: 'center' },
        enableColumnFilterModes: false,
        Cell: ({ row }) => (
          <StatusText kind={RUN_STATE_KIND[row.original.state]}>
            {t(`commands:runState.${row.original.state}`)}
          </StatusText>
        ),
      },
      {
        accessorKey: 'label',
        header: t('commands:runs.table.what'),
        size: 280,
        minSize: 160,
        mantineTableBodyCellProps: { align: 'left' },
        columnFilterModeOptions: ['contains', 'equals', 'startsWith'],
        enableColumnFilterModes: true,
        Cell: ({ row }) => (
          <Stack gap={2}>
            <Text ff="monospace" fw={500} size="sm" truncate>
              {row.original.label}
            </Text>
            <Text c="dimmed" size="xs">
              {t(`commands:runs.mode.${row.original.mode}`)}
            </Text>
          </Stack>
        ),
      },
      {
        accessorKey: 'dangerLevel',
        header: t('commands:runs.table.level'),
        size: 140,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: (['read', 'change', 'destructive'] as const).map((value) => ({
            value,
            label: t(`commands:danger.${value}`),
          })),
        },
        mantineTableBodyCellProps: { align: 'center' },
        enableColumnFilterModes: false,
        Cell: ({ row }) => <DangerBadge level={row.original.dangerLevel} />,
      },
      {
        id: 'servers',
        header: t('commands:runs.table.servers'),
        size: 200,
        enableColumnFilter: false,
        enableSorting: false,
        mantineTableBodyCellProps: { align: 'center' },
        Cell: ({ row }) => {
          const { counts } = row.original;
          const problems = counts.failed + counts.lost;
          return (
            <Group gap={6} justify="center" wrap="nowrap">
              <Text size="sm">
                {t('commands:runs.table.serversOf', {
                  done: counts.succeeded,
                  total: counts.total,
                })}
              </Text>
              {problems > 0 ? (
                <Text c="red" size="xs">
                  {t('commands:runs.table.problems', { count: problems })}
                </Text>
              ) : null}
              {counts.skipped > 0 ? (
                <Text c="dimmed" size="xs">
                  {t('commands:runs.table.skipped', { count: counts.skipped })}
                </Text>
              ) : null}
            </Group>
          );
        },
      },
      {
        accessorKey: 'createdBy',
        header: t('commands:runs.table.by'),
        size: 150,
        enableColumnFilterModes: false,
      },
      {
        accessorKey: 'createdAt',
        header: t('commands:runs.table.started'),
        size: 250,
        enableColumnFilter: false,
        enableColumnFilterModes: false,
        mantineTableBodyCellProps: { align: 'center' },
        Cell: ({ row }) => (
          <Text ff="monospace" size="sm">
            {formatDate(row.original.createdAt)}
          </Text>
        ),
      },
      {
        id: 'duration',
        header: t('commands:runs.table.duration'),
        size: 120,
        enableColumnFilter: false,
        enableSorting: false,
        mantineTableBodyCellProps: { align: 'center' },
        Cell: ({ row }) => {
          const span = spanOf(row.original.startedAt, row.original.finishedAt, now);
          return (
            <Text ff="monospace" size="sm">
              {span === undefined ? '–' : formatDuration(span)}
            </Text>
          );
        },
      },
    ],
    // `stateOptions` follows `t`; `now` moves with every refresh of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, formatDate, now],
  );

  const tableState = useMrtTableState('command-runs-v1');
  const localization = useTableLocalization(t('commands:runs.table.empty'));
  const table = useMantineReactTable<CommandRunSummary>({
    ...panelTableOptions<CommandRunSummary>(),
    enableColumnFilterModes: true,
    columns,
    data: runs,
    localization,
    ...tableState.handlers,
    state: {
      ...tableState.state,
      isLoading: list.isPending,
      showAlertBanner: list.isError,
      showProgressBars: list.isFetching,
    },
    // The panel's failure state of a table: a red banner above the (empty) table.
    ...(list.isError
      ? {
          mantineToolbarAlertBannerProps: {
            color: 'red',
            children: describeError(
              t,
              list.error,
              t('commands:signInAgain'),
              t('commands:runs.table.loadFailed'),
            ),
          },
        }
      : {}),
    getRowId: (run) => run.id,
    mantineTableBodyRowProps: ({ row }) => ({
      onClick: () => {
        setParams({ run: row.original.id });
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          setParams({ run: row.original.id });
        }
      },
      tabIndex: 0,
      style: { cursor: 'pointer' },
    }),
  });

  const clearFilters = () => {
    table.resetColumnFilters(true);
  };
  const resetTable = () => {
    tableState.reset();
    table.resetColumnFilters(true);
  };

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, xs: 2, xl: 4 }} spacing="xs">
        {metrics.map(({ id, icon, color, title, value }, index) => (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            initial={{ opacity: 0, y: 0 }}
            key={id}
            transition={{ duration: 0.2, delay: index * 0.07, ease: 'easeIn' }}
          >
            <MetricCard
              icon={icon}
              iconColor={color}
              isLoading={list.isPending || counts.isPending}
              title={title}
              value={value}
            />
          </motion.div>
        ))}
      </SimpleGrid>

      <DataTableCard.Container>
        <DataTableCard.Title
          actions={
            <HeaderActions>
              <HeaderActionGroup>
                <HeaderAction
                  color="gray"
                  grouped
                  icon={IconFilterOff}
                  label={t('common:clearFilters')}
                  loading={list.isPending}
                  onClick={clearFilters}
                />
                <HeaderAction
                  color="gray"
                  grouped
                  icon={IconRestore}
                  label={t('common:resetTable')}
                  loading={list.isPending}
                  onClick={resetTable}
                />
              </HeaderActionGroup>
              <HeaderActionGroup>
                <HeaderAction
                  grouped
                  icon={IconRefresh}
                  label={t('common:refresh')}
                  loading={list.isPending || list.isRefetching}
                  onClick={() => {
                    void list.refetch();
                    void counts.refetch();
                  }}
                />
              </HeaderActionGroup>
            </HeaderActions>
          }
          icon={<IconListCheck size={24} />}
          title={t('commands:runs.title')}
        />
        <DataTableCard.Content>
          <MantineReactTable table={table} />
          {runs.length > 0 && runs.length < total ? (
            // Only the loaded runs are in the table (and its filters): say so, and offer the older ones.
            <Group gap="md" justify="space-between" mt="md" wrap="wrap">
              <Text c="dimmed" size="sm">
                {t('commands:runs.loaded', {
                  shown: formatNumber(runs.length),
                  total: formatNumber(total),
                })}
              </Text>
              <Button
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                variant="default"
              >
                {t('commands:runs.loadOlder')}
              </Button>
            </Group>
          ) : null}
        </DataTableCard.Content>
      </DataTableCard.Container>

      <RunDrawer
        canExec={canExec}
        onClose={() => {
          setParams({});
        }}
        runId={openedRun}
      />
    </Stack>
  );
}
