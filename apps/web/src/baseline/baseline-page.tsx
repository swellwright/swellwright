// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/hosts/ui/components/
// hosts.page.component.tsx and src/pages/dashboard/nodes/ui/components/nodes.page.component.tsx (the page header card with
// the icon-only actions, the loading bar and the datatable), under the metric cards of src/pages/dashboard/home. Changes:
// the rows are the servers of the fleet with the state of their baseline check; a click on a row opens the results.
import { ActionIcon, Badge, Box, Group, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { IconChecklist, IconListCheck, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiEmpty } from 'react-icons/pi';
import {
  PiCheckCircleDuotone,
  PiClockDuotone,
  PiPlugsDuotone,
  PiWarningCircleDuotone,
  PiWarningOctagonDuotone,
} from 'react-icons/pi';

import type { BaselineFleetItem, Permission } from '@swellwright/contracts';
import {
  CountryFlag,
  DataTable,
  type DataTableColumn,
  DataTableControls,
  type DataTableSortStatus,
  EllipsisCell,
  HeaderAction,
  HeaderActionGroup,
  HeaderActions,
  LoadingScreen,
  MetricCard,
  PageHeader,
  panelDataTableProps,
  sortRecords,
  StatusBadge,
  TextSearchFilter,
  useDataTableColumns,
  usePreventTableBackScroll,
} from '@swellwright/ui';

import { getBaselineFleet, listBaselines, listServers, startServerBaselineRun } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { useDateTime, useNumber } from '../format.js';
import { useCountries } from '../fleet/countries.js';
import { QueryErrorCard } from '../security/query-error.js';
import { notifyFailure } from '../security/notify-failure.js';
import { notifySuccess } from '../shell/feedback.js';
import { BaselinesDrawer } from './baselines-drawer.js';
import { CheckDrawer } from './check-drawer.js';
import { CountBadges, runErrorText, TrendMark } from './baseline-parts.js';
import { RunChecksDialog } from './run-checks-dialog.js';

const CACHE_KEY = 'baseline-datatable-v1';
const DEFAULT_SORT: DataTableSortStatus<BaselineFleetItem> = {
  columnAccessor: 'server.name',
  direction: 'asc',
};
const GOING_MS = 2000;
const IDLE_MS = 30_000;
const DASH = '–';

/** The state of the fleet against its baselines. Reading needs `servers:read`; starting a check needs `servers:exec`. */
export function BaselinePage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['baseline', 'common', 'servers']);
  const queryClient = useQueryClient();
  const formatTime = useDateTime();
  const formatNumber = useNumber();
  const step = useStepUp();
  const { nameOf } = useCountries();
  usePreventTableBackScroll();
  const canExec = permissions.includes('servers:exec');
  const canWrite = permissions.includes('servers:write');

  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [managing, setManaging] = useState(false);
  const [running, setRunning] = useState(false);
  const [openings, setOpenings] = useState(0);
  const [sortStatus, setSortStatus] = useState(DEFAULT_SORT);
  const [search, setSearch] = useState('');

  const fleet = useQuery({
    queryKey: ['baseline', 'fleet'],
    queryFn: getBaselineFleet,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.running) === true ? GOING_MS : IDLE_MS,
    retry: false,
  });
  const baselines = useQuery({
    queryKey: ['baseline', 'list'],
    queryFn: listBaselines,
    retry: false,
  });
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => listServers(), retry: false });

  const runOne = useMutation({
    mutationFn: (serverId: string) => step.run(() => startServerBaselineRun(serverId)),
    onSuccess: async () => {
      notifySuccess(t('baseline:run.started'));
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:run.failed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noRun'),
      );
    },
  });

  const items = useMemo(() => fleet.data?.items ?? [], [fleet.data]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered =
      query === '' ? items : items.filter((item) => item.server.name.toLowerCase().includes(query));
    return sortRecords(filtered, sortStatus);
  }, [items, search, sortStatus]);
  const openedItem = items.find((item) => item.server.id === opened);

  const columns: DataTableColumn<BaselineFleetItem>[] = [
    {
      accessor: 'server.name',
      title: t('baseline:columns.server'),
      sortable: true,
      draggable: false,
      resizable: true,
      toggleable: false,
      filter: (
        <TextSearchFilter
          clearLabel={t('common:clear')}
          label={t('baseline:table.search')}
          onChange={setSearch}
          value={search}
        />
      ),
      filtering: search !== '',
      render: ({ server }) => (
        <Group gap={6} wrap="nowrap">
          <CountryFlag code={server.country} label={nameOf(server.country)} />
          <EllipsisCell>{server.name}</EllipsisCell>
        </Group>
      ),
    },
    {
      accessor: 'baseline.name',
      title: t('baseline:columns.baseline'),
      sortable: true,
      render: ({ baseline, assignedBy }) =>
        baseline === null ? (
          <Text c="dimmed" size="sm">
            {t('baseline:table.noBaseline')}
          </Text>
        ) : (
          <Group gap={6} wrap="nowrap">
            <EllipsisCell>{`${baseline.name} v${String(baseline.version)}`}</EllipsisCell>
            {assignedBy === 'tag' ? (
              <Tooltip label={t('baseline:table.assignedBy.tag')} withArrow>
                <Badge color="gray" size="sm" tt="none" variant="soft">
                  #
                </Badge>
              </Tooltip>
            ) : null}
          </Group>
        ),
    },
    {
      accessor: 'lastRun.finishedAt',
      title: t('baseline:columns.lastCheck'),
      sortable: true,
      width: 230,
      render: ({ lastRun }) => (
        <Text ff="monospace" size="sm">
          {lastRun === null ? DASH : formatTime(lastRun.finishedAt ?? lastRun.queuedAt)}
        </Text>
      ),
    },
    {
      accessor: 'result',
      title: t('baseline:columns.result'),
      sortable: false,
      width: 240,
      render: ({ lastRun, running: going, baseline }) => {
        if (going) {
          return (
            <StatusBadge kind="run" size="md">
              {t('baseline:table.running')}
            </StatusBadge>
          );
        }
        if (lastRun === null) {
          return (
            <Text c="dimmed" size="sm">
              {baseline === null ? DASH : t('baseline:table.neverChecked')}
            </Text>
          );
        }
        if (lastRun.state === 'error') {
          return (
            <Tooltip
              label={runErrorText(t, lastRun.errorCode, lastRun.errorMessage)}
              multiline
              w={320}
              withArrow
            >
              <span>
                <StatusBadge kind="err" size="md">
                  {t('baseline:state.error')}
                </StatusBadge>
              </span>
            </Tooltip>
          );
        }
        return <CountBadges counts={lastRun.counts} />;
      },
    },
    {
      accessor: 'trend',
      title: t('baseline:columns.trend'),
      sortable: false,
      width: 100,
      render: ({ trend }) => <TrendMark trend={trend} />,
    },
    {
      accessor: 'actions',
      title: t('baseline:columns.actions'),
      sortable: false,
      draggable: false,
      toggleable: false,
      width: 110,
      render: ({ server, running: going, baseline }) => (
        <Group gap={4} wrap="nowrap">
          {canExec ? (
            <Tooltip label={t('baseline:table.runNow')} withArrow>
              <ActionIcon
                aria-label={t('baseline:table.runNow')}
                color="teal"
                disabled={going || baseline === null}
                loading={runOne.isPending && runOne.variables === server.id}
                onClick={(event) => {
                  event.stopPropagation();
                  runOne.mutate(server.id);
                }}
                variant="soft"
              >
                <IconPlayerPlay size={18} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          <Tooltip label={t('baseline:table.open')} withArrow>
            <ActionIcon
              aria-label={t('baseline:table.open')}
              color="gray"
              onClick={(event) => {
                event.stopPropagation();
                setOpened(server.id);
              }}
              variant="soft"
            >
              <IconListCheck size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ),
    },
  ];
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
  } = useDataTableColumns({ key: CACHE_KEY, columns: withDefaults });
  const labelByAccessor = Object.fromEntries(
    withDefaults
      .filter((column) => typeof column.title === 'string' && column.title !== '')
      .map((column) => [column.accessor, column.title as string]),
  );

  const totals = fleet.data?.totals;
  const metrics = [
    {
      id: 'checked',
      icon: PiCheckCircleDuotone,
      color: 'teal',
      title: t('baseline:metrics.checked'),
      value: totals === undefined ? 0 : totals.checked,
      subtitle:
        totals === undefined
          ? undefined
          : t('baseline:metrics.checkedOf', { assigned: formatNumber(totals.assigned) }),
    },
    {
      id: 'failing',
      icon: PiWarningOctagonDuotone,
      color: totals !== undefined && totals.failing > 0 ? 'red' : 'gray',
      title: t('baseline:metrics.failing'),
      value: totals?.failing ?? 0,
      subtitle:
        totals === undefined
          ? undefined
          : t('baseline:metrics.failingChecks', { count: totals.failingChecks }),
    },
    {
      id: 'warning',
      icon: PiWarningCircleDuotone,
      color: totals !== undefined && totals.warning > 0 ? 'orange' : 'gray',
      title: t('baseline:metrics.warning'),
      value: totals?.warning ?? 0,
      subtitle:
        totals === undefined
          ? undefined
          : t('baseline:metrics.warningChecks', { count: totals.warningChecks }),
    },
    {
      id: 'last',
      icon: totals !== undefined && totals.unreachable > 0 ? PiPlugsDuotone : PiClockDuotone,
      color: totals !== undefined && totals.unreachable > 0 ? 'violet' : 'cyan',
      title: t('baseline:metrics.lastRun'),
      value: totals?.lastRunAt ? formatTime(totals.lastRunAt) : t('baseline:metrics.never'),
      subtitle:
        totals !== undefined && totals.unreachable > 0
          ? `${t('baseline:metrics.unreachable')}: ${formatNumber(totals.unreachable)}`
          : undefined,
    },
  ];

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderActionGroup>
              <HeaderAction
                grouped
                icon={IconRefresh}
                label={t('common:refresh')}
                loading={fleet.isFetching}
                onClick={() => void fleet.refetch()}
              />
            </HeaderActionGroup>
            <HeaderActionGroup>
              <HeaderAction
                grouped
                icon={IconChecklist}
                label={t('baseline:header.baselines')}
                onClick={() => {
                  setManaging(true);
                }}
              />
              {canExec ? (
                <HeaderAction
                  color="teal"
                  grouped
                  icon={IconPlayerPlay}
                  label={t('baseline:header.runAll')}
                  onClick={() => {
                    setOpenings((count) => count + 1);
                    setRunning(true);
                  }}
                />
              ) : null}
            </HeaderActionGroup>
          </HeaderActions>
        }
        icon={<IconChecklist size={24} />}
        title={t('baseline:title')}
      />
      {fleet.isPending ? (
        <LoadingScreen height="60vh" />
      ) : fleet.isError ? (
        <QueryErrorCard
          message={describeError(
            t,
            fleet.error,
            t('baseline:signInAgain'),
            t('baseline:readForbidden'),
          )}
          onRetry={() => void fleet.refetch()}
          title={t('baseline:loadFailed')}
        />
      ) : (
        <Stack>
          <SimpleGrid cols={{ base: 1, xs: 2, xl: 4 }} spacing="xs">
            {metrics.map(({ id, icon, color, title, value, subtitle }, index) => (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                initial={{ opacity: 0, y: 0 }}
                key={id}
                transition={{ duration: 0.2, delay: index * 0.07, ease: 'easeIn' }}
              >
                <MetricCard
                  icon={icon}
                  iconColor={color}
                  title={title}
                  value={value}
                  {...(subtitle === undefined ? {} : { subtitle })}
                />
              </motion.div>
            ))}
          </SimpleGrid>
          <motion.div
            animate={{ opacity: 1 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          >
            <DataTable
              {...panelDataTableProps}
              columns={effectiveColumns}
              emptyState={
                <Stack align="center" gap="xs">
                  <Box mb={4} p={4}>
                    <PiEmpty aria-hidden size={36} strokeWidth={1.5} />
                  </Box>
                  <Text c="dimmed" size="sm">
                    {t('baseline:table.empty')}
                  </Text>
                  <Text c="dimmed" size="xs">
                    {t('baseline:table.emptyHint')}
                  </Text>
                </Stack>
              }
              height="65vh"
              idAccessor="server.id"
              onRowClick={({ record }) => {
                setOpened(record.server.id);
              }}
              onSortStatusChange={setSortStatus}
              records={visible}
              sortStatus={sortStatus}
              storeColumnsKey={CACHE_KEY}
            />
            <DataTableControls
              columnsToggle={columnsToggle}
              labelByAccessor={labelByAccessor}
              labels={{
                reset: t('common:datatable.reset'),
                resetSort: t('common:datatable.resetSort'),
                columnWidth: t('common:datatable.columnWidth'),
                columnOrder: t('common:datatable.columnOrder'),
                columnToggle: t('common:datatable.columnToggle'),
                showAll: t('common:datatable.showAll'),
                hideAll: t('common:datatable.hideAll'),
                columns: t('common:datatable.columns'),
              }}
              onResetColumnsOrder={resetColumnsOrder}
              onResetColumnsToggle={resetColumnsToggle}
              onResetColumnsWidth={resetColumnsWidth}
              onResetSort={() => {
                setSortStatus(DEFAULT_SORT);
              }}
              setColumnsToggle={setColumnsToggle}
              sortResetDisabled={
                sortStatus.columnAccessor === DEFAULT_SORT.columnAccessor &&
                sortStatus.direction === DEFAULT_SORT.direction
              }
            />
          </motion.div>
        </Stack>
      )}
      <CheckDrawer
        canExec={canExec}
        onClose={() => {
          setOpened(undefined);
        }}
        serverId={opened}
        serverName={openedItem?.server.name}
      />
      <BaselinesDrawer
        canWrite={canWrite}
        onClose={() => {
          setManaging(false);
        }}
        opened={managing}
        servers={servers.data?.servers ?? []}
      />
      {canExec ? (
        <RunChecksDialog
          baselines={baselines.data?.baselines ?? []}
          items={items}
          key={openings}
          onClose={() => {
            setRunning(false);
          }}
          opened={running}
        />
      ) : null}
    </>
  );
}
