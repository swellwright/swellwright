// The look of this card follows the panel's drawer cards (src/shared/ui/section-card, src/shared/ui/overlays/
// base-overlay-header, `DataList` rows) and the dialog follows its create/edit modals (a titled `Modal`, labelled fields,
// a sticky `ModalFooter` with a teal soft primary button). Access entries have no counterpart in the panel.
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  DataList,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconEdit, IconKey, IconPlugConnected, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiFloppyDiskDuotone, PiUserDuotone } from 'react-icons/pi';
import { Link } from 'react-router';

import {
  ACCESS_METHODS,
  type AccessVerification,
  AccessUsernameSchema,
  type AccessMethod,
  MAX_ACCESS_PER_SERVER,
  SECRET_TYPE_FOR_METHOD,
  type ServerAccess,
  type ServerView,
  SUDO_SECRET_TYPE,
} from '@swellwright/contracts';
import {
  Callout,
  ErrorMessageBlock,
  ModalFooter,
  OverlayHeader,
  SectionCard,
  StatusBadge,
} from '@swellwright/ui';

import {
  addServerAccess,
  listSecrets,
  removeServerAccess,
  updateServerAccess,
  verifyServerAccess,
} from '../api.js';
import { SecretExpiryBadge } from '../security/secret-expiry.js';
import { useTimeFirst } from '../security/time-first.js';
import { notifyFailure } from '../security/notify-failure.js';
import { useLastDefined } from '../security/use-last-defined.js';
import { ROUTES } from '../routes.js';
import { confirmAction, notifyError, notifySuccess } from '../shell/feedback.js';
import { useIsMobile } from '../shell/use-is-mobile.js';
import { hostKeyMismatchOf, notifySshFailure, sshErrorText } from './ssh-errors.js';

const asMethod = (value: string | null): AccessMethod | null =>
  ACCESS_METHODS.find((known) => known === value) ?? null;

type Target = { entry: ServerAccess | null } | undefined;

function AccessForm({
  server,
  entry,
  canReadVault,
  onClose,
  onDone,
}: {
  server: ServerView;
  entry: ServerAccess | null;
  canReadVault: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['servers', 'common', 'vault']);
  const [method, setMethod] = useState<AccessMethod>(entry?.method ?? 'password');
  const [username, setUsername] = useState(entry?.username ?? 'root');
  const [secretId, setSecretId] = useState<string | null>(entry?.secret.id ?? null);
  const [sudoId, setSudoId] = useState<string | null>(entry?.sudoSecret?.id ?? null);
  const [priority, setPriority] = useState<number | string>(entry?.priority ?? '');
  const [touched, setTouched] = useState(false);

  const secrets = useQuery({
    queryKey: ['vault', 'secrets'],
    queryFn: listSecrets,
    enabled: canReadVault,
    retry: false,
  });
  const all = secrets.data?.secrets ?? [];
  const loginKind = SECRET_TYPE_FOR_METHOD[method];
  const optionOf = (secret: (typeof all)[number]) => ({
    value: secret.id,
    // An entry may still name an expired secret (renewing it fixes the entry), but the list says which they are.
    label: secret.expired ? `${secret.name}${t('vault:expiry.expiredSuffix')}` : secret.name,
  });
  const loginOptions = all.filter((secret) => secret.type === loginKind).map(optionOf);
  const sudoOptions = all.filter((secret) => secret.type === SUDO_SECRET_TYPE).map(optionOf);

  const usernameOk = AccessUsernameSchema.safeParse(username).success;
  const secretOk = secretId !== null && loginOptions.some((option) => option.value === secretId);
  const priorityOk =
    priority === '' || (typeof priority === 'number' && priority >= 0 && priority <= 1000);

  const mutation = useMutation({
    mutationFn: () => {
      if (secretId === null) {
        throw new Error('No secret chosen.');
      }
      const base = {
        method,
        username,
        secretId,
        ...(typeof priority === 'number' ? { priority } : {}),
      };
      return entry
        ? updateServerAccess(server.id, entry.id, { ...base, sudoSecretId: sudoId })
        : addServerAccess(server.id, {
            ...base,
            ...(sudoId === null ? {} : { sudoSecretId: sudoId }),
          });
    },
    onSuccess: () => {
      notifySuccess(
        t('toast.success'),
        entry
          ? t('access.updated', { name: server.name })
          : t('access.added', { name: server.name }),
      );
      onDone();
      onClose();
    },
    onError: (error) => {
      notifyFailure(
        t,
        entry ? t('access.editTitle') : t('access.addTitle'),
        error,
        t('signInAgain'),
        t('access.forbidden'),
      );
    },
  });

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (usernameOk && secretOk && priorityOk) {
      mutation.mutate();
    }
  };

  const vaultLink = (
    <Anchor component={Link} size="xs" to={ROUTES.DASHBOARD.SECURITY.VAULT}>
      {t('access.openVault')}
    </Anchor>
  );

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        <Select
          allowDeselect={false}
          data={ACCESS_METHODS.map((value) => ({ value, label: t(`access.methods.${value}`) }))}
          label={t('access.method')}
          onChange={(value) => {
            const next = asMethod(value) ?? 'password';
            setMethod(next);
            // A secret of the other kind does not fit the new method.
            if (
              secretId !== null &&
              all.find((secret) => secret.id === secretId)?.type !== SECRET_TYPE_FOR_METHOD[next]
            ) {
              setSecretId(null);
            }
          }}
          styles={{ label: { fontWeight: 500 } }}
          value={method}
        />
        <TextInput
          autoComplete="off"
          data-autofocus
          error={touched && !usernameOk ? t('access.usernameError') : undefined}
          label={t('access.username')}
          leftSection={<PiUserDuotone size="16px" />}
          onChange={(event) => {
            setUsername(event.currentTarget.value);
          }}
          required
          styles={{ label: { fontWeight: 500 } }}
          value={username}
        />
        <Select
          allowDeselect={false}
          data={loginOptions}
          description={
            <>
              {method === 'password' ? t('access.secretPasswordHint') : t('access.secretKeyHint')}{' '}
              {vaultLink}
            </>
          }
          error={
            touched && !secretOk
              ? t('access.secretError', { kind: t(`vault:types.${loginKind}`) })
              : secrets.isError
                ? t('access.secretsFailed')
                : undefined
          }
          label={method === 'password' ? t('access.secretPassword') : t('access.secretKey')}
          nothingFoundMessage={t('access.noSecrets', { kind: t(`vault:types.${loginKind}`) })}
          onChange={setSecretId}
          placeholder={t('access.chooseSecret')}
          required
          searchable
          styles={{ label: { fontWeight: 500 } }}
          value={secretId}
        />
        <Select
          clearable
          data={sudoOptions}
          description={t('access.sudoHint')}
          label={t('access.sudoSecret')}
          nothingFoundMessage={t('access.noSecrets', {
            kind: t(`vault:types.${SUDO_SECRET_TYPE}`),
          })}
          onChange={setSudoId}
          placeholder={t('access.noSudo')}
          searchable
          styles={{ label: { fontWeight: 500 } }}
          value={sudoId}
        />
        <NumberInput
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          description={t('access.priorityHint')}
          error={touched && !priorityOk ? t('access.priorityError') : undefined}
          hideControls
          label={t('access.priority')}
          max={1000}
          min={0}
          onChange={setPriority}
          placeholder={t('access.priorityDefault')}
          styles={{ label: { fontWeight: 500 } }}
          value={priority}
        />
      </Stack>
      <ModalFooter>
        <Button
          color="teal"
          leftSection={<PiFloppyDiskDuotone size="16px" />}
          loading={mutation.isPending}
          size="md"
          type="submit"
          variant="soft"
        >
          {t('common:save')}
        </Button>
      </ModalFooter>
    </form>
  );
}

/** Adding or changing an entry: a dialog, as the panel's create and edit forms that are small enough for one. */
function AccessDialog({
  server,
  target,
  canReadVault,
  onClose,
  onDone,
}: {
  server: ServerView;
  target: Target;
  canReadVault: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const isMobile = useIsMobile();
  const shown = useLastDefined(target);
  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      fullScreen={isMobile}
      onClose={onClose}
      opened={target !== undefined}
      title={
        <OverlayHeader
          icon={IconKey}
          iconColor="teal"
          title={shown?.entry ? t('access.editTitle') : t('access.addTitle')}
        />
      }
    >
      {shown ? (
        <AccessForm
          canReadVault={canReadVault}
          entry={shown.entry}
          key={shown.entry?.id ?? 'new'}
          onClose={onClose}
          onDone={onDone}
          server={server}
        />
      ) : null}
    </Modal>
  );
}

/** What came of trying an entry: the answer of the server, or the error that stopped the attempt. */
type Outcome = { kind: 'result'; result: AccessVerification } | { kind: 'error'; message: string };

function VerificationResult({
  outcome,
  username,
}: {
  outcome: Outcome | undefined;
  username: string;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const formatTime = useTimeFirst();
  if (outcome === undefined) {
    return null;
  }
  if (outcome.kind === 'error') {
    return (
      <Stack gap="xs">
        <StatusBadge kind="err">{t('access.result.failed')}</StatusBadge>
        <ErrorMessageBlock
          copiedLabel={t('common:copied')}
          copyLabel={t('common:copy')}
          message={outcome.message}
        />
      </Stack>
    );
  }
  const { result } = outcome;
  return (
    <Stack gap="xs">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <StatusBadge kind={result.ok ? 'ok' : 'err'}>
          {result.ok ? t('access.result.ok') : t('access.result.failed')}
        </StatusBadge>
        <Text c="dimmed" size="xs">
          {formatTime(result.verifiedAt)}
        </Text>
      </Group>
      {result.ok ? (
        <DataList orientation="vertical" size="xs" withDivider>
          <DataList.Item>
            <DataList.ItemLabel>{t('access.result.user')}</DataList.ItemLabel>
            <DataList.ItemValue>
              <Text ff="monospace" size="sm">
                {result.remoteUser ?? username}
              </Text>
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>{t('access.result.root')}</DataList.ItemLabel>
            <DataList.ItemValue>
              {result.isRoot ? t('access.result.yes') : t('access.result.no')}
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>{t('access.result.sudo')}</DataList.ItemLabel>
            <DataList.ItemValue>
              <Badge
                color={
                  result.sudo === 'ok' || result.sudo === 'not_needed'
                    ? 'teal'
                    : result.sudo === 'unavailable'
                      ? 'gray'
                      : 'orange'
                }
                size="lg"
                variant="soft"
              >
                {t(`access.result.sudoStates.${result.sudo}`)}
              </Badge>
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>{t('access.result.duration')}</DataList.ItemLabel>
            <DataList.ItemValue>
              <Text ff="monospace" size="sm">
                {t('access.result.latency', { ms: result.latencyMs })}
              </Text>
            </DataList.ItemValue>
          </DataList.Item>
        </DataList>
      ) : result.error ? (
        <ErrorMessageBlock
          copiedLabel={t('common:copied')}
          copyLabel={t('common:copy')}
          message={`${result.error.code}: ${result.error.message}`}
        />
      ) : null}
    </Stack>
  );
}

export function AccessCard({
  server,
  canWrite,
  canReadVault,
  onChanged,
}: {
  server: ServerView;
  canWrite: boolean;
  canReadVault: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['servers', 'common', 'vault']);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Target>(undefined);
  const formatTime = useTimeFirst();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const verify = useMutation({
    mutationFn: (entry: ServerAccess) => verifyServerAccess(server.id, entry.id),
    onSuccess: (result, entry) => {
      setOutcomes((previous) => ({ ...previous, [entry.id]: { kind: 'result', result } }));
      if (result.ok) {
        notifySuccess(
          t('toast.success'),
          t('access.verifiedOk', { username: entry.username, name: server.name }),
        );
      } else {
        notifyError(
          t('access.verifyFailed'),
          t('access.verifiedFailed', { username: entry.username, name: server.name }),
        );
      }
      done();
    },
    onError: (error, entry) => {
      const text = sshErrorText(t, error, t('signInAgain'), t('access.forbidden'));
      const mismatch = hostKeyMismatchOf(error);
      setOutcomes((previous) => ({
        ...previous,
        [entry.id]: {
          kind: 'error',
          message: mismatch
            ? `${text}\n${t('hostKeys.scan.expected')}: ${mismatch.expected.join(', ')}\n${t('hostKeys.scan.actual')}: ${mismatch.actual}`
            : text,
        },
      }));
      notifySshFailure(t, t('access.verifyFailed'), error, t('signInAgain'), t('access.forbidden'));
      done();
    },
  });

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['servers'] });
    void queryClient.invalidateQueries({ queryKey: ['server', server.id] });
    onChanged();
  };

  const remove = useMutation({
    mutationFn: (entry: ServerAccess) => removeServerAccess(server.id, entry.id),
    onSuccess: () => {
      notifySuccess(t('toast.success'), t('access.removed'));
      done();
    },
    onError: (error) => {
      notifyFailure(t, t('access.removeFailed'), error, t('signInAgain'), t('access.forbidden'));
    },
  });

  const askRemove = (entry: ServerAccess) => {
    confirmAction({
      title: t('access.removeTitle'),
      message: (
        <Text size="sm">
          {t('access.removeWarning', { username: entry.username, name: server.name })}
        </Text>
      ),
      confirmLabel: t('access.remove'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        remove.mutate(entry);
      },
    });
  };

  const full = server.access.length >= MAX_ACCESS_PER_SERVER;

  return (
    <>
      <SectionCard.Root>
        <SectionCard.Section>
          <Group align="center" justify="space-between" wrap="nowrap">
            <OverlayHeader
              icon={IconKey}
              iconColor="indigo"
              subtitle={t('access.subtitle', { max: MAX_ACCESS_PER_SERVER })}
              title={t('access.title')}
              titleOrder={5}
            />
            {canWrite ? (
              <Tooltip
                disabled={!full}
                label={t('access.full', { max: MAX_ACCESS_PER_SERVER })}
                withArrow
              >
                <span>
                  <Button
                    color="teal"
                    disabled={full}
                    leftSection={<IconPlus size={16} />}
                    onClick={() => {
                      setTarget({ entry: null });
                    }}
                    variant="soft"
                  >
                    {t('access.add')}
                  </Button>
                </span>
              </Tooltip>
            ) : null}
          </Group>
        </SectionCard.Section>

        {server.access.map((entry) => (
          <SectionCard.Section key={entry.id}>
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Badge
                    color={entry.method === 'key' ? 'violet' : 'cyan'}
                    size="lg"
                    variant="soft"
                  >
                    {t(`access.methods.${entry.method}`)}
                  </Badge>
                  <Text ff="monospace" fw={600} size="sm">
                    {entry.username}
                  </Text>
                </Group>
                {canWrite ? (
                  <Group gap={4} wrap="nowrap">
                    <Tooltip
                      label={t('access.verifyNamed', { username: entry.username })}
                      withArrow
                    >
                      <Button
                        color="teal"
                        leftSection={<IconPlugConnected size={16} />}
                        loading={verify.isPending && verify.variables.id === entry.id}
                        onClick={() => {
                          verify.mutate(entry);
                        }}
                        size="sm"
                        variant="soft"
                      >
                        {t('access.verify')}
                      </Button>
                    </Tooltip>
                    <Tooltip label={t('access.edit')} withArrow>
                      <ActionIcon
                        aria-label={t('access.editNamed', { username: entry.username })}
                        color="teal"
                        onClick={() => {
                          setTarget({ entry });
                        }}
                        size="lg"
                        variant="soft"
                      >
                        <IconEdit size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('access.remove')} withArrow>
                      <ActionIcon
                        aria-label={t('access.removeNamed', { username: entry.username })}
                        color="red"
                        loading={remove.isPending && remove.variables.id === entry.id}
                        onClick={() => {
                          askRemove(entry);
                        }}
                        size="lg"
                        variant="soft"
                      >
                        <IconTrash size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                ) : null}
              </Group>
              {[entry.secret, entry.sudoSecret]
                .filter((secret): secret is NonNullable<typeof secret> => secret?.expired === true)
                .map((secret) => (
                  <Callout color="red" key={secret.id}>
                    {t('access.secretExpired', { name: secret.name })}
                  </Callout>
                ))}
              <DataList orientation="vertical" withDivider>
                <DataList.Item>
                  <DataList.ItemLabel>
                    {t(entry.method === 'key' ? 'access.secretKey' : 'access.secretPassword')}
                  </DataList.ItemLabel>
                  <DataList.ItemValue>
                    <Group gap="xs" wrap="wrap">
                      <Text size="sm">{entry.secret.name}</Text>
                      <SecretExpiryBadge secret={entry.secret} />
                    </Group>
                  </DataList.ItemValue>
                </DataList.Item>
                <DataList.Item>
                  <DataList.ItemLabel>{t('access.sudoSecret')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    {entry.sudoSecret === null ? (
                      '–'
                    ) : (
                      <Group gap="xs" wrap="wrap">
                        <Text size="sm">{entry.sudoSecret.name}</Text>
                        <SecretExpiryBadge secret={entry.sudoSecret} />
                      </Group>
                    )}
                  </DataList.ItemValue>
                </DataList.Item>
                <DataList.Item>
                  <DataList.ItemLabel>{t('access.priority')}</DataList.ItemLabel>
                  <DataList.ItemValue>{entry.priority}</DataList.ItemValue>
                </DataList.Item>
                <DataList.Item>
                  <DataList.ItemLabel>{t('access.lastVerified')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    {entry.lastVerifiedAt === null ? (
                      t('access.neverVerified')
                    ) : (
                      <Group gap="xs" wrap="wrap">
                        <Text size="sm">{formatTime(entry.lastVerifiedAt)}</Text>
                        <Badge
                          color={entry.lastVerifyOk === true ? 'teal' : 'red'}
                          size="lg"
                          variant="soft"
                        >
                          {entry.lastVerifyOk === true
                            ? t('access.lastOk')
                            : t('access.lastFailed')}
                        </Badge>
                      </Group>
                    )}
                  </DataList.ItemValue>
                </DataList.Item>
              </DataList>
              <VerificationResult outcome={outcomes[entry.id]} username={entry.username} />
            </Stack>
          </SectionCard.Section>
        ))}

        {server.access.length === 0 ? (
          <SectionCard.Section>
            <Text c="dimmed" size="sm">
              {t('access.empty')}
            </Text>
          </SectionCard.Section>
        ) : null}
      </SectionCard.Root>
      <AccessDialog
        canReadVault={canReadVault}
        onClose={() => {
          setTarget(undefined);
        }}
        onDone={() => {
          // A result belongs to the entry as it was tried: a changed entry starts without one.
          setOutcomes({});
          done();
        }}
        server={server}
        target={target}
      />
    </>
  );
}
