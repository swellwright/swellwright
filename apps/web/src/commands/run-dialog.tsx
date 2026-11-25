// The dialog follows the panel's modals (a titled `Modal`, `OverlayHeader`, the sticky `ModalFooter` with a teal soft
// primary button) and its way of confirming a dangerous action (`confirmAction`: a red soft confirm and a subtle cancel).
// Running a script on servers has no counterpart in the panel; the inputs are the panel's.
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  type ComboboxItem,
  type ComboboxLikeRenderOptionInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconLock,
  IconPlayerPlay,
  IconPlus,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  checkParameterValues,
  type CommandRunView,
  type CreateCommandRunRequest,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  DANGER_LEVELS,
  type DangerLevel,
  isRunSecretNameAllowed,
  isRunSecretType,
  MAX_INLINE_COMMAND_BYTES,
  MAX_RUN_SECRETS,
  MAX_RUN_SERVERS,
  MAX_RUN_TIMEOUT_SECONDS,
  parameterSecretName,
  type ScriptSummary,
  type ServerSummary,
  utf8Length,
} from '@swellwright/contracts';
import { Callout, ModalFooter, OverlayHeader, SectionCard } from '@swellwright/ui';

import { createCommandRun, listScripts, listSecrets } from '../api.js';
import { useStepUp } from '../auth/step-up.js';
import { notifyFailure } from '../security/notify-failure.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';
import { useIsMobile } from '../shell/use-is-mobile.js';
import { CodeEditor } from './code-editor.js';
import { DANGER_COLOR, DangerBadge } from './danger.js';
import {
  initialInput,
  type ParameterInput,
  ParameterValueFields,
  valuesToSend,
} from './parameter-fields.js';

/** A server the run cannot use is skipped by the API; the dialog says so before the person starts. */
const usable = (server: ServerSummary): boolean => server.pinned && server.accessCount > 0;

type Mode = 'script' | 'inline';

interface ScriptOption extends ComboboxItem {
  script: ScriptSummary;
}

export interface RunDialogProps {
  opened: boolean;
  onClose: () => void;
  /** Every server of the inventory: the dialog offers them when the person has to choose (from the Scripts page). */
  servers: readonly ServerSummary[];
  /**
   * The servers that are chosen when it opens (the selection of the servers table). The dialog takes them and the
   * script below when it is mounted: the caller gives it a new `key` for every opening.
   */
  initialServerIds: readonly string[];
  /** A script to start with (the Scripts page). */
  initialScriptId?: string | undefined;
  /** Show the choice of servers (it is the selection of the table, so the table's dialog does not). */
  chooseServers: boolean;
  /** The role holds `vault:reveal`: only then can a secret be handed to a run (ADR 0042). */
  canReveal: boolean;
  onStarted: (run: CommandRunView) => void;
}

/** One secret of the run as the form holds it, before it is checked. */
interface SecretRow {
  readonly key: number;
  readonly name: string;
  readonly secretId: string | null;
}

export function RunDialog({
  opened,
  onClose,
  servers,
  initialServerIds,
  initialScriptId,
  chooseServers,
  canReveal,
  onStarted,
}: RunDialogProps) {
  const { t } = useTranslation(['commands', 'common', 'errors', 'vault']);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const step = useStepUp();

  const [mode, setMode] = useState<Mode>('script');
  const [serverIds, setServerIds] = useState<string[]>([...initialServerIds]);
  const [scriptId, setScriptId] = useState<string | null>(initialScriptId ?? null);
  // What was typed for the parameters of one script; another script starts from its own defaults.
  const [typed, setTyped] = useState<{ scriptId: string | null; values: ParameterInput }>({
    scriptId: null,
    values: {},
  });
  const [command, setCommand] = useState('');
  const [inlineSudo, setInlineSudo] = useState(false);
  const [inlineLevel, setInlineLevel] = useState<DangerLevel>('change');
  const [timeout, setTimeout_] = useState<number | string>(DEFAULT_RUN_TIMEOUT_SECONDS);
  const [showErrors, setShowErrors] = useState(false);
  const [secretRows, setSecretRows] = useState<readonly SecretRow[]>([]);
  const rowKeys = useRef(0);

  // The secrets of the vault a run may be given (names only; a value never reaches this form).
  const vault = useQuery({
    queryKey: ['vault', 'secrets'],
    queryFn: listSecrets,
    enabled: opened && canReveal,
    retry: false,
  });
  const secretChoices = useMemo(
    () => (vault.data?.secrets ?? []).filter((secret) => isRunSecretType(secret.type)),
    [vault.data],
  );

  const scripts = useQuery({
    queryKey: ['scripts'],
    queryFn: listScripts,
    enabled: opened,
    retry: false,
  });
  const script = scripts.data?.scripts.find((candidate) => candidate.id === scriptId);

  const scriptOptions = useMemo(() => {
    const all = scripts.data?.scripts ?? [];
    const option = (item: ScriptSummary): ScriptOption => ({
      value: item.id,
      label: item.name,
      script: item,
    });
    return [
      { group: t('commands:run.builtinGroup'), items: all.filter((s) => s.builtin).map(option) },
      { group: t('commands:run.ownGroup'), items: all.filter((s) => !s.builtin).map(option) },
    ].filter((group) => group.items.length > 0);
  }, [scripts.data, t]);

  const chosen = serverIds
    .map((id) => servers.find((server) => server.id === id))
    .filter((server): server is ServerSummary => server !== undefined);
  const unusable = chosen.filter((server) => !usable(server));

  const input = useMemo<ParameterInput>(
    () =>
      script ? (typed.scriptId === script.id ? typed.values : initialInput(script.parameters)) : {},
    [script, typed],
  );

  const level: DangerLevel = mode === 'script' ? (script?.dangerLevel ?? 'read') : inlineLevel;
  const sudo = mode === 'script' ? (script?.sudo ?? false) : inlineSudo;

  const checked = useMemo(
    () => (script ? checkParameterValues(script.parameters, valuesToSend(input)) : undefined),
    [script, input],
  );
  const parameterIssues = checked && !checked.ok ? checked.issues : [];

  const timeoutNumber = typeof timeout === 'number' ? timeout : Number(timeout);
  const problems: string[] = [];
  if (serverIds.length === 0) {
    problems.push(t('commands:run.errors.noServers'));
  }
  if (serverIds.length > MAX_RUN_SERVERS) {
    problems.push(t('commands:run.errors.tooMany', { count: MAX_RUN_SERVERS }));
  }
  if (mode === 'script' && script === undefined) {
    problems.push(t('commands:run.errors.noScript'));
  }
  if (mode === 'script' && parameterIssues.length > 0) {
    problems.push(t('commands:run.errors.parameters'));
  }
  // The names a script's secret parameters take, so that a secret added here cannot clash with one.
  const parameterSecretNames =
    mode === 'script' && script
      ? script.parameters.flatMap((parameter) =>
          parameter.type === 'secret' ? [parameterSecretName(parameter.name)] : [],
        )
      : [];
  const secretErrors = secretRows.map((row) => {
    if (!isRunSecretNameAllowed(row.name)) {
      return t('commands:run.secrets.errors.name');
    }
    if (
      parameterSecretNames.includes(row.name) ||
      secretRows.some((other) => other.key !== row.key && other.name === row.name)
    ) {
      return t('commands:run.secrets.errors.duplicate');
    }
    return row.secretId === null ? t('commands:run.secrets.errors.choose') : undefined;
  });
  if (secretErrors.some((error) => error !== undefined)) {
    problems.push(t('commands:run.secrets.errors.summary'));
  }
  const needsSecretParameter = mode === 'script' && parameterSecretNames.length > 0;
  if (needsSecretParameter && !canReveal) {
    problems.push(t('commands:run.secrets.parameterForbidden'));
  }
  if (mode === 'inline' && command.trim() === '') {
    problems.push(t('commands:run.errors.noCommand'));
  }
  if (mode === 'inline' && utf8Length(command) > MAX_INLINE_COMMAND_BYTES) {
    problems.push(t('commands:run.errors.commandTooLong'));
  }
  if (
    !Number.isInteger(timeoutNumber) ||
    timeoutNumber < 1 ||
    timeoutNumber > MAX_RUN_TIMEOUT_SECONDS
  ) {
    problems.push(t('commands:run.errors.timeout', { max: MAX_RUN_TIMEOUT_SECONDS }));
  }

  const body = (): CreateCommandRunRequest => {
    const common = {
      serverIds,
      timeoutSeconds: timeoutNumber,
      ...(level === 'read' ? {} : { confirmedLevel: level }),
      ...(secretRows.length === 0
        ? {}
        : {
            secrets: secretRows.flatMap((row) =>
              row.secretId === null ? [] : [{ name: row.name, secretId: row.secretId }],
            ),
          }),
    };
    return mode === 'script' && script
      ? {
          mode: 'script',
          ...common,
          scriptId: script.id,
          parameters: valuesToSend(input),
          // The revision shown in this dialog: a script changed meanwhile is refused, not run unseen.
          expectedScriptRevision: script.updatedAt,
        }
      : {
          mode: 'inline',
          ...common,
          command,
          sudo: inlineSudo,
          dangerLevel: inlineLevel,
        };
  };

  const start = useMutation({
    // The request is fixed when the person confirms: a refresh of the scripts meanwhile must not change what runs.
    mutationFn: (request: CreateCommandRunRequest) => step.run(() => createCommandRun(request)),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ['command-runs'] });
      notifySuccess(
        t('commands:run.toast.title'),
        t('commands:run.toast.text', { count: run.targets.length }),
      );
      onStarted(run);
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('commands:run.title', { count: serverIds.length }),
        error,
        t('commands:signInAgain'),
        t('commands:run.forbidden'),
      );
    },
  });

  const submit = () => {
    setShowErrors(true);
    if (problems.length > 0) {
      return;
    }
    // What the person sees in the confirmation is what is sent: the request, with the revision of the script on show,
    // is made now and not again when they confirm.
    const request = body();
    if (level === 'read') {
      start.mutate(request);
      return;
    }
    // The approvals of the engine come later; until then a run that changes something is confirmed in so many words.
    const confirming = level;
    confirmAction({
      title: t('commands:run.confirm.title', { count: serverIds.length }),
      message: (
        <Stack gap="sm">
          <Group gap="xs">
            <DangerBadge level={level} />
            {sudo ? (
              <Badge color="gray" size="lg" variant="soft">
                {t('commands:badges.sudo')}
              </Badge>
            ) : null}
          </Group>
          <Text size="sm">{t(`commands:run.confirm.text.${confirming}`)}</Text>
          <Text fw={600} size="sm">
            {chosen.map((server) => server.name).join(', ')}
          </Text>
          <Text c="dimmed" size="xs">
            {t('commands:run.confirm.note')}
          </Text>
        </Stack>
      ),
      confirmLabel: t(`commands:run.confirm.button.${confirming}`),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        start.mutate(request);
      },
    });
  };

  const serverOptions = servers.map((server) => ({
    value: server.id,
    label: server.name,
    disabled: false,
  }));

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common:close') }}
      closeOnClickOutside={!start.isPending}
      closeOnEscape={!start.isPending}
      fullScreen={isMobile}
      onClose={onClose}
      opened={opened}
      size="xl"
      title={
        <OverlayHeader
          icon={IconPlayerPlay}
          iconColor={DANGER_COLOR[level]}
          title={t('commands:run.title', { count: serverIds.length })}
        />
      }
    >
      <Stack gap="md">
        <SectionCard.Root>
          <SectionCard.Section>
            <Stack gap="sm">
              {chooseServers ? (
                <MultiSelect
                  checkIconPosition="right"
                  clearable
                  data={serverOptions}
                  description={t('commands:run.servers.description', { max: MAX_RUN_SERVERS })}
                  label={t('commands:run.servers.title')}
                  nothingFoundMessage={t('commands:run.servers.nothing')}
                  onChange={setServerIds}
                  placeholder={t('commands:run.servers.placeholder')}
                  searchable
                  value={serverIds}
                  withAsterisk
                  {...(showErrors && serverIds.length === 0
                    ? { error: t('commands:run.errors.noServers') }
                    : {})}
                />
              ) : (
                <Stack gap={4}>
                  <Text fw={500} size="sm">
                    {t('commands:run.servers.title')}
                  </Text>
                  <Group gap={6}>
                    {chosen.map((server) => (
                      <Badge
                        color={usable(server) ? 'gray' : 'orange'}
                        key={server.id}
                        size="lg"
                        tt="none"
                        variant="soft"
                      >
                        {server.name}
                      </Badge>
                    ))}
                  </Group>
                </Stack>
              )}
              {unusable.length > 0 ? (
                <Callout color="orange" icon={<IconAlertTriangle size={20} />}>
                  {t('commands:run.servers.skipped', {
                    count: unusable.length,
                    names: unusable.map((server) => server.name).join(', '),
                  })}
                </Callout>
              ) : null}
            </Stack>
          </SectionCard.Section>
        </SectionCard.Root>

        <SegmentedControl
          data={[
            { value: 'script', label: t('commands:run.mode.script') },
            { value: 'inline', label: t('commands:run.mode.command') },
          ]}
          fullWidth
          onChange={(value) => {
            setMode(value);
          }}
          value={mode}
        />

        {mode === 'script' ? (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="sm">
                <Select
                  data={scriptOptions}
                  description={script?.description}
                  label={t('commands:run.script.label')}
                  nothingFoundMessage={t('commands:run.script.nothing')}
                  onChange={setScriptId}
                  placeholder={t('commands:run.script.placeholder')}
                  renderOption={({ option }: ComboboxLikeRenderOptionInput<ComboboxItem>) => {
                    const item = (option as ScriptOption).script;
                    return (
                      <Stack gap={2} style={{ minWidth: 0, width: '100%' }}>
                        <Group gap="xs" justify="space-between" wrap="nowrap">
                          <Text fw={500} size="sm" truncate>
                            {item.name}
                          </Text>
                          <DangerBadge level={item.dangerLevel} />
                        </Group>
                        <Text c="dimmed" lineClamp={2} size="xs">
                          {item.description}
                        </Text>
                      </Stack>
                    );
                  }}
                  searchable
                  value={scriptId}
                  withAsterisk
                  {...(showErrors && script === undefined
                    ? { error: t('commands:run.errors.noScript') }
                    : {})}
                />
                {script ? (
                  <Group gap="xs">
                    <DangerBadge level={script.dangerLevel} />
                    {script.sudo ? (
                      <Badge color="gray" size="lg" variant="soft">
                        {t('commands:badges.sudo')}
                      </Badge>
                    ) : null}
                    {script.builtin ? (
                      <Badge color="cyan" size="lg" variant="soft">
                        {t('commands:badges.builtin')}
                      </Badge>
                    ) : null}
                  </Group>
                ) : null}
                {script && script.parameters.length > 0 ? (
                  <ParameterValueFields
                    input={input}
                    issues={showErrors ? parameterIssues : []}
                    onChange={(name, value) => {
                      setTyped({ scriptId: script.id, values: { ...input, [name]: value } });
                    }}
                    parameters={script.parameters}
                    canPickSecret={canReveal}
                    secrets={secretChoices}
                  />
                ) : null}
                {script?.parameters.length === 0 ? (
                  <Text c="dimmed" size="sm">
                    {t('commands:run.script.noParameters')}
                  </Text>
                ) : null}
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        ) : (
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="sm">
                <Stack gap={4}>
                  <Text fw={500} size="sm">
                    {t('commands:run.command.label')}
                  </Text>
                  <Text c="dimmed" size="xs">
                    {t('commands:run.command.description')}
                  </Text>
                  <CodeEditor
                    height="200px"
                    label={t('commands:run.command.label')}
                    onChange={setCommand}
                    value={command}
                  />
                  {showErrors && command.trim() === '' ? (
                    <Text c="red" size="xs">
                      {t('commands:run.errors.noCommand')}
                    </Text>
                  ) : null}
                </Stack>
                <Callout color="orange" icon={<IconInfoCircle size={20} />}>
                  {t('commands:run.command.secrets')}
                </Callout>
                <Switch
                  checked={inlineSudo}
                  description={t('commands:run.command.sudoDescription')}
                  label={t('commands:run.command.sudo')}
                  onChange={(event) => {
                    setInlineSudo(event.currentTarget.checked);
                  }}
                />
                <Stack gap={4}>
                  <Text fw={500} size="sm">
                    {t('commands:run.command.level')}
                  </Text>
                  <SegmentedControl
                    color={DANGER_COLOR[inlineLevel]}
                    data={DANGER_LEVELS.map((value) => ({
                      value,
                      label: t(`commands:danger.${value}`),
                    }))}
                    onChange={(value) => {
                      setInlineLevel(value);
                    }}
                    value={inlineLevel}
                  />
                  <Text c="dimmed" size="xs">
                    {t('commands:run.command.levelDescription')}
                  </Text>
                </Stack>
              </Stack>
            </SectionCard.Section>
          </SectionCard.Root>
        )}

        <SectionCard.Root>
          <SectionCard.Section>
            <Stack gap="sm">
              <Group gap="xs" wrap="nowrap">
                <IconLock size={18} />
                <Text fw={500} size="sm">
                  {t('commands:run.secrets.title')}
                </Text>
              </Group>
              <Text c="dimmed" size="xs">
                {t('commands:run.secrets.description')}
              </Text>
              {canReveal ? (
                <Callout color="blue" icon={<IconInfoCircle size={20} />}>
                  {t('commands:run.secrets.notice')}
                </Callout>
              ) : (
                <Callout color="orange" icon={<IconAlertTriangle size={20} />}>
                  {t('commands:run.secrets.forbidden')}
                </Callout>
              )}
              {secretRows.map((row, index) => (
                <Group align="flex-start" gap="xs" key={row.key} wrap="nowrap">
                  <TextInput
                    description={t('commands:run.secrets.nameDescription')}
                    ff="monospace"
                    label={t('commands:run.secrets.name')}
                    maxLength={64}
                    onChange={(event) => {
                      const name = event.currentTarget.value.toUpperCase();
                      setSecretRows(
                        secretRows.map((other) =>
                          other.key === row.key ? { ...other, name } : other,
                        ),
                      );
                    }}
                    style={{ flex: '1 1 40%' }}
                    value={row.name}
                    {...(showErrors && secretErrors[index] !== undefined && row.name !== ''
                      ? { error: secretErrors[index] }
                      : {})}
                  />
                  <Select
                    data={secretChoices.map((secret) => ({
                      value: secret.id,
                      label: secret.expired
                        ? `${secret.name}${t('vault:expiry.expiredSuffix')}`
                        : secret.name,
                    }))}
                    label={t('commands:run.secrets.secret')}
                    leftSection={<IconLock size={16} />}
                    nothingFoundMessage={
                      secretChoices.length === 0
                        ? t('commands:run.secrets.noSecrets')
                        : t('commands:run.secrets.nothing')
                    }
                    onChange={(value) => {
                      setSecretRows(
                        secretRows.map((other) =>
                          other.key === row.key ? { ...other, secretId: value } : other,
                        ),
                      );
                    }}
                    placeholder={t('commands:run.secrets.placeholder')}
                    searchable
                    style={{ flex: '1 1 60%' }}
                    value={row.secretId}
                    {...(showErrors && row.secretId === null
                      ? { error: t('commands:run.secrets.errors.choose') }
                      : {})}
                  />
                  <Tooltip label={t('commands:run.secrets.remove')}>
                    <ActionIcon
                      aria-label={t('commands:run.secrets.remove')}
                      color="red"
                      mt={24}
                      onClick={() => {
                        setSecretRows(secretRows.filter((other) => other.key !== row.key));
                      }}
                      size="lg"
                      variant="soft"
                    >
                      <IconTrash size={18} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
              <Group>
                <Tooltip
                  disabled={canReveal && secretRows.length < MAX_RUN_SECRETS}
                  label={
                    canReveal
                      ? t('commands:run.secrets.full', { count: MAX_RUN_SECRETS })
                      : t('commands:run.secrets.forbidden')
                  }
                  withArrow
                >
                  <span>
                    <Button
                      color="teal"
                      disabled={!canReveal || secretRows.length >= MAX_RUN_SECRETS}
                      leftSection={<IconPlus size={16} />}
                      onClick={() => {
                        rowKeys.current += 1;
                        setSecretRows([
                          ...secretRows,
                          { key: rowKeys.current, name: '', secretId: null },
                        ]);
                      }}
                      variant="soft"
                    >
                      {t('commands:run.secrets.add')}
                    </Button>
                  </span>
                </Tooltip>
              </Group>
            </Stack>
          </SectionCard.Section>
        </SectionCard.Root>

        <SectionCard.Root>
          <SectionCard.Section>
            <NumberInput
              allowDecimal={false}
              description={t('commands:run.timeout.description')}
              label={t('commands:run.timeout.label')}
              max={MAX_RUN_TIMEOUT_SECONDS}
              min={1}
              onChange={setTimeout_}
              suffix={` ${t('commands:run.timeout.unit')}`}
              value={timeout}
            />
          </SectionCard.Section>
        </SectionCard.Root>

        {level !== 'read' ? (
          <Callout
            color={level === 'destructive' ? 'red' : 'orange'}
            icon={<IconAlertTriangle size={20} />}
          >
            {t(`commands:run.levelNotice.${level}`)}
          </Callout>
        ) : null}
      </Stack>
      <ModalFooter>
        <Button
          color="gray"
          disabled={start.isPending}
          leftSection={<IconTerminal2 size={16} />}
          onClick={onClose}
          size="md"
          variant="subtle"
        >
          {t('common:cancel')}
        </Button>
        <Button
          color={level === 'read' ? 'teal' : DANGER_COLOR[level]}
          leftSection={<IconPlayerPlay size={16} />}
          loading={start.isPending}
          onClick={submit}
          size="md"
          variant="soft"
        >
          {t('commands:run.submit', { count: serverIds.length })}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
