// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): its detail drawers (a 700 px `Drawer` on the right,
// `OverlayHeader`, grouped `SectionCard`s, the sticky `DrawerFooter`) and the accordions of its settings pages. Changes: the
// panel has no check to show; the results are an `Accordion` per category with a status chip on every check.
import {
  Accordion,
  Badge,
  Box,
  Button,
  Code,
  Drawer,
  Group,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { IconChecklist, IconPlayerPlay } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type {
  BaselineCategory,
  CheckResultView,
  CheckRunDiff,
  CheckRunSummary,
} from '@swellwright/contracts';
import {
  Callout,
  DrawerFooter,
  LoaderModal,
  OverlayHeader,
  SectionCard,
  StatusBadge,
} from '@swellwright/ui';

import {
  diffBaselineRun,
  getBaselineFleet,
  getBaselineRun,
  listServerBaselineRuns,
  startServerBaselineRun,
} from '../api.js';
import { useStepUp } from '../auth/step-up.js';
import { useDateTime } from '../format.js';
import { ROUTES } from '../routes.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useLastDefined } from '../security/use-last-defined.js';
import { notifySuccess } from '../shell/feedback.js';
import { describeError } from '../auth/messages.js';
import {
  CheckStatusBadge,
  CountBadges,
  expectationText,
  runErrorText,
  STATUS_KIND,
  TrendMark,
  valueText,
} from './baseline-parts.js';

const GOING_MS = 1500;

const isGoing = (state: string | undefined): boolean => state === 'queued' || state === 'running';

/** `12 s`, `1 min 05 s`: how long a check took. */
function duration(ms: number | null): string {
  if (ms === null) {
    return '–';
  }
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${String(seconds)} s`
    : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60).padStart(2, '0')} s`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group align="flex-start" gap="md" justify="space-between" wrap="nowrap">
      <Text c="dimmed" fz="sm" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0, textAlign: 'right' }}>{children}</Box>
    </Group>
  );
}

function ResultRow({ result }: { result: CheckResultView }) {
  const { t } = useTranslation(['baseline', 'common']);
  const passed = result.status === 'pass';
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap="xs" style={{ minWidth: 0 }} wrap="nowrap">
          <CheckStatusBadge size="sm" status={result.status} />
          <Text fw={500} fz="sm" truncate>
            {result.title}
          </Text>
        </Group>
        <Badge color="gray" size="sm" tt="none" variant="soft">
          {t(`baseline:severity.${result.severity}`)}
        </Badge>
      </Group>
      <Group gap="md" ml={4}>
        <Text c="dimmed" fz="xs">
          {t('baseline:drawer.observed')}: <Code>{valueText(result.observed)}</Code>
        </Text>
        <Text c="dimmed" fz="xs">
          {t('baseline:drawer.expected')}:{' '}
          <Code>{expectationText(t, result.expectation.comparator, result.expectation.value)}</Code>
        </Text>
      </Group>
      {!passed && result.message ? (
        <Text c="dimmed" fz="xs" ml={4}>
          {result.message}
        </Text>
      ) : null}
      {!passed && result.remediationHint ? (
        <Text fz="xs" ml={4}>
          <Text component="span" fw={500} fz="xs">
            {t('baseline:drawer.hint')}:
          </Text>{' '}
          {result.remediationHint}
        </Text>
      ) : null}
    </Stack>
  );
}

function Drift({ diff }: { diff: CheckRunDiff }) {
  const { t } = useTranslation(['baseline']);
  if (diff.from === null) {
    return (
      <Text c="dimmed" fz="sm">
        {t('baseline:drawer.driftFirst')}
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {diff.notes.includes('baseline_version_differs') ||
      diff.notes.includes('baseline_differs') ? (
        <Text c="dimmed" fz="xs">
          {t('baseline:drawer.driftBaseline')}
        </Text>
      ) : null}
      {diff.identical ? (
        <Text c="dimmed" fz="sm">
          {t('baseline:drawer.driftNone')}
        </Text>
      ) : (
        diff.changes.map((change) => (
          <Stack gap={2} key={`${change.change}-${change.checkId}`}>
            <Group gap="xs" justify="space-between" wrap="nowrap">
              <Text fw={500} fz="sm" truncate>
                {change.title}
              </Text>
              <Badge
                color={
                  change.change === 'regressed'
                    ? 'red'
                    : change.change === 'improved'
                      ? 'teal'
                      : 'gray'
                }
                size="md"
                tt="none"
                variant="soft"
              >
                {t(`baseline:drawer.change.${change.change}`)}
              </Badge>
            </Group>
            <Group gap="xs" ml={4} wrap="nowrap">
              {change.from ? <CheckStatusBadge size="sm" status={change.from.status} /> : null}
              {change.from && change.to ? <Text fz="sm">→</Text> : null}
              {change.to ? <CheckStatusBadge size="sm" status={change.to.status} /> : null}
              {change.from &&
              change.to &&
              valueText(change.from.observed) !== valueText(change.to.observed) ? (
                <Text c="dimmed" fz="xs" truncate>
                  <Code>{valueText(change.from.observed)}</Code> →{' '}
                  <Code>{valueText(change.to.observed)}</Code>
                </Text>
              ) : null}
            </Group>
          </Stack>
        ))
      )}
    </Stack>
  );
}

function RunHistory({
  runs,
  shown,
  onPick,
}: {
  runs: readonly CheckRunSummary[];
  shown: string | undefined;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation(['baseline']);
  const formatTime = useDateTime();
  return (
    <Stack gap={6}>
      {runs.map((run) => (
        <Group
          gap="xs"
          justify="space-between"
          key={run.id}
          wrap="nowrap"
          {...(run.id === shown ? {} : { style: { cursor: 'pointer' } })}
          {...(run.id === shown
            ? {}
            : {
                onClick: () => {
                  onPick(run.id);
                },
                onKeyDown: (event: React.KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    onPick(run.id);
                  }
                },
                role: 'button',
                tabIndex: 0,
                'aria-label': t('baseline:drawer.historyOpen'),
              })}
        >
          <Text fz="sm" style={{ fontFamily: 'monospace' }}>
            {formatTime(run.finishedAt ?? run.queuedAt)}
          </Text>
          {run.state === 'completed' ? (
            <CountBadges counts={run.counts} />
          ) : (
            <StatusBadge kind={run.state === 'error' ? 'err' : 'run'} size="md">
              {t(`baseline:state.${run.state}`)}
            </StatusBadge>
          )}
        </Group>
      ))}
    </Stack>
  );
}

function CheckContent({
  serverId,
  canExec,
  onClose,
}: {
  serverId: string;
  canExec: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['baseline', 'common', 'errors']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const step = useStepUp();
  const formatTime = useDateTime();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<'problems' | 'all'>('problems');

  const fleet = useQuery({
    queryKey: ['baseline', 'fleet'],
    queryFn: getBaselineFleet,
    retry: false,
  });
  const item = fleet.data?.items.find((entry) => entry.server.id === serverId);
  const runs = useQuery({
    queryKey: ['baseline', 'runs', serverId],
    queryFn: () => listServerBaselineRuns(serverId, { limit: 30 }),
    refetchInterval: (query) => (isGoing(query.state.data?.runs[0]?.state) ? GOING_MS : 30_000),
    retry: false,
  });
  const runId = picked ?? runs.data?.runs[0]?.id;
  const run = useQuery({
    queryKey: ['baseline', 'run', runId ?? 'none'],
    queryFn: () => getBaselineRun(runId ?? ''),
    enabled: runId !== undefined,
    refetchInterval: (query) => (isGoing(query.state.data?.state) ? GOING_MS : false),
    retry: false,
  });
  const completed = run.data?.state === 'completed';
  const diff = useQuery({
    queryKey: ['baseline', 'diff', runId ?? 'none'],
    queryFn: () => diffBaselineRun(runId ?? ''),
    enabled: runId !== undefined && completed,
    retry: false,
  });

  const start = useMutation({
    mutationFn: () => step.run(() => startServerBaselineRun(serverId)),
    onSuccess: async () => {
      notifySuccess(t('baseline:run.started'));
      setPicked(undefined);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['baseline'] })]);
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:run.failed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noRun'),
      );
    },
  });

  const grouped = useMemo(() => {
    const results = run.data?.results ?? [];
    const shown = filter === 'all' ? results : results.filter((result) => result.status !== 'pass');
    const byCategory = new Map<BaselineCategory, CheckResultView[]>();
    for (const result of shown) {
      byCategory.set(result.category, [...(byCategory.get(result.category) ?? []), result]);
    }
    return [...byCategory.entries()];
  }, [run.data, filter]);

  const body = (() => {
    if (runs.isPending || fleet.isPending) {
      return <LoaderModal mih="40vh" />;
    }
    if (runs.isError) {
      return (
        <QueryErrorCard
          message={describeError(
            t,
            runs.error,
            t('baseline:signInAgain'),
            t('baseline:readForbidden'),
          )}
          onRetry={() => void runs.refetch()}
          title={t('baseline:drawer.loadFailed')}
        />
      );
    }
    if (runs.data.runs.length === 0 || run.data === undefined) {
      return (
        <Stack gap="md">
          {item?.baseline ? null : (
            <Callout color="orange">{t('baseline:drawer.noBaseline')}</Callout>
          )}
          <Text c="dimmed" fz="sm">
            {t('baseline:drawer.noRuns')}
          </Text>
        </Stack>
      );
    }
    const current = run.data;
    return (
      <Stack gap="md">
        {current.state === 'error' ? (
          <Callout color="red">
            <Stack gap={4}>
              <Text fw={500} fz="sm">
                {t('baseline:drawer.runErrorTitle')}
              </Text>
              <Text fz="sm">{runErrorText(t, current.errorCode, current.errorMessage)}</Text>
              <Group>
                <Button
                  onClick={() => {
                    void navigate(ROUTES.DASHBOARD.FLEET.SERVERS);
                  }}
                  size="xs"
                  variant="light"
                >
                  {t('baseline:drawer.openServer')}
                </Button>
              </Group>
            </Stack>
          </Callout>
        ) : null}
        {isGoing(current.state) ? (
          <Callout color="cyan">{t('baseline:drawer.pending')}</Callout>
        ) : null}

        <SectionCard.Root>
          <SectionCard.Section>
            <Stack gap="xs">
              <Text fw={600}>{t('baseline:drawer.summary')}</Text>
              <Row label={t('baseline:drawer.baseline')}>
                <Text fz="sm">
                  {current.baseline.name}{' '}
                  <Text c="dimmed" component="span" fz="sm">
                    {t('baseline:drawer.version', { version: current.baseline.version })}
                    {current.baseline.id === null ? `, ${t('baseline:drawer.deleted')}` : ''}
                  </Text>
                </Text>
              </Row>
              <Row label={t('baseline:drawer.result')}>
                {current.state === 'completed' ? (
                  <Group gap="xs" justify="flex-end">
                    <CountBadges counts={current.counts} />
                    <TrendMark trend={current.trend} />
                  </Group>
                ) : (
                  <StatusBadge kind={current.state === 'error' ? 'err' : 'run'} size="md">
                    {t(`baseline:state.${current.state}`)}
                  </StatusBadge>
                )}
              </Row>
              <Row label={t('baseline:drawer.checkedAt')}>
                <Text fz="sm" style={{ fontFamily: 'monospace' }}>
                  {formatTime(current.finishedAt ?? current.queuedAt)}
                </Text>
              </Row>
              <Row label={t('baseline:drawer.duration')}>
                <Text fz="sm">{duration(current.durationMs)}</Text>
              </Row>
              <Row label={t('baseline:drawer.trigger')}>
                <Text fz="sm">
                  {current.startedBy
                    ? t('baseline:drawer.triggerManual', { name: current.startedBy.name })
                    : t('baseline:drawer.triggerScheduled')}
                </Text>
              </Row>
              {current.collectedAs ? (
                <Text c={current.collectedAs === 'user' ? 'orange' : 'dimmed'} fz="xs">
                  {t(`baseline:collectedAs.${current.collectedAs}`)}
                </Text>
              ) : null}
            </Stack>
          </SectionCard.Section>
        </SectionCard.Root>

        {completed ? (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="xs">
                <Text fw={600}>{t('baseline:drawer.drift')}</Text>
                {diff.isPending ? (
                  <LoaderModal mih="60px" />
                ) : diff.isError ? (
                  <Text c="red" fz="sm">
                    {t('baseline:drawer.driftFailed')}
                  </Text>
                ) : (
                  <Drift diff={diff.data} />
                )}
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : null}

        {current.results.length > 0 ? (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="sm">
                <Group justify="space-between">
                  <Text fw={600}>{t('baseline:drawer.results')}</Text>
                  <SegmentedControl
                    data={[
                      { value: 'problems', label: t('baseline:drawer.onlyProblems') },
                      { value: 'all', label: t('baseline:drawer.all') },
                    ]}
                    onChange={(value) => {
                      setFilter(value === 'all' ? 'all' : 'problems');
                    }}
                    size="xs"
                    value={filter}
                  />
                </Group>
                {grouped.length === 0 ? (
                  <Text c="dimmed" fz="sm">
                    {t('baseline:drawer.noProblems')}
                  </Text>
                ) : (
                  <Accordion
                    defaultValue={grouped.map(([category]) => category)}
                    key={`${current.id}-${filter}`}
                    multiple
                    variant="separated"
                  >
                    {grouped.map(([category, results]) => (
                      <Accordion.Item key={category} value={category}>
                        <Accordion.Control>
                          <Group gap="xs" justify="space-between" pr="xs" wrap="nowrap">
                            <Text fw={500} fz="sm">
                              {t(`baseline:category.${category}`)}
                            </Text>
                            <Group gap={4}>
                              {(['fail', 'warn', 'error', 'pass', 'skipped'] as const)
                                .filter((status) =>
                                  results.some((result) => result.status === status),
                                )
                                .map((status) => (
                                  <StatusBadge
                                    iconSize={12}
                                    key={status}
                                    kind={STATUS_KIND[status]}
                                    size="sm"
                                  >
                                    {String(
                                      results.filter((result) => result.status === status).length,
                                    )}
                                  </StatusBadge>
                                ))}
                            </Group>
                          </Group>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Stack gap="md">
                            {results.map((result) => (
                              <ResultRow key={result.checkId} result={result} />
                            ))}
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    ))}
                  </Accordion>
                )}
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : null}

        {runs.data.runs.length > 1 ? (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="xs">
                <Text fw={600}>{t('baseline:drawer.history')}</Text>
                <RunHistory onPick={setPicked} runs={runs.data.runs} shown={runId} />
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : null}
      </Stack>
    );
  })();

  return (
    <>
      <Stack gap="md" pb="xl">
        {body}
      </Stack>
      <DrawerFooter>
        <Group gap="xs" justify="space-between" w="100%">
          {canExec ? (
            <Button
              color="teal"
              disabled={isGoing(runs.data?.runs[0]?.state)}
              leftSection={<IconPlayerPlay size={18} />}
              loading={start.isPending}
              onClick={() => {
                start.mutate();
              }}
              variant="light"
            >
              {t('baseline:drawer.runNow')}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={onClose} variant="subtle">
            {t('baseline:drawer.close')}
          </Button>
        </Group>
      </DrawerFooter>
    </>
  );
}

/** The results of the checks of one server: the newest check, what changed since the one before, and the history. */
export function CheckDrawer({
  serverId,
  serverName,
  canExec,
  onClose,
}: {
  serverId: string | undefined;
  serverName: string | undefined;
  canExec: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const shown = useLastDefined(serverId);
  return (
    <Drawer
      closeButtonProps={{ 'aria-label': t('common:close'), ...{ 'data-autofocus': true } }}
      onClose={onClose}
      opened={serverId !== undefined}
      padding="lg"
      position="right"
      size="700px"
      title={
        <OverlayHeader
          icon={IconChecklist}
          iconColor="cyan"
          subtitle={t('baseline:drawer.title')}
          title={serverName ?? t('baseline:drawer.title')}
          truncateTitle
        />
      }
    >
      {shown === undefined ? null : (
        <CheckContent canExec={canExec} key={shown} onClose={onClose} serverId={shown} />
      )}
    </Drawer>
  );
}

export type { CheckRunSummary };
