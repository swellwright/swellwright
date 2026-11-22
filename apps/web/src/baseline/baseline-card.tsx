// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): its settings cards (a soft icon, a title, a description and
// the content). Changes: the card shows how a server did in its newest baseline check and opens the results.
import { Button, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconChecklist } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SectionCard, StatusBadge } from '@swellwright/ui';

import { listServerBaselineRuns } from '../api.js';
import { useDateTime } from '../format.js';
import { CheckDrawer } from './check-drawer.js';
import { CountBadges, runErrorText, TrendMark } from './baseline-parts.js';

/** The newest baseline check of one server, and the way to its results. Needs `servers:read`. */
export function BaselineCard({
  serverId,
  serverName,
  canExec,
}: {
  serverId: string;
  serverName: string;
  canExec: boolean;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const formatTime = useDateTime();
  const [open, setOpen] = useState(false);
  const runs = useQuery({
    queryKey: ['baseline', 'runs', serverId, 'card'],
    queryFn: () => listServerBaselineRuns(serverId, { limit: 1 }),
    retry: false,
  });
  const last = runs.data?.runs[0];
  return (
    <>
      <SectionCard.Root>
        <SectionCard.Section>
          <Stack gap="sm">
            <Group gap="md" justify="space-between" wrap="nowrap">
              <Group gap="md" wrap="nowrap">
                <ThemeIcon color="cyan" size="xl" variant="soft">
                  <IconChecklist size={24} />
                </ThemeIcon>
                <Stack gap={0}>
                  <Text fw={600}>{t('baseline:title')}</Text>
                  <Text c="dimmed" size="sm">
                    {last === undefined
                      ? t('baseline:drawer.noRuns')
                      : `${last.baseline.name} · ${formatTime(last.finishedAt ?? last.queuedAt)}`}
                  </Text>
                </Stack>
              </Group>
              <Button
                onClick={() => {
                  setOpen(true);
                }}
                size="xs"
                variant="light"
              >
                {t('baseline:table.open')}
              </Button>
            </Group>
            {last === undefined ? null : last.state === 'completed' ? (
              <Group gap="xs">
                <CountBadges counts={last.counts} />
                <TrendMark trend={last.trend} />
              </Group>
            ) : last.state === 'error' ? (
              <Stack gap={4}>
                <StatusBadge kind="err" size="md">
                  {t('baseline:state.error')}
                </StatusBadge>
                <Text c="dimmed" size="xs">
                  {runErrorText(t, last.errorCode, last.errorMessage)}
                </Text>
              </Stack>
            ) : (
              <StatusBadge kind="run" size="md">
                {t(`baseline:state.${last.state}`)}
              </StatusBadge>
            )}
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>
      <CheckDrawer
        canExec={canExec}
        onClose={() => {
          setOpen(false);
        }}
        serverId={open ? serverId : undefined}
        serverName={serverName}
      />
    </>
  );
}
