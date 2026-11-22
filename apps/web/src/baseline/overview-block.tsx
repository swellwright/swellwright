// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/home/components/home.page.tsx (a titled
// `MetricSection` with metric cards). Changes: the numbers come from this server's own records of the baseline checks.
import { Box } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  PiCheckCircleDuotone,
  PiWarningCircleDuotone,
  PiWarningOctagonDuotone,
} from 'react-icons/pi';
import { useNavigate } from 'react-router';

import { MetricCard, MetricSection } from '@swellwright/ui';

import { getBaselineFleet } from '../api.js';
import { ROUTES } from '../routes.js';

/** Shown to people who may read servers; nothing at all while there is nothing to say. */
export function BaselineOverviewBlock({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation(['baseline']);
  const navigate = useNavigate();
  const fleet = useQuery({
    queryKey: ['baseline', 'fleet'],
    queryFn: getBaselineFleet,
    enabled,
    retry: false,
    refetchInterval: 60_000,
  });
  const totals = fleet.data?.totals;
  if (!enabled || totals === undefined || totals.assigned === 0) {
    return null;
  }
  const problems = totals.failing > 0 || totals.warning > 0;
  return (
    <MetricSection cols={{ base: 1, sm: 2, xl: 3 }} title={t('baseline:overview.title')}>
      <Box
        onClick={() => {
          void navigate(ROUTES.DASHBOARD.FLEET.BASELINE);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            void navigate(ROUTES.DASHBOARD.FLEET.BASELINE);
          }
        }}
        role="link"
        style={{ cursor: 'pointer' }}
        tabIndex={0}
      >
        <MetricCard
          icon={
            totals.failing > 0
              ? PiWarningOctagonDuotone
              : problems
                ? PiWarningCircleDuotone
                : PiCheckCircleDuotone
          }
          iconColor={totals.failing > 0 ? 'red' : problems ? 'orange' : 'teal'}
          subtitle={
            totals.unreachable > 0
              ? t('baseline:overview.unreachable', { count: totals.unreachable })
              : totals.checked === 0
                ? t('baseline:overview.none')
                : problems
                  ? t('baseline:overview.problems', {
                      failing: totals.failing,
                      warning: totals.warning,
                    })
                  : t('baseline:overview.allGood')
          }
          title={t('baseline:overview.card')}
          value={`${String(totals.checked)}/${String(totals.assigned)}`}
        />
      </Box>
    </MetricSection>
  );
}
