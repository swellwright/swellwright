// The drawer follows the panel's detail drawers (a 700 px `Drawer` on the right, full screen on a phone, a soft icon and the
// name in the title, grouped `SectionCard`s with `DataList` rows, the sticky `DrawerFooter`). The panel has no run to
// show; the servers are an `Accordion` with a state chip on each, as its Mantine accordions are drawn.
import { Accordion, Badge, Button, DataList, Drawer, Group, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconListCheck,
  IconPlayerStop,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type CommandOutput,
  type CommandRunView,
  type CommandTargetView,
  OUTPUT_PAGE_MAX,
} from '@swellwright/contracts';
import {
  Callout,
  CopyableCodeBlock,
  DrawerFooter,
  LoaderModal,
  OverlayHeader,
  SectionCard,
  StatusBadge,
} from '@swellwright/ui';

import { ApiRequestError, cancelCommandRun, getCommandOutput, getCommandRun } from '../api.js';
import { useStepUp } from '../auth/step-up.js';
import { useDateTime } from '../format.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useLastDefined } from '../security/use-last-defined.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';
import { DangerBadge, isGoing, RUN_STATE_KIND, TARGET_STATE_KIND } from './danger.js';
import { OutputView } from './output-view.js';

/** The codes that have a text of their own; any other code is shown as it is. */
const KNOWN_ERRORS = [
  'timeout',
  'server_deleted',
  'step_lost',
  'unreachable',
  'start_failed',
  'host_key_mismatch',
  'host_key_not_pinned',
  'no_access_entry',
  'ssh_auth_failed',
  'ssh_key_invalid',
  'ssh_connect_failed',
  'ssh_timeout',
  'ssh_failed',
  'address_not_allowed',
  'secret_unavailable',
  'cancelled',
  'internal_error',
] as const;
const isKnownError = (code: string): code is (typeof KNOWN_ERRORS)[number] =>
  (KNOWN_ERRORS as readonly string[]).includes(code);

const KNOWN_WAITING = ['vault_sealed', 'ssh_connect_failed', 'ssh_timeout', 'ssh_failed'] as const;
const isKnownWaiting = (code: string): code is (typeof KNOWN_WAITING)[number] =>
  (KNOWN_WAITING as readonly string[]).includes(code);

/** `1 h 02 min`, `3 min 07 s`, `12 s`: a span without the unit noise. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  if (minutes > 0) {
    return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
  }
  return `0:${String(rest).padStart(2, '0')}`;
}

/** The span a thing took, or has taken so far when it is still going. */
export function spanOf(
  startedAt: string | null,
  finishedAt: string | null,
  now: number,
): number | undefined {
  if (startedAt === null) {
    return undefined;
  }
  return (finishedAt === null ? now : Date.parse(finishedAt)) - Date.parse(startedAt);
}

/** The current time, moved on every second while something is going (so a running span counts up). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

/** One stream of one server: the end of what it wrote, and a way to read all of it. */
function StreamBlock({
  runId,
  targetId,
  stream,
  output,
  serverName,
  following,
}: {
  runId: string;
  targetId: string;
  stream: 'stdout' | 'stderr';
  output: CommandOutput;
  serverName: string;
  following: boolean;
}) {
  const { t } = useTranslation(['commands', 'common']);
  // The whole text, and how much output there was when it was read: more output since makes the tail the better view.
  const [loaded, setLoaded] = useState<{ at: number; text: string } | undefined>(undefined);
  const full = loaded?.at === output.storedBytes ? loaded.text : undefined;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const partial = output.tailOffset > 0;

  const loadAll = async () => {
    setLoading(true);
    setFailed(false);
    try {
      let offset = 0;
      let text = '';
      for (;;) {
        const page = await getCommandOutput(runId, targetId, {
          stream,
          offset,
          limit: OUTPUT_PAGE_MAX,
        });
        text += page.text;
        if (page.eof || page.nextOffset <= offset) {
          break;
        }
        offset = page.nextOffset;
      }
      setLoaded({ at: output.storedBytes, text });
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  if (output.storedBytes === 0 && stream === 'stderr') {
    return null;
  }
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between">
        <Group gap="xs">
          <Text fw={500} size="sm">
            {t(`commands:runDetail.${stream}`)}
          </Text>
          <Text c="dimmed" size="xs">
            {t('commands:runDetail.bytes', { count: output.storedBytes })}
          </Text>
        </Group>
        {partial && full === undefined ? (
          <Button
            loading={loading}
            onClick={() => {
              void loadAll();
            }}
            size="compact-sm"
            variant="subtle"
          >
            {t('commands:runDetail.showAll')}
          </Button>
        ) : null}
      </Group>
      {partial && full === undefined ? (
        <Text c="dimmed" size="xs">
          {t('commands:runDetail.onlyEnd', { count: output.tail.length })}
        </Text>
      ) : null}
      {failed ? (
        <Text c="red" size="xs">
          {t('commands:runDetail.loadFailed')}
        </Text>
      ) : null}
      <OutputView
        follow={following && full === undefined}
        label={t('commands:runDetail.outputLabel', {
          stream: t(`commands:runDetail.${stream}`),
          name: serverName,
        })}
        text={full ?? output.tail}
      />
      {output.truncated ? (
        <Callout color="orange" icon={<IconAlertTriangle size={20} />}>
          {t('commands:runDetail.truncated', {
            kept: output.storedBytes,
            total: output.totalBytes,
          })}
        </Callout>
      ) : null}
    </Stack>
  );
}

function TargetPanel({
  run,
  target,
  now,
}: {
  run: CommandRunView;
  target: CommandTargetView;
  now: number;
}) {
  const { t } = useTranslation(['commands', 'common']);
  const going = target.state === 'running' || target.state === 'pending';
  return (
    <Stack gap="sm">
      {target.errorCode !== null || target.errorMessage !== null ? (
        <Callout
          color={
            target.state === 'skipped' ? 'blue' : target.state === 'cancelled' ? 'gray' : 'red'
          }
          icon={<IconAlertTriangle size={20} />}
          title={
            target.errorCode === null
              ? undefined
              : isKnownError(target.errorCode)
                ? t(`commands:targetError.${target.errorCode}`)
                : target.errorCode
          }
        >
          {target.errorMessage ?? ''}
        </Callout>
      ) : null}
      {target.waiting !== null ? (
        <Callout color="orange" icon={<IconInfoCircle size={20} />}>
          {isKnownWaiting(target.waiting)
            ? t(`commands:waiting.${target.waiting}`)
            : t('commands:waiting.other')}
        </Callout>
      ) : null}
      {target.state === 'pending' ? (
        <Text c="dimmed" size="sm">
          {t('commands:runDetail.pending')}
        </Text>
      ) : null}
      {target.state !== 'pending' && target.state !== 'skipped' ? (
        <>
          <StreamBlock
            following={going}
            output={target.stdout}
            runId={run.id}
            serverName={target.serverName}
            stream="stdout"
            targetId={target.id}
          />
          <StreamBlock
            following={going}
            output={target.stderr}
            runId={run.id}
            serverName={target.serverName}
            stream="stderr"
            targetId={target.id}
          />
        </>
      ) : null}
      {target.startedAt !== null ? (
        <Text c="dimmed" size="xs">
          {t('commands:runDetail.took', {
            span: formatDuration(spanOf(target.startedAt, target.finishedAt, now) ?? 0),
          })}
        </Text>
      ) : null}
    </Stack>
  );
}

function RunBody({
  run,
  canExec,
  onClose,
}: {
  run: CommandRunView;
  canExec: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['commands', 'common']);
  const formatTime = useDateTime();
  const queryClient = useQueryClient();
  const step = useStepUp();
  const going = isGoing(run.state);
  const now = useNow(going);

  const cancel = useMutation({
    mutationFn: () => step.run(() => cancelCommandRun(run.id)),
    onSuccess: (updated) => {
      queryClient.setQueryData(['command-run', run.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['command-runs'] });
      notifySuccess(t('commands:runDetail.cancelled'), t('commands:runDetail.cancelledText'));
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('commands:runDetail.cancelTitle'),
        error,
        t('commands:signInAgain'),
        t('commands:runDetail.cancelForbidden'),
      );
    },
  });
  const askCancel = () => {
    confirmAction({
      title: t('commands:runDetail.cancelTitle'),
      message: <Text size="sm">{t('commands:runDetail.cancelText')}</Text>,
      confirmLabel: t('commands:runDetail.cancel'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        cancel.mutate();
      },
    });
  };

  // The servers that need a look are open: the failed ones, or the only one.
  const initiallyOpen = run.targets
    .filter(
      (target) => run.targets.length <= 2 || ['failed', 'lost', 'running'].includes(target.state),
    )
    .slice(0, 5)
    .map((target) => target.id);
  const parameters = Object.entries(run.parameters);

  return (
    <>
      <Stack gap="md">
        <SectionCard.Root>
          <SectionCard.Section>
            <Group gap="xs" justify="space-between">
              <Group gap="xs">
                <StatusBadge kind={RUN_STATE_KIND[run.state]}>
                  {t(`commands:runState.${run.state}`)}
                </StatusBadge>
                <DangerBadge level={run.dangerLevel} />
                {run.sudo ? (
                  <Badge color="gray" size="lg" variant="soft">
                    {t('commands:badges.sudo')}
                  </Badge>
                ) : null}
              </Group>
              <Text c="dimmed" size="xs">
                {t(`commands:runs.mode.${run.mode}`)}
              </Text>
            </Group>
          </SectionCard.Section>
          <SectionCard.Section>
            <DataList>
              <DataList.Item>
                <DataList.ItemLabel>{t('commands:runDetail.by')}</DataList.ItemLabel>
                <DataList.ItemValue>{run.createdBy}</DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>{t('commands:runDetail.created')}</DataList.ItemLabel>
                <DataList.ItemValue>{formatTime(run.createdAt)}</DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>{t('commands:runDetail.finished')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  {run.finishedAt === null ? '–' : formatTime(run.finishedAt)}
                </DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>{t('commands:runDetail.duration')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  {run.startedAt === null
                    ? '–'
                    : formatDuration(spanOf(run.startedAt, run.finishedAt, now) ?? 0)}
                </DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>{t('commands:runDetail.timeout')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  {t('commands:runDetail.seconds', { count: run.timeoutSeconds })}
                </DataList.ItemValue>
              </DataList.Item>
              {run.scriptName !== null ? (
                <DataList.Item>
                  <DataList.ItemLabel>{t('commands:runDetail.script')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    {run.scriptName}
                    {run.scriptVersion === null ? '' : ` v${String(run.scriptVersion)}`}
                  </DataList.ItemValue>
                </DataList.Item>
              ) : null}
              {run.confirmedLevel !== null ? (
                <DataList.Item>
                  <DataList.ItemLabel>{t('commands:runDetail.confirmed')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    {t(`commands:danger.${run.confirmedLevel}`)}
                  </DataList.ItemValue>
                </DataList.Item>
              ) : null}
              {parameters.map(([name, value]) => (
                <DataList.Item key={name}>
                  <DataList.ItemLabel ff="monospace">{name}</DataList.ItemLabel>
                  <DataList.ItemValue ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {String(value)}
                  </DataList.ItemValue>
                </DataList.Item>
              ))}
              {run.secrets.length > 0 ? (
                <DataList.Item>
                  <DataList.ItemLabel>{t('commands:runDetail.handed')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    <Stack gap={6}>
                      {run.secrets.map((secret) => (
                        <Group gap="xs" key={secret.name} wrap="wrap">
                          <Badge color="blue" ff="monospace" size="lg" tt="none" variant="soft">
                            {secret.name}
                          </Badge>
                          <Text size="sm">
                            {secret.secretName}
                            {secret.secretId === null
                              ? ` (${t('commands:runDetail.handedDeleted')})`
                              : ''}
                          </Text>
                        </Group>
                      ))}
                      <Text c="dimmed" size="xs">
                        {t('commands:runDetail.handedNote')}
                      </Text>
                    </Stack>
                  </DataList.ItemValue>
                </DataList.Item>
              ) : null}
            </DataList>
          </SectionCard.Section>
        </SectionCard.Root>

        <Callout color="orange" icon={<IconInfoCircle size={20} />}>
          {t('commands:runDetail.secretsNotice')}
        </Callout>

        <Accordion chevronPosition="right" defaultValue={null} variant="separated">
          <Accordion.Item value="text">
            <Accordion.Control>{t('commands:runDetail.text')}</Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                <Text c="dimmed" size="xs">
                  {t('commands:runDetail.textNote')}
                </Text>
                <CopyableCodeBlock
                  copiedLabel={t('common:copied')}
                  copyLabel={t('common:copy')}
                  maxHeight={320}
                  multiline
                  regionLabel={t('commands:runDetail.text')}
                  value={run.body}
                />
                <CopyableCodeBlock
                  copiedLabel={t('common:copied')}
                  copyLabel={t('common:copy')}
                  inputWrapperProps={{ label: t('commands:editor.hash') }}
                  size="small"
                  value={run.bodySha256}
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>

        <Stack gap="xs">
          <Group gap="xs" justify="space-between">
            <Text fw={600}>{t('commands:runDetail.servers', { count: run.counts.total })}</Text>
            <Group gap={6}>
              {(
                [
                  'succeeded',
                  'failed',
                  'lost',
                  'running',
                  'pending',
                  'cancelled',
                  'skipped',
                ] as const
              )
                .filter((state) => run.counts[state] > 0)
                .map((state) => (
                  <StatusBadge key={state} kind={TARGET_STATE_KIND[state]} maw="none" size="md">
                    {`${t(`commands:targetState.${state}`)} ${String(run.counts[state])}`}
                  </StatusBadge>
                ))}
            </Group>
          </Group>
          <Accordion
            chevronPosition="right"
            defaultValue={initiallyOpen}
            key={run.id}
            multiple
            variant="separated"
          >
            {run.targets.map((target) => (
              <Accordion.Item key={target.id} value={target.id}>
                <Accordion.Control>
                  <Group gap="xs" justify="space-between" pr="xs" wrap="nowrap">
                    <Text fw={500} size="sm" truncate>
                      {target.serverName}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      {target.exitCode === null ? null : (
                        <Text c="dimmed" ff="monospace" size="xs">
                          {t('commands:runDetail.exit', { code: target.exitCode })}
                        </Text>
                      )}
                      <StatusBadge kind={TARGET_STATE_KIND[target.state]} maw="none" size="md">
                        {t(`commands:targetState.${target.state}`)}
                      </StatusBadge>
                    </Group>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <TargetPanel now={now} run={run} target={target} />
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </Stack>
      </Stack>
      <DrawerFooter>
        <Group gap="xs" justify="space-between" w="100%">
          <Button color="gray" onClick={onClose} size="md" variant="subtle">
            {t('common:close')}
          </Button>
          {canExec && going && run.cancelRequestedAt === null ? (
            <Button
              color="red"
              leftSection={<IconPlayerStop size={16} />}
              loading={cancel.isPending}
              onClick={askCancel}
              size="md"
              variant="soft"
            >
              {t('commands:runDetail.cancel')}
            </Button>
          ) : null}
          {going && run.cancelRequestedAt !== null ? (
            <Text c="orange" size="sm">
              {t('commands:runDetail.stopping')}
            </Text>
          ) : null}
        </Group>
      </DrawerFooter>
    </>
  );
}

function RunContent({
  id,
  canExec,
  onClose,
}: {
  id: string;
  canExec: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['commands', 'common']);
  const query = useQuery({
    queryKey: ['command-run', id],
    queryFn: () => getCommandRun(id),
    // Asked again every second and a half while the run is going, as the panel's live views are.
    refetchInterval: (state) =>
      state.state.data && !isGoing(state.state.data.state) ? false : 1500,
    retry: false,
  });
  if (query.isPending) {
    return <LoaderModal label={t('common:loading')} mih="78vh" />;
  }
  if (query.isError) {
    const gone = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <QueryErrorCard
        message={gone ? t('commands:runDetail.goneText') : t('commands:runDetail.failedText')}
        onRetry={gone ? onClose : () => void query.refetch()}
        title={gone ? t('commands:runDetail.goneTitle') : t('commands:runDetail.failedTitle')}
      />
    );
  }
  return <RunBody canExec={canExec} onClose={onClose} run={query.data} />;
}

/** The drawer of one run: who started it and what ran, and every server with its state and its output. */
export function RunDrawer({
  runId,
  canExec,
  onClose,
}: {
  runId: string | undefined;
  canExec: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['commands', 'common']);
  const shown = useLastDefined(runId);
  const title = useQuery({
    queryKey: ['command-run', shown ?? 'none'],
    queryFn: () => getCommandRun(shown ?? ''),
    enabled: shown !== undefined,
    retry: false,
  });
  return (
    <Drawer
      closeButtonProps={{ 'aria-label': t('common:close'), ...{ 'data-autofocus': true } }}
      onClose={onClose}
      opened={runId !== undefined}
      padding="lg"
      position="right"
      size="700px"
      title={
        <OverlayHeader
          icon={IconListCheck}
          iconColor="cyan"
          title={title.data?.label ?? t('commands:runDetail.title')}
          truncateTitle
          {...(shown === undefined ? {} : { subtitle: shown, withCopy: true })}
        />
      }
    >
      {shown === undefined ? null : (
        <RunContent canExec={canExec} id={shown} key={shown} onClose={onClose} />
      )}
    </Drawer>
  );
}
