// New in Swellwright, encoding how the pages of the Remnawave panel frontend 3.4.11 (AGPL-3.0-only) read their data
// (src/pages/dashboard/*/connectors/*: a loading bar until the data is there, then the page, an empty layout when there
// is nothing). The console reads the panel through its own API (ADR 0041), so a page can also find that no panel is
// connected, or that the panel does not answer; both have a state of their own here.
import { Button } from '@mantine/core';
import { IconPlugConnectedX } from '@tabler/icons-react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TbPlugConnected } from 'react-icons/tb';
import { Link } from 'react-router';

import { EmptyPageLayout, LoadingScreen } from '@swellwright/ui';

import { ApiRequestError } from '../api.js';
import { describeError } from '../auth/messages.js';
import { ROUTES } from '../routes.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useConsole } from '../shell/console-context.js';

/** How often a page reads again by itself: the panel's own tables do it every minute, and the server remembers 15 s. */
const REFRESH_MS = 60_000;

/** The key under which a kind of panel object is kept, so a drawer and its page share one read. */
export const panelKey = (kind: string, ...rest: readonly string[]): readonly string[] => [
  'panel',
  kind,
  ...rest,
];

export interface PanelRead<T> {
  query: UseQueryResult<T>;
  /** Asks the panel itself (`?refresh=true`) instead of the memory of the server; the server limits how often. */
  refresh: () => Promise<void>;
  /** True while a refresh asked of the panel is on its way. */
  refreshing: boolean;
}

/**
 * Reads one kind of panel object. The page shows what the server remembers; the refresh button of its header asks
 * the panel again. A refused refresh (the server limits them) is a toast, not a failed page.
 */
export function usePanelRead<T>(
  key: readonly string[],
  read: (refresh: boolean) => Promise<T>,
  enabled = true,
): PanelRead<T> {
  const { t } = useTranslation(['panel', 'errors', 'common']);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const query = useQuery({
    queryKey: key,
    queryFn: () => read(false),
    retry: false,
    refetchInterval: REFRESH_MS,
    enabled,
  });
  const refresh = async () => {
    setRefreshing(true);
    try {
      queryClient.setQueryData(key, await read(true));
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

/** The page when nothing is connected: the panel's empty layout with the way to the Connection page. */
export function PanelNotConnected() {
  const { t } = useTranslation('panel');
  const { session } = useConsole();
  const canConnect = session.permissions.includes('panel:write');
  return (
    <EmptyPageLayout
      description={canConnect ? t('notConnected.text') : t('notConnected.textNoRight')}
      icon={<IconPlugConnectedX size="2rem" />}
      mih="50vh"
      title={t('notConnected.title')}
    >
      {canConnect ? (
        <Button
          color="teal"
          component={Link}
          leftSection={<TbPlugConnected size={18} />}
          size="md"
          to={ROUTES.DASHBOARD.PANEL.CONNECTION}
          variant="soft"
        >
          {t('notConnected.connect')}
        </Button>
      ) : null}
    </EmptyPageLayout>
  );
}

/**
 * What a page shows when the panel could not be read: "no panel is connected" gets its own layout, every other
 * failure the failed-load card with the text of its code and a way to the Connection page, where the connection is
 * tested.
 */
export function PanelReadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation(['panel', 'errors']);
  if (error instanceof ApiRequestError && error.code === 'panel_not_connected') {
    return <PanelNotConnected />;
  }
  // A refusal of this person's role is not about the connection; every other failure of a read is about the panel.
  const aboutConnection = error instanceof ApiRequestError && error.code.startsWith('panel_');
  return (
    <QueryErrorCard
      {...(aboutConnection
        ? {
            action: (
              <Button
                component={Link}
                leftSection={<TbPlugConnected size={18} />}
                to={ROUTES.DASHBOARD.PANEL.CONNECTION}
                variant="light"
              >
                {t('panel:errorCard.testLink')}
              </Button>
            ),
          }
        : {})}
      message={describeError(t, error, t('panel:signInAgain'), t('panel:readForbidden'))}
      onRetry={onRetry}
      title={t('panel:errorCard.title')}
    />
  );
}

/**
 * The body of a panel page: the loading bar until the first answer, the failure states, then the page, which fades in
 * as the panel's pages do. `children` gets the data.
 */
export function PanelBoundary<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) {
    return <LoadingScreen height="60vh" />;
  }
  if (query.isError) {
    return (
      <PanelReadFailure
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return (
    <motion.div animate={{ opacity: 1 }} initial={{ opacity: 0 }} transition={{ duration: 0.5 }}>
      {children(query.data)}
    </motion.div>
  );
}
