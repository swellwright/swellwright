// New in Swellwright (ADR 0047), built from the panel's pieces: a titled section of metric cards (src/pages/dashboard/home) over
// the titled table card of its Users page (src/pages/dashboard/users: `@kastov/mantine-react-table-open` inside a card, filters
// under the head, paged by the server). The rows are the servers of the inventory with what this server stored about them.
import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconChecklist, IconRefresh, IconServer2 } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiCheckCircleDuotone,
  PiHardDrivesDuotone,
  PiQuestionDuotone,
  PiWarningCircleDuotone,
  PiWarningOctagonDuotone,
} from 'react-icons/pi';
import { Link, useNavigate } from 'react-router';

import {
  FLEET_FLAGS,
  FLEET_HEALTH_STATES,
  type FleetFlag,
  type FleetHealthRow,
  type FleetHealthState,
} from '@swellwright/contracts';
import {
  CountryFlag,
  DataTableCard,
  HeaderAction,
  HeaderActions,
  MantineReactTable,
  type MRT_ColumnDef,
  type MRT_ColumnFiltersState,
  MetricCard,
  MetricSection,
  panelTableOptions,
  StatusBadge,
  type StatusKind,
  useMantineReactTable,
  useMrtTableState,
} from '@swellwright/ui';

import { getBaselineFleet, getDashboardFleet } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useCountries } from '../fleet/countries.js';
import { useDateTime, useNumber } from '../format.js';
import { useRelativeTime } from '../panel/snapshot-parts.js';
import { ROUTES } from '../routes.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useTableLocalization } from '../tables.js';
import { DASHBOARD_REFRESH_MS } from './attention-card.js';
import { sub } from './props.js';

const HEALTH_KIND: Record<FleetHealthState, StatusKind> = {
  critical: 'err',
  warning: 'warn',
  ok: 'ok',
  unknown: 'wait',
};

const BASELINE_KIND: Record<FleetHealthRow['baseline']['status'], StatusKind | undefined> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'err',
  unreachable: 'warn',
  never: 'wait',
  unassigned: undefined,
};

const NODE_COLOR = {
  online: 'teal',
  offline: 'red',
  connecting: 'cyan',
  disabled: 'gray',
} as const;

function filterText(filters: MRT_ColumnFiltersState, id: string): string | undefined {
  const value = filters.find((filter) => filter.id === id)?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const isFilled = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** The strip of cards above the table and the card of the table. Nothing here connects to a server. */
export function FleetSection() {
  const { t } = useTranslation(['dashboard', 'overview', 'baseline', 'common', 'servers']);
  const formatNumber = useNumber();
  const formatDate = useDateTime();
  const relative = useRelativeTime();
  const navigate = useNavigate();
  const { nameOf } = useCountries();
  const tableState = useMrtTableState('dashboard-fleet-v1');

  const { columnFilters, pagination } = tableState.state;
  const q = filterText(columnFilters, 'server');
  const healthText = filterText(columnFilters, 'health');
  const health = FLEET_HEALTH_STATES.find((known) => known === healthText);
  const flagText = filterText(columnFilters, 'flags');
  const flag = FLEET_FLAGS.find((known) => known === flagText);

  const fleet = useQuery({
    queryKey: ['dashboard', 'fleet', q, health, flag, pagination.pageIndex, pagination.pageSize],
    queryFn: () =>
      getDashboardFleet({
        limit: pagination.pageSize,
        offset: pagination.pageIndex * pagination.pageSize,
        ...(q === undefined ? {} : { q }),
        ...(health === undefined ? {} : { health }),
        ...(flag === undefined ? {} : { flag }),
      }),
    placeholderData: keepPreviousData,
    refetchInterval: DASHBOARD_REFRESH_MS,
    retry: false,
  });
  const baseline = useQuery({
    queryKey: ['baseline', 'fleet'],
    queryFn: getBaselineFleet,
    retry: false,
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  // A page that is no longer there (a saved page number, or a filter that matches less) goes to the last that is.
  const total = fleet.data?.total;
  const { onPaginationChange } = tableState.handlers;
  useEffect(() => {
    if (
      total !== undefined &&
      pagination.pageIndex > 0 &&
      pagination.pageIndex * pagination.pageSize >= total
    ) {
      onPaginationChange((previous) => ({
        ...previous,
        pageIndex: Math.max(0, Math.ceil(total / previous.pageSize) - 1),
      }));
    }
  }, [total, pagination.pageIndex, pagination.pageSize, onPaginationChange]);

  const rows = useMemo(() => fleet.data?.rows ?? [], [fleet.data]);
  const filtersActive = q !== undefined || health !== undefined || flag !== undefined;
  const localization = useTableLocalization(
    filtersActive ? t('dashboard:fleet.emptyFiltered') : t('dashboard:fleet.empty'),
  );

  const columns = useMemo<MRT_ColumnDef<FleetHealthRow>[]>(
    () => [
      {
        id: 'server',
        header: t('dashboard:fleet.columns.server'),
        accessorFn: (row) => row.server.name,
        size: 200,
        enableColumnFilter: true,
        Cell: ({ row }) => (
          <Group gap={6} wrap="nowrap">
            <CountryFlag
              code={row.original.server.country}
              label={nameOf(row.original.server.country)}
            />
            <Text fw={500} size="sm" truncate="end">
              {row.original.server.name}
            </Text>
            {row.original.server.state === 'draft' || row.original.server.state === 'retired' ? (
              <Badge color="gray" size="sm" tt="none" variant="soft">
                {t(`servers:states.${row.original.server.state}`)}
              </Badge>
            ) : null}
          </Group>
        ),
      },
      {
        id: 'health',
        header: t('dashboard:fleet.columns.health'),
        accessorFn: (row) => row.health,
        size: 210,
        filterVariant: 'select',
        mantineFilterSelectProps: ({ column }) => ({
          data: FLEET_HEALTH_STATES.map((value) => ({
            value,
            label: t(`dashboard:fleet.health.${value}`),
          })),
          clearable: isFilled(column.getFilterValue()),
        }),
        Cell: ({ row }) => (
          <StatusBadge kind={HEALTH_KIND[row.original.health]} size="md">
            {t(`dashboard:fleet.health.${row.original.health}`)}
          </StatusBadge>
        ),
      },
      {
        id: 'baseline',
        header: t('dashboard:fleet.columns.baseline'),
        accessorFn: (row) => row.baseline.status,
        size: 200,
        enableColumnFilter: false,
        Cell: ({ row }) => {
          const { baseline: result } = row.original;
          const kind = BASELINE_KIND[result.status];
          if (kind === undefined) {
            return (
              <Text c="dimmed" size="sm">
                {t('dashboard:fleet.baselineStatus.unassigned')}
              </Text>
            );
          }
          return (
            <Stack gap={2}>
              <StatusBadge kind={kind} size="md">
                {t(`dashboard:fleet.baselineStatus.${result.status}`)}
              </StatusBadge>
              {result.counts !== null && (result.counts.fail > 0 || result.counts.warn > 0) ? (
                <Text c="dimmed" fz="xs">
                  {t('dashboard:fleet.baselineCounts', {
                    fail: result.counts.fail,
                    warn: result.counts.warn,
                  })}
                </Text>
              ) : null}
            </Stack>
          );
        },
      },
      {
        id: 'lastCheck',
        header: t('dashboard:fleet.columns.lastCheck'),
        accessorFn: (row) => row.baseline.lastRunAt ?? '',
        size: 250,
        enableColumnFilter: false,
        Cell: ({ row }) => (
          <Text ff="monospace" size="sm">
            {row.original.baseline.lastRunAt === null
              ? t('dashboard:fleet.never')
              : formatDate(row.original.baseline.lastRunAt)}
          </Text>
        ),
      },
      {
        id: 'facts',
        header: t('dashboard:fleet.columns.facts'),
        accessorFn: (row) => row.facts?.collectedAt ?? '',
        size: 190,
        enableColumnFilter: false,
        Cell: ({ row }) => {
          const { facts } = row.original;
          if (facts === null) {
            return (
              <Text c="dimmed" size="sm">
                {t('dashboard:fleet.factsNone')}
              </Text>
            );
          }
          return (
            <Group gap={6} wrap="nowrap">
              <Text {...(facts.stale ? { c: 'orange' } : {})} size="sm">
                {relative(facts.collectedAt)}
              </Text>
            </Group>
          );
        },
      },
      {
        id: 'hostKey',
        header: t('dashboard:fleet.columns.hostKey'),
        accessorFn: (row) => (row.hostKey.pinned ? 'pinned' : 'missing'),
        size: 150,
        enableColumnFilter: false,
        Cell: ({ row }) => (
          <Text {...(row.original.hostKey.pinned ? {} : { c: 'orange' })} size="sm">
            {row.original.hostKey.pinned
              ? t('dashboard:fleet.hostKeyPinned')
              : t('dashboard:fleet.hostKeyMissing')}
          </Text>
        ),
      },
      {
        id: 'access',
        header: t('dashboard:fleet.columns.access'),
        accessorFn: (row) => row.access.entries,
        size: 190,
        enableColumnFilter: false,
        Cell: ({ row }) => {
          const { access } = row.original;
          if (access.entries === 0) {
            return (
              <Text c="orange" size="sm">
                {t('dashboard:fleet.access.none')}
              </Text>
            );
          }
          if (access.usable === 0) {
            return (
              <Text c="red" size="sm">
                {t('dashboard:fleet.access.expired')}
              </Text>
            );
          }
          return (
            <Stack gap={0}>
              <Text size="sm">
                {t('dashboard:fleet.access.usable', {
                  usable: access.usable,
                  entries: access.entries,
                })}
              </Text>
              {access.lastVerifyOk === false ? (
                <Text c="orange" fz="xs">
                  {t('dashboard:fleet.access.failed')}
                </Text>
              ) : null}
            </Stack>
          );
        },
      },
      {
        id: 'node',
        header: t('dashboard:fleet.columns.node'),
        accessorFn: (row) => row.panelNode?.name ?? '',
        size: 200,
        enableColumnFilter: false,
        Cell: ({ row }) => {
          const { panelNode } = row.original;
          if (panelNode === null) {
            return (
              <Text c="dimmed" size="sm">
                –
              </Text>
            );
          }
          return (
            <Tooltip
              label={t('dashboard:fleet.asOfPanel', { when: formatDate(panelNode.asOf) })}
              withArrow
            >
              <Group gap={6} w="fit-content" wrap="nowrap">
                <Badge color={NODE_COLOR[panelNode.state]} size="md" tt="none" variant="soft">
                  {t(`dashboard:fleet.node.${panelNode.state}`)}
                </Badge>
                <Text size="sm" truncate="end">
                  {panelNode.name}
                </Text>
              </Group>
            </Tooltip>
          );
        },
      },
      {
        id: 'flags',
        header: t('dashboard:fleet.columns.flags'),
        accessorFn: (row) => row.flags.join(','),
        size: 260,
        filterVariant: 'select',
        mantineFilterSelectProps: ({ column }) => ({
          data: FLEET_FLAGS.map((value) => ({ value, label: t(`dashboard:fleet.flags.${value}`) })),
          searchable: true,
          clearable: isFilled(column.getFilterValue()),
        }),
        Cell: ({ row }) => <Flags flags={row.original.flags} />,
      },
    ],
    [t, formatDate, relative, nameOf],
  );

  const table = useMantineReactTable<FleetHealthRow>({
    ...panelTableOptions<FleetHealthRow>(),
    columns,
    data: rows,
    localization,
    ...tableState.handlers,
    // A new filter starts again from the first page.
    onColumnFiltersChange: (updater) => {
      tableState.handlers.onColumnFiltersChange(updater);
      tableState.handlers.onPaginationChange((previous) => ({ ...previous, pageIndex: 0 }));
    },
    enableSorting: false,
    manualFiltering: true,
    manualPagination: true,
    manualSorting: true,
    rowCount: fleet.data?.total ?? 0,
    state: {
      ...tableState.state,
      isLoading: fleet.isPending,
      showAlertBanner: fleet.isError,
      showProgressBars: fleet.isFetching,
    },
    ...(fleet.isError
      ? {
          mantineToolbarAlertBannerProps: {
            color: 'red',
            children: describeError(
              t,
              fleet.error,
              t('dashboard:signInAgain'),
              t('dashboard:readForbidden'),
            ),
          },
        }
      : {}),
    // While the first page loads, the table draws placeholder rows whose cells hold nothing (`server` is null).
    getRowId: (row, index) =>
      (row as Partial<FleetHealthRow> | null)?.server?.id ?? `loading-${String(index)}`,
    enableRowActions: true,
    positionActionsColumn: 'last',
    displayColumnDefOptions: { 'mrt-row-actions': { size: 110 } },
    renderRowActions: ({ row }) => (
      <ActionIcon.Group>
        <Tooltip label={t('dashboard:fleet.row.openServer')} withArrow>
          <ActionIcon
            aria-label={`${t('dashboard:fleet.row.openServer')}: ${row.original.server.name}`}
            color="gray"
            component={Link}
            size="input-sm"
            to={`${ROUTES.DASHBOARD.FLEET.SERVERS}?server=${row.original.server.id}`}
            variant="soft"
          >
            <IconServer2 size="1.5rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t('dashboard:fleet.row.openBaseline')} withArrow>
          <ActionIcon
            aria-label={`${t('dashboard:fleet.row.openBaseline')}: ${row.original.server.name}`}
            color="gray"
            component={Link}
            size="input-sm"
            to={`${ROUTES.DASHBOARD.FLEET.BASELINE}?server=${row.original.server.id}`}
            variant="soft"
          >
            <IconChecklist size="1.5rem" />
          </ActionIcon>
        </Tooltip>
      </ActionIcon.Group>
    ),
  });

  const totals = fleet.data?.totals;
  const checked = baseline.data?.totals;
  const loading = totals === undefined && !fleet.isError;
  const none = totals?.servers === 0;

  return (
    <Stack gap="sm">
      <MetricSection cols={{ base: 1, sm: 2, xl: 5 }} title={t('overview:sections.fleet')}>
        <MetricCard
          icon={PiHardDrivesDuotone}
          iconColor="cyan"
          isLoading={loading}
          {...sub(
            totals === undefined
              ? undefined
              : none
                ? t('overview:fleet.serversNone')
                : t('overview:fleet.serversOk', { ok: formatNumber(totals.ok) }),
          )}
          title={t('overview:fleet.servers')}
          value={totals === undefined ? '–' : formatNumber(totals.servers)}
        />
        <MetricCard
          icon={PiWarningOctagonDuotone}
          iconColor={(totals?.critical ?? 0) > 0 ? 'red' : 'gray'}
          isLoading={loading}
          title={t('overview:fleet.critical')}
          value={totals === undefined ? '–' : formatNumber(totals.critical)}
        />
        <MetricCard
          icon={PiWarningCircleDuotone}
          iconColor={(totals?.warning ?? 0) > 0 ? 'orange' : 'gray'}
          isLoading={loading}
          title={t('overview:fleet.warning')}
          value={totals === undefined ? '–' : formatNumber(totals.warning)}
        />
        <MetricCard
          icon={PiQuestionDuotone}
          iconColor="gray"
          isLoading={loading}
          title={t('overview:fleet.unknown')}
          value={totals === undefined ? '–' : formatNumber(totals.unknown)}
        />
        <Link
          style={{ color: 'inherit', textDecoration: 'none' }}
          to={ROUTES.DASHBOARD.FLEET.BASELINE}
        >
          <MetricCard
            icon={PiCheckCircleDuotone}
            iconColor={
              checked === undefined
                ? 'gray'
                : checked.failing > 0
                  ? 'red'
                  : checked.warning > 0 || checked.unreachable > 0
                    ? 'orange'
                    : checked.checked > 0
                      ? 'teal'
                      : 'gray'
            }
            isLoading={baseline.isPending}
            {...sub(
              checked === undefined
                ? undefined
                : checked.unreachable > 0
                  ? t('baseline:overview.unreachable', { count: checked.unreachable })
                  : checked.checked === 0
                    ? t('baseline:overview.none')
                    : checked.failing + checked.warning > 0
                      ? t('baseline:overview.problems', {
                          failing: checked.failing,
                          warning: checked.warning,
                        })
                      : t('baseline:overview.allGood'),
            )}
            title={t('baseline:overview.card')}
            value={
              checked === undefined ? '–' : `${String(checked.checked)}/${String(checked.assigned)}`
            }
          />
        </Link>
      </MetricSection>

      {fleet.isError && fleet.data === undefined ? (
        <QueryErrorCard
          message={describeError(
            t,
            fleet.error,
            t('dashboard:signInAgain'),
            t('dashboard:readForbidden'),
          )}
          onRetry={() => void fleet.refetch()}
          title={t('dashboard:fleet.loadFailed')}
        />
      ) : (
        <DataTableCard.Container>
          <DataTableCard.Title
            actions={
              <HeaderActions>
                <HeaderAction
                  icon={IconRefresh}
                  label={t('dashboard:fleet.refresh')}
                  loading={fleet.isRefetching}
                  onClick={() => void fleet.refetch()}
                />
                <HeaderAction
                  color="gray"
                  icon={IconServer2}
                  label={t('dashboard:fleet.openServers')}
                  onClick={() => {
                    void navigate(ROUTES.DASHBOARD.FLEET.SERVERS);
                  }}
                />
              </HeaderActions>
            }
            description={t('dashboard:fleet.description')}
            icon={<IconChecklist size={24} />}
            title={t('dashboard:fleet.title')}
          />
          <DataTableCard.Content>
            <MantineReactTable table={table} />
          </DataTableCard.Content>
        </DataTableCard.Container>
      )}
    </Stack>
  );
}

/** The flags of a server: the first two as chips, the rest in a tooltip. */
function Flags({ flags }: { flags: readonly FleetFlag[] }) {
  const { t } = useTranslation('dashboard');
  if (flags.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        –
      </Text>
    );
  }
  const shown = flags.slice(0, 2);
  const rest = flags.slice(2);
  return (
    <Group gap={4} wrap="nowrap">
      {shown.map((flag) => (
        <Badge color="gray" key={flag} size="md" tt="none" variant="soft">
          {t(`fleet.flags.${flag}`)}
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Tooltip
          label={rest.map((flag) => t(`fleet.flags.${flag}`)).join(', ')}
          multiline
          w={260}
          withArrow
        >
          <Badge color="gray" size="md" tt="none" variant="soft">
            +{rest.length}
          </Badge>
        </Tooltip>
      ) : null}
    </Group>
  );
}
