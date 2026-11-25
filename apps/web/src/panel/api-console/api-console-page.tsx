// New in Swellwright (ADR 0046). The Remnawave panel frontend 3.4.11 (AGPL-3.0-only) has no API console, so the page is
// put together from its patterns: the header card with a soft icon (src/shared/ui/page-header), the cards of its settings
// and template pages (`SectionCard`, `OverlayHeader`), a code card with Monaco in its dark theme, and the titled card with a
// `@kastov/mantine-react-table-open` table for the lists (as its Users page). The operations come from the description
// of the panel's API that ships with the server; the page sends only what the server allows, and shows only what the
// server has masked.
import { Button, Grid, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useClipboard, useMediaQuery } from '@mantine/hooks';
import { IconApi, IconBookmarkPlus } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type Permission,
  PanelConsoleIssuesSchema,
  type PanelConsoleOperation,
  type PanelConsoleResult,
} from '@swellwright/contracts';
import { LoadingScreen, ModalFooter, OverlayHeader, PageHeader } from '@swellwright/ui';

import {
  ApiRequestError,
  getPanelConnection,
  getPanelConsoleOperation,
  listPanelConsoleOperations,
  sendPanelConsoleRequest,
} from '../../api.js';
import { describeError } from '../../auth/messages.js';
import { useStepUp } from '../../auth/step-up.js';
import { QueryErrorCard } from '../../security/query-error.js';
import { useConsole } from '../../shell/console-context.js';
import { notifyError, notifySuccess } from '../../shell/feedback.js';
import { panelKey } from '../panel-data.js';
import {
  addHistory,
  addSample,
  buildRequest,
  canKeepSample,
  clearHistory,
  curlOf,
  type FormValues,
  fileNameOf,
  forgetLegacyStorage,
  type HistoryEntry,
  historyEntryOf,
  missingRequired,
  newId,
  readHistory,
  readLastOperation,
  readSamples,
  removeSample,
  type Sample,
  type Submission,
  submissionOf,
  valuesOf,
  writeLastOperation,
} from './console-model.js';
import { HistoryCard } from './history-card.js';
import { OperationList } from './operation-list.js';
import { RequestCard } from './request-card.js';
import { ResponseCard } from './response-card.js';

/** The operation the page opens on when the person has not chosen one yet. */
const DEFAULT_OPERATION = 'SystemController_getRemnawaveHealth';

/** A dialog that asks for the name of a sample. */
function SampleDialog({
  opened,
  onClose,
  onSave,
}: {
  opened: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  const [name, setName] = useState('');
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (name.trim() !== '') {
      onSave(name.trim());
      setName('');
    }
  };
  return (
    <Modal
      centered
      onClose={onClose}
      opened={opened}
      title={
        <OverlayHeader
          icon={IconBookmarkPlus}
          iconColor="teal"
          title={t('apiConsole:samples.dialogTitle')}
        />
      }
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            {t('apiConsole:samples.dialogText')}
          </Text>
          <TextInput
            autoFocus
            data-autofocus
            label={t('apiConsole:samples.name')}
            maxLength={100}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
            value={name}
          />
          <ModalFooter>
            <Button onClick={onClose} type="button" variant="subtle">
              {t('common:cancel')}
            </Button>
            <Button
              color="teal"
              disabled={name.trim() === ''}
              leftSection={<IconBookmarkPlus size={16} />}
              size="md"
              type="submit"
              variant="soft"
            >
              {t('apiConsole:samples.save')}
            </Button>
          </ModalFooter>
        </Stack>
      </form>
    </Modal>
  );
}

/** The result a saved sample stands for, so that it can be shown in the response card again. */
function resultOf(sample: Sample): PanelConsoleResult {
  return {
    operationId: sample.operationId,
    method: 'get',
    path: sample.path,
    status: sample.result.status,
    durationMs: sample.result.durationMs,
    attempts: 1,
    headers: {},
    contentType: null,
    bodyFormat: sample.result.bodyFormat,
    body: sample.result.body,
    bodyBytes: sample.result.bodyBytes,
    truncated: sample.result.truncated,
    masked: sample.result.maskedCount > 0,
    maskedCount: sample.result.maskedCount,
    maskProfile: 'standard',
    sentAt: sample.savedAt,
  };
}

/**
 * The API console of the connected panel: the operations of its API, a form for the selected one, the masked answer, and
 * the last calls and samples of this browser. It only reads; what is about people needs more than a role and a code.
 */
export function ApiConsolePage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['apiConsole', 'common', 'panel']);
  const step = useStepUp();
  const clipboard = useClipboard();
  const narrow = useMediaQuery('(max-width: 63.99em)');
  const requestRef = useRef<HTMLDivElement>(null);
  const canSend = permissions.includes('panel:console');
  // An operation about people needs `vault:reveal` as well (ADR 0046); the server checks it again.
  const canSendUserData = canSend && permissions.includes('vault:reveal');
  const { session } = useConsole();
  const userId = session.user.id;

  const catalogue = useQuery({
    queryKey: panelKey('console', 'catalogue'),
    queryFn: listPanelConsoleOperations,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const connection = useQuery({
    queryKey: panelKey('connection'),
    queryFn: getPanelConnection,
    retry: false,
  });
  const connected =
    connection.data === undefined ? undefined : connection.data.state !== 'unconfigured';

  const operations = useMemo(() => catalogue.data?.operations ?? [], [catalogue.data]);
  const [chosen, setChosen] = useState<string | undefined>(() => readLastOperation() ?? undefined);
  const operation: PanelConsoleOperation | undefined =
    operations.find((o) => o.operationId === chosen) ??
    operations.find((o) => o.operationId === DEFAULT_OPERATION) ??
    operations.find((o) => o.availability === 'open');

  const [values, setValues] = useState<FormValues>({});
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  // The answer on screen, with the request it answers (not the form as it is now).
  const [shown, setShown] = useState<
    { readonly result: PanelConsoleResult; readonly submission: Submission } | undefined
  >(undefined);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory(userId));
  const [samples, setSamples] = useState<Sample[]>(() => readSamples(userId));
  const [naming, setNaming] = useState(false);
  // Every choice of an operation (or of a sample, or a replay) is a new view. An answer is shown only in the view that
  // sent the request; in another it is only recorded in the history.
  const viewRef = useRef(0);
  const [view, setView] = useState(0);
  useEffect(() => {
    forgetLegacyStorage();
  }, []);

  const detail = useQuery({
    queryKey: panelKey('console', 'operation', operation?.operationId ?? ''),
    queryFn: () => getPanelConsoleOperation(operation?.operationId ?? ''),
    enabled: operation !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const choose = (operationId: string, next: FormValues = {}) => {
    viewRef.current += 1;
    setView(viewRef.current);
    setChosen(operationId);
    writeLastOperation(operationId);
    setValues(next);
    setIssues({});
    setShown(undefined);
    setErrorText(undefined);
    // On a narrow screen the request is below the list: bring it into view.
    if (narrow) {
      requestRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const send = useMutation({
    mutationFn: (submission: Submission) =>
      step.run(() => sendPanelConsoleRequest(submission.request)),
    onSuccess: (answer, submission) => {
      setHistory(addHistory(userId, historyEntryOf(submission, { answer }, newId())));
      if (submission.view !== viewRef.current) {
        return;
      }
      setShown({ result: answer, submission });
      setErrorText(undefined);
      setIssues({});
    },
    onError: (error, submission) => {
      setHistory(
        addHistory(
          userId,
          historyEntryOf(
            submission,
            {
              at: new Date().toISOString(),
              errorCode: error instanceof ApiRequestError ? error.code : null,
            },
            newId(),
          ),
        ),
      );
      if (submission.view !== viewRef.current) {
        return;
      }
      setShown(undefined);
      // A request that does not fit the operation: the server names the fields, and the fields show it.
      if (error instanceof ApiRequestError && error.code === 'validation_failed') {
        const parsed = PanelConsoleIssuesSchema.safeParse(error.details);
        if (parsed.success) {
          const next: Record<string, string> = {};
          for (const issue of parsed.data.issues) {
            const [where, name] = issue.path.split('.');
            if (name !== undefined) {
              next[`${where === 'pathParams' ? 'path' : 'query'}:${name}`] = issue.message;
            }
          }
          setIssues(next);
          setErrorText(undefined);
          return;
        }
      }
      setIssues({});
      setErrorText(describeError(t, error, t('panel:signInAgain'), t('apiConsole:errors.noRole')));
    },
  });
  // The spinner belongs to the view that sent the request.
  const sending = send.isPending && send.variables.view === view;

  const request = useMemo(
    () => (operation === undefined ? undefined : buildRequest(operation, values)),
    [operation, values],
  );
  const missing = useMemo(
    () => (operation === undefined ? [] : missingRequired(operation, values)),
    [operation, values],
  );

  const schemaText = useMemo(() => {
    if (operation === undefined || detail.data === undefined) {
      return detail.isError ? null : undefined;
    }
    const write = operation.method !== 'get';
    const schema = write ? detail.data.requestBodySchema : detail.data.responseSchema;
    if (schema === null || schema === undefined) {
      return null;
    }
    return {
      label: write ? t('apiConsole:response.tabBodySchema') : t('apiConsole:response.tabSchema'),
      text: JSON.stringify(schema, null, 2),
    };
  }, [operation, detail.data, detail.isError, t]);

  const download = () => {
    if (shown === undefined) {
      return;
    }
    const { result: answer, submission } = shown;
    const json = answer.bodyFormat === 'json';
    const url = URL.createObjectURL(
      new Blob([answer.body], { type: json ? 'application/json' : 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameOf(submission.operationId, json ? 'json' : 'txt');
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const saveSample = (name: string) => {
    // The sample is the request that was sent and its answer, never the form as it is now.
    if (shown === undefined || !canKeepSample(shown.submission, shown.result)) {
      setNaming(false);
      return;
    }
    const { result: answer, submission } = shown;
    const saved = addSample(userId, {
      id: newId(),
      name,
      savedAt: new Date().toISOString(),
      operationId: submission.operationId,
      path: submission.path,
      request: submission.request,
      result: {
        status: answer.status,
        bodyFormat: answer.bodyFormat,
        body: answer.body,
        bodyBytes: answer.bodyBytes,
        truncated: answer.truncated,
        maskedCount: answer.maskedCount,
        durationMs: answer.durationMs,
      },
    });
    setSamples(saved.samples);
    setNaming(false);
    if (saved.ok) {
      notifySuccess(t('apiConsole:samples.saved'), name);
    } else {
      notifyError(t('apiConsole:samples.failed'), t('apiConsole:samples.failedText'));
    }
  };

  if (catalogue.isPending) {
    return (
      <>
        <PageHeader
          description={t('apiConsole:description')}
          icon={<IconApi size={24} />}
          title={t('apiConsole:title')}
        />
        <LoadingScreen height="60vh" />
      </>
    );
  }
  if (catalogue.isError) {
    return (
      <>
        <PageHeader
          description={t('apiConsole:description')}
          icon={<IconApi size={24} />}
          title={t('apiConsole:title')}
        />
        <QueryErrorCard
          message={describeError(
            t,
            catalogue.error,
            t('panel:signInAgain'),
            t('panel:readForbidden'),
          )}
          onRetry={() => {
            void catalogue.refetch();
          }}
          title={t('apiConsole:loadFailed')}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description={t('apiConsole:description')}
        icon={<IconApi size={24} />}
        title={t('apiConsole:title')}
      />
      <Stack gap="md">
        <Grid gap="md">
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <OperationList
              height={narrow ? 340 : 720}
              onSelect={(operationId) => {
                choose(operationId);
              }}
              operations={operations}
              selected={operation?.operationId}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Stack
              gap="md"
              ref={requestRef}
              style={{ scrollMarginTop: 'var(--sw-header-height, 124px)' }}
            >
              {operation === undefined ? null : (
                <>
                  <RequestCard
                    canSend={canSend}
                    canSendUserData={canSendUserData}
                    connected={connected}
                    issues={issues}
                    missing={missing}
                    onChange={(key, value) => {
                      setValues((previous) => ({ ...previous, [key]: value }));
                      setIssues((previous) => {
                        if (previous[key] === undefined) {
                          return previous;
                        }
                        return Object.fromEntries(
                          Object.entries(previous).filter(([name]) => name !== key),
                        );
                      });
                    }}
                    onCopyCurl={() => {
                      clipboard.copy(
                        curlOf(
                          operation,
                          request ?? { operationId: operation.operationId },
                          connection.data?.baseUrl ?? null,
                        ),
                      );
                      notifySuccess(t('common:copied'), t('apiConsole:request.curlCopied'));
                    }}
                    onSend={() => {
                      if (request !== undefined) {
                        send.mutate(submissionOf(operation, request, viewRef.current));
                      }
                    }}
                    operation={operation}
                    sending={sending}
                    userDataEnabled={catalogue.data.settings.userDataEnabled}
                    values={values}
                  />
                  <ResponseCard
                    canSaveSample={
                      shown !== undefined && canKeepSample(shown.submission, shown.result)
                    }
                    errorText={errorText}
                    onDownload={download}
                    onSaveSample={() => {
                      setNaming(true);
                    }}
                    operation={operation}
                    result={shown?.result}
                    schemaText={schemaText}
                    sending={sending}
                  />
                </>
              )}
            </Stack>
          </Grid.Col>
        </Grid>
        <HistoryCard
          history={history}
          onClear={() => {
            clearHistory(userId);
            setHistory([]);
          }}
          onOpenSample={(sample) => {
            const target = operations.find((o) => o.operationId === sample.operationId);
            if (target === undefined) {
              return;
            }
            choose(target.operationId, valuesOf(target, sample.request));
            setShown({
              result: resultOf(sample),
              submission: submissionOf(target, sample.request, viewRef.current),
            });
          }}
          onRemoveSample={(sample) => {
            setSamples(removeSample(userId, sample.id));
          }}
          onReplay={(entry) => {
            const target = operations.find((o) => o.operationId === entry.operationId);
            if (target === undefined) {
              return;
            }
            choose(
              target.operationId,
              entry.request === null ? {} : valuesOf(target, entry.request),
            );
          }}
          samples={samples}
        />
      </Stack>
      <SampleDialog
        onClose={() => {
          setNaming(false);
        }}
        onSave={saveSample}
        opened={naming}
      />
    </>
  );
}
