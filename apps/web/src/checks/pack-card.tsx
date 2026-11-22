// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the editor card of the config profiles and templates pages
// (src/widgets/dashboard/config-profiles/config-editor/config-editor.widget.tsx: Monaco in a titled card with a footer bar
// of actions) and the drawers with a sticky footer (src/shared/ui/drawer-footer). Changes: the document is a convention pack
// (YAML or JSON), the editor checks it on the server while it is typed (a list of problems with their lines and paths, not
// markers in the text), saving makes a new version and asks for a code, and the history of versions is a tab of the drawer.
import {
  ActionIcon,
  Badge,
  Button,
  Drawer,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TbChecklist, TbDownload, TbHistory, TbPencil, TbRestore, TbUpload } from 'react-icons/tb';

import type { ConventionPackView, PackIssue } from '@swellwright/contracts';
import { CONVENTION_PACK_LIMITS } from '@swellwright/contracts';
import {
  Callout,
  CopyableCodeBlock,
  DrawerFooter,
  OverlayHeader,
  SectionCard,
  StatusBadge,
} from '@swellwright/ui';

import { ApiRequestError } from '../api.js';
import { useStepUp } from '../auth/step-up.js';
import { CodeEditor } from '../commands/code-editor.js';
import { useDateTime } from '../format.js';
import { PanelReadFailure } from '../panel/panel-data.js';
import { notifyFailure } from '../security/notify-failure.js';
import { confirmAction, notifyError, notifySuccess } from '../shell/feedback.js';
import {
  getConventionPack,
  listConventionPackVersions,
  resetConventionPack,
  saveConventionPack,
  validateConventionPack,
} from './checks-api.js';
import { checksKey } from './checks-data.js';

/** Starts the download of a text, as a file. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const fileName = (pack: ConventionPackView): string =>
  `conventions-${pack.pack.version === null ? 'built-in' : `v${String(pack.pack.version)}`}.yaml`;

function Issues({ issues }: { issues: readonly PackIssue[] }) {
  const { t } = useTranslation('checks');
  return (
    <Stack gap="xs">
      {issues.map((issue, index) => (
        <Group align="flex-start" gap="xs" key={`${issue.path}:${String(index)}`} wrap="nowrap">
          <StatusBadge iconSize={16} kind={issue.severity === 'error' ? 'err' : 'warn'} size="md">
            {t(`ui.conventions.pack.editor.${issue.severity}`)}
          </StatusBadge>
          <Stack gap={0}>
            <Text size="sm">{issue.message}</Text>
            <Text c="dimmed" ff="monospace" size="xs">
              {issue.path}
              {issue.line === null
                ? ''
                : ` · ${t('ui.conventions.pack.editor.line', { line: issue.line })}`}
            </Text>
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

/** What the server said about a failed save: the issues of a pack that is not valid, when it sent them. */
function issuesOf(error: unknown): PackIssue[] {
  if (
    !(error instanceof ApiRequestError) ||
    typeof error.details !== 'object' ||
    error.details === null
  ) {
    return [];
  }
  const issues = (error.details as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as PackIssue[]) : [];
}

function PackEditorDrawer({
  opened,
  onClose,
  pack,
  initialText,
  canWrite,
}: {
  opened: boolean;
  onClose: () => void;
  pack: ConventionPackView;
  /** The text to start from (an imported file); the pack in use when not given. */
  initialText: string | undefined;
  canWrite: boolean;
}) {
  const { t } = useTranslation(['checks', 'common', 'panel']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const formatTime = useDateTime();
  const [text, setText] = useState(initialText ?? pack.yaml);
  const [comment, setComment] = useState('');
  const [conflict, setConflict] = useState(false);
  const [serverIssues, setServerIssues] = useState<PackIssue[]>([]);
  const [debounced] = useDebouncedValue(text, 450);
  // The pack the editor started from: the version a save is checked against.
  const baseVersion = pack.pack.version;

  const validation = useQuery({
    queryKey: checksKey('validate', debounced),
    queryFn: () => validateConventionPack({ yaml: debounced }),
    enabled: opened && debounced.trim() !== '',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
  });
  const history = useQuery({
    queryKey: checksKey('versions'),
    queryFn: listConventionPackVersions,
    enabled: opened,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      step.run(() =>
        saveConventionPack({
          yaml: text,
          expectedVersion: baseVersion,
          ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
        }),
      ),
    onSuccess: (saved) => {
      notifySuccess(
        t('checks:ui.conventions.pack.editor.title'),
        t('checks:ui.conventions.pack.editor.saved', { version: saved.pack.version ?? 0 }),
      );
      void queryClient.invalidateQueries({ queryKey: checksKey() });
      setComment('');
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'conflict') {
        setConflict(true);
        return;
      }
      setServerIssues(issuesOf(error));
      notifyFailure(
        t,
        t('checks:ui.conventions.pack.editor.title'),
        error,
        t('panel:signInAgain'),
        t('checks:ui.conventions.pack.noWrite'),
      );
    },
  });

  const loadVersion = useMutation({
    mutationFn: (version: number) => getConventionPack(version),
    onSuccess: (loaded) => {
      setText(loaded.yaml);
      setServerIssues([]);
    },
  });
  const reload = useMutation({
    mutationFn: () => getConventionPack(),
    onSuccess: (active) => {
      setText(active.yaml);
      setConflict(false);
      void queryClient.invalidateQueries({ queryKey: checksKey('pack') });
    },
  });

  const result = validation.data;
  const current = debounced === text;
  const valid = current && result?.valid === true;
  const issues = serverIssues.length > 0 ? serverIssues : current ? (result?.issues ?? []) : [];
  const changed = text !== pack.yaml;

  return (
    <Drawer
      closeButtonProps={{ 'aria-label': t('common:close'), ...{ 'data-autofocus': true } }}
      onClose={onClose}
      opened={opened}
      padding="lg"
      position="right"
      size="900px"
      title={
        <OverlayHeader
          icon={TbChecklist}
          iconColor="cyan"
          subtitle={pack.pack.name}
          title={t('checks:ui.conventions.pack.editor.title')}
        />
      }
    >
      <Tabs color="cyan" keepMounted={false} defaultValue="editor">
        <Tabs.List mb="md">
          <Tabs.Tab leftSection={<TbPencil size={18} />} value="editor">
            {t('checks:ui.conventions.pack.edit')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<TbHistory size={18} />} value="history">
            {t('checks:ui.conventions.pack.editor.historyTitle')}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="editor">
          <Stack gap="md">
            {conflict ? (
              <Callout color="orange">
                <Stack gap="xs">
                  <Text size="sm">{t('checks:ui.conventions.pack.editor.conflict')}</Text>
                  <Group>
                    <Button
                      color="orange"
                      loading={reload.isPending}
                      onClick={() => {
                        reload.mutate();
                      }}
                      size="xs"
                      variant="light"
                    >
                      {t('checks:ui.conventions.pack.editor.reload')}
                    </Button>
                  </Group>
                </Stack>
              </Callout>
            ) : null}
            <Text c="dimmed" size="xs">
              {t('checks:ui.conventions.pack.editor.hintSecrets')}{' '}
              {t('checks:ui.conventions.pack.editor.hintPatterns')}
            </Text>
            <CodeEditor
              height="480px"
              label={t('checks:ui.conventions.pack.editor.yaml')}
              language="yaml"
              onChange={(value) => {
                setText(value);
                setServerIssues([]);
              }}
              readOnly={!canWrite}
              value={text}
            />
            <Group gap="xs" wrap="nowrap">
              {validation.isFetching || !current ? (
                <>
                  <Loader size="xs" />
                  <Text c="dimmed" size="sm">
                    {t('checks:ui.conventions.pack.editor.checking')}
                  </Text>
                </>
              ) : result === undefined ? null : (
                <StatusBadge kind={result.valid ? 'ok' : 'err'}>
                  {result.valid
                    ? t('checks:ui.conventions.pack.editor.valid')
                    : t('checks:ui.conventions.pack.editor.invalid')}
                </StatusBadge>
              )}
            </Group>
            {issues.length === 0 ? null : (
              <SectionCard.Root>
                <SectionCard.Section>
                  <Text fw={600} size="sm">
                    {t('checks:ui.conventions.pack.editor.issues')}
                  </Text>
                </SectionCard.Section>
                <SectionCard.Section>
                  <Issues issues={issues} />
                </SectionCard.Section>
              </SectionCard.Root>
            )}
            <TextInput
              disabled={!canWrite}
              label={t('checks:ui.conventions.pack.editor.comment')}
              maxLength={500}
              onChange={(event) => {
                setComment(event.currentTarget.value);
              }}
              placeholder={t('checks:ui.conventions.pack.editor.commentPlaceholder')}
              value={comment}
            />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="history">
          {history.isError ? (
            <PanelReadFailure
              error={history.error}
              onRetry={() => {
                void history.refetch();
              }}
            />
          ) : history.isPending ? (
            <Loader size="sm" />
          ) : history.data.versions.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('checks:ui.conventions.pack.editor.noHistory')}
            </Text>
          ) : (
            <Stack gap="xs">
              {history.data.versions.map((version) => (
                <SectionCard.Root key={version.version}>
                  <SectionCard.Section>
                    <Group gap="md" justify="space-between" wrap="nowrap">
                      <Stack gap={2} miw={0}>
                        <Group gap="xs">
                          <Text fw={600} size="sm">
                            {t('checks:ui.conventions.pack.version', { version: version.version })}
                          </Text>
                          {version.active ? (
                            <Badge color="teal" size="md" variant="soft">
                              {t('checks:ui.conventions.pack.editor.current')}
                            </Badge>
                          ) : null}
                        </Group>
                        <Text c="dimmed" size="xs">
                          {version.createdBy ?? '–'} · {formatTime(version.createdAt)}
                        </Text>
                        {version.comment === null ? null : <Text size="sm">{version.comment}</Text>}
                      </Stack>
                      <Button
                        loading={loadVersion.isPending && loadVersion.variables === version.version}
                        onClick={() => {
                          loadVersion.mutate(version.version);
                        }}
                        size="xs"
                        variant="light"
                      >
                        {t('checks:ui.conventions.pack.editor.load')}
                      </Button>
                    </Group>
                  </SectionCard.Section>
                </SectionCard.Root>
              ))}
            </Stack>
          )}
        </Tabs.Panel>
      </Tabs>

      <DrawerFooter>
        <Button color="gray" onClick={onClose} variant="subtle">
          {t('common:cancel')}
        </Button>
        <Tooltip disabled={canWrite} label={t('checks:ui.conventions.pack.noWrite')} withArrow>
          <span>
            <Button
              color="teal"
              disabled={!canWrite || !valid || !changed}
              loading={save.isPending}
              onClick={() => {
                setConflict(false);
                save.mutate();
              }}
              variant="soft"
            >
              {t('checks:ui.conventions.pack.editor.save')}
            </Button>
          </span>
        </Tooltip>
      </DrawerFooter>
    </Drawer>
  );
}

/** The pack in use: its name, version and hash, and what can be done with it. */
export function PackCard({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation(['checks', 'common', 'panel']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const formatTime = useDateTime();
  const [editing, setEditing] = useState(false);
  const [imported, setImported] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement | null>(null);
  const pack = useQuery({
    queryKey: checksKey('pack'),
    queryFn: () => getConventionPack(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const reset = useMutation({
    mutationFn: () => step.run(() => resetConventionPack()),
    onSuccess: () => {
      notifySuccess(
        t('checks:ui.conventions.pack.title'),
        t('checks:ui.conventions.pack.resetDone'),
      );
      void queryClient.invalidateQueries({ queryKey: checksKey() });
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('checks:ui.conventions.pack.title'),
        error,
        t('panel:signInAgain'),
        t('checks:ui.conventions.pack.noWrite'),
      );
    },
  });

  if (pack.isError) {
    return (
      <PanelReadFailure
        error={pack.error}
        onRetry={() => {
          void pack.refetch();
        }}
      />
    );
  }
  const view = pack.data;
  const custom = view?.pack.source === 'custom';

  const onFile = async (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    if (file.size > CONVENTION_PACK_LIMITS.textChars * 4) {
      notifyError(
        t('checks:ui.conventions.pack.title'),
        t('checks:ui.conventions.pack.editor.importTooBig'),
      );
      return;
    }
    try {
      const content = await file.text();
      setImported(content);
      setEditing(true);
      notifySuccess(
        t('checks:ui.conventions.pack.title'),
        t('checks:ui.conventions.pack.editor.imported', { name: file.name }),
      );
    } catch {
      notifyError(
        t('checks:ui.conventions.pack.title'),
        t('checks:ui.conventions.pack.editor.importFailed'),
      );
    }
  };

  return (
    <>
      <SectionCard.Root mt="md">
        <SectionCard.Section>
          <Group align="flex-start" gap="md" justify="space-between" wrap="wrap">
            <Stack gap="xs" miw={0}>
              <OverlayHeader
                icon={TbChecklist}
                iconColor="cyan"
                iconSize={18}
                subtitle={t('checks:ui.conventions.pack.description')}
                title={t('checks:ui.conventions.pack.title')}
                titleOrder={5}
              />
              {view === undefined ? (
                <Loader size="sm" />
              ) : (
                <Group gap="xs">
                  <Badge color={custom ? 'cyan' : 'gray'} size="lg" variant="soft">
                    {custom
                      ? t('checks:ui.conventions.pack.custom')
                      : t('checks:ui.conventions.pack.builtIn')}
                  </Badge>
                  <Text fw={600} size="sm">
                    {view.pack.name}
                  </Text>
                  {view.pack.version === null ? null : (
                    <Badge color="teal" size="lg" variant="soft">
                      {t('checks:ui.conventions.pack.version', { version: view.pack.version })}
                    </Badge>
                  )}
                </Group>
              )}
              {view === undefined ? null : custom ? (
                <Text c="dimmed" size="xs">
                  {t('checks:ui.conventions.pack.savedBy', {
                    user: view.createdBy ?? '–',
                    time: view.createdAt === null ? '–' : formatTime(view.createdAt),
                  })}
                  {view.comment === null ? '' : ` · ${view.comment}`}
                </Text>
              ) : (
                <Text c="dimmed" size="xs">
                  {t('checks:ui.conventions.pack.builtInHint')}
                </Text>
              )}
              {view === undefined ? null : (
                <CopyableCodeBlock
                  inputWrapperProps={{ label: t('checks:ui.conventions.pack.hash') }}
                  size="small"
                  value={view.pack.hash}
                />
              )}
            </Stack>
            <Group gap="xs" wrap="wrap">
              <Tooltip
                disabled={canWrite}
                label={t('checks:ui.conventions.pack.noWrite')}
                withArrow
              >
                <span>
                  <Button
                    color="cyan"
                    disabled={view === undefined || !canWrite}
                    leftSection={<TbPencil size={18} />}
                    onClick={() => {
                      setImported(undefined);
                      setEditing(true);
                    }}
                    variant="light"
                  >
                    {t('checks:ui.conventions.pack.edit')}
                  </Button>
                </span>
              </Tooltip>
              <Button
                disabled={view === undefined}
                leftSection={<TbDownload size={18} />}
                onClick={() => {
                  if (view !== undefined) {
                    download(fileName(view), view.yaml);
                  }
                }}
                variant="default"
              >
                {t('checks:ui.conventions.pack.export')}
              </Button>
              <input
                accept=".yaml,.yml,.json,text/plain,application/json"
                hidden
                onChange={(event) => {
                  void onFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = '';
                }}
                ref={input}
                type="file"
              />
              <Tooltip
                disabled={canWrite}
                label={t('checks:ui.conventions.pack.noWrite')}
                withArrow
              >
                <span>
                  <Button
                    disabled={!canWrite}
                    leftSection={<TbUpload size={18} />}
                    onClick={() => input.current?.click()}
                    variant="default"
                  >
                    {t('checks:ui.conventions.pack.import')}
                  </Button>
                </span>
              </Tooltip>
              {custom && canWrite ? (
                <Tooltip label={t('checks:ui.conventions.pack.reset')} withArrow>
                  <ActionIcon
                    aria-label={t('checks:ui.conventions.pack.reset')}
                    color="red"
                    loading={reset.isPending}
                    onClick={() => {
                      confirmAction({
                        title: t('checks:ui.conventions.pack.resetTitle'),
                        message: t('checks:ui.conventions.pack.resetText'),
                        confirmLabel: t('checks:ui.conventions.pack.reset'),
                        cancelLabel: t('common:cancel'),
                        onConfirm: () => {
                          reset.mutate();
                        },
                      });
                    }}
                    size="input-sm"
                    variant="soft"
                  >
                    <TbRestore size={20} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
            </Group>
          </Group>
        </SectionCard.Section>
      </SectionCard.Root>
      {view === undefined ? null : (
        <PackEditorDrawer
          canWrite={canWrite}
          initialText={imported}
          key={`${view.pack.hash}:${imported === undefined ? 'active' : 'imported'}:${editing ? 'open' : 'shut'}`}
          onClose={() => {
            setEditing(false);
            setImported(undefined);
          }}
          opened={editing}
          pack={view}
        />
      )}
    </>
  );
}
