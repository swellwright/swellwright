// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/home/components/home.page.tsx and
// src/widgets/dashboard/recap/* (titled sections of metric cards: a level 4 heading with icon actions, a grid of cards with the
// panel's breakpoints, cards that fade in one after another). Changes: the sections show the connected panel (as this server
// reads it), the last checks and snapshots (as this server remembers them) and the state of the API itself; each section
// reads its own endpoints, so one that fails shows its own error and the page stays; a section whose source the role may not
// read or that is not set up is not drawn.
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconDatabaseOff, IconPlugConnectedX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  PiCalendarCheckDuotone,
  PiCameraDuotone,
  PiCloudDuotone,
  PiDatabaseDuotone,
  PiGitDiffDuotone,
  PiHeartbeatDuotone,
  PiListChecksDuotone,
  PiPlugsConnectedDuotone,
  PiPulse,
  PiScalesDuotone,
  PiShieldCheckDuotone,
  PiTagDuotone,
  PiUsersDuotone,
  PiWarningCircle,
} from 'react-icons/pi';
import { TbApi, TbBraces, TbPlugConnected, TbRefresh } from 'react-icons/tb';
import { Link } from 'react-router';

import type { PanelConnectionView } from '@swellwright/contracts';
import {
  EmptyPageLayout,
  ErrorMessageBlock,
  MetricCard,
  MetricSection,
  MetricSectionAction,
  OverlayHeader,
  SectionCard,
} from '@swellwright/ui';

import {
  ApiUnreachableError,
  getPanelConnection,
  getPanelOverview,
  listPanelSnapshots,
  loadSystemStatus,
} from '../api.js';
import { getLastConventionRun, getLastReconciliation } from '../checks/checks-api.js';
import { checksKey } from '../checks/checks-data.js';
import { useFullDate, useNumber } from '../format.js';
import { PanelReadFailure, panelKey, usePanelRead } from '../panel/panel-data.js';
import { useRelativeTime } from '../panel/snapshot-parts.js';
import { ROUTES } from '../routes.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useConsole } from '../shell/console-context.js';
import { DASHBOARD_REFRESH_MS } from './attention-card.js';
import { sub } from './props.js';

const count = (value: number | null, format: (value: number) => string): string =>
  value === null ? '–' : format(value);

/** Four placeholders for a section that is still loading. */
function Loading({ title }: { title: string }) {
  return (
    <>
      {[0, 1, 2, 3].map((index) => (
        <MetricCard icon={PiPlugsConnectedDuotone} isLoading key={index} title={title} value={0} />
      ))}
    </>
  );
}

/** The connection to the panel, read quietly: the sections that depend on it hide themselves when there is none. */
function usePanelConnection() {
  const { session } = useConsole();
  const canRead = session.permissions.includes('panel:read');
  const connection = useQuery({
    queryKey: panelKey('connection'),
    queryFn: getPanelConnection,
    retry: false,
    enabled: canRead,
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const view: PanelConnectionView | undefined = connection.data;
  return {
    canRead,
    connection,
    connected: view !== undefined && view.state !== 'unconfigured',
  };
}

// ---- Panel ------------------------------------------------------------------------------------------------------------

/** The panel's block: the connected panel in numbers, or a way to connect one. */
export function PanelSection() {
  const { t } = useTranslation(['overview', 'common']);
  const { session } = useConsole();
  const canConnect = session.permissions.includes('panel:write');
  const { canRead, connection, connected } = usePanelConnection();
  const number = useNumber();
  const formatDate = useFullDate();
  const overview = usePanelRead(panelKey('overview'), getPanelOverview, connected);

  if (!canRead || connection.isPending || connection.isError) {
    // The connection is read quietly: the page has its own failures to show, and this block is not worth another.
    return null;
  }

  if (!connected) {
    return (
      <SectionCard.Root>
        <SectionCard.Section>
          <Group gap="md" justify="space-between" wrap="wrap">
            <Stack gap="xs">
              <OverlayHeader
                icon={IconPlugConnectedX}
                iconColor="gray"
                title={t('overview:panel.notConnectedTitle')}
                titleOrder={5}
              />
              <Text c="dimmed" size="sm">
                {canConnect
                  ? t('overview:panel.notConnectedText')
                  : t('overview:panel.notConnectedTextNoRight')}
              </Text>
            </Stack>
            {canConnect ? (
              <Button
                color="teal"
                component={Link}
                leftSection={<TbPlugConnected size={18} />}
                size="md"
                to={ROUTES.DASHBOARD.PANEL.CONNECTION}
                variant="soft"
              >
                {t('overview:panel.connect')}
              </Button>
            ) : null}
          </Group>
        </SectionCard.Section>
      </SectionCard.Root>
    );
  }

  if (overview.query.isError) {
    return (
      <PanelReadFailure
        error={overview.query.error}
        onRetry={() => {
          void overview.query.refetch();
        }}
      />
    );
  }

  const data = overview.query.data;
  const { nodes, users, token, system } = data ?? {
    nodes: null,
    users: null,
    token: null,
    system: null,
  };
  const version = system?.version ?? data?.connection.panelVersion;
  const supported = data?.connection.versionSupport ?? null;
  const trouble = nodes === null ? null : nodes.offline + nodes.connecting;
  const daysLeft = token?.daysLeft ?? null;
  const onlineNow = users?.onlineNow ?? null;
  const tokenColor =
    daysLeft === null ? 'gray' : daysLeft < 0 ? 'red' : token?.expiryWarning ? 'orange' : 'teal';

  return (
    <MetricSection
      actions={
        <MetricSectionAction
          label={t('common:refresh')}
          loading={overview.refreshing || overview.query.isFetching}
          onClick={() => void overview.refresh()}
        >
          <TbRefresh size={24} />
        </MetricSectionAction>
      }
      cols={{ base: 1, sm: 2, xl: 4 }}
      title={t('overview:sections.panel')}
    >
      {data === undefined ? (
        <Loading title={t('overview:panel.version')} />
      ) : (
        [
          <MetricCard
            key="version"
            icon={PiTagDuotone}
            iconColor={supported?.status === 'unsupported' ? 'red' : 'cyan'}
            {...sub(
              supported === null
                ? undefined
                : supported.status === 'supported'
                  ? t('overview:panel.supported', { range: supported.range })
                  : t('overview:panel.unsupported'),
            )}
            title={t('overview:panel.version')}
            value={version ?? '–'}
          />,
          <MetricCard
            key="nodesOnline"
            icon={PiPulse}
            iconColor="teal"
            {...sub(
              data.counts.nodes === null
                ? undefined
                : t('overview:panel.ofTotal', { total: data.counts.nodes }),
            )}
            title={t('overview:panel.nodesOnline')}
            value={nodes === null ? '–' : number(nodes.online)}
          />,
          <MetricCard
            key="nodesTrouble"
            icon={PiWarningCircle}
            iconColor={trouble !== null && trouble > 0 ? 'red' : 'gray'}
            title={t('overview:panel.nodesTrouble')}
            value={count(trouble, number)}
          />,
          <MetricCard
            key="health"
            icon={PiHeartbeatDuotone}
            iconColor={system?.health === 'ok' ? 'teal' : 'gray'}
            {...sub(
              system?.health === 'ok'
                ? t('overview:panel.instances', { count: system.instances })
                : undefined,
            )}
            title={t('overview:panel.health')}
            value={
              system === null
                ? '–'
                : system.health === 'ok'
                  ? t('overview:panel.healthOk')
                  : t('overview:panel.healthUnknown')
            }
          />,
          <MetricCard
            key="hosts"
            icon={PiListChecksDuotone}
            iconColor="blue"
            title={t('overview:panel.hosts')}
            value={count(data.counts.hosts, number)}
          />,
          <MetricCard
            key="profiles"
            icon={TbBraces}
            iconColor="violet"
            title={t('overview:panel.profiles')}
            value={count(data.counts.configProfiles, number)}
          />,
          <MetricCard
            key="users"
            icon={PiUsersDuotone}
            iconColor="cyan"
            {...sub(
              onlineNow === null
                ? undefined
                : t('overview:panel.usersOnline', { count: onlineNow }),
            )}
            title={t('overview:panel.users')}
            value={users === null ? '–' : number(users.total)}
          />,
          <MetricCard
            key="token"
            icon={PiCalendarCheckDuotone}
            iconColor={tokenColor}
            subtitle={
              token?.expiresAt == null
                ? t('overview:panel.tokenNoExpiry')
                : formatDate(token.expiresAt)
            }
            title={t('overview:panel.token')}
            value={
              daysLeft === null
                ? '–'
                : daysLeft < 0
                  ? t('overview:panel.tokenExpired')
                  : t('overview:panel.tokenDays', { count: daysLeft })
            }
          />,
        ]
      )}
    </MetricSection>
  );
}

// ---- Checks -----------------------------------------------------------------------------------------------------------

/** What the last convention run and the last reconciliation found, as this server remembers it (neither is run here). */
export function ChecksSection() {
  const { t } = useTranslation(['overview', 'checks', 'dashboard']);
  const number = useNumber();
  const { canRead, connected } = usePanelConnection();
  const conventions = useQuery({
    queryKey: checksKey('last'),
    queryFn: getLastConventionRun,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: DASHBOARD_REFRESH_MS,
    enabled: connected && canRead,
  });
  const reconciliation = useQuery({
    queryKey: checksKey('reconciliation', 'last'),
    queryFn: getLastReconciliation,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: DASHBOARD_REFRESH_MS,
    enabled: connected && canRead,
  });
  if (!canRead || !connected) {
    return null;
  }
  const summary = conventions.data?.summary ?? null;
  const counts = reconciliation.data?.counts ?? null;
  const differences = counts === null ? 0 : counts.drift + counts.missing + counts.extra;

  return (
    <MetricSection cols={{ base: 1, sm: 2, xl: 4 }} title={t('overview:sections.checks')}>
      <Link
        key="conventions"
        style={{ color: 'inherit', textDecoration: 'none' }}
        to={ROUTES.DASHBOARD.PANEL.CHECKS}
      >
        <MetricCard
          icon={PiShieldCheckDuotone}
          iconColor={
            summary === null
              ? 'gray'
              : summary.error > 0
                ? 'red'
                : summary.warning > 0
                  ? 'orange'
                  : 'teal'
          }
          isLoading={conventions.isPending}
          subtitle={
            summary === null
              ? t('checks:ui.overview.notYetHint')
              : summary.error + summary.warning === 0
                ? t('checks:ui.overview.clean')
                : t('checks:ui.overview.value', {
                    errors: summary.error,
                    warnings: summary.warning,
                  })
          }
          title={t('checks:ui.overview.title')}
          value={
            summary === null
              ? t('checks:ui.overview.notYet')
              : `${number(summary.error)} / ${number(summary.warning)}`
          }
        />
      </Link>
      <Link
        key="reconciliation"
        style={{ color: 'inherit', textDecoration: 'none' }}
        to={ROUTES.DASHBOARD.PANEL.CHECKS}
      >
        <MetricCard
          icon={PiScalesDuotone}
          iconColor={counts === null ? 'gray' : differences > 0 ? 'orange' : 'teal'}
          isLoading={reconciliation.isPending}
          subtitle={
            counts === null
              ? t('overview:reconciliation.notYetHint')
              : differences === 0
                ? t('overview:reconciliation.clean')
                : t('overview:reconciliation.breakdown', counts)
          }
          title={t('overview:reconciliation.title')}
          value={counts === null ? t('overview:reconciliation.notYet') : number(differences)}
        />
      </Link>
    </MetricSection>
  );
}

// ---- Snapshots --------------------------------------------------------------------------------------------------------

/** The last snapshot of the panel and what changed since, as the server last found it (it never asks the panel here). */
export function SnapshotsSection() {
  const { t } = useTranslation(['overview']);
  const number = useNumber();
  const relative = useRelativeTime();
  const formatDate = useFullDate();
  const { canRead, connected } = usePanelConnection();
  const latest = useQuery({
    queryKey: panelKey('snapshots', 'latest'),
    queryFn: () => listPanelSnapshots({ limit: 1 }),
    enabled: connected && canRead,
    retry: false,
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  if (!canRead || !connected) {
    return null;
  }
  const snapshot = latest.data === undefined ? undefined : (latest.data.snapshots[0] ?? null);
  const changes = snapshot?.changesSince ?? null;

  return (
    <MetricSection cols={{ base: 1, sm: 2, xl: 4 }} title={t('overview:sections.snapshots')}>
      <Link
        key="snapshot"
        style={{ color: 'inherit', textDecoration: 'none' }}
        to={ROUTES.DASHBOARD.PANEL.SNAPSHOTS}
      >
        <MetricCard
          icon={PiCameraDuotone}
          iconColor={snapshot === null || snapshot === undefined ? 'gray' : 'cyan'}
          isLoading={latest.isPending}
          {...sub(
            snapshot === null
              ? t('overview:panel.snapshotNoneHint')
              : snapshot === undefined
                ? undefined
                : formatDate(snapshot.createdAt),
          )}
          title={t('overview:panel.snapshot')}
          value={
            snapshot === null || snapshot === undefined
              ? t('overview:panel.snapshotNone')
              : relative(snapshot.createdAt)
          }
        />
      </Link>
      <Link
        key="changes"
        style={{ color: 'inherit', textDecoration: 'none' }}
        to={ROUTES.DASHBOARD.PANEL.SNAPSHOTS}
      >
        <MetricCard
          icon={PiGitDiffDuotone}
          iconColor={changes === null ? 'gray' : changes > 0 ? 'orange' : 'teal'}
          isLoading={latest.isPending}
          {...sub(
            snapshot === null || snapshot === undefined
              ? undefined
              : changes === null
                ? t('overview:panel.snapshotUnknown')
                : changes === 0
                  ? t('overview:panel.snapshotSame')
                  : t('overview:panel.snapshotChanges', { count: changes }),
          )}
          title={t('overview:snapshots.changes')}
          value={
            changes === null
              ? t('overview:snapshots.changesUnknown')
              : changes === 0
                ? t('overview:snapshots.changesNone')
                : number(changes)
          }
        />
      </Link>
    </MetricSection>
  );
}

// ---- System -----------------------------------------------------------------------------------------------------------

/** The API itself and what it depends on (the readiness probe), as the Overview always had it. */
export function SystemSection() {
  const { t } = useTranslation(['overview', 'common']);
  const status = useQuery({
    queryKey: ['system', 'status'],
    queryFn: loadSystemStatus,
    refetchInterval: DASHBOARD_REFRESH_MS,
    retry: false,
  });

  if (status.isError && status.data === undefined) {
    const unreachable = status.error instanceof ApiUnreachableError;
    return (
      <QueryErrorCard
        message={
          unreachable ? t('overview:error.unreachableText') : t('overview:error.unexpectedText')
        }
        onRetry={() => void status.refetch()}
        title={
          unreachable ? t('overview:error.unreachableTitle') : t('overview:error.unexpectedTitle')
        }
      />
    );
  }
  const data = status.data;
  const checks = data === undefined ? [] : Object.entries(data.ready.checks);
  const up = checks.filter(([, check]) => check.status === 'up').length;

  return (
    <Stack gap="sm">
      <MetricSection
        actions={
          <MetricSectionAction
            href="/api/v1/openapi.json"
            label={t('overview:checks.apiDescription')}
          >
            <TbApi size={24} />
          </MetricSectionAction>
        }
        cols={{ base: 1, sm: 2, xl: 3 }}
        title={t('overview:sections.system')}
      >
        <MetricCard
          icon={PiCloudDuotone}
          iconColor="teal"
          isLoading={data === undefined}
          title={t('overview:stats.api')}
          value={t('overview:stats.alive')}
        />
        <MetricCard
          icon={PiPlugsConnectedDuotone}
          iconColor={data?.ready.status === 'ready' ? 'teal' : data === undefined ? 'gray' : 'red'}
          isLoading={data === undefined}
          {...(checks.length === 0
            ? {}
            : { subtitle: t('overview:stats.dependenciesSummary', { up, total: checks.length }) })}
          title={t('overview:stats.dependencies')}
          value={
            data?.ready.status === 'ready'
              ? t('overview:stats.ready')
              : t('overview:stats.notReady')
          }
        />
        <MetricCard
          icon={PiTagDuotone}
          iconColor="cyan"
          isLoading={data === undefined}
          {...(data?.version.commit ? { subtitle: data.version.commit.slice(0, 7) } : {})}
          title={t('overview:stats.version')}
          value={data?.version.version ?? '–'}
        />
      </MetricSection>

      {data === undefined ? null : checks.length === 0 ? (
        <EmptyPageLayout
          description={t('overview:checks.none')}
          icon={<IconDatabaseOff size="3rem" />}
          title={t('overview:checks.noneTitle')}
        />
      ) : (
        <MetricSection title={t('overview:checks.title')}>
          {checks.map(([name, check]) => (
            <MetricCard
              icon={PiDatabaseDuotone}
              iconColor={check.status === 'up' ? 'teal' : 'red'}
              key={name}
              subtitle={t('overview:checks.latencyValue', { ms: check.latencyMs })}
              title={name}
              value={check.status === 'up' ? t('overview:checks.up') : t('overview:checks.down')}
            />
          ))}
        </MetricSection>
      )}

      {checks.map(([name, check]) =>
        check.error ? (
          <ErrorMessageBlock
            copiedLabel={t('common:copied')}
            copyLabel={t('common:copy')}
            key={name}
            message={`${name}: ${check.error}`}
          />
        ) : null,
      )}
    </Stack>
  );
}
