// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the table cards of its Users and request-history pages
// (src/widgets/dashboard/users/users-table/user-table.widget.tsx): a titled card with `@kastov/mantine-react-table-open`
// inside. Changes: the rules of the convention linter with the settings the active pack gives them, and a read-only drawer
// per rule (its kinds of finding, its parameters with the defaults and the values in force, its scope).
import { Badge, DataList, Group, Stack, Text } from '@mantine/core';
import { IconRestore } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TbChecklist, TbListDetails } from 'react-icons/tb';

import type { ConventionRuleInfo } from '@swellwright/contracts';
import {
  CopyableDataListItem,
  DataTableCard,
  HeaderAction,
  HeaderActions,
  LoaderModal,
  MantineReactTable,
  type MRT_ColumnDef,
  panelTableOptions,
  SectionCard,
  StatusBadge,
  useMantineReactTable,
  useMrtTableState,
} from '@swellwright/ui';

import { PanelDrawer } from '../panel/panel-drawer.js';
import { PanelReadFailure } from '../panel/panel-data.js';
import { useTableLocalization } from '../tables.js';
import { getConventionRules } from './checks-api.js';
import { checksKey } from './checks-data.js';
import { kindIcon, KIND_COLOR, SeverityBadge } from './checks-format.js';

const STATE_KIND = { active: 'ok', disabled: 'wait', needs_params: 'warn' } as const;

function stateOf(rule: ConventionRuleInfo): keyof typeof STATE_KIND {
  return rule.effective.inactive ?? 'active';
}

/** A value of a parameter as text. */
function show(value: unknown, empty: string): string {
  if (value === null || value === undefined) {
    return empty;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function RuleDrawer({
  rule,
  onClose,
}: {
  rule: ConventionRuleInfo | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('checks');
  return (
    <PanelDrawer
      header={(item) => ({
        icon: TbChecklist,
        iconColor: KIND_COLOR[item.kind],
        title: t(`rules.${item.id}.title` as never),
        subtitle: item.id,
      })}
      item={rule}
      onClose={onClose}
    >
      {(item) => {
        const state = stateOf(item);
        return (
          <Stack gap="md">
            <SectionCard.Root>
              <SectionCard.Section>
                <Stack gap="xs">
                  <Group gap="xs">
                    <StatusBadge kind={STATE_KIND[state]}>
                      {t(
                        `ui.conventions.rules.state.${state === 'needs_params' ? 'needsParams' : state}`,
                      )}
                    </StatusBadge>
                    <SeverityBadge severity={item.effective.severity} />
                  </Group>
                  <Text size="sm">{t(`rules.${item.id}.description` as never)}</Text>
                  {item.effective.note === null ? null : (
                    <Text c="dimmed" size="xs">
                      {t('ui.conventions.rules.note')}: {item.effective.note}
                    </Text>
                  )}
                </Stack>
              </SectionCard.Section>
              <SectionCard.Section>
                <DataList orientation="vertical" size="xs" withDivider>
                  <CopyableDataListItem
                    label={t('ui.conventions.rules.defaultSeverity')}
                    value={t(`ui.severity.${item.defaultSeverity}`)}
                  />
                  <CopyableDataListItem
                    label={t('ui.conventions.rules.codes')}
                    monospace
                    value={item.codes.join(', ')}
                  />
                  <CopyableDataListItem
                    label={t('ui.conventions.rules.needs')}
                    monospace
                    value={item.needs.length === 0 ? null : item.needs.join(', ')}
                    emptyValue="–"
                  />
                  <CopyableDataListItem
                    label={t('ui.conventions.rules.scope')}
                    monospace
                    value={
                      item.effective.scope === null
                        ? t('ui.conventions.rules.scopeAll')
                        : JSON.stringify(item.effective.scope)
                    }
                  />
                </DataList>
              </SectionCard.Section>
            </SectionCard.Root>

            <SectionCard.Root>
              <SectionCard.Section>
                <Text fw={600} size="sm">
                  {t('ui.conventions.rules.parameters')}
                </Text>
              </SectionCard.Section>
              <SectionCard.Section>
                {item.params.length === 0 ? (
                  <Text c="dimmed" size="sm">
                    {t('ui.conventions.rules.noParams')}
                  </Text>
                ) : (
                  <Stack gap="md">
                    {item.params.map((param) => (
                      <Stack gap={4} key={param.name}>
                        <Group gap="xs" wrap="nowrap">
                          <Text ff="monospace" fw={600} size="sm">
                            {param.name}
                          </Text>
                          <Badge color="gray" size="sm" variant="light">
                            {param.type}
                          </Badge>
                        </Group>
                        <Text c="dimmed" size="xs">
                          {t(`rules.${item.id}.params.${param.name}` as never, {
                            defaultValue: param.description,
                          })}
                        </Text>
                        <DataList orientation="vertical" size="xs">
                          <CopyableDataListItem
                            label={t('ui.conventions.rules.value')}
                            monospace
                            value={show(
                              item.effective.params[param.name],
                              t('ui.conventions.rules.notSet'),
                            )}
                          />
                          <CopyableDataListItem
                            label={t('ui.conventions.rules.defaultValue')}
                            monospace
                            value={show(param.default, t('ui.conventions.rules.notSet'))}
                          />
                        </DataList>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </SectionCard.Section>
            </SectionCard.Root>
          </Stack>
        );
      }}
    </PanelDrawer>
  );
}

/** The rules of the linter, as the table card of the panel. */
export function RulesCard() {
  const { t } = useTranslation(['checks', 'common']);
  const rules = useQuery({
    queryKey: checksKey('rules'),
    queryFn: getConventionRules,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [opened, setOpened] = useState<ConventionRuleInfo | undefined>(undefined);
  const data = rules.data?.rules;

  const columns = useMemo<MRT_ColumnDef<ConventionRuleInfo>[]>(
    () => [
      {
        id: 'rule',
        header: t('checks:ui.conventions.rules.columns.rule'),
        accessorFn: (rule) => `${rule.id} ${String(t(`checks:rules.${rule.id}.title` as never))}`,
        size: 320,
        Cell: ({ row }) => (
          <Stack gap={0}>
            <Text fw={500} size="sm" truncate="end">
              {t(`checks:rules.${row.original.id}.title` as never)}
            </Text>
            <Text c="dimmed" ff="monospace" size="xs" truncate="end">
              {row.original.id}
            </Text>
          </Stack>
        ),
      },
      {
        id: 'kind',
        header: t('checks:ui.conventions.rules.columns.kind'),
        accessorFn: (rule) => rule.kind,
        size: 240,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: [...new Set((data ?? []).map((rule) => rule.kind))].map((kind) => ({
            value: kind,
            label: t(`checks:ui.kind.${kind}`),
          })),
        },
        Cell: ({ row }) => {
          const Icon = kindIcon(row.original.kind);
          return (
            <Group gap="xs" wrap="nowrap">
              <Icon size={16} />
              <Text size="sm">{t(`checks:ui.kind.${row.original.kind}`)}</Text>
            </Group>
          );
        },
      },
      {
        id: 'severity',
        header: t('checks:ui.conventions.rules.columns.severity'),
        accessorFn: (rule) => rule.effective.severity,
        size: 210,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: (['error', 'warning', 'info'] as const).map((value) => ({
            value,
            label: t(`checks:ui.severity.${value}`),
          })),
        },
        Cell: ({ row }) => <SeverityBadge severity={row.original.effective.severity} />,
      },
      {
        id: 'state',
        header: t('checks:ui.conventions.rules.columns.state'),
        accessorFn: (rule) => stateOf(rule),
        size: 200,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: (['active', 'disabled', 'needs_params'] as const).map((value) => ({
            value,
            label: t(
              `checks:ui.conventions.rules.state.${value === 'needs_params' ? 'needsParams' : value}`,
            ),
          })),
        },
        Cell: ({ row }) => {
          const state = stateOf(row.original);
          return (
            <StatusBadge iconSize={16} kind={STATE_KIND[state]} size="md">
              {t(
                `checks:ui.conventions.rules.state.${state === 'needs_params' ? 'needsParams' : state}`,
              )}
            </StatusBadge>
          );
        },
      },
      {
        id: 'params',
        header: t('checks:ui.conventions.rules.columns.parameters'),
        accessorFn: (rule) => rule.params.map((param) => param.name).join(' '),
        enableColumnFilter: false,
        size: 240,
        Cell: ({ row }) =>
          row.original.params.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('checks:ui.conventions.rules.noParams')}
            </Text>
          ) : (
            <Text ff="monospace" size="xs" truncate="end">
              {row.original.params.map((param) => param.name).join(', ')}
            </Text>
          ),
      },
    ],
    [t, data],
  );

  const tableState = useMrtTableState('checks-rules-v1');
  const localization = useTableLocalization(t('checks:ui.conventions.rules.empty'));
  const table = useMantineReactTable<ConventionRuleInfo>({
    ...panelTableOptions<ConventionRuleInfo>(),
    columns,
    data: data ?? [],
    localization,
    ...tableState.handlers,
    state: {
      ...tableState.state,
      showProgressBars: rules.isFetching,
    },
    getRowId: (rule) => rule.id,
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
      <DataTableCard.Container mt="md">
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
          description={t('checks:ui.conventions.rules.description')}
          icon={<TbListDetails size={24} />}
          title={t('checks:ui.conventions.rules.title')}
        />
        <DataTableCard.Content>
          {rules.isError ? (
            <PanelReadFailure
              error={rules.error}
              onRetry={() => {
                void rules.refetch();
              }}
            />
          ) : rules.isPending ? (
            <LoaderModal label={t('common:loading')} mih="200px" />
          ) : (
            // Not `isLoading` of the table: its skeleton rows are objects without the fields the accessors read.
            <MantineReactTable table={table} />
          )}
        </DataTableCard.Content>
      </DataTableCard.Container>
      <RuleDrawer
        onClose={() => {
          setOpened(undefined);
        }}
        rule={opened}
      />
    </>
  );
}
