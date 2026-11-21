// The look of this card follows the panel's drawer cards (src/shared/ui/section-card, src/shared/ui/overlays/
// base-overlay-header and the `DataList` rows of its record drawers) and is built like the access card beside it. The
// push dialog follows the panel's create and edit modals (a titled `Modal`, labelled fields, a sticky `ModalFooter` with
// a teal soft primary button). Pushing files to a server has no counterpart in the panel.
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  DataList,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconPackage, IconShieldCheck, IconTrash, IconUpload } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ARTIFACT_DESTINATIONS,
  type ArtifactDestination,
  type ArtifactList,
  ARTIFACT_SYSTEM_DIR,
  ARTIFACT_USER_DIR,
  type ServerArtifact,
  type ServerView,
} from '@swellwright/contracts';
import {
  CopyableDataListItem,
  ErrorMessageBlock,
  LoadingScreen,
  ModalFooter,
  OverlayHeader,
  SectionCard,
  StatusBadge,
  type StatusKind,
} from '@swellwright/ui';

import {
  listArtifacts,
  listServerArtifacts,
  pushServerArtifact,
  removeServerArtifact,
  verifyServerArtifact,
} from '../api.js';
import { useStepUp } from '../auth/step-up.js';
import { notifyArtifactFailure } from '../operations/artifact-errors.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useTimeFirst } from '../security/time-first.js';
import { confirmAction, notifyError, notifySuccess } from '../shell/feedback.js';
import { useIsMobile } from '../shell/use-is-mobile.js';

/** The chip of what the last check found, or "not checked yet": an icon and a word, never colour alone. */
const COPY_KIND = {
  ok: 'ok',
  differs: 'err',
  missing: 'err',
  never: 'wait',
} as const satisfies Record<string, StatusKind>;

type CopyState = keyof typeof COPY_KIND;

const stateOf = (copy: ServerArtifact): CopyState => copy.verify?.state ?? 'never';

const asDestination = (value: string | null): ArtifactDestination | null =>
  ARTIFACT_DESTINATIONS.find((known) => known === value) ?? null;

/** What the person chose in the push dialog; the file name comes from the manifest of the chosen version. */
function PushForm({
  server,
  catalogue,
  onClose,
  onDone,
}: {
  server: ServerView;
  catalogue: ArtifactList;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['artifacts', 'common']);
  // What can be pushed: a version that is intact. The latest of each name is the default.
  const choices = useMemo(
    () =>
      catalogue.artifacts.flatMap((artifact) => {
        const intact = artifact.versions.flatMap((version) =>
          version.state === 'ok' && version.version !== null && version.manifest !== null
            ? [{ version: version.version, file: version.manifest.file }]
            : [],
        );
        return intact.length === 0
          ? []
          : [{ name: artifact.name, latest: artifact.latestVersion, versions: intact }];
      }),
    [catalogue],
  );
  const first = choices[0];
  const [name, setName] = useState<string | null>(first?.name ?? null);
  const [version, setVersion] = useState<string | null>(
    first?.latest ?? first?.versions[0]?.version ?? null,
  );
  const [destination, setDestination] = useState<ArtifactDestination>('user');
  const [touched, setTouched] = useState(false);

  const chosen = choices.find((choice) => choice.name === name);
  const file = chosen?.versions.find((candidate) => candidate.version === version)?.file;

  const step = useStepUp();
  const push = useMutation({
    mutationFn: () => {
      if (name === null) {
        throw new Error('No artifact chosen.');
      }
      return step.run(() =>
        pushServerArtifact(server.id, {
          name,
          ...(version === null ? {} : { version }),
          destination,
        }),
      );
    },
    onSuccess: (pushed) => {
      const text = {
        name: pushed.artifact.name,
        version: pushed.artifact.version,
        server: server.name,
      };
      notifySuccess(
        t('server.title'),
        pushed.result === 'pushed' ? t('server.pushedNow', text) : t('server.unchangedNow', text),
      );
      onDone();
      onClose();
    },
    onError: (error) => {
      notifyArtifactFailure(
        t,
        t('server.pushFailed'),
        error,
        t('signInAgain'),
        t('server.pushForbidden'),
      );
    },
  });

  if (choices.length === 0) {
    return (
      <>
        <Text c="dimmed" size="sm">
          {t('dialog.nothingToPush')}
        </Text>
        <ModalFooter>
          <Button color="teal" onClick={onClose} size="md" variant="light">
            {t('common:close')}
          </Button>
        </ModalFooter>
      </>
    );
  }

  const root = destination === 'system' ? ARTIFACT_SYSTEM_DIR : `~/${ARTIFACT_USER_DIR}`;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (name !== null) {
          push.mutate();
        }
      }}
    >
      <Stack gap="md">
        <Select
          allowDeselect={false}
          data={choices.map((choice) => ({ value: choice.name, label: choice.name }))}
          data-autofocus
          error={touched && name === null ? t('dialog.chooseError') : undefined}
          label={t('dialog.artifact')}
          onChange={(value) => {
            const next = choices.find((choice) => choice.name === value);
            setName(value);
            setVersion(next?.latest ?? next?.versions[0]?.version ?? null);
          }}
          placeholder={t('dialog.artifactPlaceholder')}
          searchable
          styles={{ label: { fontWeight: 500 } }}
          value={name}
        />
        <Select
          allowDeselect={false}
          data={(chosen?.versions ?? []).map((candidate) => ({
            value: candidate.version,
            label: candidate.version,
          }))}
          label={t('dialog.version')}
          onChange={setVersion}
          styles={{ label: { fontWeight: 500 } }}
          value={version}
        />
        <Select
          allowDeselect={false}
          data={ARTIFACT_DESTINATIONS.map((value) => ({
            value,
            label: t(`dialog.destinations.${value}`),
          }))}
          description={destination === 'system' ? t('dialog.systemHint') : t('dialog.userHint')}
          label={t('dialog.destination')}
          onChange={(value) => {
            setDestination(asDestination(value) ?? 'user');
          }}
          styles={{ label: { fontWeight: 500 } }}
          value={destination}
        />
        {name !== null && version !== null && file !== undefined ? (
          <Stack gap={4}>
            <Text c="dimmed" size="xs">
              {t('dialog.pathExample')}
            </Text>
            <Code block>{`${root}/${name}/${version}/${file}`}</Code>
          </Stack>
        ) : null}
        <Text c="dimmed" size="xs">
          {t('dialog.notice')}
        </Text>
      </Stack>
      <ModalFooter>
        <Button
          color="teal"
          leftSection={<IconUpload size={16} />}
          loading={push.isPending}
          size="md"
          type="submit"
          variant="soft"
        >
          {t('dialog.push')}
        </Button>
      </ModalFooter>
    </form>
  );
}

function PushDialog({
  server,
  opened,
  onClose,
  onDone,
}: {
  server: ServerView;
  opened: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['artifacts', 'common']);
  const isMobile = useIsMobile();
  // The catalogue is only asked for when the dialog opens.
  const catalogue = useQuery({
    queryKey: ['artifacts'],
    queryFn: listArtifacts,
    enabled: opened,
    retry: false,
  });
  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      fullScreen={isMobile}
      onClose={onClose}
      opened={opened}
      title={
        <OverlayHeader
          icon={IconUpload}
          iconColor="teal"
          subtitle={t('dialog.subtitle')}
          title={t('dialog.title', { name: server.name })}
        />
      }
    >
      {catalogue.isPending ? (
        <LoadingScreen height="20vh" />
      ) : catalogue.isError ? (
        <QueryErrorCard
          message={t('readForbidden')}
          onRetry={() => void catalogue.refetch()}
          title={t('loadFailedTitle')}
        />
      ) : (
        <PushForm catalogue={catalogue.data} onClose={onClose} onDone={onDone} server={server} />
      )}
    </Modal>
  );
}

/**
 * The artifacts Swellwright pushed to a server: what, where, whether the copy still is what the catalogue says, and
 * the actions on it. Reading needs `servers:read` and never connects to the server; pushing, checking and removing
 * need `servers:write`, except pushing and removing: they need `servers:exec` and a fresh code, because what is
 * pushed is meant to be run.
 */
export function ArtifactsCard({
  server,
  canWrite,
  canExec,
  onChanged,
}: {
  server: ServerView;
  canWrite: boolean;
  canExec: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['artifacts', 'common']);
  const step = useStepUp();
  const formatTime = useTimeFirst();
  const queryClient = useQueryClient();
  const [pushing, setPushing] = useState(false);
  // A new dialog for every opening, so that what was chosen last time is not still there.
  const [opening, setOpening] = useState(0);

  const list = useQuery({
    queryKey: ['server', server.id, 'artifacts'],
    queryFn: () => listServerArtifacts(server.id),
    retry: false,
  });
  const copies = list.data?.artifacts ?? [];

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.id, 'artifacts'] });
    onChanged();
  };

  const verify = useMutation({
    mutationFn: (copy: ServerArtifact) => verifyServerArtifact(server.id, copy.name, copy.version),
    onSuccess: (result, copy) => {
      const text = { name: copy.name, version: copy.version, server: server.name };
      const bad = result.results.find((check) => check.state !== 'ok');
      if (bad === undefined) {
        notifySuccess(t('server.title'), t('server.verifiedOk', text));
      } else {
        notifyError(
          t('server.verifyFailed'),
          t('server.verifiedBad', {
            ...text,
            state: t(`server.badStates.${bad.state === 'ok' ? 'differs' : bad.state}`),
          }),
        );
      }
      done();
    },
    onError: (error) => {
      notifyArtifactFailure(
        t,
        t('server.verifyFailed'),
        error,
        t('signInAgain'),
        t('server.pushForbidden'),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (copy: ServerArtifact) =>
      step.run(() => removeServerArtifact(server.id, copy.name, copy.version)),
    onSuccess: (_result, copy) => {
      notifySuccess(
        t('server.title'),
        t('server.removed', { name: copy.name, version: copy.version, server: server.name }),
      );
      done();
    },
    onError: (error) => {
      notifyArtifactFailure(
        t,
        t('server.removeFailed'),
        error,
        t('signInAgain'),
        t('server.pushForbidden'),
      );
    },
  });

  const askRemove = (copy: ServerArtifact) => {
    confirmAction({
      title: t('server.removeTitle'),
      message: (
        <Text size="sm">
          {t('server.removeWarning', {
            name: copy.name,
            version: copy.version,
            server: server.name,
          })}
        </Text>
      ),
      confirmLabel: t('server.remove'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        remove.mutate(copy);
      },
    });
  };

  return (
    <>
      <SectionCard.Root>
        <SectionCard.Section>
          <Group align="center" gap="xs" justify="space-between" wrap="wrap">
            <OverlayHeader
              icon={IconPackage}
              iconColor="grape"
              subtitle={t('server.subtitle')}
              title={t('server.title')}
              titleOrder={5}
            />
            <Group gap="xs" style={{ flexShrink: 0 }} wrap="nowrap">
              <Badge
                color={copies.length > 0 ? 'teal' : 'gray'}
                maw="none"
                size="lg"
                styles={{ root: { flexShrink: 0 } }}
                variant="soft"
              >
                {copies.length > 0 ? t('server.count', { count: copies.length }) : t('server.none')}
              </Badge>
              {canExec ? (
                <Button
                  color="teal"
                  leftSection={<IconUpload size={16} />}
                  onClick={() => {
                    setOpening((count) => count + 1);
                    setPushing(true);
                  }}
                  variant="soft"
                >
                  {t('server.push')}
                </Button>
              ) : null}
            </Group>
          </Group>
        </SectionCard.Section>

        {list.isPending ? (
          <SectionCard.Section>
            <LoadingScreen height="10vh" />
          </SectionCard.Section>
        ) : list.isError ? (
          <SectionCard.Section>
            <QueryErrorCard
              message={t('readForbidden')}
              onRetry={() => void list.refetch()}
              title={t('server.readFailed')}
            />
          </SectionCard.Section>
        ) : null}

        {copies.map((copy) => {
          const state = stateOf(copy);
          return (
            <SectionCard.Section key={`${copy.name}@${copy.version}`}>
              <Stack gap="xs">
                <Group gap="xs" justify="space-between" wrap="wrap">
                  <Group gap="xs" wrap="nowrap">
                    <Text ff="monospace" fw={600} size="sm">
                      {copy.name}
                    </Text>
                    <Badge color="gray" size="lg" variant="soft">
                      {copy.version}
                    </Badge>
                  </Group>
                  {canWrite ? (
                    <Group gap={4} wrap="nowrap">
                      <Tooltip
                        label={t('server.verifyNamed', { name: copy.name, version: copy.version })}
                        withArrow
                      >
                        <Button
                          color="teal"
                          leftSection={<IconShieldCheck size={16} />}
                          loading={
                            verify.isPending &&
                            verify.variables.name === copy.name &&
                            verify.variables.version === copy.version
                          }
                          onClick={() => {
                            verify.mutate(copy);
                          }}
                          size="sm"
                          variant="soft"
                        >
                          {t('server.verify')}
                        </Button>
                      </Tooltip>
                      {canExec ? (
                        <Tooltip label={t('server.remove')} withArrow>
                          <ActionIcon
                            aria-label={t('server.removeNamed', {
                              name: copy.name,
                              version: copy.version,
                            })}
                            color="red"
                            loading={
                              remove.isPending &&
                              remove.variables.name === copy.name &&
                              remove.variables.version === copy.version
                            }
                            onClick={() => {
                              askRemove(copy);
                            }}
                            size="lg"
                            variant="soft"
                          >
                            <IconTrash size={18} />
                          </ActionIcon>
                        </Tooltip>
                      ) : null}
                    </Group>
                  ) : null}
                </Group>
                <Group gap="xs" wrap="wrap">
                  <StatusBadge kind={COPY_KIND[state]}>{t(`server.states.${state}`)}</StatusBadge>
                  <Badge
                    color={copy.destination === 'system' ? 'violet' : 'cyan'}
                    size="lg"
                    variant="soft"
                  >
                    {t(`server.destinations.${copy.destination}`)}
                  </Badge>
                  {copy.catalogue === 'ok' ? null : (
                    <StatusBadge kind="warn">{t(`server.catalogue.${copy.catalogue}`)}</StatusBadge>
                  )}
                </Group>
                <DataList orientation="vertical" withDivider>
                  <CopyableDataListItem
                    copiedLabel={t('common:copied')}
                    copyLabel={t('common:copy')}
                    label={t('server.fields.path')}
                    monospace
                    value={copy.remotePath}
                  />
                  <CopyableDataListItem
                    copiedLabel={t('common:copied')}
                    copyLabel={t('common:copy')}
                    label={t('server.fields.sha256')}
                    monospace
                    value={copy.sha256}
                  />
                  <DataList.Item>
                    <DataList.ItemLabel>{t('server.fields.pushed')}</DataList.ItemLabel>
                    <DataList.ItemValue>
                      {copy.pushedBy ?? '–'}, {formatTime(copy.pushedAt)}
                    </DataList.ItemValue>
                  </DataList.Item>
                  <DataList.Item>
                    <DataList.ItemLabel>{t('server.fields.checked')}</DataList.ItemLabel>
                    <DataList.ItemValue>
                      {copy.verify === null
                        ? t('server.states.never')
                        : formatTime(copy.verify.verifiedAt)}
                    </DataList.ItemValue>
                  </DataList.Item>
                </DataList>
                {copy.verify !== null && copy.verify.state === 'differs' ? (
                  <ErrorMessageBlock
                    copiedLabel={t('common:copied')}
                    copyLabel={t('common:copy')}
                    message={`${t('server.fields.onServer')}: ${copy.verify.remoteSha256 ?? '–'}\n${t('server.fields.expected')}: ${copy.sha256}`}
                  />
                ) : null}
              </Stack>
            </SectionCard.Section>
          );
        })}

        {!list.isPending && !list.isError && copies.length === 0 ? (
          <SectionCard.Section>
            <Text c="dimmed" size="sm">
              {t('server.empty')}
            </Text>
          </SectionCard.Section>
        ) : null}
      </SectionCard.Root>
      <PushDialog
        key={opening}
        onClose={() => {
          setPushing(false);
        }}
        onDone={done}
        opened={pushing}
        server={server}
      />
    </>
  );
}
