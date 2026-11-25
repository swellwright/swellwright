import {
  ActionIcon,
  Box,
  Button,
  DataList,
  Drawer,
  Group,
  Modal,
  Progress,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconBook,
  IconBookmark,
  IconCheck,
  IconDownload,
  IconFilterOff,
  IconListCheck,
  IconListDetails,
  IconRefresh,
  IconRestore,
  IconShieldCheck,
  IconShieldX,
} from '@tabler/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiInfoDuotone, PiLinkDuotone, PiListBulletsDuotone } from 'react-icons/pi';

import {
  AUDIT_ACTIONS,
  AUDIT_EXPORT_FORMAT,
  AUDIT_EXPORT_VERSION,
  AUDIT_OUTCOMES,
  type AuditCheckpoint,
  type AuditCheckpointVerification,
  type AuditEvent,
  type AuditOutcome,
  type ChainVerification,
  type Permission,
} from '@swellwright/contracts';
import {
  Callout,
  CopyableCodeBlock,
  CopyableDataListItem,
  DataTableCard,
  HeaderAction,
  HeaderActionGroup,
  HeaderActions,
  MantineReactTable,
  type MRT_ColumnDef,
  type MRT_ColumnFiltersState,
  ModalFooter,
  OverlayHeader,
  PageHeader,
  panelTableOptions,
  SectionCard,
  StatusBadge,
  StatusText,
  type StatusKind,
  useMantineReactTable,
  useMrtTableState,
  usePreventTableBackScroll,
} from '@swellwright/ui';

import {
  createAuditCheckpoint,
  exportAudit,
  listAudit,
  verifyAuditCheckpoint,
  verifyAuditChain,
} from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { notifyError, notifySuccess } from '../shell/feedback.js';
import { useTableLocalization } from '../tables.js';
import { LABEL_WEIGHT } from './form-styles.js';
import { useTimeFirst } from './time-first.js';

/** Events per request when the log is exported: fewer requests, and each one is recorded in the log. */
const EXPORT_PAGE_SIZE = 1000;
/** How the exported file is checked without this server. A command, not a text to translate. */
const VERIFY_COMMAND = 'node dist/admin.js audit-verify <file>';

const OUTCOME_KIND: Record<AuditOutcome, StatusKind> = {
  success: 'ok',
  failure: 'err',
  denied: 'warn',
};

function detailsText(event: AuditEvent): string {
  return Object.entries(event.details)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');
}

/** What an event is about and the facts it carries, on one line: the second line of the "What" cell. */
function eventSummary(event: AuditEvent): string {
  return [event.object ? `${event.object.type} ${event.object.id}` : '', detailsText(event)]
    .filter(Boolean)
    .join(' · ');
}

/** Hands a file to the browser as a download. */
function saveFile(content: Blob, name: string): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // The download has started by then; a large file needs the address a little longer than a click does.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** The words for what a chain check found: the headline of a toast and the body of the result card. */
function useVerificationText() {
  const { t } = useTranslation('audit');
  return (result: ChainVerification): string => {
    if (result.ok) {
      return result.checked === 0
        ? t('verification.emptyLog')
        : t('verification.allChecked', { count: result.checked });
    }
    return result.problem
      ? [
          t(`verification.problem.${result.problem.reason}`, { seq: result.problem.seq }),
          t('verification.intactBefore', { count: result.checked }),
        ].join(' ')
      : t('verification.failed');
  };
}

/** What the check of the whole chain came to, as a card of its own under the page header. */
function VerificationResult({ result }: { result: ChainVerification }) {
  const { t } = useTranslation(['audit', 'common']);
  const describe = useVerificationText();
  return (
    <SectionCard.Root mb="md" role="status">
      <SectionCard.Section>
        <OverlayHeader
          icon={result.ok ? IconShieldCheck : IconShieldX}
          iconColor={result.ok ? 'teal' : 'red'}
          title={result.ok ? t('verification.intactTitle') : t('verification.brokenTitle')}
          titleOrder={5}
        />
      </SectionCard.Section>
      <SectionCard.Section>
        <Text size="sm">{describe(result)}</Text>
      </SectionCard.Section>
      {result.ok && result.head ? (
        <SectionCard.Section>
          <Stack gap="xs">
            <Text c="dimmed" size="sm">
              {t('verification.head', { seq: result.head.seq })}
            </Text>
            <CopyableCodeBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('common:copy')}
              inputWrapperProps={{ label: t('verification.headLabel'), styles: LABEL_WEIGHT }}
              size="small"
              value={result.head.hash}
            />
          </Stack>
        </SectionCard.Section>
      ) : null}
    </SectionCard.Root>
  );
}

/** The command that checks a downloaded file anywhere, shown before and after the export. */
function VerifyCommand() {
  const { t } = useTranslation(['audit', 'common']);
  return (
    <CopyableCodeBlock
      copiedLabel={t('common:copied')}
      copyLabel={t('common:copy')}
      inputWrapperProps={{ label: t('export.verifyHint'), styles: LABEL_WEIGHT }}
      size="small"
      value={VERIFY_COMMAND}
    />
  );
}

/** What the export came to: the file name, how many events it holds and the last of them. */
interface ExportDone {
  readonly file: string;
  readonly count: number;
  readonly head: { readonly seq: number; readonly hash: string } | null;
}

/**
 * Downloads the whole log as a file that can be checked without this server. Every page is fetched with a fresh
 * confirmation by code (asked again if it lapses on a long export) and the file is put together here.
 */
function ExportDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation(['audit', 'common']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const [fetched, setFetched] = useState(0);
  // Set when the person gives up or leaves the page: the run stops after the page it is waiting for.
  const run = useRef<{ stopped: boolean } | undefined>(undefined);

  useEffect(
    () => () => {
      if (run.current) {
        run.current.stopped = true;
      }
    },
    [],
  );

  const exportLog = useMutation({
    gcTime: 0,
    mutationFn: async (): Promise<ExportDone | undefined> => {
      const mine = { stopped: false };
      run.current = mine;
      setFetched(0);
      // Every page after the first is bounded by the head the first one saw, so the export ends although each page
      // writes an event of its own.
      let through: number | undefined;
      const fetchPage = (from: number | undefined) =>
        step.run(() =>
          exportAudit({
            limit: EXPORT_PAGE_SIZE,
            ...(from === undefined ? {} : { from }),
            ...(through === undefined ? {} : { through }),
          }),
        );

      const parts = [
        `${JSON.stringify({ format: AUDIT_EXPORT_FORMAT, version: AUDIT_EXPORT_VERSION })}\n`,
      ];
      let count = 0;
      let last: AuditEvent | undefined;
      let from: number | undefined;
      for (;;) {
        const page = await fetchPage(from);
        if (mine.stopped) {
          return undefined;
        }
        if (through === undefined) {
          if (page.head === null) {
            break;
          }
          through = page.head.seq;
        }
        for (const event of page.events) {
          parts.push(`${JSON.stringify(event)}\n`);
        }
        count += page.events.length;
        last = page.events.at(-1) ?? last;
        setFetched(count);
        if (page.nextFrom === null) {
          break;
        }
        // A page that does not move on would repeat for ever.
        if (page.nextFrom <= (from ?? 1)) {
          throw new Error('The export did not advance.');
        }
        from = page.nextFrom;
      }

      const file = `swellwright-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
      saveFile(new Blob(parts, { type: 'application/x-ndjson' }), file);
      return { file, count, head: last ? { seq: last.seq, hash: last.hash } : null };
    },
    onSuccess: (finished) => {
      if (finished) {
        notifySuccess(
          t('export.doneTitle'),
          t('export.done', { count: finished.count, file: finished.file }),
        );
      }
    },
    onError: (error) => {
      notifyError(
        t('export.title'),
        describeError(t, error, t('signInAgain'), t('exportForbidden')),
      );
    },
    // The export itself is recorded, page by page, even when it stops half way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });
  const done = exportLog.data;

  const close = () => {
    if (run.current) {
      run.current.stopped = true;
    }
    exportLog.reset();
    setFetched(0);
    onClose();
  };

  return (
    <Modal
      closeOnClickOutside={!exportLog.isPending}
      closeOnEscape={!exportLog.isPending}
      onClose={close}
      opened={opened}
      size="lg"
      title={<OverlayHeader icon={IconDownload} iconColor="teal" title={t('export.title')} />}
    >
      <Stack gap="md">
        {done ? (
          <SectionCard.Root role="status">
            <SectionCard.Section>
              <OverlayHeader
                icon={IconCheck}
                iconColor="teal"
                title={t('export.doneTitle')}
                titleOrder={5}
              />
            </SectionCard.Section>
            <SectionCard.Section>
              <Stack gap="xs">
                <Text size="sm">{t('export.done', { count: done.count, file: done.file })}</Text>
                {done.head ? (
                  <>
                    <Text c="dimmed" size="sm">
                      {t('export.head', { seq: done.head.seq })}
                    </Text>
                    <CopyableCodeBlock
                      copiedLabel={t('common:copied')}
                      copyLabel={t('common:copy')}
                      inputWrapperProps={{ label: t('export.headLabel'), styles: LABEL_WEIGHT }}
                      size="small"
                      value={done.head.hash}
                    />
                  </>
                ) : null}
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : (
          <>
            <Text size="sm">{t('export.intro')}</Text>
            <Text c="dimmed" size="sm">
              {t('export.stepUp')}
            </Text>
          </>
        )}
        <VerifyCommand />
        {exportLog.isPending ? (
          <Stack gap="xs" role="status">
            <Text size="sm">{t('export.progress', { count: fetched })}</Text>
            <Progress animated color="cyan" radius="xs" size="sm" striped value={100} />
          </Stack>
        ) : null}
      </Stack>
      <ModalFooter>
        {done ? (
          <Button color="teal" onClick={close} size="md" variant="light">
            {t('common:close')}
          </Button>
        ) : (
          <Button
            color="teal"
            leftSection={<IconDownload size={16} />}
            loading={exportLog.isPending}
            onClick={() => {
              exportLog.mutate();
            }}
            size="md"
            variant="soft"
          >
            {t('export.submit')}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

/** The checkpoint that was just made, with the plain warning that it is worth nothing if it stays here. */
function CheckpointDialog({
  checkpoint,
  opened,
  onClose,
}: {
  checkpoint: AuditCheckpoint | undefined;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['audit', 'common']);
  const formatTime = useTimeFirst();
  return (
    <Modal
      onClose={onClose}
      opened={opened && checkpoint !== undefined}
      size="lg"
      title={<OverlayHeader icon={IconBookmark} iconColor="orange" title={t('checkpoint.title')} />}
    >
      {checkpoint ? (
        <>
          <Stack gap="md">
            <Text size="sm">
              {t('checkpoint.made', {
                seq: checkpoint.seq,
                when: formatTime(checkpoint.issuedAt),
              })}
            </Text>
            <Callout color="yellow" title={t('checkpoint.warningTitle')}>
              {t('checkpoint.warning')}
            </Callout>
            <CopyableCodeBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('common:copy')}
              inputWrapperProps={{
                styles: LABEL_WEIGHT,
                label: t('checkpoint.valueLabel'),
                description: t('checkpoint.valueDescription'),
              }}
              size="small"
              value={checkpoint.checkpoint}
            />
          </Stack>
          <ModalFooter>
            <Button color="teal" onClick={onClose} size="md" variant="light">
              {t('common:close')}
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}

/** What a check against a checkpoint found, in words for an administrator. */
function CheckpointResult({ result }: { result: AuditCheckpointVerification }) {
  const { t } = useTranslation(['audit', 'common']);
  const formatTime = useTimeFirst();
  const kind = result.result;
  if (kind === 'ok') {
    return (
      <SectionCard.Root role="status">
        <SectionCard.Section>
          <OverlayHeader
            icon={IconShieldCheck}
            iconColor="teal"
            title={t('check.okTitle')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap={4}>
            {result.seq !== null && result.issuedAt !== null ? (
              <Text size="sm">
                {t('check.ok', { seq: result.seq, when: formatTime(result.issuedAt) })}
              </Text>
            ) : null}
            {result.eventsSince !== null ? (
              <Text c="dimmed" size="sm">
                {t('check.added', { count: result.eventsSince })}
              </Text>
            ) : null}
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>
    );
  }
  return (
    <SectionCard.Root role="alert">
      <SectionCard.Section>
        <OverlayHeader
          icon={IconShieldX}
          iconColor="red"
          title={t('check.failedTitle')}
          titleOrder={5}
        />
      </SectionCard.Section>
      <SectionCard.Section>
        <Text size="sm">{t(`check.result.${kind}`, { seq: result.seq ?? '?' })}</Text>
      </SectionCard.Section>
    </SectionCard.Root>
  );
}

/** Pastes a checkpoint noted earlier and checks the log against it. */
function CheckDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation(['audit', 'common']);
  const queryClient = useQueryClient();
  const formatTime = useTimeFirst();
  const [text, setText] = useState('');
  const check = useMutation({
    mutationFn: verifyAuditCheckpoint,
    // A check is recorded, so the list has a new event whatever the answer was.
    onSuccess: (result) => {
      if (result.result === 'ok' && result.seq !== null && result.issuedAt !== null) {
        notifySuccess(
          t('check.okTitle'),
          t('check.ok', { seq: result.seq, when: formatTime(result.issuedAt) }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (error) => {
      notifyError(
        t('check.title'),
        describeError(t, error, t('signInAgain'), t('checkpointForbidden')),
      );
    },
  });

  // A checkpoint has no spaces; a copy that was wrapped on the way may have gained line breaks.
  const value = text.replace(/\s+/gu, '');
  const close = () => {
    check.reset();
    setText('');
    onClose();
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (value.length > 0) {
      check.mutate(value);
    }
  };

  return (
    <Modal
      onClose={close}
      opened={opened}
      size="lg"
      title={<OverlayHeader icon={IconListCheck} iconColor="cyan" title={t('check.title')} />}
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            {t('check.intro')}
          </Text>
          <Textarea
            autoComplete="off"
            autosize
            data-autofocus
            label={t('check.inputLabel')}
            maxRows={6}
            minRows={2}
            onChange={(e) => {
              setText(e.currentTarget.value);
              // The answer belongs to the text that was checked, not to the one being typed.
              if (check.data !== undefined || check.error) {
                check.reset();
              }
            }}
            placeholder={t('check.inputPlaceholder')}
            spellCheck={false}
            styles={{
              ...LABEL_WEIGHT,
              input: { fontFamily: 'var(--mantine-font-family-monospace)' },
            }}
            value={text}
          />
          {check.data ? <CheckpointResult result={check.data} /> : null}
        </Stack>
        <ModalFooter>
          <Button
            color="teal"
            disabled={value.length === 0}
            leftSection={<IconListCheck size={16} />}
            loading={check.isPending}
            size="md"
            type="submit"
            variant="soft"
          >
            {t('check.submit')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** One event in full: every field the hashes cover, each copyable, grouped as the panel groups a record in a drawer. */
function EventDrawer({
  event,
  opened,
  onClose,
}: {
  event: AuditEvent | undefined;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['audit', 'common']);
  const formatTime = useTimeFirst();
  const copy = { copiedLabel: t('common:copied'), copyLabel: t('common:copy') };
  const details = event ? Object.entries(event.details) : [];
  return (
    <Drawer
      closeButtonProps={{ 'aria-label': t('common:close') }}
      onClose={onClose}
      opened={opened && event !== undefined}
      padding="lg"
      position="right"
      size="lg"
      title={
        <OverlayHeader
          icon={IconListDetails}
          iconColor="blue"
          title={t('event.title', { seq: event?.seq ?? 0 })}
        />
      }
    >
      {event ? (
        <Stack gap="md">
          <SectionCard.Root>
            <SectionCard.Section>
              <Group align="center" justify="space-between">
                <OverlayHeader
                  icon={PiInfoDuotone}
                  iconColor="blue"
                  title={t('event.sectionEvent')}
                />
                <StatusBadge h={28} kind={OUTCOME_KIND[event.outcome]}>
                  {t(`outcome.${event.outcome}`)}
                </StatusBadge>
              </Group>
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" withDivider>
                <CopyableDataListItem
                  label={t('columns.time')}
                  monospace
                  value={formatTime(event.occurredAt)}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('columns.who')}
                  value={event.actor?.name ?? t('nobody')}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('columns.what')}
                  monospace
                  value={event.action}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('event.object')}
                  monospace
                  value={event.object ? `${event.object.type} ${event.object.id}` : null}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('columns.address')}
                  monospace
                  value={event.ip}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('event.requestId')}
                  monospace
                  value={event.requestId}
                  {...copy}
                />
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>
          {details.length > 0 ? (
            <SectionCard.Root>
              <SectionCard.Section>
                <OverlayHeader
                  icon={PiListBulletsDuotone}
                  iconColor="violet"
                  title={t('event.sectionDetails')}
                />
              </SectionCard.Section>
              <SectionCard.Section>
                <DataList orientation="vertical" withDivider>
                  {details.map(([key, value]) => (
                    <CopyableDataListItem
                      key={key}
                      label={key}
                      monospace
                      value={value === null ? null : String(value)}
                      {...copy}
                    />
                  ))}
                </DataList>
              </SectionCard.Section>
            </SectionCard.Root>
          ) : null}
          <SectionCard.Root>
            <SectionCard.Section>
              <OverlayHeader
                icon={PiLinkDuotone}
                iconColor="gray"
                title={t('event.sectionChain')}
              />
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" withDivider>
                <CopyableDataListItem
                  label={t('event.prevHash')}
                  monospace
                  value={event.prevHash}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('event.hash')}
                  monospace
                  value={event.hash}
                  {...copy}
                />
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>
        </Stack>
      ) : null}
    </Drawer>
  );
}

/** The value of a text column filter, or nothing while it is empty. */
function filterText(filters: MRT_ColumnFiltersState, id: string): string | undefined {
  const value = filters.find((filter) => filter.id === id)?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const isFilled = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** How often the list reads the log again by itself, as the panel's inspector tables do. */
const REFRESH_MS = 25_000;

/** The audit log: newest first, filters under the head, and the integrity check for those who may run it. */
export function AuditPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['audit', 'common']);
  const formatTime = useTimeFirst();
  const queryClient = useQueryClient();
  const tableState = useMrtTableState('audit-v2');
  usePreventTableBackScroll();
  const [exporting, setExporting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showCheckpoint, setShowCheckpoint] = useState(false);
  // The event stays after its drawer is closed, so the text does not vanish mid-slide.
  const [viewed, setViewed] = useState<AuditEvent | undefined>(undefined);
  const [viewing, setViewing] = useState(false);
  const canVerify = permissions.includes('audit:verify');
  const canExport = permissions.includes('audit:export');
  const describeVerification = useVerificationText();

  const { columnFilters, pagination } = tableState.state;
  const action = filterText(columnFilters, 'action');
  const outcomeText = filterText(columnFilters, 'outcome');
  const outcome = AUDIT_OUTCOMES.find((known) => known === outcomeText);
  const filtersActive = action !== undefined || outcome !== undefined;

  // The panel's inspector tables page, filter and sort on the server; so does this one (the order is the chain's).
  const log = useQuery({
    queryKey: ['audit', 'list', action, outcome, pagination.pageIndex, pagination.pageSize],
    queryFn: () =>
      listAudit({
        limit: pagination.pageSize,
        offset: pagination.pageIndex * pagination.pageSize,
        ...(action ? { action } : {}),
        ...(outcome ? { outcome } : {}),
      }),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  // A page that is no longer there (the saved page number of an earlier visit, or a filter that matches less) goes to
  // the last one that is.
  const total = log.data?.total;
  const { onPaginationChange } = tableState.handlers;
  useEffect(() => {
    if (
      total !== undefined &&
      pagination.pageIndex > 0 &&
      pagination.pageIndex * pagination.pageSize >= total
    ) {
      onPaginationChange((previous) => ({
        ...previous,
        pageIndex: Math.max(0, Math.ceil(total / previous.pageSize) - 1),
      }));
    }
  }, [total, pagination.pageIndex, pagination.pageSize, onPaginationChange]);

  const verify = useMutation({
    mutationFn: verifyAuditChain,
    onSuccess: (result) => {
      if (result.ok) {
        notifySuccess(t('verification.intactTitle'), describeVerification(result));
      } else {
        notifyError(t('verification.brokenTitle'), describeVerification(result));
      }
      return queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (error) => {
      notifyError(
        t('verifyChain'),
        describeError(t, error, t('signInAgain'), t('verifyForbidden')),
      );
    },
  });

  // The checkpoint stays in the mutation after the dialog is closed, so its text does not vanish mid-fade.
  const noteHead = useMutation({
    mutationFn: createAuditCheckpoint,
    onSuccess: () => {
      setShowCheckpoint(true);
      return queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (error) => {
      notifyError(
        t('checkpoint.button'),
        describeError(t, error, t('signInAgain'), t('checkpointForbidden')),
      );
    },
  });

  const events = useMemo(() => log.data?.events ?? [], [log.data]);
  const open = (event: AuditEvent) => {
    setViewed(event);
    setViewing(true);
  };

  const columns = useMemo<MRT_ColumnDef<AuditEvent>[]>(
    () => [
      {
        accessorKey: 'seq',
        header: '#',
        size: 90,
        enableColumnFilter: false,
        Cell: ({ row }) => (
          <Text c="dimmed" ff="monospace" size="sm">
            {row.original.seq}
          </Text>
        ),
      },
      {
        id: 'occurredAt',
        header: t('columns.time'),
        accessorFn: (event) => formatTime(event.occurredAt),
        minSize: 250,
        enableColumnFilter: false,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
      {
        id: 'actor',
        header: t('columns.who'),
        accessorFn: (event) => event.actor?.name ?? t('nobody'),
        size: 170,
        enableColumnFilter: false,
      },
      {
        accessorKey: 'action',
        header: t('columns.what'),
        size: 360,
        filterVariant: 'select',
        mantineFilterSelectProps: ({ column }) => ({
          data: [...AUDIT_ACTIONS],
          searchable: true,
          clearable: isFilled(column.getFilterValue()),
        }),
        Cell: ({ row }) => {
          const summary = eventSummary(row.original);
          return (
            <Box>
              <Text ff="monospace" size="sm" truncate="end">
                {row.original.action}
              </Text>
              {summary ? (
                <Text c="dimmed" size="xs" title={summary} truncate="end">
                  {summary}
                </Text>
              ) : null}
            </Box>
          );
        },
      },
      {
        accessorKey: 'outcome',
        header: t('columns.outcome'),
        size: 190,
        filterVariant: 'select',
        mantineFilterSelectProps: ({ column }) => ({
          data: AUDIT_OUTCOMES.map((value) => ({ value, label: t(`outcome.${value}`) })),
          clearable: isFilled(column.getFilterValue()),
        }),
        Cell: ({ row }) => (
          <StatusText kind={OUTCOME_KIND[row.original.outcome]}>
            {t(`outcome.${row.original.outcome}`)}
          </StatusText>
        ),
      },
      {
        accessorKey: 'ip',
        header: t('columns.address'),
        accessorFn: (event) => event.ip ?? '–',
        size: 150,
        enableColumnFilter: false,
      },
    ],
    [t, formatTime],
  );

  const localization = useTableLocalization(filtersActive ? t('emptyFiltered') : t('empty'));
  const table = useMantineReactTable<AuditEvent>({
    ...panelTableOptions<AuditEvent>(),
    columns,
    data: events,
    localization,
    ...tableState.handlers,
    // A new filter starts again from the first page.
    onColumnFiltersChange: (updater) => {
      tableState.handlers.onColumnFiltersChange(updater);
      tableState.handlers.onPaginationChange((previous) => ({ ...previous, pageIndex: 0 }));
    },
    enableClickToCopy: true,
    enableSorting: false,
    manualFiltering: true,
    manualPagination: true,
    manualSorting: true,
    rowCount: log.data?.total ?? 0,
    ...(log.isError
      ? {
          mantineToolbarAlertBannerProps: {
            color: 'red',
            children: describeError(t, log.error, t('signInAgain'), t('readForbidden')),
          },
        }
      : {}),
    state: {
      ...tableState.state,
      isLoading: log.isPending,
      showAlertBanner: log.isError,
      showProgressBars: log.isFetching,
    },
    getRowId: (event) => String(event.seq),
    enableRowActions: true,
    displayColumnDefOptions: { 'mrt-row-actions': { size: 90 } },
    renderRowActions: ({ row }) => (
      <ActionIcon.Group>
        <Tooltip label={t('event.view')} withArrow>
          <ActionIcon
            aria-label={t('event.viewAria', { seq: row.original.seq })}
            color="gray"
            onClick={() => {
              open(row.original);
            }}
            size="input-sm"
            variant="soft"
          >
            <IconListDetails size="1.5rem" />
          </ActionIcon>
        </Tooltip>
      </ActionIcon.Group>
    ),
  });

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={log.isRefetching}
              onClick={() => void log.refetch()}
            />
            {canExport ? (
              <HeaderAction
                color="gray"
                icon={IconDownload}
                label={t('export.button')}
                onClick={() => {
                  setExporting(true);
                }}
              />
            ) : null}
            {canVerify ? (
              <>
                <HeaderAction
                  color="gray"
                  icon={IconBookmark}
                  label={t('checkpoint.button')}
                  loading={noteHead.isPending}
                  onClick={() => {
                    noteHead.mutate();
                  }}
                />
                <HeaderAction
                  color="gray"
                  icon={IconListCheck}
                  label={t('check.button')}
                  onClick={() => {
                    setChecking(true);
                  }}
                />
                <HeaderAction
                  color="teal"
                  icon={IconShieldCheck}
                  label={t('verifyChain')}
                  loading={verify.isPending}
                  onClick={() => {
                    verify.mutate();
                  }}
                />
              </>
            ) : null}
          </HeaderActions>
        }
        description={t('description')}
        icon={<IconBook size={24} />}
        title={t('title')}
      />

      {verify.data ? <VerificationResult result={verify.data} /> : null}

      <DataTableCard.Container>
        <DataTableCard.Title
          actions={
            <HeaderActionGroup>
              <HeaderAction
                color="gray"
                grouped
                icon={IconFilterOff}
                label={t('common:clearFilters')}
                onClick={() => {
                  table.resetPageIndex(false);
                  table.resetColumnFilters(true);
                }}
              />
              <HeaderAction
                color="gray"
                grouped
                icon={IconRestore}
                label={t('common:resetTable')}
                onClick={() => {
                  tableState.reset();
                  table.resetColumnFilters(true);
                }}
              />
            </HeaderActionGroup>
          }
          description={filtersActive ? t('list.descriptionFiltered') : t('list.description')}
          icon={<IconBook size={24} />}
          title={t('list.title')}
        />
        <DataTableCard.Content>
          <MantineReactTable table={table} />
        </DataTableCard.Content>
      </DataTableCard.Container>

      <EventDrawer
        event={viewed}
        onClose={() => {
          setViewing(false);
        }}
        opened={viewing}
      />
      {canExport ? (
        <ExportDialog
          onClose={() => {
            setExporting(false);
          }}
          opened={exporting}
        />
      ) : null}
      {canVerify ? (
        <>
          <CheckpointDialog
            checkpoint={noteHead.data}
            onClose={() => {
              setShowCheckpoint(false);
            }}
            opened={showCheckpoint}
          />
          <CheckDialog
            onClose={() => {
              setChecking(false);
            }}
            opened={checking}
          />
        </>
      ) : null}
    </>
  );
}
