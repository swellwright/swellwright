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
import { type SyntheticEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type Permission,
  PanelConsoleIssuesSchema,
  type PanelConsoleOperation,
  type PanelConsoleRequest,
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
import { notifyError, notifySuccess } from '../../shell/feedback.js';
import { panelKey } from '../panel-data.js';
import {
  addHistory,
  addSample,
  buildRequest,
  clearHistory,
  curlOf,
  type FormValues,
  fileNameOf,
  type HistoryEntry,
  missingRequired,
  newId,
  readHistory,
  readLastOperation,
  readSamples,
  removeSample,
  SAMPLE_BODY_MAX,
  type Sample,
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
  const [result, setResult] = useState<PanelConsoleResult | undefined>(undefined);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory);
  const [samples, setSamples] = useState<Sample[]>(readSamples);
  const [naming, setNaming] = useState(false);

  const detail = useQuery({
    queryKey: panelKey('console', 'operation', operation?.operationId ?? ''),
    queryFn: () => getPanelConsoleOperation(operation?.operationId ?? ''),
    enabled: operation !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const choose = (operationId: string, next: FormValues = {}) => {
    setChosen(operationId);
    writeLastOperation(operationId);
    setValues(next);
    setIssues({});
    setResult(undefined);
    setErrorText(undefined);
    // On a narrow screen the request is below the list: bring it into view.
    if (narrow) {
      requestRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const send = useMutation({
    mutationFn: (request: PanelConsoleRequest) => step.run(() => sendPanelConsoleRequest(request)),
    onSuccess: (answer, request) => {
      if (operation === undefined) {
        return;
      }
      setResult(answer);
      setErrorText(undefined);
      setIssues({});
      setHistory(
        addHistory({
          id: newId(),
          at: answer.sentAt,
          operationId: operation.operationId,
          path: operation.path,
          status: answer.status,
          durationMs: answer.durationMs,
          bytes: answer.bodyBytes,
          errorCode: null,
          // The values of a request about people (a short UUID, a name) are not kept in the browser.
          request: operation.availability === 'user_data' ? null : request,
        }),
      );
    },
    onError: (error, request) => {
      setResult(undefined);
      if (operation !== undefined) {
        setHistory(
          addHistory({
            id: newId(),
            at: new Date().toISOString(),
            operationId: operation.operationId,
            path: operation.path,
            status: null,
            durationMs: null,
            bytes: null,
            errorCode: error instanceof ApiRequestError ? error.code : null,
            request: operation.availability === 'user_data' ? null : request,
          }),
        );
      }
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
    if (result === undefined || operation === undefined) {
      return;
    }
    const json = result.bodyFormat === 'json';
    const url = URL.createObjectURL(
      new Blob([result.body], { type: json ? 'application/json' : 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameOf(operation.operationId, json ? 'json' : 'txt');
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const saveSample = (name: string) => {
    if (result === undefined || operation === undefined || request === undefined) {
      return;
    }
    const saved = addSample({
      id: newId(),
      name,
      savedAt: new Date().toISOString(),
      operationId: operation.operationId,
      path: operation.path,
      request,
      result: {
        status: result.status,
        bodyFormat: result.bodyFormat,
        body: result.body,
        bodyBytes: result.bodyBytes,
        truncated: result.truncated,
        maskedCount: result.maskedCount,
        durationMs: result.durationMs,
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
                        send.mutate(request);
                      }
                    }}
                    operation={operation}
                    sending={send.isPending}
                    userDataEnabled={catalogue.data.settings.userDataEnabled}
                    values={values}
                  />
                  <ResponseCard
                    canSaveSample={
                      result !== undefined &&
                      result.body.length <= SAMPLE_BODY_MAX &&
                      result.maskProfile === 'standard'
                    }
                    errorText={errorText}
                    onDownload={download}
                    onSaveSample={() => {
                      setNaming(true);
                    }}
                    operation={operation}
                    result={result}
                    schemaText={schemaText}
                    sending={send.isPending}
                  />
                </>
              )}
            </Stack>
          </Grid.Col>
        </Grid>
        <HistoryCard
          history={history}
          onClear={() => {
            clearHistory();
            setHistory([]);
          }}
          onOpenSample={(sample) => {
            const target = operations.find((o) => o.operationId === sample.operationId);
            if (target === undefined) {
              return;
            }
            choose(target.operationId, valuesOf(target, sample.request));
            setResult(resultOf(sample));
          }}
          onRemoveSample={(sample) => {
            setSamples(removeSample(sample.id));
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
