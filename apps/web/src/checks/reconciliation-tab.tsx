// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): a strip of metric cards above a list and the table card of
// its Users page (`@kastov/mantine-react-table-open` in a titled card). Changes: the rows of the reconciliation of hosts with
// nodes and of nodes with the server inventory, with the status chips of the panel and a drawer per row; the cards say how many
// rows are in each status, and a line under them says what DNS and the inventory contributed.
import { Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconFilter, IconRestore } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCheckCircle, PiLinkBreak, PiQuestion, PiTrash, PiWarning } from 'react-icons/pi';
import { TbChecklist } from 'react-icons/tb';

import {
  RECONCILIATION_CHECKS,
  RECONCILIATION_STATUSES,
  type ReconciliationReport,
  type ReconciliationRow,
} from '@swellwright/contracts';
import {
  Callout,
  DataTableCard,
  EmptyPageLayout,
  HeaderAction,
  HeaderActionGroup,
  HeaderActions,
  MantineReactTable,
  MetricCard,
  type MRT_ColumnDef,
  panelTableOptions,
  useMantineReactTable,
  useMrtTableState,
} from '@swellwright/ui';

import { useDateTime, useNumber } from '../format.js';
import { PanelBoundary } from '../panel/panel-data.js';
import { useTableLocalization } from '../tables.js';
import { type ChecksRead } from './checks-data.js';
import { ObjectLabel, ReconciliationStatusBadge, useCheckText } from './checks-format.js';
import { ReconciliationDrawer } from './finding-drawer.js';

function Rows({ report }: { report: ReconciliationReport }) {
  const { t } = useTranslation(['checks', 'common']);
  const text = useCheckText();
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [opened, setOpened] = useState<ReconciliationRow | undefined>(undefined);
  const data = useMemo(
    () => (problemsOnly ? report.rows.filter((row) => row.status !== 'ok') : report.rows),
    [report.rows, problemsOnly],
  );

  const columns = useMemo<MRT_ColumnDef<ReconciliationRow>[]>(
    () => [
      {
        id: 'status',
        header: t('checks:ui.reconciliation.columns.status'),
        accessorFn: (row) => row.status,
        size: 190,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: RECONCILIATION_STATUSES.map((value) => ({
            value,
            label: t(`checks:ui.status.${value}`),
          })),
        },
        sortingFn: (a, b) =>
          RECONCILIATION_STATUSES.indexOf(b.original.status) -
          RECONCILIATION_STATUSES.indexOf(a.original.status),
        Cell: ({ row }) => <ReconciliationStatusBadge status={row.original.status} />,
      },
      {
        id: 'check',
        header: t('checks:ui.reconciliation.columns.check'),
        accessorFn: (row) => row.check,
        size: 230,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: RECONCILIATION_CHECKS.map((value) => ({
            value,
            label: t(`checks:reconciliation.checks.${value}.title` as never),
          })),
        },
        Cell: ({ row }) => (
          <Text size="sm" truncate="end">
            {t(`checks:reconciliation.checks.${row.original.check}.title` as never)}
          </Text>
        ),
      },
      {
        id: 'subject',
        header: t('checks:ui.reconciliation.columns.subject'),
        accessorFn: (row) => row.subject.name,
        size: 220,
        Cell: ({ row }) => <ObjectLabel object={row.original.subject} />,
      },
      {
        id: 'expected',
        header: t('checks:ui.reconciliation.columns.expected'),
        accessorFn: (row) => row.expected ?? '',
        size: 200,
        Cell: ({ row }) => (
          <Text ff="monospace" size="sm" truncate="end">
            {row.original.expected ?? '–'}
          </Text>
        ),
      },
      {
        id: 'actual',
        header: t('checks:ui.reconciliation.columns.actual'),
        accessorFn: (row) => row.actual ?? '',
        size: 200,
        Cell: ({ row }) => (
          <Text ff="monospace" size="sm" truncate="end">
            {row.original.actual ?? '–'}
          </Text>
        ),
      },
      {
        id: 'reason',
        header: t('checks:ui.reconciliation.columns.reason'),
        accessorFn: (row) => text(row.reasonKey, row.reason, row.params),
        size: 420,
        Cell: ({ row }) => (
          <Text size="sm" truncate="end">
            {text(row.original.reasonKey, row.original.reason, row.original.params)}
          </Text>
        ),
      },
      {
        id: 'ttl',
        header: t('checks:ui.reconciliation.columns.ttl'),
        accessorFn: (row) => row.ttlSeconds ?? -1,
        size: 90,
        enableColumnFilter: false,
        Cell: ({ row }) => (
          <Text ff="monospace" size="sm">
            {row.original.ttlSeconds ?? '–'}
          </Text>
        ),
      },
    ],
    [t, text],
  );

  const tableState = useMrtTableState('checks-reconciliation-v1');
  const localization = useTableLocalization(
    problemsOnly ? t('checks:ui.reconciliation.noRows') : t('checks:ui.reconciliation.emptyText'),
  );
  const table = useMantineReactTable<ReconciliationRow>({
    ...panelTableOptions<ReconciliationRow>(),
    columns,
    data,
    localization,
    ...tableState.handlers,
    state: { ...tableState.state },
    getRowId: (row) => row.id,
    mantineTableBodyRowProps: ({ row }) => ({
      onClick: () => {
        setOpened(row.original);
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          setOpened(row.original);
        }
      },
      tabIndex: 0,
      style: { cursor: 'pointer' },
    }),
  });

  return (
    <>
      <DataTableCard.Container>
        <DataTableCard.Title
          actions={
            <HeaderActions>
              <HeaderActionGroup>
                <HeaderAction
                  color={problemsOnly ? 'cyan' : 'gray'}
                  grouped
                  icon={IconFilter}
                  label={t('checks:ui.reconciliation.problemsOnly')}
                  onClick={() => {
                    setProblemsOnly(!problemsOnly);
                  }}
                />
                <HeaderAction
                  color="gray"
                  grouped
                  icon={IconRestore}
                  label={t('common:resetTable')}
                  onClick={() => {
                    setProblemsOnly(false);
                    tableState.reset();
                    table.resetColumnFilters(true);
                  }}
                />
              </HeaderActionGroup>
            </HeaderActions>
          }
          description={t('checks:ui.reconciliation.description')}
          icon={<TbChecklist size={24} />}
          title={t('checks:ui.reconciliation.title')}
        />
        <DataTableCard.Content>
          <MantineReactTable table={table} />
        </DataTableCard.Content>
      </DataTableCard.Container>
      <ReconciliationDrawer
        onClose={() => {
          setOpened(undefined);
        }}
        row={opened}
      />
    </>
  );
}

function ReconciliationBody({ report }: { report: ReconciliationReport }) {
  const { t } = useTranslation('checks');
  const number = useNumber();
  const formatTime = useDateTime();
  const { summary, dns, inventory, settings } = report;

  if (report.rows.length === 0) {
    return (
      <EmptyPageLayout
        description={t('ui.reconciliation.emptyText')}
        icon={<TbChecklist size="2rem" />}
        mih="30vh"
        title={t('ui.reconciliation.empty')}
      />
    );
  }
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 5 }} spacing="xs">
        <MetricCard
          icon={PiCheckCircle}
          iconColor="teal"
          subtitle={t('ui.reconciliation.metrics.okHint')}
          title={t('ui.reconciliation.metrics.ok')}
          value={number(summary.ok)}
        />
        <MetricCard
          icon={PiWarning}
          iconColor={summary.drift > 0 ? 'orange' : 'gray'}
          subtitle={t('ui.reconciliation.metrics.driftHint')}
          title={t('ui.reconciliation.metrics.drift')}
          value={number(summary.drift)}
        />
        <MetricCard
          icon={PiLinkBreak}
          iconColor={summary.missing > 0 ? 'red' : 'gray'}
          subtitle={t('ui.reconciliation.metrics.missingHint')}
          title={t('ui.reconciliation.metrics.missing')}
          value={number(summary.missing)}
        />
        <MetricCard
          icon={PiTrash}
          iconColor={summary.extra > 0 ? 'violet' : 'gray'}
          subtitle={t('ui.reconciliation.metrics.extraHint')}
          title={t('ui.reconciliation.metrics.extra')}
          value={number(summary.extra)}
        />
        <MetricCard
          icon={PiQuestion}
          iconColor="gray"
          subtitle={t('ui.reconciliation.metrics.unknownHint')}
          title={t('ui.reconciliation.metrics.unknown')}
          value={number(summary.unknown)}
        />
      </SimpleGrid>

      <Stack gap={2}>
        <Text c="dimmed" size="xs">
          {t('ui.conventions.findings.checkedAt', { time: formatTime(report.ranAt) })}
        </Text>
        <Group gap="md" wrap="wrap">
          <Text c="dimmed" size="xs">
            {t('ui.reconciliation.expectations.hostAddress')}:{' '}
            {t(`ui.reconciliation.expectations.values.${settings.hostAddress}`)}
          </Text>
          <Text c="dimmed" size="xs">
            {t('ui.reconciliation.expectations.hostSni')}:{' '}
            {t(`ui.reconciliation.expectations.values.${settings.hostSni}`)}
          </Text>
          <Text c="dimmed" size="xs">
            {t('ui.reconciliation.expectations.hostPort')}:{' '}
            {t(`ui.reconciliation.expectations.values.${settings.hostPort}`)}
          </Text>
        </Group>
      </Stack>

      {dns.enabled ? (
        <Callout color="blue">
          {t('ui.reconciliation.dns.summary', {
            names: number(dns.names),
            resolved: number(dns.resolved),
            failed: number(dns.failed),
            ms: number(dns.durationMs),
          })}
          {dns.cached > 0 ? ` ${t('ui.reconciliation.dns.cached', { count: dns.cached })}` : ''}
        </Callout>
      ) : (
        <Callout color="orange">{t('ui.reconciliation.dns.off')}</Callout>
      )}
      {dns.capped ? (
        <Callout color="orange">
          {t('ui.reconciliation.dns.capped', { skipped: number(dns.skipped) })}
        </Callout>
      ) : null}
      {inventory.available ? (
        <Text c="dimmed" size="xs">
          {t('ui.reconciliation.inventory.servers', { count: inventory.servers })}
        </Text>
      ) : (
        <Callout color="orange">{t('ui.reconciliation.inventory.noPermission')}</Callout>
      )}
      {report.truncated ? <Callout color="blue">{t('ui.reconciliation.truncated')}</Callout> : null}

      <Rows report={report} />
    </Stack>
  );
}

/** The Reconciliation tab: hosts, nodes and servers compared. */
export function ReconciliationTab({ read }: { read: ChecksRead<ReconciliationReport> }) {
  return (
    <PanelBoundary query={read.query}>
      {(report) => <ReconciliationBody report={report} />}
    </PanelBoundary>
  );
}
