// New in Swellwright (ADR 0044). The reads of the Checks page. They are like the reads of the panel pages (`usePanelRead`),
// with one difference: they do not read again by themselves. A run of the checks is work for the server (the linter over
// everything, DNS for the reconciliation), so it happens when the page opens and when the person presses refresh.
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { notifyFailure } from '../security/notify-failure.js';
import { runConventionChecks, runReconciliation } from './checks-api.js';

export const checksKey = (...rest: readonly string[]): readonly string[] => [
  'panel',
  'checks',
  ...rest,
];

export interface ChecksRead<T> {
  query: UseQueryResult<T>;
  /** Asks the panel again (`?refresh=true`) instead of the memory of the server; the server limits how often. */
  refresh: () => Promise<void>;
  refreshing: boolean;
}

function useChecksRead<T>(
  key: readonly string[],
  read: (refresh: boolean) => Promise<T>,
  enabled: boolean,
): ChecksRead<T> {
  const { t } = useTranslation(['panel', 'errors', 'common']);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const query = useQuery({
    queryKey: key,
    queryFn: () => read(false),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    enabled,
  });
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await read(true);
      queryClient.setQueryData(key, fresh);
      // What the last run found changed with it (the overview shows it).
      void queryClient.invalidateQueries({ queryKey: checksKey('last') });
    } catch (error) {
      notifyFailure(
        t,
        t('panel:refreshFailed'),
        error,
        t('panel:signInAgain'),
        t('panel:readForbidden'),
      );
    } finally {
      setRefreshing(false);
    }
  };
  return { query, refresh, refreshing };
}

export const useConventionRun = (enabled = true) =>
  useChecksRead(checksKey('convention'), runConventionChecks, enabled);

export const useReconciliation = (enabled = true) =>
  useChecksRead(checksKey('reconciliation'), runReconciliation, enabled);
