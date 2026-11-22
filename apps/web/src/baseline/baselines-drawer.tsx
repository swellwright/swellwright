// The drawer follows the panel's detail drawers (a wide `Drawer` on the right, `OverlayHeader`, grouped `SectionCard`s, the
// sticky `DrawerFooter`). The panel edits a configuration profile in its code editor with a validation under it; the
// baseline document is edited the same way (Monaco, the problems underlined, a line that says whether the text is valid).
import {
  Accordion,
  Badge,
  Button,
  Code,
  Drawer,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconChecklist, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { BaselineSummary, ServerSummary } from '@swellwright/contracts';
import {
  Callout,
  DrawerFooter,
  LoaderModal,
  ModalFooter,
  OverlayHeader,
  SectionCard,
} from '@swellwright/ui';

import {
  ApiRequestError,
  createBaseline,
  deleteBaseline,
  getBaseline,
  getBaselineCatalogue,
  listBaselines,
  setBaselineAssignments,
  updateBaseline,
  validateBaseline,
} from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { CodeEditor } from '../commands/code-editor.js';
import { useDateTime } from '../format.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';

const STARTER = `schema: 1
description: What a healthy server looks like.
checks:
  - id: ssh.root-login
    title: Root cannot log in with a password
    category: ssh
    severity: medium
    observe: { kind: sshd.effective, field: permitrootlogin }
    expect: { in: [no, prohibit-password, forced-commands-only] }
    remediationHint: Set PermitRootLogin no.
`;

type View = { kind: 'list' } | { kind: 'edit'; id: string } | { kind: 'new'; source: string };

/** The problems of a text as the editor underlines them, and a line that says whether it is valid. */
function useValidation(source: string, enabled: boolean) {
  const [debounced] = useDebouncedValue(source, 450);
  const query = useQuery({
    queryKey: ['baseline', 'validate', debounced],
    queryFn: () => validateBaseline(debounced),
    enabled: enabled && debounced.trim() !== '',
    retry: false,
    staleTime: 60_000,
  });
  return { settled: debounced === source, result: query.data, pending: query.isFetching };
}

function ValidationLine({
  source,
  settled,
  pending,
  result,
}: {
  source: string;
  settled: boolean;
  pending: boolean;
  result: ReturnType<typeof useValidation>['result'];
}) {
  const { t } = useTranslation(['baseline']);
  if (source.trim() === '') {
    return null;
  }
  if (!settled || pending || result === undefined) {
    return (
      <Text c="dimmed" fz="sm">
        {t('baseline:baselines.validating')}
      </Text>
    );
  }
  if (result.valid) {
    return (
      <Text c="teal" fz="sm">
        {t('baseline:baselines.valid', { count: result.checkCount })}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      <Text c="red" fz="sm">
        {t('baseline:baselines.invalid')}
      </Text>
      {result.issues.slice(0, 8).map((issue, index) => (
        <Text fz="xs" key={`${issue.path}-${String(index)}`}>
          {issue.line === null ? '' : `${t('baseline:baselines.line', { line: issue.line })}: `}
          {issue.message}
          {issue.path === '' ? '' : ` (${issue.path})`}
        </Text>
      ))}
    </Stack>
  );
}

/** What the catalogue offers, for a person who writes a baseline: kinds, their parameters and fields. */
function CatalogueReference() {
  const { t } = useTranslation(['baseline']);
  const catalogue = useQuery({
    queryKey: ['baseline', 'catalogue'],
    queryFn: getBaselineCatalogue,
    retry: false,
    staleTime: Infinity,
  });
  if (catalogue.data === undefined) {
    return null;
  }
  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Stack gap="xs">
          <Text fw={600}>{t('baseline:baselines.catalogue')}</Text>
          <Text c="dimmed" fz="xs">
            {t('baseline:baselines.catalogueHint')}
          </Text>
          <Accordion variant="separated">
            {catalogue.data.kinds.map((kind) => (
              <Accordion.Item key={kind.kind} value={kind.kind}>
                <Accordion.Control>
                  <Group gap="xs" wrap="nowrap">
                    <Code>{kind.kind}</Code>
                    <Text fz="sm" truncate>
                      {kind.title}
                    </Text>
                    {kind.needsRoot ? (
                      <Badge color="gray" size="sm" tt="none" variant="soft">
                        {t('baseline:baselines.needsRoot')}
                      </Badge>
                    ) : null}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap={6}>
                    <Text fz="xs">{kind.description}</Text>
                    {kind.params.length > 0 ? (
                      <Text fz="xs">
                        <Text component="span" fw={500} fz="xs">
                          {t('baseline:baselines.kindParams')}:
                        </Text>{' '}
                        {kind.params
                          .map((param) => `${param.name}${param.required ? '*' : ''}`)
                          .join(', ')}
                      </Text>
                    ) : null}
                    <Text fz="xs">
                      <Text component="span" fw={500} fz="xs">
                        {t('baseline:baselines.kindFields')}:
                      </Text>{' '}
                      {kind.fields.map((field) => `${field.name} (${field.type})`).join(', ')}
                    </Text>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </Stack>
      </SectionCard.Section>
    </SectionCard.Root>
  );
}

function BaselineList({
  canWrite,
  onOpen,
  onNew,
}: {
  canWrite: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const list = useQuery({ queryKey: ['baseline', 'list'], queryFn: listBaselines, retry: false });
  if (list.isPending) {
    return <LoaderModal mih="40vh" />;
  }
  if (list.isError) {
    return (
      <QueryErrorCard
        message={describeError(
          t,
          list.error,
          t('baseline:signInAgain'),
          t('baseline:readForbidden'),
        )}
        onRetry={() => void list.refetch()}
        title={t('baseline:baselines.loadFailed')}
      />
    );
  }
  return (
    <Stack gap="md">
      <Text c="dimmed" fz="sm">
        {t('baseline:baselines.description')}
      </Text>
      {canWrite ? (
        <Group>
          <Button leftSection={<IconPlus size={18} />} onClick={onNew} variant="light">
            {t('baseline:baselines.new')}
          </Button>
        </Group>
      ) : null}
      {list.data.baselines.length === 0 ? (
        <Text c="dimmed" fz="sm">
          {t('baseline:baselines.empty')}
        </Text>
      ) : (
        list.data.baselines.map((baseline) => (
          <SectionCard.Root
            key={baseline.id}
            onClick={() => {
              onOpen(baseline.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onOpen(baseline.id);
              }
            }}
            role="button"
            style={{ cursor: 'pointer' }}
            tabIndex={0}
          >
            <SectionCard.Section>
              <Stack gap={4}>
                <Group gap="xs" justify="space-between" wrap="nowrap">
                  <Text fw={600} truncate>
                    {baseline.name}
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    {baseline.builtIn ? (
                      <Badge color="cyan" size="lg" tt="none" variant="soft">
                        {t('baseline:baselines.builtIn')}
                      </Badge>
                    ) : null}
                    <Badge color="gray" size="lg" tt="none" variant="soft">
                      {t('baseline:baselines.version', { version: baseline.currentVersion })}
                    </Badge>
                  </Group>
                </Group>
                {baseline.description ? (
                  <Text c="dimmed" fz="sm" lineClamp={2}>
                    {baseline.description}
                  </Text>
                ) : null}
                <Group gap="md">
                  <Text c="dimmed" fz="xs">
                    {t('baseline:baselines.checks', { count: baseline.checkCount })}
                  </Text>
                  <Text c="dimmed" fz="xs">
                    {t('baseline:baselines.servers', { count: baseline.serverCount })}
                  </Text>
                </Group>
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ))
      )}
    </Stack>
  );
}

function CopyDialog({
  opened,
  source,
  onClose,
  onCreated,
}: {
  opened: boolean;
  source: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const step = useStepUp();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => step.run(() => createBaseline({ name: name.trim(), source })),
    onSuccess: async (created) => {
      notifySuccess(t('baseline:baselines.copyDone'));
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
      setName('');
      onCreated(created.id);
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:baselines.createFailed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noWrite'),
      );
    },
  });
  return (
    <Modal
      centered
      onClose={onClose}
      opened={opened}
      title={
        <OverlayHeader icon={IconCopy} iconColor="cyan" title={t('baseline:baselines.copyTitle')} />
      }
    >
      <TextInput
        data-autofocus
        description={t('baseline:baselines.nameHint')}
        label={t('baseline:baselines.copyName')}
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
        value={name}
      />
      <ModalFooter>
        <Group gap="xs" justify="flex-end" w="100%">
          <Button onClick={onClose} variant="subtle">
            {t('common:cancel')}
          </Button>
          <Button
            color="teal"
            disabled={name.trim() === ''}
            loading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
            variant="light"
          >
            {t('baseline:baselines.create')}
          </Button>
        </Group>
      </ModalFooter>
    </Modal>
  );
}

function Editor({
  id,
  canWrite,
  servers,
  onBack,
}: {
  id: string;
  canWrite: boolean;
  servers: readonly ServerSummary[];
  onBack: () => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const formatTime = useDateTime();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const view = useQuery({
    queryKey: ['baseline', 'view', id, version ?? 'current'],
    queryFn: () => getBaseline(id, version),
    retry: false,
  });
  // A text typed for one version is not carried to another: it is kept with the version it was typed for.
  const [typed, setTyped] = useState<
    { readonly version: number | undefined; readonly text: string } | undefined
  >(undefined);
  const source = typed !== undefined && typed.version === version ? typed.text : undefined;
  const setSource = (text: string | undefined): void => {
    setTyped(text === undefined ? undefined : { version, text });
  };
  const [comment, setComment] = useState('');
  const [serverIds, setServerIds] = useState<string[] | undefined>(undefined);
  const [tags, setTags] = useState<string[] | undefined>(undefined);
  const [copying, setCopying] = useState(false);

  const data = view.data;
  const current = version === undefined || version === data?.currentVersion;
  const editable = canWrite && data !== undefined && !data.builtIn && current;
  const text = source ?? data?.source ?? '';
  const dirty = data !== undefined && source !== undefined && source.trim() !== data.source.trim();
  const validation = useValidation(text, data !== undefined);
  const markers = useMemo(
    () =>
      (validation.result?.issues ?? []).flatMap((issue) =>
        issue.line === null
          ? []
          : [{ line: issue.line, column: issue.column, message: issue.message }],
      ),
    [validation.result],
  );

  const save = useMutation({
    mutationFn: () =>
      step.run(() =>
        updateBaseline(id, {
          source: text,
          ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
          ...(data ? { expectedVersion: data.currentVersion } : {}),
        }),
      ),
    onSuccess: async () => {
      notifySuccess(t('baseline:baselines.saved'));
      setSource(undefined);
      setComment('');
      setVersion(undefined);
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
    },
    onError: (error) => {
      const conflict = error instanceof ApiRequestError && error.status === 409;
      notifyFailure(
        t,
        t('baseline:baselines.saveFailed'),
        conflict ? new Error(t('baseline:baselines.conflict')) : error,
        t('baseline:signInAgain'),
        t('baseline:noWrite'),
      );
    },
  });
  const assign = useMutation({
    mutationFn: () =>
      step.run(() =>
        setBaselineAssignments(id, {
          serverIds: serverIds ?? data?.assignments.servers.map((server) => server.id) ?? [],
          tags: tags ?? data?.assignments.tags ?? [],
        }),
      ),
    onSuccess: async () => {
      notifySuccess(t('baseline:baselines.savedAssignments'));
      setServerIds(undefined);
      setTags(undefined);
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:baselines.saveFailed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noWrite'),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => step.run(() => deleteBaseline(id)),
    onSuccess: async () => {
      notifySuccess(t('baseline:baselines.deleteDone'));
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
      onBack();
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:baselines.deleteFailed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noWrite'),
      );
    },
  });

  if (view.isPending) {
    return <LoaderModal mih="40vh" />;
  }
  if (view.isError || data === undefined) {
    return (
      <QueryErrorCard
        message={describeError(
          t,
          view.error,
          t('baseline:signInAgain'),
          t('baseline:readForbidden'),
        )}
        onRetry={() => void view.refetch()}
        title={t('baseline:baselines.loadFailed')}
      />
    );
  }
  const assignedServers = serverIds ?? data.assignments.servers.map((server) => server.id);
  const assignedTags = tags ?? data.assignments.tags;
  const assignmentsDirty = serverIds !== undefined || tags !== undefined;
  const tagSuggestions = [...new Set(servers.flatMap((server) => server.tags))].sort();

  return (
    <>
      <Stack gap="md" pb="xl">
        <Group gap="xs" justify="space-between">
          <Button onClick={onBack} size="xs" variant="subtle">
            {t('baseline:baselines.back')}
          </Button>
          <Group gap={4}>
            {data.builtIn ? (
              <Badge color="cyan" size="lg" tt="none" variant="soft">
                {t('baseline:baselines.builtIn')}
              </Badge>
            ) : null}
            <Badge color="gray" size="lg" tt="none" variant="soft">
              {t('baseline:baselines.checks', { count: data.checkCount })}
            </Badge>
          </Group>
        </Group>
        {data.builtIn ? (
          <Callout color="blue">{t('baseline:baselines.readOnlyBuiltIn')}</Callout>
        ) : null}
        {!data.builtIn && !current ? (
          <Callout color="orange">{t('baseline:baselines.readOnlyOld')}</Callout>
        ) : null}

        <SectionCard.Root>
          <SectionCard.Section>
            <Stack gap="xs">
              <Group gap="xs" justify="space-between">
                <Text fw={600}>{t('baseline:baselines.document')}</Text>
                <Select
                  aria-label={t('baseline:baselines.versionPick')}
                  allowDeselect={false}
                  data={data.versions.map((entry) => ({
                    value: String(entry.version),
                    label: `${t('baseline:baselines.version', { version: entry.version })} · ${formatTime(entry.createdAt)}${entry.comment ? ` · ${entry.comment}` : ''}`,
                  }))}
                  onChange={(value) => {
                    setVersion(value === null ? undefined : Number(value));
                  }}
                  size="xs"
                  value={String(data.version)}
                  w={300}
                />
              </Group>
              <CodeEditor
                height="420px"
                label={t('baseline:baselines.documentLabel')}
                language="yaml"
                markers={markers}
                onChange={editable ? setSource : undefined}
                readOnly={!editable}
                value={text}
              />
              {editable ? (
                <ValidationLine
                  pending={validation.pending}
                  result={validation.result}
                  settled={validation.settled}
                  source={text}
                />
              ) : null}
              {editable ? (
                <TextInput
                  description={t('baseline:baselines.versionCommentHint')}
                  label={t('baseline:baselines.versionComment')}
                  maxLength={200}
                  onChange={(event) => {
                    setComment(event.currentTarget.value);
                  }}
                  value={comment}
                />
              ) : null}
            </Stack>
          </SectionCard.Section>
        </SectionCard.Root>

        {canWrite && !data.builtIn ? (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="xs">
                <Text fw={600}>{t('baseline:baselines.assignments')}</Text>
                <Text c="dimmed" fz="xs">
                  {t('baseline:baselines.assignmentsHint')}
                </Text>
                <MultiSelect
                  checkIconPosition="right"
                  clearable
                  data={servers.map((server) => ({ value: server.id, label: server.name }))}
                  label={t('baseline:baselines.assignServers')}
                  onChange={setServerIds}
                  searchable
                  value={assignedServers}
                />
                <TagsInput
                  data={tagSuggestions}
                  label={t('baseline:baselines.assignTags')}
                  onChange={setTags}
                  placeholder={t('baseline:baselines.assignTagsPlaceholder')}
                  value={assignedTags}
                />
                <Group justify="flex-end">
                  <Button
                    disabled={!assignmentsDirty}
                    loading={assign.isPending}
                    onClick={() => {
                      assign.mutate();
                    }}
                    variant="light"
                  >
                    {t('baseline:baselines.saveAssignments')}
                  </Button>
                </Group>
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : data.assignments.servers.length + data.assignments.tags.length > 0 ? (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap={4}>
                <Text fw={600}>{t('baseline:baselines.assignments')}</Text>
                <Text fz="sm">
                  {[
                    ...data.assignments.servers.map((server) => server.name),
                    ...data.assignments.tags.map((tag) => `#${tag}`),
                  ].join(', ')}
                </Text>
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : null}

        <CatalogueReference />
      </Stack>
      <DrawerFooter>
        <Group gap="xs" justify="space-between" w="100%">
          <Group gap="xs">
            {editable ? (
              <Button
                color="teal"
                disabled={!dirty || validation.result?.valid !== true || !validation.settled}
                loading={save.isPending}
                onClick={() => {
                  save.mutate();
                }}
                variant="light"
              >
                {t('baseline:baselines.save')}
              </Button>
            ) : null}
            {canWrite ? (
              <Button
                leftSection={<IconCopy size={18} />}
                onClick={() => {
                  setCopying(true);
                }}
                variant="subtle"
              >
                {t('baseline:baselines.copy')}
              </Button>
            ) : null}
          </Group>
          {canWrite && !data.builtIn ? (
            <Button
              color="red"
              leftSection={<IconTrash size={18} />}
              onClick={() => {
                confirmAction({
                  title: t('baseline:baselines.deleteTitle'),
                  message: (
                    <Text size="sm">
                      {t('baseline:baselines.deleteMessage', { name: data.name })}
                    </Text>
                  ),
                  confirmLabel: t('baseline:baselines.deleteConfirm'),
                  cancelLabel: t('common:cancel'),
                  onConfirm: () => {
                    remove.mutate();
                  },
                });
              }}
              variant="subtle"
            >
              {t('baseline:baselines.delete')}
            </Button>
          ) : null}
        </Group>
      </DrawerFooter>
      <CopyDialog
        onClose={() => {
          setCopying(false);
        }}
        onCreated={() => {
          setCopying(false);
          onBack();
        }}
        opened={copying}
        source={text}
      />
    </>
  );
}

function NewBaseline({
  initial,
  onBack,
  onCreated,
}: {
  initial: string;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const [name, setName] = useState('');
  const [source, setSource] = useState(initial);
  const validation = useValidation(source, true);
  const markers = (validation.result?.issues ?? []).flatMap((issue) =>
    issue.line === null ? [] : [{ line: issue.line, column: issue.column, message: issue.message }],
  );
  const create = useMutation({
    mutationFn: () => step.run(() => createBaseline({ name: name.trim(), source })),
    onSuccess: async (created) => {
      notifySuccess(t('baseline:baselines.saved'));
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
      onCreated(created.id);
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:baselines.createFailed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noWrite'),
      );
    },
  });
  return (
    <>
      <Stack gap="md" pb="xl">
        <Group>
          <Button onClick={onBack} size="xs" variant="subtle">
            {t('baseline:baselines.back')}
          </Button>
        </Group>
        <TextInput
          description={t('baseline:baselines.nameHint')}
          label={t('baseline:baselines.name')}
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
          value={name}
          withAsterisk
        />
        <CodeEditor
          height="380px"
          label={t('baseline:baselines.documentLabel')}
          language="yaml"
          markers={markers}
          onChange={setSource}
          value={source}
        />
        <ValidationLine
          pending={validation.pending}
          result={validation.result}
          settled={validation.settled}
          source={source}
        />
        <CatalogueReference />
      </Stack>
      <DrawerFooter>
        <Group gap="xs" justify="flex-end" w="100%">
          <Button
            color="teal"
            disabled={
              name.trim() === '' || validation.result?.valid !== true || !validation.settled
            }
            loading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
            variant="light"
          >
            {t('baseline:baselines.create')}
          </Button>
        </Group>
      </DrawerFooter>
    </>
  );
}

/** The baselines of this instance: the list, one baseline with its versions and assignments, a new baseline. */
export function BaselinesDrawer({
  opened,
  canWrite,
  servers,
  onClose,
}: {
  opened: boolean;
  canWrite: boolean;
  servers: readonly ServerSummary[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const [view, setView] = useState<View>({ kind: 'list' });
  return (
    <Drawer
      closeButtonProps={{ 'aria-label': t('common:close'), ...{ 'data-autofocus': true } }}
      onClose={() => {
        setView({ kind: 'list' });
        onClose();
      }}
      opened={opened}
      padding="lg"
      position="right"
      size="860px"
      title={
        <OverlayHeader
          icon={IconChecklist}
          iconColor="cyan"
          title={t('baseline:baselines.title')}
        />
      }
    >
      {view.kind === 'list' ? (
        <BaselineList
          canWrite={canWrite}
          onNew={() => {
            setView({ kind: 'new', source: STARTER });
          }}
          onOpen={(id) => {
            setView({ kind: 'edit', id });
          }}
        />
      ) : view.kind === 'edit' ? (
        <Editor
          canWrite={canWrite}
          id={view.id}
          key={view.id}
          onBack={() => {
            setView({ kind: 'list' });
          }}
          servers={servers}
        />
      ) : (
        <NewBaseline
          initial={view.source}
          onBack={() => {
            setView({ kind: 'list' });
          }}
          onCreated={(id) => {
            setView({ kind: 'edit', id });
          }}
        />
      )}
    </Drawer>
  );
}

export type { BaselineSummary };
