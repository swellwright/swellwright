// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/users/components/users.page.component.tsx
// and src/widgets/dashboard/users/users-table/user-table.widget.tsx (a header card with icon-only actions, then a titled
// card that holds a `@kastov/mantine-react-table-open` table with its tools in the title), and the row actions of the
// panel's tables (soft icon buttons with a tooltip). Changes: new list. It pages on the server (the list does not carry the
// content of a snapshot), has no column filters (the server has no filter for it), and its actions are the ones a snapshot
// has: details, compare with the panel now, download as JSON, and delete with a confirmation and a code.
import { ActionIcon, Group, Text, Tooltip } from '@mantine/core';
import {
  IconCamera,
  IconDownload,
  IconGitCompare,
  IconListDetails,
  IconRefresh,
  IconRestore,
  IconTrash,
} from '@tabler/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TbCamera } from 'react-icons/tb';

import type { Permission, PanelSnapshotSummary } from '@swellwright/contracts';
import {
  DataTableCard,
  HeaderAction,
  HeaderActionGroup,
  HeaderActions,
  MantineReactTable,
  type MRT_ColumnDef,
  PageHeader,
  panelTableOptions,
  useMantineReactTable,
  useMrtTableState,
  usePreventTableBackScroll,
} from '@swellwright/ui';

import {
  deletePanelSnapshot,
  getPanelConnection,
  listPanelSnapshots,
  panelSnapshotExportPath,
} from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { useBytes, useNumber } from '../format.js';
import { notifyFailure } from '../security/notify-failure.js';
import { useTimeFirst } from '../security/time-first.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';
import { useTableLocalization } from '../tables.js';
import { PanelNotConnected, panelKey } from './panel-data.js';
import { TakeSnapshotDialog } from './snapshot-dialogs.js';
import { CompareDrawer } from './snapshot-compare.js';
import { SnapshotDrawer } from './snapshot-drawer.js';
import {
  ChangesSince,
  IncompleteMark,
  SourceBadge,
  useIncompleteText,
  useSnapshotName,
} from './snapshot-parts.js';

/** How often the list reads again by itself. */
const REFRESH_MS = 30_000;

/** What is being compared: which snapshot, against what, and a number that makes the drawer start afresh. */
interface Comparison {
  readonly nonce: number;
  readonly from: string | undefined;
  readonly against: string;
}

/**
 * The snapshots of the connected panel, newest first: the list, the details of one, a comparison with the panel now or
 * with another snapshot, a download as JSON and the deletion of a snapshot.
 */
export function SnapshotsPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['snapshots', 'common', 'panel']);
  const queryClient = useQueryClient();
  const formatTime = useTimeFirst();
  const number = useNumber();
  const bytes = useBytes();
  const nameOf = useSnapshotName();
  const incompleteText = useIncompleteText();
  const step = useStepUp();
  const tableState = useMrtTableState('panel-snapshots-v1');
  usePreventTableBackScroll();
  const canWrite = permissions.includes('panel:write');

  const [taking, setTaking] = useState(false);
  const [viewed, setViewed] = useState<PanelSnapshotSummary | undefined>(undefined);
  const [comparison, setComparison] = useState<Comparison | undefined>(undefined);
  const [comparing, setComparing] = useState(false);

  const connection = useQuery({
    queryKey: panelKey('connection'),
    queryFn: getPanelConnection,
    retry: false,
  });
  const connected = connection.data !== undefined && connection.data.state !== 'unconfigured';

  const { pagination } = tableState.state;
  const list = useQuery({
    queryKey: panelKey(
      'snapshots',
      'list',
      String(pagination.pageIndex),
      String(pagination.pageSize),
    ),
    queryFn: () =>
      listPanelSnapshots({
        limit: pagination.pageSize,
        offset: pagination.pageIndex * pagination.pageSize,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  // A page that is no longer there (a saved page number, or snapshots that were removed) goes to the last that is.
  const total = list.data?.total;
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

  const remove = useMutation({
    mutationFn: (snapshot: PanelSnapshotSummary) =>
      step.run(() => deletePanelSnapshot(snapshot.id)),
    onSuccess: () => {
      notifySuccess(t('snapshots:deleteConfirm.done'));
      return queryClient.invalidateQueries({ queryKey: panelKey('snapshots') });
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('snapshots:deleteConfirm.failed'),
        error,
        t('panel:signInAgain'),
        t('snapshots:noWrite'),
      );
    },
  });

  const snapshots = useMemo(() => list.data?.snapshots ?? [], [list.data]);
  const settings = list.data?.settings;

  const compare = (from: string | undefined, against: string) => {
    setComparison((previous) => ({ nonce: (previous?.nonce ?? 0) + 1, from, against }));
    setComparing(true);
  };
  const askDelete = (snapshot: PanelSnapshotSummary) => {
    confirmAction({
      title: t('snapshots:deleteConfirm.title'),
      message: (
        <Text size="sm">{t('snapshots:deleteConfirm.message', { name: nameOf(snapshot) })}</Text>
      ),
      confirmLabel: t('snapshots:deleteConfirm.confirm'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        remove.mutate(snapshot);
      },
    });
  };

  const columns = useMemo<MRT_ColumnDef<PanelSnapshotSummary>[]>(
    () => [
      {
        id: 'createdAt',
        header: t('snapshots:columns.taken'),
        accessorFn: (snapshot) => formatTime(snapshot.createdAt),
        minSize: 220,
        enableColumnFilter: false,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
      {
        id: 'name',
        header: t('snapshots:columns.name'),
        accessorFn: (snapshot) => snapshot.label ?? '',
        size: 200,
        enableColumnFilter: false,
        Cell: ({ row }) => (
          <div>
            <Text fz="sm" truncate="end">
              {row.original.label ?? t('snapshots:unnamed')}
            </Text>
            <Text c="dimmed" fz="xs" truncate="end">
              {row.original.createdBy === null
                ? t('snapshots:byJob')
                : t('snapshots:by', { name: row.original.createdBy.name })}
            </Text>
          </div>
        ),
      },
      {
        id: 'source',
        header: t('snapshots:columns.source'),
        accessorFn: (snapshot) => t(`snapshots:source.${snapshot.kind}`),
        size: 170,
        enableColumnFilter: false,
        Cell: ({ row }) => <SourceBadge kind={row.original.kind} />,
      },
      {
        id: 'version',
        header: t('snapshots:columns.version'),
        accessorFn: (snapshot) => snapshot.panelVersion ?? '–',
        size: 130,
        enableColumnFilter: false,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
      {
        id: 'objects',
        header: t('snapshots:columns.objects'),
        accessorFn: (snapshot) => snapshot.objectCount,
        size: 110,
        enableColumnFilter: false,
        Cell: ({ row }) => {
          const incomplete = incompleteText(row.original);
          return (
            <Group gap={6} wrap="nowrap">
              <Text ff="monospace" fz="sm">
                {number(row.original.objectCount)}
              </Text>
              {incomplete === null ? null : <IncompleteMark text={incomplete} />}
            </Group>
          );
        },
      },
      {
        id: 'since',
        header: t('snapshots:columns.since'),
        accessorFn: (snapshot) => snapshot.changesSince ?? -1,
        size: 130,
        enableColumnFilter: false,
        Cell: ({ row }) => <ChangesSince snapshot={row.original} />,
      },
      {
        id: 'size',
        header: t('snapshots:columns.size'),
        accessorFn: (snapshot) => bytes(snapshot.sizeBytes),
        size: 100,
        enableColumnFilter: false,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
    ],
    [t, formatTime, number, bytes, incompleteText],
  );

  const localization = useTableLocalization(t('snapshots:list.empty'));
  const table = useMantineReactTable<PanelSnapshotSummary>({
    ...panelTableOptions<PanelSnapshotSummary>(),
    columns,
    data: snapshots,
    localization,
    ...tableState.handlers,
    enableColumnFilters: false,
    enableSorting: false,
    manualPagination: true,
    rowCount: list.data?.total ?? 0,
    ...(list.isError
      ? {
          mantineToolbarAlertBannerProps: {
            color: 'red',
            children: describeError(
              t,
              list.error,
              t('panel:signInAgain'),
              t('panel:readForbidden'),
            ),
          },
        }
      : {}),
    state: {
      ...tableState.state,
      isLoading: list.isPending,
      showAlertBanner: list.isError,
      showProgressBars: list.isFetching,
    },
    getRowId: (snapshot) => snapshot.id,
    enableRowActions: true,
    displayColumnDefOptions: { 'mrt-row-actions': { size: 170 } },
    renderRowActions: ({ row }) => {
      const snapshot = row.original;
      const name = nameOf(snapshot);
      return (
        <ActionIcon.Group>
          <Tooltip label={t('snapshots:actions.view')} withArrow>
            <ActionIcon
              aria-label={t('snapshots:actions.viewAria', { name })}
              color="gray"
              onClick={() => {
                setViewed(snapshot);
              }}
              size="input-sm"
              variant="soft"
            >
              <IconListDetails size="1.5rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={connected ? t('snapshots:actions.compareLive') : t('snapshots:actions.noPanel')}
            withArrow
          >
            <ActionIcon
              aria-label={t('snapshots:actions.compareLiveAria', { name })}
              color="cyan"
              disabled={!connected}
              onClick={() => {
                compare(snapshot.id, 'live');
              }}
              size="input-sm"
              variant="soft"
            >
              <IconGitCompare size="1.5rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('snapshots:actions.export')} withArrow>
            <ActionIcon
              aria-label={t('snapshots:actions.exportAria', { name })}
              color="gray"
              component="a"
              download
              href={panelSnapshotExportPath(snapshot.id)}
              size="input-sm"
              variant="soft"
            >
              <IconDownload size="1.5rem" />
            </ActionIcon>
          </Tooltip>
          {canWrite ? (
            <Tooltip label={t('snapshots:actions.delete')} withArrow>
              <ActionIcon
                aria-label={t('snapshots:actions.deleteAria', { name })}
                color="red"
                loading={remove.isPending && remove.variables.id === snapshot.id}
                onClick={() => {
                  askDelete(snapshot);
                }}
                size="input-sm"
                variant="soft"
              >
                <IconTrash size="1.5rem" />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </ActionIcon.Group>
      );
    },
  });

  const schedule = settings
    ? [
        settings.scheduling
          ? t('snapshots:list.scheduleOn', {
              interval: `${String(settings.intervalHours)} ${t('snapshots:hoursShort')}`,
            })
          : t('snapshots:list.scheduleOff'),
        t('snapshots:list.retention', { count: settings.keep, days: settings.keepDailyDays }),
        connected || connection.isPending ? '' : t('snapshots:list.noPanelNote'),
      ]
        .filter(Boolean)
        .join(' ')
    : undefined;

  const empty = list.data?.total === 0 && !connected && !connection.isPending;

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              color="gray"
              disabled={(list.data?.total ?? 0) === 0}
              icon={IconGitCompare}
              label={
                (list.data?.total ?? 0) === 0
                  ? t('snapshots:actions.compareNeedsSnapshot')
                  : t('snapshots:actions.compare')
              }
              onClick={() => {
                compare(snapshots[0]?.id, connected ? 'live' : (snapshots[1]?.id ?? 'live'));
              }}
            />
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={list.isFetching}
              onClick={() => void list.refetch()}
            />
            {canWrite ? (
              <HeaderAction
                color="teal"
                disabled={!connected}
                icon={IconCamera}
                label={connected ? t('snapshots:take.button') : t('snapshots:actions.noPanel')}
                onClick={() => {
                  setTaking(true);
                }}
              />
            ) : null}
          </HeaderActions>
        }
        description={t('snapshots:description')}
        icon={<TbCamera size={24} />}
        title={t('snapshots:title')}
      />

      {empty ? (
        <PanelNotConnected />
      ) : (
        <DataTableCard.Container>
          <DataTableCard.Title
            actions={
              <HeaderActionGroup>
                <HeaderAction
                  color="gray"
                  grouped
                  icon={IconRestore}
                  label={t('common:resetTable')}
                  onClick={() => {
                    tableState.reset();
                  }}
                />
              </HeaderActionGroup>
            }
            {...(schedule === undefined ? {} : { description: schedule })}
            icon={<TbCamera size={24} />}
            title={t('snapshots:list.title')}
          />
          <DataTableCard.Content>
            <MantineReactTable table={table} />
          </DataTableCard.Content>
        </DataTableCard.Container>
      )}

      <SnapshotDrawer
        canCompareLive={connected}
        onClose={() => {
          setViewed(undefined);
        }}
        onCompareLive={(snapshot) => {
          setViewed(undefined);
          compare(snapshot.id, 'live');
        }}
        onCompareOther={(snapshot) => {
          setViewed(undefined);
          const other = snapshots.find((candidate) => candidate.id !== snapshot.id);
          compare(snapshot.id, other?.id ?? 'live');
        }}
        snapshot={viewed}
      />
      <CompareDrawer
        canCompareLive={connected}
        initialAgainst={comparison?.against ?? 'live'}
        initialFrom={comparison?.from}
        key={comparison?.nonce ?? 0}
        onClose={() => {
          setComparing(false);
        }}
        opened={comparing}
      />
      {canWrite ? (
        <TakeSnapshotDialog
          onClose={() => {
            setTaking(false);
          }}
          opened={taking}
        />
      ) : null}
    </>
  );
}
