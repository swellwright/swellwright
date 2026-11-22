// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): a strip of metric cards above a list
// (src/pages/dashboard/nodes: `SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="xs"` of `MetricCard`s) and the table card
// of its Users page (`@kastov/mantine-react-table-open` in a titled card with column filters under the head). Changes: the
// findings of the convention linter; a row opens a drawer, and the card of the pack in use and the table of the rules follow.
import { SimpleGrid, Stack, Text } from '@mantine/core';
import { IconRestore } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCheckCircle, PiInfo, PiWarning, PiXCircle } from 'react-icons/pi';
import { TbChecklist } from 'react-icons/tb';

import type { CheckSeverity, ConventionFinding, ConventionRun } from '@swellwright/contracts';
import {
  Callout,
  DataTableCard,
  HeaderAction,
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
import { kindIcon, ObjectLabel, SeverityBadge, useCheckText } from './checks-format.js';
import { FindingDrawer } from './finding-drawer.js';
import { PackCard } from './pack-card.js';
import { RulesCard } from './rules-card.js';

const SEVERITIES: readonly CheckSeverity[] = ['error', 'warning', 'info'];
const KINDS = [
  'panel',
  'host',
  'node',
  'configProfile',
  'inbound',
  'internalSquad',
  'externalSquad',
  'subscriptionTemplate',
  'snippet',
  'nodePlugin',
  'server',
] as const;

function Findings({ run }: { run: ConventionRun }) {
  const { t } = useTranslation(['checks', 'common']);
  const text = useCheckText();
  const [opened, setOpened] = useState<ConventionFinding | undefined>(undefined);

  const columns = useMemo<MRT_ColumnDef<ConventionFinding>[]>(
    () => [
      {
        id: 'severity',
        header: t('checks:ui.conventions.findings.columns.severity'),
        accessorFn: (finding) => finding.severity,
        size: 210,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: SEVERITIES.map((value) => ({ value, label: t(`checks:ui.severity.${value}`) })),
        },
        sortingFn: (a, b) =>
          SEVERITIES.indexOf(a.original.severity) - SEVERITIES.indexOf(b.original.severity),
        Cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      },
      {
        id: 'kind',
        header: t('checks:ui.conventions.findings.filterKind'),
        accessorFn: (finding) => finding.object.kind,
        size: 190,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: KINDS.map((value) => ({ value, label: t(`checks:ui.kind.${value}`) })),
        },
        Cell: ({ row }) => {
          const Icon = kindIcon(row.original.object.kind);
          return (
            <Text size="sm">
              <Icon size={14} /> {t(`checks:ui.kind.${row.original.object.kind}`)}
            </Text>
          );
        },
      },
      {
        id: 'object',
        header: t('checks:ui.conventions.findings.columns.object'),
        accessorFn: (finding) => finding.object.name,
        size: 220,
        Cell: ({ row }) => <ObjectLabel object={row.original.object} />,
      },
      {
        id: 'rule',
        header: t('checks:ui.conventions.findings.columns.rule'),
        accessorFn: (finding) => finding.ruleId,
        size: 240,
        Cell: ({ row }) => (
          <Stack gap={0}>
            <Text size="sm" truncate="end">
              {t(`checks:rules.${row.original.ruleId}.title` as never)}
            </Text>
            <Text c="dimmed" ff="monospace" size="xs" truncate="end">
              {row.original.ruleId}
            </Text>
          </Stack>
        ),
      },
      {
        id: 'message',
        header: t('checks:ui.conventions.findings.columns.message'),
        accessorFn: (finding) => text(finding.messageKey, finding.message, finding.params),
        size: 460,
        Cell: ({ row }) => (
          <Text size="sm" truncate="end">
            {text(row.original.messageKey, row.original.message, row.original.params)}
          </Text>
        ),
      },
    ],
    [t, text],
  );

  const tableState = useMrtTableState('checks-findings-v1');
  const localization = useTableLocalization(t('checks:ui.conventions.findings.emptyText'));
  const table = useMantineReactTable<ConventionFinding>({
    ...panelTableOptions<ConventionFinding>(),
    columns,
    data: run.findings,
    localization,
    ...tableState.handlers,
    state: { ...tableState.state },
    getRowId: (finding) => finding.id,
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
              <HeaderAction
                color="gray"
                icon={IconRestore}
                label={t('common:resetTable')}
                onClick={() => {
                  tableState.reset();
                  table.resetColumnFilters(true);
                }}
              />
            </HeaderActions>
          }
          description={t('checks:ui.conventions.findings.description')}
          icon={<TbChecklist size={24} />}
          title={t('checks:ui.conventions.findings.title')}
        />
        <DataTableCard.Content>
          <MantineReactTable table={table} />
        </DataTableCard.Content>
      </DataTableCard.Container>
      <FindingDrawer
        finding={opened}
        onClose={() => {
          setOpened(undefined);
        }}
      />
    </>
  );
}

function ConventionsBody({ run, canWrite }: { run: ConventionRun; canWrite: boolean }) {
  const { t } = useTranslation('checks');
  const number = useNumber();
  const formatTime = useDateTime();
  const { summary } = run;
  const ruleName = (id: string): string => t(`rules.${id}.title` as never);

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="xs">
        <MetricCard
          icon={PiXCircle}
          iconColor={summary.error > 0 ? 'red' : 'gray'}
          subtitle={t('ui.conventions.metrics.errorsHint')}
          title={t('ui.conventions.metrics.errors')}
          value={number(summary.error)}
        />
        <MetricCard
          icon={PiWarning}
          iconColor={summary.warning > 0 ? 'orange' : 'gray'}
          subtitle={t('ui.conventions.metrics.warningsHint')}
          title={t('ui.conventions.metrics.warnings')}
          value={number(summary.warning)}
        />
        <MetricCard
          icon={PiInfo}
          iconColor={summary.info > 0 ? 'blue' : 'gray'}
          subtitle={t('ui.conventions.metrics.infoHint')}
          title={t('ui.conventions.metrics.info')}
          value={number(summary.info)}
        />
        <MetricCard
          icon={PiCheckCircle}
          iconColor={summary.total === 0 ? 'teal' : 'cyan'}
          subtitle={t('ui.conventions.metrics.objectsHint', {
            count: Object.keys(summary.byRule).length,
          })}
          title={t('ui.conventions.metrics.objects')}
          value={number(summary.objects)}
        />
      </SimpleGrid>

      <Text c="dimmed" size="xs">
        {t('ui.conventions.findings.checkedAt', { time: formatTime(run.fetchedAt) })}
        {run.cached ? ` · ${t('ui.conventions.findings.cached')}` : ''}
      </Text>

      {run.truncated ? (
        <Callout color="blue">
          {t('ui.conventions.findings.truncated', {
            shown: number(run.findings.length),
            total: number(summary.total),
          })}
        </Callout>
      ) : null}
      {run.skipped.length === 0 ? null : (
        <Callout color="orange">
          {t('ui.conventions.findings.skipped', {
            rules: run.skipped.map((entry) => ruleName(entry.ruleId)).join(', '),
          })}
        </Callout>
      )}
      {run.failed.length === 0 ? null : (
        <Callout color="red">
          {t('ui.conventions.findings.failed', {
            rules: run.failed.map((entry) => ruleName(entry.ruleId)).join(', '),
          })}
        </Callout>
      )}

      <Findings run={run} />
      <PackCard canWrite={canWrite} />
      <RulesCard />
    </Stack>
  );
}

/** The Conventions tab: the findings of the linter, the pack in use and the rules. */
export function ConventionsTab({
  read,
  canWrite,
}: {
  read: ChecksRead<ConventionRun>;
  canWrite: boolean;
}) {
  return (
    <PanelBoundary query={read.query}>
      {(run) => <ConventionsBody canWrite={canWrite} run={run} />}
    </PanelBoundary>
  );
}
