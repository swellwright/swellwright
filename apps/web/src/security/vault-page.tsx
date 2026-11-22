import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCalendar,
  IconDeviceFloppy,
  IconEye,
  IconFilterOff,
  IconKey,
  IconLifebuoy,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRefreshDot,
  IconRestore,
  IconShieldLock,
  IconTag,
  IconTrash,
  type TablerIcon,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCalendarCheckDuotone, PiKeyDuotone, PiLockKeyDuotone } from 'react-icons/pi';

import {
  CreateSecretRequestSchema,
  type Permission,
  SECRET_TYPES,
  type SecretType,
  type SecretView,
  VAULT_PASSPHRASE_MIN_LENGTH,
  type VaultInitialized,
  type VaultStatus,
} from '@swellwright/contracts';
import {
  Callout,
  CopyableCodeBlock,
  DataTableCard,
  DatePickerInput,
  EmptyPageLayout,
  ErrorMessageBlock,
  HeaderAction,
  HeaderActionGroup,
  HeaderActions,
  LoaderModal,
  LoadingScreen,
  MantineReactTable,
  type MRT_ColumnDef,
  MetricCard,
  ModalFooter,
  OverlayHeader,
  PageHeader,
  panelTableOptions,
  SectionCard,
  SettingsCard,
  StatusBadge,
  useMantineReactTable,
  useMrtTableState,
  usePreventTableBackScroll,
} from '@swellwright/ui';

import {
  ApiRequestError,
  changeVaultPassphrase,
  createSecret,
  deleteSecret,
  getVaultStatus,
  initializeVault,
  listSecrets,
  revealSecret,
  rotateDataKeys,
  rotateKek,
  rotateRecoveryKey,
  sealVault,
  StepUpCancelledError,
  unsealVault,
  updateSecret,
} from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { useFullDate, useNumber } from '../format.js';
import { confirmAction, notifyError, notifySuccess, notifyWarning } from '../shell/feedback.js';
import { useIsMobile } from '../shell/use-is-mobile.js';
import { useTableLocalization } from '../tables.js';
import { LABEL_WEIGHT } from './form-styles.js';
import { expiryState, SecretExpiryBadge } from './secret-expiry.js';
import { useTimeFirst } from './time-first.js';

const HIDE_AFTER_SECONDS = 30;

/** The kinds of secret for a select, named in the language of the console. */
function useTypeOptions() {
  const { t } = useTranslation('vault');
  return SECRET_TYPES.map((value) => ({ value, label: t(`types.${value}`) }));
}

const asType = (value: string | null): SecretType | null =>
  SECRET_TYPES.find((known) => known === value) ?? null;

/**
 * A refusal that belongs next to the passphrase field and stays there: a wrong passphrase or recovery key (401) and
 * the lock-out after too many of them (429). Every other failure is a toast.
 */
function isFieldError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.code === 'unauthorized' || error.code === 'rate_limited')
  );
}

/** What a failed call says, and the toast for the failures that do not belong to a field. */
function useFailure() {
  const { t } = useTranslation(['vault', 'common']);
  return {
    /** The text for a failed call. `unauthorized` is what a 401 means on the screen (the session, or a wrong passphrase). */
    message: (error: unknown, forbidden: string, unauthorized?: string): string =>
      describeError(t, error, unauthorized ?? t('signInAgain'), forbidden),
    /** The text for the field of a passphrase form, or nothing when the failure is not the field's. */
    fieldMessage: (error: unknown, forbidden: string, unauthorized: string): string | undefined =>
      isFieldError(error) ? describeError(t, error, unauthorized, forbidden) : undefined,
    /** A toast for the failure. A closed step-up dialog is a warning ("nothing was changed"), not an error. */
    report: (title: string, error: unknown, forbidden: string): void => {
      const text = describeError(t, error, t('signInAgain'), forbidden);
      if (error instanceof StepUpCancelledError) {
        notifyWarning(title, text);
      } else {
        notifyError(title, text);
      }
    },
  };
}

/** Length is what counts (docs/en/design/05-security.md): a bar for how far the passphrase is from comfortable. */
function Strength({ length }: { length: number }) {
  const { t } = useTranslation('vault');
  const percent = Math.min(100, Math.round((length / 24) * 100));
  const color = length < VAULT_PASSPHRASE_MIN_LENGTH ? 'red' : length < 24 ? 'yellow' : 'teal';
  return (
    <Stack gap={4}>
      <Progress color={color} radius="sm" size="sm" value={percent} />
      <Text c="dimmed" fz="xs">
        {length < VAULT_PASSPHRASE_MIN_LENGTH
          ? t('strength.tooShort', { count: VAULT_PASSPHRASE_MIN_LENGTH })
          : length < 24
            ? t('strength.acceptable')
            : t('strength.long')}
      </Text>
    </Stack>
  );
}

const isNewPassphraseValid = (passphrase: string, repeat: string): boolean =>
  passphrase.length >= VAULT_PASSPHRASE_MIN_LENGTH && passphrase === repeat;

/** A new passphrase typed twice, with the strength bar between the two fields. Shared by setup and the change dialog. */
function NewPassphraseFields({
  passphrase,
  repeat,
  onPassphrase,
  onRepeat,
  passphraseLabel,
  repeatLabel,
  autoFocus,
}: {
  passphrase: string;
  repeat: string;
  onPassphrase: (value: string) => void;
  onRepeat: (value: string) => void;
  passphraseLabel: string;
  repeatLabel: string;
  /** Put the cursor in the first field when the form opens. */
  autoFocus: boolean;
}) {
  const { t } = useTranslation('vault');
  return (
    <>
      <PasswordInput
        styles={LABEL_WEIGHT}
        autoComplete="new-password"
        data-autofocus={autoFocus ? true : undefined}
        label={passphraseLabel}
        leftSection={<IconLock size={16} />}
        onChange={(e) => {
          onPassphrase(e.currentTarget.value);
        }}
        required
        value={passphrase}
      />
      <Strength length={passphrase.length} />
      <PasswordInput
        styles={LABEL_WEIGHT}
        autoComplete="new-password"
        error={repeat.length > 0 && repeat !== passphrase ? t('setup.mismatch') : undefined}
        label={repeatLabel}
        leftSection={<IconLock size={16} />}
        onChange={(e) => {
          onRepeat(e.currentTarget.value);
        }}
        required
        value={repeat}
      />
    </>
  );
}

/**
 * A recovery key, shown once, and the way out: it can be left only after the person says it is stored. Used right
 * after the vault is created (`card`: the button sits under the checkbox) and after a rotation that issued a new key
 * (`modal`: the button is the footer of the dialog).
 */
function RecoveryKeyPanel({
  recoveryKey,
  warning,
  doneLabel,
  onDone,
  layout,
}: {
  recoveryKey: string;
  warning: string;
  doneLabel: string;
  onDone: () => void;
  layout: 'card' | 'modal';
}) {
  const { t } = useTranslation(['vault', 'common']);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Stack gap="md">
        <Callout color="yellow">{warning}</Callout>
        <CopyableCodeBlock
          copiedLabel={t('common:copied')}
          copyLabel={t('common:copy')}
          value={recoveryKey}
          wrap
        />
        <Checkbox
          checked={saved}
          label={t('recoveryKey.storedLabel')}
          onChange={(e) => {
            setSaved(e.currentTarget.checked);
          }}
        />
        {layout === 'card' ? (
          <Button
            disabled={!saved}
            fullWidth
            leftSection={<IconLockOpen size={16} />}
            onClick={onDone}
            variant="soft"
          >
            {doneLabel}
          </Button>
        ) : null}
      </Stack>
      {layout === 'modal' ? (
        <ModalFooter>
          <Button color="teal" disabled={!saved} onClick={onDone} size="md" variant="soft">
            {doneLabel}
          </Button>
        </ModalFooter>
      ) : null}
    </>
  );
}

function SetupVault({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['vault', 'common']);
  const failure = useFailure();
  const step = useStepUp();
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const mutation = useMutation({
    mutationFn: () => step.run(() => initializeVault({ passphrase })),
    onSuccess: () => {
      setPassphrase('');
      setRepeat('');
    },
    onError: (error) => {
      failure.report(t('setup.submit'), error, t('setup.forbidden'));
    },
  });
  const created: VaultInitialized | undefined = mutation.data;
  const valid = isNewPassphraseValid(passphrase, repeat);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (valid) {
      mutation.mutate();
    }
  };

  if (created) {
    return (
      <SectionCard.Root maw={520} mx="auto" w="100%">
        <SectionCard.Section>
          <OverlayHeader
            icon={IconKey}
            iconColor="orange"
            title={t('recoveryKey.title')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <RecoveryKeyPanel
            doneLabel={t('recoveryKey.open')}
            layout="card"
            onDone={onDone}
            recoveryKey={created.recoveryKey}
            warning={t('recoveryKey.warning')}
          />
        </SectionCard.Section>
      </SectionCard.Root>
    );
  }

  return (
    <form onSubmit={submit}>
      <SectionCard.Root maw={520} mx="auto" w="100%">
        <SectionCard.Section>
          <OverlayHeader
            icon={IconShieldLock}
            iconColor="orange"
            subtitle={t('setup.intro')}
            title={t('setup.title')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <NewPassphraseFields
              autoFocus
              onPassphrase={setPassphrase}
              onRepeat={setRepeat}
              passphrase={passphrase}
              passphraseLabel={t('setup.passphraseLabel')}
              repeat={repeat}
              repeatLabel={t('setup.repeatLabel')}
            />
            <Button
              disabled={!valid}
              fullWidth
              leftSection={<IconLock size={16} />}
              loading={mutation.isPending}
              type="submit"
              variant="soft"
            >
              {t('setup.submit')}
            </Button>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>
    </form>
  );
}

function Unseal({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('vault');
  const failure = useFailure();
  const step = useStepUp();
  const [recovery, setRecovery] = useState(false);
  const [text, setText] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      step.run(() => unsealVault(recovery ? { recoveryKey: text } : { passphrase: text })),
    onSuccess: () => {
      setText('');
      onDone();
    },
    onError: (error) => {
      setText('');
      if (!isFieldError(error)) {
        failure.report(t('unseal.submit'), error, t('unseal.forbidden'));
      }
    },
  });
  // A wrong passphrase or recovery key, and the lock-out after too many, stay next to the field.
  const fieldError = failure.fieldMessage(
    mutation.error,
    t('unseal.forbidden'),
    recovery ? t('unseal.wrongRecoveryKey') : t('unseal.wrongPassphrase'),
  );
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (text.length > 0) {
      mutation.mutate();
    }
  };

  return (
    <form onSubmit={submit}>
      <SectionCard.Root maw={450} mx="auto" w="100%">
        <SectionCard.Section>
          <OverlayHeader
            icon={recovery ? IconKey : IconLock}
            iconColor={recovery ? 'cyan' : 'blue'}
            subtitle={t('unseal.notice')}
            title={t('sealed.title')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="xs">
            {recovery ? (
              <TextInput
                styles={LABEL_WEIGHT}
                autoComplete="off"
                data-autofocus
                description={t('unseal.recoveryKeyDescription')}
                error={fieldError}
                label={t('unseal.recoveryKeyLabel')}
                leftSection={<IconKey size={16} />}
                onChange={(e) => {
                  setText(e.currentTarget.value);
                }}
                value={text}
              />
            ) : (
              <PasswordInput
                styles={LABEL_WEIGHT}
                autoComplete="off"
                data-autofocus
                error={fieldError}
                label={t('unseal.passphraseLabel')}
                leftSection={<IconLock size={16} />}
                onChange={(e) => {
                  setText(e.currentTarget.value);
                }}
                value={text}
              />
            )}
            <Button
              fullWidth
              leftSection={<IconLockOpen size={16} />}
              loading={mutation.isPending}
              type="submit"
              variant="soft"
            >
              {t('unseal.submit')}
            </Button>
            <Group justify="center">
              <Anchor
                c="dimmed"
                component="button"
                onClick={() => {
                  setRecovery(!recovery);
                  setText('');
                  mutation.reset();
                }}
                size="xs"
                type="button"
              >
                {recovery ? t('unseal.usePassphrase') : t('unseal.useRecoveryKey')}
              </Anchor>
            </Group>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>
    </form>
  );
}

/** The value, for a short while. It is cleared when the dialog closes or the time is up. */
function RevealDialog({
  secret,
  onClose,
}: {
  secret: SecretView | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation(['vault', 'common']);
  const failure = useFailure();
  const step = useStepUp();
  const isMobile = useIsMobile();
  // The moment the value is hidden again, counted from when it arrived.
  const [deadline, setDeadline] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const mutation = useMutation({
    mutationFn: (id: string) => step.run(() => revealSecret(id)),
    onSuccess: () => {
      setNow(Date.now());
      setDeadline(Date.now() + HIDE_AFTER_SECONDS * 1000);
    },
    onError: (error) => {
      // Nothing to show: say why in a toast and let the dialog go.
      failure.report(t('menu.reveal'), error, t('reveal.forbidden'));
      onClose();
    },
  });
  const { mutate, reset, data } = mutation;
  // The title stays while the dialog fades out; the value does not (it is cleared the moment the dialog closes).
  const [shown, setShown] = useState(secret);
  if (secret !== undefined && secret !== shown) {
    setShown(secret);
  }

  useEffect(() => {
    if (secret) {
      mutate(secret.id);
    }
    return () => {
      reset();
      setDeadline(undefined);
    };
  }, [secret, mutate, reset]);

  useEffect(() => {
    if (deadline === undefined) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) {
        onClose();
      }
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [deadline, onClose]);
  const left = deadline === undefined ? HIDE_AFTER_SECONDS : Math.ceil((deadline - now) / 1000);

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      fullScreen={isMobile}
      onClose={onClose}
      opened={secret !== undefined}
      title={
        <OverlayHeader
          icon={IconEye}
          iconColor="blue"
          subtitle={shown ? t(`types.${shown.type}`) : undefined}
          title={shown?.name ?? ''}
          truncateTitle
        />
      }
    >
      {data ? (
        <>
          <Stack gap="md">
            {data.expired ? <Callout color="orange">{t('reveal.expiredNotice')}</Callout> : null}
            <CopyableCodeBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('common:copy')}
              value={data.value}
              wrap
            />
            <Text c="dimmed" fz="sm">
              {t('reveal.hiddenIn', { count: Math.max(left, 0) })}
            </Text>
          </Stack>
          <ModalFooter>
            <Button color="teal" onClick={onClose} size="md" variant="light">
              {t('common:close')}
            </Button>
          </ModalFooter>
        </>
      ) : secret === undefined ? (
        <Box mih="200px" />
      ) : (
        <LoaderModal label={t('common:loading')} mih="200px" />
      )}
    </Modal>
  );
}

function SecretForm({
  secret,
  onClose,
  onDone,
}: {
  secret: SecretView | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation(['vault', 'common']);
  const typeOptions = useTypeOptions();
  const failure = useFailure();
  const step = useStepUp();
  const [name, setName] = useState(secret?.name ?? '');
  const [type, setType] = useState<SecretType>(secret?.type ?? 'generic');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState(secret?.description ?? '');
  const [expires, setExpires] = useState(secret?.expiresAt?.slice(0, 10) ?? '');
  const expiresAt = expires ? new Date(`${expires}T00:00:00.000Z`).toISOString() : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      step.run(() =>
        secret
          ? updateSecret(secret.id, {
              name: name.trim(),
              description: description.trim() || null,
              expiresAt: expiresAt ?? null,
              ...(value.length > 0 ? { value } : {}),
            })
          : createSecret({
              name: name.trim(),
              type,
              value,
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(expiresAt ? { expiresAt } : {}),
            }),
      ),
    onSuccess: () => {
      notifySuccess(name.trim(), secret ? t('toast.updated') : t('toast.created'));
      onDone();
      onClose();
    },
    onError: (error) => {
      failure.report(secret ? t('menu.change') : t('form.addTitle'), error, t('form.forbidden'));
    },
  });
  const check = CreateSecretRequestSchema.safeParse({
    name: name.trim(),
    type,
    value: value || 'x',
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (check.success && (secret || value.length > 0)) {
      mutation.mutate();
    }
  };

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        <TextInput
          styles={LABEL_WEIGHT}
          autoComplete="off"
          data-autofocus
          label={t('form.name')}
          leftSection={<IconTag size={16} />}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
          required
          value={name}
        />
        <Select
          styles={LABEL_WEIGHT}
          allowDeselect={false}
          data={typeOptions}
          description={secret ? t('form.kindLocked') : undefined}
          disabled={secret !== undefined}
          label={t('form.kind')}
          onChange={(v) => {
            setType(asType(v) ?? 'generic');
          }}
          value={type}
        />
        <Textarea
          autoComplete="off"
          autosize
          description={secret ? t('form.valueHintEdit') : t('form.valueHintCreate')}
          label={secret ? t('form.newValue') : t('form.value')}
          maxRows={8}
          minRows={3}
          onChange={(e) => {
            setValue(e.currentTarget.value);
          }}
          required={secret === undefined}
          spellCheck={false}
          styles={{
            ...LABEL_WEIGHT,
            input: { fontFamily: 'var(--mantine-font-family-monospace)' },
          }}
          value={value}
        />
        <TextInput
          styles={LABEL_WEIGHT}
          label={t('form.description')}
          onChange={(e) => {
            setDescription(e.currentTarget.value);
          }}
          value={description}
        />
        <DatePickerInput
          styles={LABEL_WEIGHT}
          clearable
          description={t('form.expiresHint')}
          highlightToday
          label={t('form.expiresOn')}
          leftSection={<IconCalendar size={16} />}
          locale={i18n.resolvedLanguage ?? i18n.language}
          minDate={new Date()}
          onChange={(value) => {
            setExpires(value ?? '');
          }}
          valueFormat="D MMMM, YYYY"
          value={expires === '' ? null : expires}
        />
      </Stack>
      <ModalFooter>
        <Button
          color="teal"
          leftSection={<IconDeviceFloppy size={16} />}
          loading={mutation.isPending}
          size="md"
          type="submit"
          variant="soft"
        >
          {secret ? t('common:save') : t('form.submitCreate')}
        </Button>
      </ModalFooter>
    </form>
  );
}

/** The four operations of the key-rotation card, in the order they are listed. */
type RotationKind = 'passphrase' | 'recoveryKey' | 'kek' | 'dataKeys';

/**
 * `needsOpen`: the key is needed in memory, so the vault has to be unsealed. The icon and its colour tell the four
 * apart, as the icons of the tools in the panel's backend-tools card do.
 */
const ROTATIONS: readonly {
  readonly kind: RotationKind;
  readonly needsOpen: boolean;
  readonly icon: TablerIcon;
  readonly color: string;
}[] = [
  { kind: 'passphrase', needsOpen: false, icon: IconKey, color: 'blue' },
  { kind: 'recoveryKey', needsOpen: false, icon: IconLifebuoy, color: 'orange' },
  { kind: 'kek', needsOpen: true, icon: IconShieldLock, color: 'violet' },
  { kind: 'dataKeys', needsOpen: true, icon: IconRefreshDot, color: 'teal' },
];

/**
 * One card per operation, as the panel lists its backend tools: what it does, when it was last done, and a small
 * button on the right.
 */
function RotationCard({
  status,
  onStart,
}: {
  status: VaultStatus;
  onStart: (kind: RotationKind) => void;
}) {
  const { t } = useTranslation('vault');
  const formatTime = useTimeFirst();
  const open = status.state === 'unsealed';
  const lastDone: Record<RotationKind, string | null> = {
    passphrase: status.passphraseChangedAt,
    recoveryKey: status.recoveryKeyRotatedAt,
    kek: status.kekRotatedAt,
    dataKeys: status.dataKeysRotatedAt,
  };

  return (
    <SettingsCard.Container>
      <SettingsCard.Header
        description={t('rotation.description')}
        icon={<IconRefreshDot size={24} />}
        iconColor="blue"
        title={t('rotation.title')}
      />
      <SettingsCard.Content>
        {ROTATIONS.map(({ kind, needsOpen, icon: Icon, color }) => {
          const at = lastDone[kind];
          const blocked = needsOpen && !open;
          return (
            <Card key={kind} radius="md" withBorder>
              <Group gap="md" justify="space-between" wrap="nowrap">
                <Group gap="md" wrap="nowrap">
                  <ThemeIcon color={color} size="lg" variant="soft">
                    <Icon size={20} />
                  </ThemeIcon>
                  <Stack gap={2} miw={0}>
                    <Text fw={600} size="sm">
                      {t(`rotation.${kind}.title`)}
                    </Text>
                    <Text c="dimmed" size="xs">
                      {t(`rotation.${kind}.description`)}
                    </Text>
                    <Text c="dimmed" size="xs">
                      {at ? t('rotation.lastDone', { date: formatTime(at) }) : t('rotation.never')}
                    </Text>
                    {blocked ? (
                      <Text c="yellow" size="xs">
                        {t('rotation.needsOpen')}
                      </Text>
                    ) : null}
                  </Stack>
                </Group>

                <Button
                  disabled={blocked}
                  flex="none"
                  onClick={() => {
                    onStart(kind);
                  }}
                  size="xs"
                  variant="soft"
                >
                  {t(`rotation.${kind}.action`)}
                </Button>
              </Group>
            </Card>
          );
        })}
      </SettingsCard.Content>
    </SettingsCard.Container>
  );
}

/** Change the passphrase. It works while the vault is sealed; nothing is re-encrypted. */
function ChangePassphraseDialog({
  opened,
  onClose,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['vault', 'common']);
  const failure = useFailure();
  const step = useStepUp();
  const isMobile = useIsMobile();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      step.run(() => changeVaultPassphrase({ currentPassphrase: current, newPassphrase: next })),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
      onDone();
      onClose();
    },
    onError: (error) => {
      if (!isFieldError(error)) {
        failure.report(t('rotation.passphrase.action'), error, t('rotation.passphrase.forbidden'));
      }
    },
  });
  const valid = current.length > 0 && isNewPassphraseValid(next, repeat);
  const close = () => {
    mutation.reset();
    setCurrent('');
    setNext('');
    setRepeat('');
    onClose();
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (valid) {
      mutation.mutate();
    }
  };

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      fullScreen={isMobile}
      onClose={close}
      opened={opened}
      title={
        <OverlayHeader icon={IconKey} iconColor="cyan" title={t('rotation.passphrase.action')} />
      }
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Text c="dimmed" fz="sm">
            {t('rotation.passphrase.intro')}
          </Text>
          <PasswordInput
            styles={LABEL_WEIGHT}
            autoComplete="off"
            data-autofocus
            error={failure.fieldMessage(
              mutation.error,
              t('rotation.passphrase.forbidden'),
              t('rotation.wrongPassphrase'),
            )}
            label={t('rotation.passphrase.currentLabel')}
            leftSection={<IconLock size={16} />}
            onChange={(e) => {
              setCurrent(e.currentTarget.value);
            }}
            required
            value={current}
          />
          <NewPassphraseFields
            autoFocus={false}
            onPassphrase={setNext}
            onRepeat={setRepeat}
            passphrase={next}
            passphraseLabel={t('rotation.passphrase.newLabel')}
            repeat={repeat}
            repeatLabel={t('rotation.passphrase.repeatLabel')}
          />
        </Stack>
        <ModalFooter>
          <Button
            color="teal"
            disabled={!valid}
            leftSection={<IconKey size={16} />}
            loading={mutation.isPending}
            size="md"
            type="submit"
            variant="soft"
          >
            {t('rotation.passphrase.submit')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/**
 * Rotate the recovery key or the key-encryption key. Both ask for the passphrase again and both answer with a new
 * recovery key, which is shown once. The dialog cannot be left while the call runs or before the key is stored: the
 * old key is already dead and this is the only time the new one is seen.
 */
function NewRecoveryKeyDialog({
  kind,
  opened,
  onClose,
  onDone,
}: {
  kind: 'recoveryKey' | 'kek';
  opened: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['vault', 'common']);
  const failure = useFailure();
  const step = useStepUp();
  const isMobile = useIsMobile();
  const [passphrase, setPassphrase] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      step.run(() =>
        kind === 'kek' ? rotateKek({ passphrase }) : rotateRecoveryKey({ passphrase }),
      ),
    onSuccess: () => {
      setPassphrase('');
      onDone();
    },
    onError: (error) => {
      if (!isFieldError(error)) {
        failure.report(t(`rotation.${kind}.action`), error, t(`rotation.${kind}.forbidden`));
      }
    },
  });
  const created: VaultInitialized | undefined = mutation.data;
  const locked = mutation.isPending || created !== undefined;
  const close = () => {
    mutation.reset();
    setPassphrase('');
    onClose();
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (passphrase.length > 0) {
      mutation.mutate();
    }
  };

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      closeOnClickOutside={!locked}
      closeOnEscape={!locked}
      fullScreen={isMobile}
      onClose={close}
      opened={opened}
      title={
        <OverlayHeader
          icon={IconKey}
          iconColor="orange"
          title={created ? t('rotation.newKey.title') : t(`rotation.${kind}.action`)}
        />
      }
      withCloseButton={!locked}
    >
      {created ? (
        <RecoveryKeyPanel
          doneLabel={t('common:close')}
          layout="modal"
          onDone={close}
          recoveryKey={created.recoveryKey}
          warning={t('rotation.newKey.warning')}
        />
      ) : (
        <form onSubmit={submit}>
          <Stack gap="md">
            <Text c="dimmed" fz="sm">
              {t(`rotation.${kind}.intro`)}
            </Text>
            <PasswordInput
              styles={LABEL_WEIGHT}
              autoComplete="off"
              data-autofocus
              error={failure.fieldMessage(
                mutation.error,
                t(`rotation.${kind}.forbidden`),
                t('rotation.wrongPassphrase'),
              )}
              label={t('rotation.passphraseLabel')}
              leftSection={<IconLock size={16} />}
              onChange={(e) => {
                setPassphrase(e.currentTarget.value);
              }}
              required
              value={passphrase}
            />
          </Stack>
          <ModalFooter>
            <Button
              color="teal"
              disabled={passphrase.length === 0}
              leftSection={<IconKey size={16} />}
              loading={mutation.isPending}
              size="md"
              type="submit"
              variant="soft"
            >
              {t(`rotation.${kind}.submit`)}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

/** Encrypt every secret again under a fresh data key. Needs the vault open; no passphrase is asked. */
function RotateDataKeysDialog({
  opened,
  onClose,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  onDone: (rotated: number) => void;
}) {
  const { t } = useTranslation(['vault', 'common']);
  const failure = useFailure();
  const step = useStepUp();
  const isMobile = useIsMobile();
  const mutation = useMutation({
    mutationFn: () => step.run(() => rotateDataKeys()),
    onSuccess: (result) => {
      onDone(result.rotated);
      onClose();
    },
    onError: (error) => {
      failure.report(t('rotation.dataKeys.action'), error, t('rotation.dataKeys.forbidden'));
    },
  });
  const close = () => {
    mutation.reset();
    onClose();
  };

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      fullScreen={isMobile}
      onClose={close}
      opened={opened}
      title={
        <OverlayHeader
          icon={IconRefreshDot}
          iconColor="cyan"
          title={t('rotation.dataKeys.action')}
        />
      }
    >
      <Text fz="sm">{t('rotation.dataKeys.intro')}</Text>
      <ModalFooter>
        <Button
          color="teal"
          leftSection={<IconRefreshDot size={16} />}
          loading={mutation.isPending}
          onClick={() => {
            mutation.mutate();
          }}
          size="md"
          variant="soft"
        >
          {t('rotation.dataKeys.submit')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** The row actions of a secret, as the panel's card tables show them: soft icon buttons in one group. */
function SecretActions({
  secret,
  canReveal,
  canManage,
  open,
  onReveal,
  onEdit,
  onDelete,
}: {
  secret: SecretView;
  canReveal: boolean;
  canManage: boolean;
  /** The vault is unsealed: only then can a value be revealed. */
  open: boolean;
  onReveal: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(['vault', 'common']);
  return (
    <ActionIcon.Group>
      {canReveal ? (
        <Tooltip label={t('menu.reveal')} withArrow>
          <ActionIcon
            aria-label={t('list.revealAria', { name: secret.name })}
            disabled={!open}
            onClick={onReveal}
            size="input-sm"
            variant="soft"
          >
            <IconEye size="1.5rem" />
          </ActionIcon>
        </Tooltip>
      ) : null}
      {canManage ? (
        <>
          <Tooltip label={t('menu.change')} withArrow>
            <ActionIcon
              aria-label={t('list.changeAria', { name: secret.name })}
              color="teal"
              onClick={onEdit}
              size="input-sm"
              variant="soft"
            >
              <IconPencil size="1.5rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('common:delete')} withArrow>
            <ActionIcon
              aria-label={t('list.deleteAria', { name: secret.name })}
              color="red"
              onClick={onDelete}
              size="input-sm"
              variant="soft"
            >
              <IconTrash size="1.5rem" />
            </ActionIcon>
          </Tooltip>
        </>
      ) : null}
    </ActionIcon.Group>
  );
}

/** The secrets of the vault as the panel's card table: filters under the head, sorting, columns and pages. */
function SecretsTable({
  secrets,
  loading,
  fetching,
  loadFailure,
  canManage,
  canReveal,
  open,
  onDelete,
  onEdit,
  onReveal,
}: {
  secrets: readonly SecretView[];
  loading: boolean;
  fetching: boolean;
  /** The text of the failure when the list could not be read. */
  loadFailure?: string;
  canManage: boolean;
  canReveal: boolean;
  /** The vault is unsealed. */
  open: boolean;
  onDelete: (secret: SecretView) => void;
  onEdit: (secret: SecretView) => void;
  onReveal: (secret: SecretView) => void;
}) {
  const { t } = useTranslation(['vault', 'common']);
  const formatDay = useFullDate();
  const formatTime = useTimeFirst();
  const typeOptions = useTypeOptions();

  const columns = useMemo<MRT_ColumnDef<SecretView>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('list.name'),
        size: 320,
        Cell: ({ row }) => (
          <Stack gap={0}>
            <Text fw={500} fz="sm" maw={360} title={row.original.name} truncate="end">
              {row.original.name}
            </Text>
            {row.original.description ? (
              <Text c="dimmed" fz="xs" maw={360} title={row.original.description} truncate="end">
                {row.original.description}
              </Text>
            ) : null}
          </Stack>
        ),
      },
      {
        accessorKey: 'type',
        header: t('list.kind'),
        size: 170,
        filterVariant: 'select',
        mantineFilterSelectProps: { data: typeOptions },
        Cell: ({ row }) => (
          <Badge color="gray" size="lg" variant="soft">
            {t(`types.${row.original.type}`)}
          </Badge>
        ),
      },
      {
        accessorKey: 'version',
        header: t('list.version'),
        size: 110,
        enableColumnFilter: false,
        Cell: ({ row }) => (
          <Text c="dimmed" fz="sm">
            v{row.original.version}
          </Text>
        ),
      },
      {
        id: 'expiry',
        header: t('list.expires'),
        size: 270,
        accessorFn: (secret) => expiryState(secret),
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: (['expired', 'soon', 'ok', 'none'] as const).map((value) => ({
            value,
            label: t(`expiry.filter.${value}`),
          })),
        },
        sortingFn: (a, b) => {
          // The soonest first, and what never expires last.
          const left = a.original.expiresAt;
          const right = b.original.expiresAt;
          if (left === right) {
            return 0;
          }
          if (left === null) {
            return 1;
          }
          if (right === null) {
            return -1;
          }
          return left < right ? -1 : 1;
        },
        Cell: ({ row }) => {
          const secret = row.original;
          if (secret.expiresAt === null) {
            return (
              <Text c="dimmed" fz="sm">
                {t('common:never')}
              </Text>
            );
          }
          const day = formatDay(secret.expiresAt);
          return expiryState(secret) === 'ok' ? (
            <StatusBadge kind="ok">{day}</StatusBadge>
          ) : (
            <Stack gap={2}>
              <SecretExpiryBadge secret={secret} />
              <Text c="dimmed" fz="xs">
                {day}
              </Text>
            </Stack>
          );
        },
      },
      {
        id: 'valueChangedAt',
        header: t('list.valueChanged'),
        accessorFn: (secret) => formatTime(secret.valueChangedAt),
        minSize: 250,
        enableColumnFilter: false,
        mantineTableBodyCellProps: { ff: 'monospace' },
      },
    ],
    [t, typeOptions, formatDay, formatTime],
  );

  const tableState = useMrtTableState('vault-secrets-v3');
  usePreventTableBackScroll();
  const localization = useTableLocalization(t('list.empty'));
  const table = useMantineReactTable<SecretView>({
    ...panelTableOptions<SecretView>(),
    columns,
    data: secrets as SecretView[],
    localization,
    ...tableState.handlers,
    state: {
      ...tableState.state,
      isLoading: loading,
      showAlertBanner: false,
      showProgressBars: fetching,
    },
    getRowId: (secret) => secret.id,
    enableRowActions: canManage || canReveal,
    displayColumnDefOptions: { 'mrt-row-actions': { size: 140 } },
    renderRowActions: ({ row }) => (
      <SecretActions
        canManage={canManage}
        canReveal={canReveal}
        onDelete={() => {
          onDelete(row.original);
        }}
        onEdit={() => {
          onEdit(row.original);
        }}
        onReveal={() => {
          onReveal(row.original);
        }}
        open={open}
        secret={row.original}
      />
    ),
  });

  return (
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
        icon={<IconKey size={24} />}
        title={t('list.title')}
      />
      <DataTableCard.Content>
        {loadFailure === undefined ? (
          <MantineReactTable table={table} />
        ) : (
          <Box p="md">
            <ErrorMessageBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('common:copy')}
              message={loadFailure}
            />
          </Box>
        )}
      </DataTableCard.Content>
    </DataTableCard.Container>
  );
}

/** The vault: set it up, unseal it, keep secrets. Values are write-only except through a recorded reveal. */
export function VaultPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['vault', 'common']);
  const formatDay = useFullDate();
  const formatNumber = useNumber();
  const failure = useFailure();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const canManage = permissions.includes('vault:manage');
  const canReveal = permissions.includes('vault:reveal');
  const step = useStepUp();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SecretView | undefined>(undefined);
  const [revealing, setRevealing] = useState<SecretView | undefined>(undefined);
  const [rotating, setRotating] = useState<RotationKind | undefined>(undefined);

  const state = useQuery({ queryKey: ['vault', 'status'], queryFn: getVaultStatus, retry: false });
  const secrets = useQuery({ queryKey: ['vault', 'secrets'], queryFn: listSecrets, retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['vault'] });
  const seal = useMutation({
    mutationFn: () => step.run(() => sealVault()),
    onSuccess: refresh,
    onError: (error) => {
      failure.report(t('header.sealNow'), error, t('seal.forbidden'));
    },
  });
  const remove = useMutation({
    mutationFn: (secret: SecretView) => step.run(() => deleteSecret(secret.id)),
    onSuccess: (_result, secret) => {
      notifySuccess(secret.name, t('toast.deleted'));
      void refresh();
    },
    onError: (error) => {
      failure.report(t('common:delete'), error, t('delete.forbidden'));
    },
  });
  const askDelete = (secret: SecretView) => {
    confirmAction({
      title: t('delete.title', { name: secret.name }),
      message: t('delete.warning'),
      confirmLabel: t('common:delete'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        remove.mutate(secret);
      },
    });
  };

  const status: VaultStatus | undefined = state.data;
  const open = status?.state === 'unsealed';

  const stateBadge =
    status === undefined ? undefined : status.state === 'unsealed' ? (
      <StatusBadge kind="ok">{t('states.unsealed')}</StatusBadge>
    ) : status.state === 'sealed' ? (
      <StatusBadge kind="warn">{t('states.sealed')}</StatusBadge>
    ) : (
      <StatusBadge kind="wait">{t('states.uninitialized')}</StatusBadge>
    );

  const header = (
    <PageHeader
      actions={
        <HeaderActions>
          {canManage && open ? (
            <HeaderAction
              color="gray"
              icon={IconLock}
              label={t('header.sealNow')}
              loading={seal.isPending}
              onClick={() => {
                seal.mutate();
              }}
            />
          ) : null}
          <HeaderAction
            icon={IconRefresh}
            label={t('common:refresh')}
            loading={state.isRefetching || secrets.isRefetching}
            onClick={() => void refresh()}
          />
          {canManage && open ? (
            <HeaderAction
              color="teal"
              icon={IconPlus}
              label={t('header.addSecret')}
              onClick={() => {
                setAdding(true);
              }}
            />
          ) : null}
        </HeaderActions>
      }
      badges={stateBadge}
      description={t('header.description')}
      icon={<IconKey size={24} />}
      title={t('header.title')}
    />
  );

  if (state.isPending) {
    return (
      <>
        {header}
        <LoadingScreen height="60vh" />
      </>
    );
  }
  if (state.isError || !status) {
    return (
      <>
        {header}
        <SectionCard.Root>
          <SectionCard.Section>
            <OverlayHeader
              icon={IconAlertCircle}
              iconColor="red"
              title={t('error.statusTitle')}
              titleOrder={5}
            />
          </SectionCard.Section>
          <SectionCard.Section>
            <ErrorMessageBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('common:copy')}
              message={failure.message(state.error, t('list.statusFailed'))}
            />
          </SectionCard.Section>
        </SectionCard.Root>
      </>
    );
  }
  if (status.state === 'uninitialized') {
    return (
      <>
        {header}
        {canManage ? (
          <SetupVault
            onDone={() => {
              void refresh();
            }}
          />
        ) : (
          <EmptyPageLayout
            description={t('setup.ownerNeeded')}
            icon={<IconShieldLock size={32} />}
            title={t('setup.title')}
          />
        )}
      </>
    );
  }

  const list = secrets.data?.secrets ?? [];

  return (
    <>
      {header}
      <Stack gap="md">
        {status.state === 'sealed' ? (
          canManage ? (
            <Unseal
              onDone={() => {
                void refresh();
              }}
            />
          ) : (
            <SectionCard.Root maw={450} mx="auto" w="100%">
              <SectionCard.Section>
                <OverlayHeader
                  icon={IconLock}
                  iconColor="blue"
                  subtitle={t('sealed.ownerNeeded')}
                  title={t('sealed.title')}
                  titleOrder={5}
                />
              </SectionCard.Section>
            </SectionCard.Root>
          )
        ) : null}

        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xs">
          <MetricCard
            formatValue={formatNumber}
            icon={PiKeyDuotone}
            iconColor="blue"
            title={t('summary.secrets')}
            value={status.secretCount}
          />
          <MetricCard
            icon={PiLockKeyDuotone}
            iconColor="cyan"
            title={t('summary.keyVersion')}
            value={status.kekVersion ?? '—'}
          />
          <MetricCard
            icon={PiCalendarCheckDuotone}
            iconColor="gray"
            title={t('summary.setUp')}
            value={status.createdAt ? formatDay(status.createdAt) : '—'}
          />
        </SimpleGrid>

        {list.some((secret) => secret.expired) ? (
          <Callout color="red">
            {t('expiry.notice', { count: list.filter((secret) => secret.expired).length })}
          </Callout>
        ) : null}

        <SecretsTable
          canManage={canManage}
          canReveal={canReveal}
          fetching={secrets.isFetching}
          loading={secrets.isPending}
          onDelete={askDelete}
          onEdit={setEditing}
          onReveal={setRevealing}
          open={open}
          secrets={list}
          {...(secrets.isError
            ? { loadFailure: failure.message(secrets.error, t('list.loadFailed')) }
            : {})}
        />

        {canManage ? (
          <RotationCard
            onStart={(kind) => {
              setRotating(kind);
            }}
            status={status}
          />
        ) : null}
      </Stack>

      <Modal
        closeButtonProps={{ 'aria-label': t('common:close') }}
        fullScreen={isMobile}
        onClose={() => {
          setAdding(false);
        }}
        opened={adding}
        title={<OverlayHeader icon={IconPlus} iconColor="teal" title={t('form.addTitle')} />}
      >
        {adding ? (
          <SecretForm
            onClose={() => {
              setAdding(false);
            }}
            onDone={() => void refresh()}
            secret={undefined}
          />
        ) : null}
      </Modal>
      <Modal
        closeButtonProps={{ 'aria-label': t('common:close') }}
        fullScreen={isMobile}
        onClose={() => {
          setEditing(undefined);
        }}
        opened={editing !== undefined}
        title={
          <OverlayHeader
            icon={IconPencil}
            iconColor="teal"
            title={t('form.editTitle', { name: editing?.name ?? '' })}
            truncateTitle
          />
        }
      >
        {editing ? (
          <SecretForm
            key={editing.id}
            onClose={() => {
              setEditing(undefined);
            }}
            onDone={() => void refresh()}
            secret={editing}
          />
        ) : null}
      </Modal>
      <RevealDialog
        onClose={() => {
          setRevealing(undefined);
        }}
        secret={revealing}
      />
      {canManage ? (
        <>
          <ChangePassphraseDialog
            onClose={() => {
              setRotating(undefined);
            }}
            onDone={() => {
              notifySuccess(t('rotation.passphrase.action'), t('rotation.passphrase.done'));
              void refresh();
            }}
            opened={rotating === 'passphrase'}
          />
          <NewRecoveryKeyDialog
            kind="recoveryKey"
            onClose={() => {
              setRotating(undefined);
            }}
            onDone={() => void refresh()}
            opened={rotating === 'recoveryKey'}
          />
          <NewRecoveryKeyDialog
            kind="kek"
            onClose={() => {
              setRotating(undefined);
            }}
            onDone={() => void refresh()}
            opened={rotating === 'kek'}
          />
          <RotateDataKeysDialog
            onClose={() => {
              setRotating(undefined);
            }}
            onDone={(count) => {
              notifySuccess(t('rotation.dataKeys.action'), t('rotation.dataKeys.done', { count }));
              void refresh();
            }}
            opened={rotating === 'dataKeys'}
          />
        </>
      ) : null}
    </>
  );
}
