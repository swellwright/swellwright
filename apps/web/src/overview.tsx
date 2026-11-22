// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/home/components/home.page.tsx.
// Changes: the sections and cards show the console's own state (the API, its dependencies), not the panel's load; when
// a Remnawave panel is connected, its block of metric cards comes first (`panel/overview-block.tsx`).
import { Stack } from '@mantine/core';
import { IconDatabaseOff } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  PiCloudDuotone,
  PiDatabaseDuotone,
  PiPlugsConnectedDuotone,
  PiTagDuotone,
} from 'react-icons/pi';
import { TbApi, TbRefresh } from 'react-icons/tb';

import {
  EmptyPageLayout,
  ErrorMessageBlock,
  LoadingScreen,
  MetricCard,
  MetricSection,
  MetricSectionAction,
} from '@swellwright/ui';

import { ApiUnreachableError, loadSystemStatus } from './api.js';
import { BaselineOverviewBlock } from './baseline/overview-block.js';
import { PanelOverviewBlock } from './panel/overview-block.js';
import { QueryErrorCard } from './security/query-error.js';
import { useConsole } from './shell/console-context.js';

/**
 * The Overview, laid out like the panel's Home page: no header card, but titled sections (a level 4 heading, then a
 * grid of metric cards with the panel's breakpoints), one under the other with a gap of `sm`. The panel's Home shows
 * the load of its processes, traffic and users; this console has the state of its API and what it depends on.
 */
export function Overview() {
  const { t } = useTranslation(['overview', 'common']);
  const { session } = useConsole();
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['system', 'status'],
    queryFn: loadSystemStatus,
    refetchInterval: 10_000,
  });

  if (isPending) {
    // The panel's Home shows its loading bar until it has everything it draws.
    return <LoadingScreen />;
  }

  if (error) {
    const unreachable = error instanceof ApiUnreachableError;
    return (
      <QueryErrorCard
        message={unreachable ? t('error.unreachableText') : t('error.unexpectedText')}
        onRetry={() => void refetch()}
        title={unreachable ? t('error.unreachableTitle') : t('error.unexpectedTitle')}
      />
    );
  }

  const { ready, version } = data;
  const checks = Object.entries(ready.checks);
  const up = checks.filter(([, check]) => check.status === 'up').length;

  return (
    <Stack gap="sm">
      <PanelOverviewBlock />
      <BaselineOverviewBlock enabled={session.permissions.includes('servers:read')} />

      <MetricSection
        actions={
          <>
            <MetricSectionAction href="/api/v1/openapi.json" label={t('checks.apiDescription')}>
              <TbApi size={24} />
            </MetricSectionAction>
            <MetricSectionAction
              label={t('common:refresh')}
              loading={isFetching}
              onClick={() => void refetch()}
            >
              <TbRefresh size={24} />
            </MetricSectionAction>
          </>
        }
        cols={{ base: 1, sm: 2, xl: 3 }}
        title={t('sections.status')}
      >
        <MetricCard
          icon={PiCloudDuotone}
          iconColor="teal"
          title={t('stats.api')}
          value={t('stats.alive')}
        />
        <MetricCard
          icon={PiPlugsConnectedDuotone}
          iconColor={ready.status === 'ready' ? 'teal' : 'red'}
          title={t('stats.dependencies')}
          value={ready.status === 'ready' ? t('stats.ready') : t('stats.notReady')}
          {...(checks.length === 0
            ? {}
            : { subtitle: t('stats.dependenciesSummary', { up, total: checks.length }) })}
        />
        <MetricCard
          icon={PiTagDuotone}
          iconColor="cyan"
          title={t('stats.version')}
          value={version.version}
          {...(version.commit ? { subtitle: version.commit.slice(0, 7) } : {})}
        />
      </MetricSection>

      {checks.length === 0 ? (
        <EmptyPageLayout
          description={t('checks.none')}
          icon={<IconDatabaseOff size="3rem" />}
          title={t('checks.noneTitle')}
        />
      ) : (
        <MetricSection title={t('checks.title')}>
          {checks.map(([name, check]) => (
            <MetricCard
              icon={PiDatabaseDuotone}
              iconColor={check.status === 'up' ? 'teal' : 'red'}
              key={name}
              subtitle={t('checks.latencyValue', { ms: check.latencyMs })}
              title={name}
              value={check.status === 'up' ? t('checks.up') : t('checks.down')}
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
