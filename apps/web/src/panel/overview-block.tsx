// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/home/components/home.page.tsx and
// src/widgets/dashboard/recap/*, the titled sections of metric cards of the Home page (a level 4 heading with icon
// actions, a grid of cards with the panel's breakpoints, cards that fade in one after another). Changes: the cards show the
// connected panel as the server reads it (its version, how many nodes are online, how many hosts and profiles it has, how
// many users, when the token expires); without a panel it is a small card that leads to the Connection page.
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconPlugConnectedX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiCalendarCheckDuotone,
  PiHeartbeatDuotone,
  PiListChecksDuotone,
  PiPlugsConnectedDuotone,
  PiPulse,
  PiTagDuotone,
  PiUsersDuotone,
  PiWarningCircle,
} from 'react-icons/pi';
import { TbBraces, TbCamera, TbPlugConnected, TbRefresh } from 'react-icons/tb';
import { Link } from 'react-router';

import type { PanelOverview, PanelSnapshotSummary } from '@swellwright/contracts';
import {
  MetricCard,
  MetricSection,
  MetricSectionAction,
  OverlayHeader,
  SectionCard,
} from '@swellwright/ui';

import { getPanelConnection, getPanelOverview, listPanelSnapshots } from '../api.js';
import { useFullDate, useNumber } from '../format.js';
import { ROUTES } from '../routes.js';
import { useConsole } from '../shell/console-context.js';
import { PanelReadFailure, panelKey, usePanelRead } from './panel-data.js';
import { useRelativeTime } from './snapshot-parts.js';

const count = (value: number | null, format: (value: number) => string): string =>
  value === null ? '–' : format(value);

/** The `subtitle` prop of a card, or nothing: a card without a line under its value has no such prop. */
const sub = (text: string | undefined): { subtitle?: string } =>
  text === undefined ? {} : { subtitle: text };

/** The cards of the block, as a list: `MetricSection` gives each its place in the grid and its entrance. */
function useOverviewCards(
  overview: PanelOverview | undefined,
  /** The newest snapshot: a snapshot, null when there is none yet, undefined while it is not known. */
  snapshot: PanelSnapshotSummary | null | undefined,
): ReactNode[] {
  const { t } = useTranslation('overview');
  const number = useNumber();
  const formatDate = useFullDate();
  const relative = useRelativeTime();
  if (overview === undefined) {
    return [];
  }
  const { nodes, users, token, system, connection } = overview;
  const version = system?.version ?? connection.panelVersion;
  const supported = connection.versionSupport;
  const trouble = nodes === null ? null : nodes.offline + nodes.connecting;
  const daysLeft = token?.daysLeft ?? null;
  const expiresAt = token?.expiresAt ?? null;
  const onlineNow = users?.onlineNow ?? null;
  const tokenColor =
    daysLeft === null ? 'gray' : daysLeft < 0 ? 'red' : token?.expiryWarning ? 'orange' : 'teal';

  return [
    <MetricCard
      key="version"
      icon={PiTagDuotone}
      iconColor={supported?.status === 'unsupported' ? 'red' : 'cyan'}
      {...sub(
        supported === null
          ? undefined
          : supported.status === 'supported'
            ? t('panel.supported', { range: supported.range })
            : t('panel.unsupported'),
      )}
      title={t('panel.version')}
      value={version ?? '–'}
    />,
    <MetricCard
      key="nodesOnline"
      icon={PiPulse}
      iconColor="teal"
      {...sub(
        overview.counts.nodes === null
          ? undefined
          : t('panel.ofTotal', { total: overview.counts.nodes }),
      )}
      title={t('panel.nodesOnline')}
      value={nodes === null ? '–' : number(nodes.online)}
    />,
    <MetricCard
      key="nodesTrouble"
      icon={PiWarningCircle}
      iconColor={trouble !== null && trouble > 0 ? 'red' : 'gray'}
      title={t('panel.nodesTrouble')}
      value={count(trouble, number)}
    />,
    <MetricCard
      key="health"
      icon={PiHeartbeatDuotone}
      iconColor={system?.health === 'ok' ? 'teal' : 'gray'}
      {...sub(
        system?.health === 'ok' ? t('panel.instances', { count: system.instances }) : undefined,
      )}
      title={t('panel.health')}
      value={
        system === null
          ? '–'
          : system.health === 'ok'
            ? t('panel.healthOk')
            : t('panel.healthUnknown')
      }
    />,
    <MetricCard
      key="hosts"
      icon={PiListChecksDuotone}
      iconColor="blue"
      title={t('panel.hosts')}
      value={count(overview.counts.hosts, number)}
    />,
    <MetricCard
      key="profiles"
      icon={TbBraces}
      iconColor="violet"
      title={t('panel.profiles')}
      value={count(overview.counts.configProfiles, number)}
    />,
    <MetricCard
      key="users"
      icon={PiUsersDuotone}
      iconColor="cyan"
      {...sub(onlineNow === null ? undefined : t('panel.usersOnline', { count: onlineNow }))}
      title={t('panel.users')}
      value={users === null ? '–' : number(users.total)}
    />,
    <MetricCard
      key="token"
      icon={PiCalendarCheckDuotone}
      iconColor={tokenColor}
      subtitle={expiresAt === null ? t('panel.tokenNoExpiry') : formatDate(expiresAt)}
      title={t('panel.token')}
      value={
        daysLeft === null
          ? '–'
          : daysLeft < 0
            ? t('panel.tokenExpired')
            : t('panel.tokenDays', { count: daysLeft })
      }
    />,
    // The last snapshot and what changed since, as the server last found it (the Overview never asks the panel for it).
    ...(snapshot === undefined
      ? []
      : [
          <MetricCard
            key="snapshot"
            icon={TbCamera}
            iconColor={
              snapshot === null
                ? 'gray'
                : snapshot.changesSince === null
                  ? 'cyan'
                  : snapshot.changesSince > 0
                    ? 'orange'
                    : 'teal'
            }
            subtitle={
              snapshot === null
                ? t('panel.snapshotNoneHint')
                : snapshot.changesSince === null
                  ? t('panel.snapshotUnknown')
                  : snapshot.changesSince === 0
                    ? t('panel.snapshotSame')
                    : t('panel.snapshotChanges', { count: snapshot.changesSince })
            }
            title={t('panel.snapshot')}
            value={snapshot === null ? t('panel.snapshotNone') : relative(snapshot.createdAt)}
          />,
        ]),
  ];
}

/** The panel's block on the Overview: the connected panel in numbers, or a way to connect one. */
export function PanelOverviewBlock() {
  const { t } = useTranslation(['overview', 'common']);
  const { session } = useConsole();
  const canRead = session.permissions.includes('panel:read');
  const canConnect = session.permissions.includes('panel:write');

  const connection = useQuery({
    queryKey: panelKey('connection'),
    queryFn: getPanelConnection,
    retry: false,
    enabled: canRead,
  });
  const connected = connection.data !== undefined && connection.data.state !== 'unconfigured';
  const overview = usePanelRead(panelKey('overview'), getPanelOverview, connected);
  // Read from this server's own records: it does not call the panel.
  const latest = useQuery({
    queryKey: panelKey('snapshots', 'latest'),
    queryFn: () => listPanelSnapshots({ limit: 1 }),
    enabled: connected && canRead,
    retry: false,
    refetchInterval: 60_000,
  });
  const cards = useOverviewCards(
    overview.query.data,
    latest.data === undefined ? undefined : (latest.data.snapshots[0] ?? null),
  );

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
      title={t('overview:panel.title')}
    >
      {overview.query.isPending ? (
        <MetricCard
          icon={PiPlugsConnectedDuotone}
          isLoading
          title={t('overview:panel.version')}
          value={0}
        />
      ) : (
        cards
      )}
    </MetricSection>
  );
}
