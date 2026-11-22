// New in Swellwright (ADR 0047), built from the panel's pieces: the titled card of its lists (src/shared/ui/table: a soft cyan icon,
// a level 4 title, a description and icon-only actions, over the page background), rows of the kind of its "node status" and
// "request history" lists (a soft icon, a bold line, a dimmed line, the actions on the right) and the empty layout of its pages.
// The panel has no "needs attention" list; this is the closest card it has for it.
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconCircleCheck, IconClock, IconEyeOff, IconRefresh } from '@tabler/icons-react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ElementType, Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiInfoDuotone, PiWarningCircleDuotone, PiWarningOctagonDuotone } from 'react-icons/pi';
import { TbBellRinging } from 'react-icons/tb';
import { Link } from 'react-router';

import {
  ATTENTION_SEVERITIES,
  type AttentionItem,
  type AttentionSeverity,
} from '@swellwright/contracts';
import {
  Callout,
  DataTableCard,
  EmptyPageLayout,
  HeaderAction,
  HeaderActions,
  ShimmerSkeleton,
} from '@swellwright/ui';

import { getDashboardAttention } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useDateTime } from '../format.js';
import { useRelativeTime } from '../panel/snapshot-parts.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useConsole } from '../shell/console-context.js';
import { useHiddenAttention } from './hidden.js';

/** The page asks again this often while it is visible (React Query stops while the tab is hidden). */
export const DASHBOARD_REFRESH_MS = 60_000;

export const attentionKey = ['dashboard', 'attention'] as const;

/** How many items the card shows before a button offers the rest: a system with everything wrong is a long list. */
const COLLAPSED_ITEMS = 6;

/** The reads that make up the dashboard: its own endpoints and the stored facts of the panel, the checks and the API. */
const PANEL_PARTS = new Set(['connection', 'overview', 'snapshots', 'checks']);
const isDashboardRead = (key: readonly unknown[]): boolean =>
  key[0] === 'dashboard' ||
  key[0] === 'system' ||
  (key[0] === 'baseline' && key[1] === 'fleet') ||
  (key[0] === 'panel' && PANEL_PARTS.has(String(key[1])));

/**
 * The refresh button of the page: reads everything on it again from this server, and says so while it does. It never
 * asks the panel itself (that is the button of the panel's own section).
 */
export function useDashboardRefresh(): { fetching: boolean; refresh: () => void } {
  const client = useQueryClient();
  const fetching = useIsFetching({ predicate: (query) => isDashboardRead(query.queryKey) }) > 0;
  return {
    fetching,
    refresh: () => {
      void client.invalidateQueries({ predicate: (query) => isDashboardRead(query.queryKey) });
    },
  };
}

const SEVERITY: Record<AttentionSeverity, { color: string; icon: ElementType<{ size?: number }> }> =
  {
    critical: { color: 'red', icon: PiWarningOctagonDuotone },
    warning: { color: 'orange', icon: PiWarningCircleDuotone },
    info: { color: 'cyan', icon: PiInfoDuotone },
  };

/** The English text of the server, or the text of this console in the language of the person when it has one. */
export function useAttentionText(): (item: AttentionItem) => { title: string; detail: string } {
  const { t, i18n } = useTranslation('dashboard');
  const lookup = t as unknown as (key: string, options?: object) => string;
  return (item) => {
    const base = `attention.kinds.${item.kind}`;
    const more = typeof item.params['more'] === 'number' ? item.params['more'] : 0;
    const names = typeof item.params['names'] === 'string' ? item.params['names'] : '';
    const params = {
      ...item.params,
      names: more > 0 ? `${names} ${t('attention.andMore', { count: more })}` : names,
    };
    const text = (part: 'title' | 'detail', fallback: string): string =>
      i18n.exists(`${base}.${part}`, { ns: 'dashboard' })
        ? lookup(`${base}.${part}`, params)
        : fallback;
    return { title: text('title', item.title), detail: text('detail', item.detail) };
  };
}

function AttentionRow({
  item,
  onHide,
}: {
  item: AttentionItem;
  onHide: (item: AttentionItem) => void;
}) {
  const { t } = useTranslation(['dashboard', 'common']);
  const text = useAttentionText()(item);
  const relative = useRelativeTime();
  const formatDate = useDateTime();
  const { color, icon: Icon } = SEVERITY[item.severity];

  return (
    <Group
      align="flex-start"
      data-attention-kind={item.kind}
      gap="md"
      justify="space-between"
      px="md"
      py="sm"
      // On a phone the buttons drop under the text instead of squeezing it into a narrow column.
      wrap="wrap"
    >
      <Group align="flex-start" gap="md" miw={0} style={{ flex: '1 1 18rem' }} wrap="nowrap">
        <ThemeIcon aria-hidden color={color} radius="lg" size="xl" variant="soft">
          <Icon size={24} />
        </ThemeIcon>
        <Stack gap={2} miw={0}>
          <Text fw={600} size="sm">
            {text.title}
          </Text>
          <Text c="dimmed" size="sm">
            {text.detail}
          </Text>
          {item.since === null ? null : (
            <Tooltip
              label={t('dashboard:attention.since', { when: formatDate(item.since) })}
              withArrow
            >
              <Group gap={4} w="fit-content" wrap="nowrap">
                <IconClock aria-hidden color="var(--mantine-color-dimmed)" size={14} />
                <Text c="dimmed" fz="xs">
                  {relative(item.since)}
                </Text>
              </Group>
            </Tooltip>
          )}
        </Stack>
      </Group>
      <Group gap="xs" wrap="nowrap">
        {item.link === null ? null : (
          <Button component={Link} size="xs" to={item.link} variant="light">
            {t('dashboard:attention.open')}
          </Button>
        )}
        <Tooltip label={t('dashboard:attention.hide')} withArrow>
          <ActionIcon
            aria-label={t('dashboard:attention.hide')}
            color="gray"
            onClick={() => {
              onHide(item);
            }}
            size="input-sm"
            variant="subtle"
          >
            <IconEyeOff size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}

function Skeleton() {
  return (
    <Stack aria-hidden gap="md" p="md">
      {[0, 1, 2].map((row) => (
        <Group gap="md" key={row} wrap="nowrap">
          <ShimmerSkeleton height={44} width={44} />
          <Stack gap={6} style={{ flex: 1 }}>
            <ShimmerSkeleton height={14} width="40%" />
            <ShimmerSkeleton height={12} width="70%" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * The top card of the dashboard: what needs attention, grouped by severity. It asks its own endpoint every minute while
 * the page is visible, hides what a person hid in this browser (until the facts behind it change), says which sources it
 * could not read, and has an empty state for a system in order.
 */
export function AttentionCard() {
  const { t } = useTranslation(['dashboard', 'common']);
  const { session } = useConsole();
  const hidden = useHiddenAttention(session.user.id);
  const page = useDashboardRefresh();
  const feed = useQuery({
    queryKey: attentionKey,
    queryFn: getDashboardAttention,
    refetchInterval: DASHBOARD_REFRESH_MS,
    retry: false,
  });

  const [expanded, setExpanded] = useState(false);
  const visible = useMemo(
    () => (feed.data?.items ?? []).filter((item) => !hidden.isHidden(item)),
    [feed.data, hidden],
  );
  const grouped = useMemo(() => {
    // The most severe items come first, so a collapsed card keeps the ones that matter most.
    const shown = expanded ? visible : visible.slice(0, COLLAPSED_ITEMS);
    return ATTENTION_SEVERITIES.map((severity) => ({
      severity,
      items: shown.filter((item) => item.severity === severity),
    })).filter((group) => group.items.length > 0);
  }, [visible, expanded]);
  const rest = visible.length - COLLAPSED_ITEMS;
  const hiddenCount = (feed.data?.items.length ?? 0) - visible.length;

  if (feed.isError && feed.data === undefined) {
    return (
      <QueryErrorCard
        message={describeError(
          t,
          feed.error,
          t('dashboard:signInAgain'),
          t('dashboard:readForbidden'),
        )}
        onRetry={() => void feed.refetch()}
        title={t('dashboard:attention.loadFailed')}
      />
    );
  }

  const failed = (feed.data?.sources ?? [])
    .filter((entry) => entry.state === 'failed')
    .map((entry) => t(`dashboard:attention.sources.${entry.source}`));

  return (
    <DataTableCard.Container>
      <DataTableCard.Title
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={page.fetching}
              onClick={page.refresh}
            />
          </HeaderActions>
        }
        description={t('dashboard:attention.description')}
        icon={<TbBellRinging size={24} />}
        title={t('dashboard:attention.title')}
      />
      <DataTableCard.Content>
        {feed.isPending ? (
          <Skeleton />
        ) : (
          <>
            {failed.length > 0 ? (
              <Box p="md">
                <Callout color="orange">
                  {t('dashboard:attention.failedSources', { sources: failed.join(', ') })}
                </Callout>
              </Box>
            ) : null}
            {grouped.length === 0 ? (
              <EmptyPageLayout
                embedded
                icon={<IconCircleCheck size="2rem" />}
                title={t('dashboard:attention.empty.title')}
                description={t('dashboard:attention.empty.text')}
              />
            ) : (
              <Stack gap={0}>
                {grouped.map((group, index) => (
                  <Fragment key={group.severity}>
                    <Group
                      gap="xs"
                      px="md"
                      py="xs"
                      style={{
                        borderTop:
                          index === 0 && failed.length === 0
                            ? undefined
                            : '1px solid var(--mantine-color-default-border)',
                      }}
                    >
                      <Badge
                        color={SEVERITY[group.severity].color}
                        size="lg"
                        tt="none"
                        variant="soft"
                      >
                        {t(`dashboard:attention.groups.${group.severity}`)} · {group.items.length}
                      </Badge>
                    </Group>
                    {group.items.map((item) => (
                      <AttentionRow item={item} key={item.id} onHide={hidden.hide} />
                    ))}
                  </Fragment>
                ))}
              </Stack>
            )}
            {rest > 0 ? (
              <Group
                gap="xs"
                justify="center"
                px="md"
                py="xs"
                style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
              >
                <Button
                  onClick={() => {
                    setExpanded((open) => !open);
                  }}
                  size="compact-sm"
                  variant="subtle"
                >
                  {expanded
                    ? t('dashboard:attention.showLess')
                    : t('dashboard:attention.showMore', { count: rest })}
                </Button>
              </Group>
            ) : null}
            {hiddenCount > 0 ? (
              <Group
                gap="xs"
                px="md"
                py="xs"
                style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
              >
                <Text c="dimmed" size="sm">
                  {t('dashboard:attention.hiddenCount', { count: hiddenCount })}
                </Text>
                <Button onClick={hidden.clear} size="compact-sm" variant="subtle">
                  {t('dashboard:attention.showHidden')}
                </Button>
              </Group>
            ) : null}
          </>
        )}
      </DataTableCard.Content>
    </DataTableCard.Container>
  );
}
