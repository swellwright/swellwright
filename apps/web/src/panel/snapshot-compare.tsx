// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the panel has no comparison screen, so this takes its closest
// parts: a right-hand drawer (src/shared/_modals/hosts/edit-host-modal) holding a strip of metric cards
// (src/shared/ui/metrics/metric-card), a titled card with a `@kastov/mantine-react-table-open` table with column filters
// (src/widgets/dashboard/users/users-table/user-table.widget.tsx) and, for the rows, the detail panel that the panel's
// inspector tables use for a request. Changes: new composition. The table lists the objects that differ and a row opens
// the field changes of that object; values that hold a masked secret show their keyed fingerprint and a "secret" chip.
import {
  Badge,
  Button,
  Checkbox,
  Code,
  Drawer,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconCircleCheck,
  IconGitCompare,
  IconListDetails,
  IconMinus,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconEqual,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiKeyDuotone } from 'react-icons/pi';

import {
  PANEL_DIFF_AGAINST_LIVE,
  PANEL_DIFF_OBJECT_STATUSES,
  PANEL_SNAPSHOT_OBJECT_KINDS,
  type PanelDiff,
  type PanelDiffNote,
  type PanelDiffObject,
  type PanelDiffObjectStatus,
  type PanelFieldChange,
  type PanelSnapshotSummary,
} from '@swellwright/contracts';
import {
  Callout,
  DataTableCard,
  EmptyPageLayout,
  LoadingScreen,
  MantineReactTable,
  type MRT_ColumnDef,
  MetricCard,
  OverlayHeader,
  panelTableOptions,
  useMantineReactTable,
} from '@swellwright/ui';

import { diffPanelSnapshot, listPanelSnapshots } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useDateTime, useNumber } from '../format.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useTableLocalization } from '../tables.js';
import { panelKey } from './panel-data.js';
import { useKindNames, useSnapshotName } from './snapshot-parts.js';

const STATUS_STYLE: Record<PanelDiffObjectStatus, { color: string }> = {
  added: { color: 'teal' },
  removed: { color: 'red' },
  changed: { color: 'orange' },
  unchanged: { color: 'gray' },
};

/** A value of a field change, as text: scalars as they are, anything else as compact JSON. */
function asText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const isItems = (value: unknown): value is { items: number } =>
  value !== null &&
  typeof value === 'object' &&
  'items' in value &&
  typeof value.items === 'number';

/** One side of a field change: the value, named when it is the uuid of an object that is known. */
function DiffValue({
  value,
  change,
  labels,
}: {
  value: unknown;
  change: PanelFieldChange;
  labels: Readonly<Record<string, string>>;
}) {
  const { t } = useTranslation('snapshots');
  if (value === undefined) {
    return (
      <Text c="dimmed" fz="sm">
        –
      </Text>
    );
  }
  if (change.hidden === true && isItems(value)) {
    return (
      <Text c="dimmed" fz="sm">
        {t('compare.value.items', { count: value.items })}
      </Text>
    );
  }
  if (typeof value === 'string' && change.lines !== undefined) {
    return (
      <Code block fz="xs" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {value === '' ? t('compare.value.none') : value}
      </Code>
    );
  }
  if (typeof value === 'string' && labels[value] !== undefined) {
    return (
      <Stack gap={0}>
        <Text fz="sm">{labels[value]}</Text>
        <Text c="dimmed" ff="monospace" fz="xs" style={{ wordBreak: 'break-all' }}>
          {value}
        </Text>
      </Stack>
    );
  }
  if (value !== null && typeof value === 'object') {
    return (
      <Code block fz="xs" style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(value, null, 2)}
      </Code>
    );
  }
  const text = asText(value);
  if (text === '') {
    return (
      <Text c="dimmed" fz="sm">
        {t('compare.value.empty')}
      </Text>
    );
  }
  return (
    <Text ff="monospace" fz="sm" style={{ overflowWrap: 'anywhere' }}>
      {text}
    </Text>
  );
}

/** The field changes of one object: a small table with the path, what happened, and the two values. */
function ChangesTable({
  object,
  labels,
}: {
  object: PanelDiffObject;
  labels: Readonly<Record<string, string>>;
}) {
  const { t } = useTranslation('snapshots');
  const number = useNumber();
  return (
    <Stack gap="xs" p="md">
      <Table.ScrollContainer minWidth={560}>
        <Table highlightOnHover={false} verticalSpacing="xs" withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('compare.fields.path')}</Table.Th>
              <Table.Th>{t('compare.fields.op')}</Table.Th>
              <Table.Th>{t('compare.fields.before')}</Table.Th>
              <Table.Th>{t('compare.fields.after')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {object.changes.map((change, index) => (
              <Table.Tr key={`${change.path}:${change.op}:${String(index)}`}>
                <Table.Td style={{ maxWidth: 320 }}>
                  <Text ff="monospace" fz="sm" style={{ overflowWrap: 'anywhere' }}>
                    {change.path === '' ? t('compare.fields.wholeObject') : change.path}
                  </Text>
                  {change.lines === undefined ? null : (
                    <Text c="dimmed" fz="xs">
                      {t('compare.value.lines', change.lines)}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ minWidth: 130 }}>
                  <Group gap={6} wrap="wrap">
                    <Badge color={STATUS_STYLE[change.op].color} size="md" variant="soft">
                      {t(`compare.fields.${change.op}`)}
                    </Badge>
                    {change.masked === true && change.hidden !== true ? (
                      <Tooltip label={t('compare.value.maskedHint')} multiline w={260} withArrow>
                        <Badge
                          color="violet"
                          leftSection={<PiKeyDuotone size={12} />}
                          size="md"
                          variant="soft"
                        >
                          {t('compare.value.masked')}
                        </Badge>
                      </Tooltip>
                    ) : null}
                  </Group>
                </Table.Td>
                <Table.Td style={{ maxWidth: 260 }}>
                  <DiffValue change={change} labels={labels} value={change.before} />
                </Table.Td>
                <Table.Td style={{ maxWidth: 260 }}>
                  <DiffValue change={change} labels={labels} value={change.after} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {object.truncated ? (
        <Text c="dimmed" fz="sm">
          {t('compare.fields.truncated', {
            count: number(object.changeCount - object.changes.length),
          })}
        </Text>
      ) : null}
    </Stack>
  );
}

function NoteCallout({ note }: { note: PanelDiffNote }) {
  const { t } = useTranslation('snapshots');
  const names = useKindNames();
  const count = note.count ?? 0;
  let text: string;
  switch (note.code) {
    case 'kind_not_covered':
      text = t('compare.notes.kind_not_covered', {
        kinds: (note.kinds ?? []).map((kind) => names.many(kind)).join(', '),
      });
      break;
    case 'noise_only':
      text = t('compare.notes.noise_only', { count });
      break;
    case 'objects_cut':
      text = t('compare.notes.objects_cut', { count });
      break;
    case 'mask_key_differs':
      text = t('compare.notes.mask_key_differs');
      break;
    case 'panel_version_differs':
      text = t('compare.notes.panel_version_differs');
      break;
  }
  const warn = note.code === 'kind_not_covered' || note.code === 'mask_key_differs';
  return <Callout color={warn ? 'orange' : 'blue'}>{text}</Callout>;
}

/** What the comparison found: the strip of numbers, the notes, and the table of the objects that differ. */
function DiffResult({ diff }: { diff: PanelDiff }) {
  const { t } = useTranslation(['snapshots', 'common']);
  const number = useNumber();
  const names = useKindNames();
  const { objects: counts } = diff.summary;

  const columns = useMemo<MRT_ColumnDef<PanelDiffObject>[]>(
    () => [
      {
        id: 'kind',
        header: t('snapshots:compare.columns.kind'),
        accessorFn: (object) => names.one(object.kind),
        size: 190,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: PANEL_SNAPSHOT_OBJECT_KINDS.map((kind) => ({
            value: names.one(kind),
            label: names.one(kind),
          })),
        },
      },
      {
        id: 'object',
        header: t('snapshots:compare.columns.object'),
        accessorFn: (object) => object.name,
        size: 320,
        Cell: ({ row }) => (
          <div>
            <Text fz="sm" truncate="end">
              {row.original.name}
            </Text>
            <Text c="dimmed" ff="monospace" fz="xs" truncate="end">
              {row.original.id}
            </Text>
          </div>
        ),
      },
      {
        id: 'status',
        header: t('snapshots:compare.columns.status'),
        accessorFn: (object) => t(`snapshots:compare.status.${object.status}`),
        size: 170,
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: PANEL_DIFF_OBJECT_STATUSES.map((status) => ({
            value: t(`snapshots:compare.status.${status}`),
            label: t(`snapshots:compare.status.${status}`),
          })),
        },
        Cell: ({ row }) => (
          <Badge color={STATUS_STYLE[row.original.status].color} size="lg" variant="soft">
            {t(`snapshots:compare.status.${row.original.status}`)}
          </Badge>
        ),
      },
      {
        id: 'changes',
        header: t('snapshots:compare.columns.changes'),
        accessorFn: (object) => object.changeCount,
        enableColumnFilter: false,
        size: 110,
        Cell: ({ row }) => (
          <Text ff="monospace" fz="sm">
            {row.original.status === 'changed' ? number(row.original.changeCount) : '–'}
          </Text>
        ),
      },
    ],
    [t, names, number],
  );

  const localization = useTableLocalization(t('snapshots:compare.noDifferencesTitle'));
  const table = useMantineReactTable<PanelDiffObject>({
    ...panelTableOptions<PanelDiffObject>(),
    columns,
    data: diff.objects,
    localization,
    getRowId: (object) => `${object.kind}:${object.id}`,
    getRowCanExpand: (row) => row.original.status === 'changed' && row.original.changes.length > 0,
    renderDetailPanel: ({ row }) =>
      row.original.status === 'changed' ? (
        <ChangesTable labels={diff.labels} object={row.original} />
      ) : null,
    enableColumnOrdering: false,
    enableColumnPinning: false,
    enableColumnResizing: false,
    enableSorting: false,
    initialState: {
      density: 'xxs',
      showColumnFilters: true,
      pagination: { pageIndex: 0, pageSize: 25 },
    },
  });

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
        <MetricCard
          icon={IconPlus}
          iconColor="teal"
          title={t('snapshots:compare.summary.added')}
          value={number(counts.added)}
        />
        <MetricCard
          icon={IconMinus}
          iconColor="red"
          title={t('snapshots:compare.summary.removed')}
          value={number(counts.removed)}
        />
        <MetricCard
          icon={IconPencil}
          iconColor="orange"
          subtitle={t('snapshots:compare.summary.fields', { count: diff.summary.fieldChanges })}
          title={t('snapshots:compare.summary.changed')}
          value={number(counts.changed)}
        />
        <MetricCard
          icon={IconEqual}
          iconColor="gray"
          title={t('snapshots:compare.summary.unchanged')}
          value={number(counts.unchanged)}
        />
      </SimpleGrid>

      {diff.notes.map((note) => (
        <NoteCallout key={note.code} note={note} />
      ))}

      {diff.identical ? (
        <EmptyPageLayout
          description={t('snapshots:compare.noDifferencesText')}
          icon={<IconCircleCheck size="2rem" />}
          mih="20vh"
          title={t('snapshots:compare.noDifferencesTitle')}
        />
      ) : (
        <DataTableCard.Container>
          <DataTableCard.Title
            description={t('snapshots:compare.objectsDescription')}
            icon={<IconListDetails size={24} />}
            title={t('snapshots:compare.objects')}
          />
          <DataTableCard.Content>
            <MantineReactTable table={table} />
          </DataTableCard.Content>
        </DataTableCard.Container>
      )}
    </Stack>
  );
}

/**
 * The comparison of a snapshot with the panel now or with another snapshot: choose the two sides, see the objects that
 * differ and open one to read the field changes. The comparison with the panel reads it through the memory of the
 * server; "ask the panel again" forces a new read (the server limits those).
 */
export function CompareDrawer({
  opened,
  onClose,
  initialFrom,
  initialAgainst,
  canCompareLive,
}: {
  opened: boolean;
  onClose: () => void;
  /** The snapshot to start from; the person may change it. */
  initialFrom: string | undefined;
  /** `live`, or the id of the snapshot to compare with. */
  initialAgainst: string;
  canCompareLive: boolean;
}) {
  const { t } = useTranslation(['snapshots', 'common', 'panel']);
  const formatTime = useDateTime();
  const nameOf = useSnapshotName();
  // The page remounts this drawer (a new `key`) each time it asks for a comparison, so the choice starts from what it
  // asked for and is the person's own from then on.
  const [choice, setChoice] = useState<{ from: string | null; against: string }>({
    from: initialFrom ?? null,
    against: initialAgainst,
  });
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [asked, setAsked] = useState(0);

  const options = useQuery({
    queryKey: panelKey('snapshots', 'options'),
    queryFn: () => listPanelSnapshots({ limit: 100 }),
    enabled: opened,
    retry: false,
  });
  const snapshots: readonly PanelSnapshotSummary[] = options.data?.snapshots ?? [];
  const { from, against } = choice;
  const same = from !== null && from === against;

  const labelOf = (snapshot: PanelSnapshotSummary): string =>
    snapshot.label === null
      ? nameOf(snapshot)
      : `${snapshot.label} · ${formatTime(snapshot.createdAt)}`;
  const fromData = snapshots.map((snapshot) => ({ value: snapshot.id, label: labelOf(snapshot) }));
  const againstData = [
    ...(canCompareLive
      ? [{ value: PANEL_DIFF_AGAINST_LIVE, label: t('snapshots:compare.live') }]
      : []),
    ...snapshots
      .filter((snapshot) => snapshot.id !== from)
      .map((snapshot) => ({
        value: snapshot.id,
        label: labelOf(snapshot),
      })),
  ];

  const diff = useQuery({
    queryKey: panelKey(
      'snapshots',
      'diff',
      from ?? '',
      against,
      String(showUnchanged),
      String(asked),
    ),
    queryFn: () =>
      diffPanelSnapshot(from ?? '', against, {
        refresh: asked > 0 && against === PANEL_DIFF_AGAINST_LIVE,
        includeUnchanged: showUnchanged,
      }),
    enabled:
      opened && from !== null && !same && (against !== PANEL_DIFF_AGAINST_LIVE || canCompareLive),
    retry: false,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });

  // A comparison with the panel is kept on the snapshot as "changes since": the list and the Overview show it.
  const queryClient = useQueryClient();
  const comparedLive = diff.data?.to.type === 'live';
  useEffect(() => {
    if (comparedLive) {
      void queryClient.invalidateQueries({ queryKey: panelKey('snapshots', 'list') });
      void queryClient.invalidateQueries({ queryKey: panelKey('snapshots', 'latest') });
    }
  }, [comparedLive, diff.dataUpdatedAt, queryClient]);

  return (
    <Drawer
      closeButtonProps={{ 'aria-label': t('common:close') }}
      onClose={onClose}
      opened={opened}
      padding="lg"
      position="right"
      size="min(1000px, 100vw)"
      title={
        <OverlayHeader
          icon={IconGitCompare}
          iconColor="cyan"
          subtitle={t('snapshots:compare.description')}
          title={t('snapshots:compare.title')}
        />
      }
    >
      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <Select
            allowDeselect={false}
            data={fromData}
            label={t('snapshots:compare.from')}
            nothingFoundMessage={t('snapshots:list.empty')}
            onChange={(value) => {
              setChoice({
                from: value,
                against: value === against ? PANEL_DIFF_AGAINST_LIVE : against,
              });
              setAsked(0);
            }}
            placeholder={t('snapshots:compare.pick')}
            searchable
            value={from}
          />
          <Select
            allowDeselect={false}
            data={againstData}
            label={t('snapshots:compare.against')}
            onChange={(value) => {
              setChoice({ from, against: value ?? PANEL_DIFF_AGAINST_LIVE });
              setAsked(0);
            }}
            placeholder={t('snapshots:compare.pick')}
            searchable
            value={againstData.some((option) => option.value === against) ? against : null}
          />
        </SimpleGrid>
        <Group gap="md" justify="space-between">
          <Checkbox
            checked={showUnchanged}
            label={t('snapshots:compare.showUnchanged')}
            onChange={(event) => {
              setShowUnchanged(event.currentTarget.checked);
            }}
          />
          {against === PANEL_DIFF_AGAINST_LIVE && canCompareLive ? (
            <Button
              leftSection={<IconRefresh size={16} />}
              loading={diff.isFetching && asked > 0}
              onClick={() => {
                setAsked((count) => count + 1);
              }}
              variant="light"
            >
              {t('snapshots:compare.askAgain')}
            </Button>
          ) : null}
        </Group>

        {same ? (
          <Callout color="orange">{t('snapshots:compare.sameChoice')}</Callout>
        ) : from === null ? null : against === PANEL_DIFF_AGAINST_LIVE && !canCompareLive ? (
          <Callout color="orange">{t('snapshots:actions.noPanel')}</Callout>
        ) : diff.isError ? (
          <QueryErrorCard
            message={describeError(t, diff.error, t('panel:signInAgain'), t('panel:readForbidden'))}
            onRetry={() => void diff.refetch()}
            title={t('snapshots:compare.failed')}
          />
        ) : diff.data === undefined ? (
          <LoadingScreen height="30vh" />
        ) : (
          <>
            <Text c="dimmed" fz="sm">
              {t('snapshots:compare.peer', {
                from: sideName(diff.data.from, nameOf, formatTime, t('snapshots:compare.live')),
                to: sideName(
                  diff.data.to,
                  nameOf,
                  formatTime,
                  t('snapshots:compare.liveAt', { time: formatTime(diff.data.to.at) }),
                ),
              })}
            </Text>
            <DiffResult diff={diff.data} />
          </>
        )}
      </Stack>
    </Drawer>
  );
}

/** What one side of a comparison is called: its label or time, or "the panel now". */
function sideName(
  side: PanelDiff['from'],
  nameOf: (snapshot: { label: string | null; createdAt: string }) => string,
  formatTime: (value: string) => string,
  live: string,
): string {
  if (side.type === 'live') {
    return live;
  }
  return side.label === null
    ? nameOf({ label: null, createdAt: side.at })
    : `${side.label} · ${formatTime(side.at)}`;
}
