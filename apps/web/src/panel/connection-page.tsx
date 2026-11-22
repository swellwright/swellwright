// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the settings pages built from `SettingsCardShared`
// (src/pages/dashboard/remnawave-settings/components/remnawave-settings.page.component.tsx and the cards of
// src/widgets/dashboard/remnawave-settings/*: a header with a soft icon, the content, a bottom bar with the action) and the
// accordion of its authentication card (src/widgets/dashboard/remnawave-settings/authentification-settings-card). The
// panel has no page about a connection to another panel, so this is built from those cards. Changes: the cards show the
// state of the connection that the last check found, what the token can read, and a form that connects.
import {
  Accordion,
  Button,
  Card,
  Checkbox,
  DataList,
  Group,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { PiFloppyDiskDuotone } from 'react-icons/pi';
import {
  TbCertificate,
  TbInfoCircle,
  TbPlugConnected,
  TbPlugConnectedX,
  TbShieldCheck,
} from 'react-icons/tb';
import { Link } from 'react-router';

import {
  PANEL_RESOURCES,
  type Permission,
  type PanelCapabilityState,
  type PanelConnectionView,
  type PanelResource,
} from '@swellwright/contracts';
import {
  Callout,
  CopyableDataListItem,
  ErrorMessageBlock,
  HeaderAction,
  HeaderActions,
  LoadingScreen,
  PageHeader,
  SettingsCard,
  StatusBadge,
  type StatusKind,
} from '@swellwright/ui';

import {
  connectPanel,
  connectPanelWithToken,
  disconnectPanel,
  getPanelConnection,
  listSecrets,
  testPanel,
} from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { useDateTime } from '../format.js';
import { ROUTES } from '../routes.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { confirmAction, notifySuccess, notifyWarning } from '../shell/feedback.js';
import { panelKey } from './panel-data.js';
import { CONNECTION_STATE_KIND } from './panel-format.js';

/** The key of the connection itself; the reads of the objects are under `['panel', kind]`. */
const CONNECTION_KEY = panelKey('connection');

const CAPABILITY_KIND: Record<PanelCapabilityState, StatusKind> = {
  ok: 'ok',
  denied: 'warn',
  failed: 'err',
};

type TokenMode = 'vault' | 'paste';

/** How a token that expires is told: the date and the days left, orange from the warning on, red once it has expired. */
function ExpiryBadge({ token }: { token: NonNullable<PanelConnectionView['token']> }) {
  const { t } = useTranslation('panel');
  if (token.daysLeft === null) {
    return null;
  }
  const kind: StatusKind = token.daysLeft < 0 ? 'err' : token.expiryWarning ? 'warn' : 'ok';
  return (
    <StatusBadge kind={kind}>
      {token.daysLeft < 0
        ? t('connection.token.expired')
        : t('connection.token.daysLeft', { count: token.daysLeft })}
    </StatusBadge>
  );
}

/** The row of the status card that says what the last check found about the token. */
function TokenRows({ token }: { token: NonNullable<PanelConnectionView['token']> }) {
  const { t } = useTranslation(['panel', 'common']);
  const formatTime = useDateTime();
  return (
    <>
      <CopyableDataListItem
        copiedLabel={t('common:copied')}
        copyLabel={t('common:copy')}
        label={t('connection.rows.token')}
        value={token.secretName}
      />
      <DataList.Item>
        <DataList.ItemLabel>{t('connection.rows.tokenExpires')}</DataList.ItemLabel>
        <DataList.ItemValue>
          {token.expiresAt === null ? (
            <Text c="dimmed" size="sm">
              {t('connection.token.noExpiry')}
            </Text>
          ) : (
            <Group gap="xs" wrap="wrap">
              <Text size="sm">{formatTime(token.expiresAt)}</Text>
              <ExpiryBadge token={token} />
            </Group>
          )}
        </DataList.ItemValue>
      </DataList.Item>
    </>
  );
}

/** What a warning of the connection says, in the language of the console. */
function WarningText({
  warning,
  token,
}: {
  warning: PanelConnectionView['warnings'][number];
  token: PanelConnectionView['token'];
}) {
  const { t } = useTranslation('panel');
  if (
    warning.code === 'token_expiring' &&
    token?.daysLeft !== null &&
    token?.daysLeft !== undefined
  ) {
    return <>{t('connection.warnings.tokenExpiring', { count: Math.max(token.daysLeft, 0) })}</>;
  }
  if (warning.code === 'capabilities_limited') {
    return <>{t('connection.warnings.capabilitiesLimited')}</>;
  }
  return <>{warning.message}</>;
}

/** The state of the connection: what the last check found, and the actions on it. */
function StatusCard({
  connection,
  canWrite,
  latencyMs,
  onTested,
}: {
  connection: PanelConnectionView;
  canWrite: boolean;
  /** The time the last test of this session took, when there was one. */
  latencyMs: number | undefined;
  onTested: (latencyMs: number) => void;
}) {
  const { t } = useTranslation(['panel', 'common', 'errors']);
  const queryClient = useQueryClient();
  const formatTime = useDateTime();
  const connected = connection.state !== 'unconfigured';

  const test = useMutation({
    mutationFn: testPanel,
    onSuccess: (result) => {
      queryClient.setQueryData(CONNECTION_KEY, result.connection);
      // What was read from the panel before may not be what it says now.
      void queryClient.invalidateQueries({ queryKey: ['panel'] });
      onTested(result.latencyMs);
      const title = t(`connection.states.${result.connection.state}`);
      const text = t('connection.test.done', { ms: result.latencyMs });
      if (result.ok) {
        notifySuccess(title, text);
      } else {
        notifyWarning(title, result.connection.lastError?.message ?? text);
      }
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('connection.test.failed'),
        error,
        t('signInAgain'),
        t('connection.noWrite'),
      );
    },
  });

  const disconnect = useMutation({
    mutationFn: disconnectPanel,
    onSuccess: () => {
      queryClient.setQueryData(CONNECTION_KEY, {
        state: 'unconfigured',
        baseUrl: null,
        panelVersion: null,
        versionSupport: null,
        capabilities: null,
        token: null,
        warnings: [],
        lastCheckedAt: null,
        lastError: null,
        trustedCa: false,
        createdAt: null,
        updatedAt: null,
      } satisfies PanelConnectionView);
      queryClient.removeQueries({ queryKey: ['panel'] });
      void queryClient.invalidateQueries({ queryKey: CONNECTION_KEY });
      notifySuccess(t('connection.disconnect.done'), t('connection.disconnect.doneText'));
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('connection.disconnect.failed'),
        error,
        t('signInAgain'),
        t('connection.noWrite'),
      );
    },
  });

  const askDisconnect = () => {
    confirmAction({
      title: t('connection.disconnect.title'),
      message: <Text size="sm">{t('connection.disconnect.text')}</Text>,
      confirmLabel: t('connection.disconnect.confirm'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        disconnect.mutate();
      },
    });
  };

  const support = connection.versionSupport;
  const noWriteTip = canWrite ? undefined : t('connection.noWrite');

  return (
    <SettingsCard.Container>
      <SettingsCard.Header
        description={t(`connection.stateHints.${connection.state}`)}
        icon={connected ? <TbPlugConnected size={24} /> : <TbPlugConnectedX size={24} />}
        title={t('connection.status.title')}
      />

      <SettingsCard.Content>
        {connected ? (
          <Stack gap="md">
            <DataList orientation="vertical" withDivider>
              <DataList.Item>
                <DataList.ItemLabel>{t('connection.rows.state')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  <StatusBadge kind={CONNECTION_STATE_KIND[connection.state]}>
                    {t(`connection.states.${connection.state}`)}
                  </StatusBadge>
                </DataList.ItemValue>
              </DataList.Item>
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('connection.rows.address')}
                monospace
                value={connection.baseUrl}
              />
              <DataList.Item>
                <DataList.ItemLabel>{t('connection.rows.version')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  {connection.panelVersion === null ? (
                    <Text c="dimmed" size="sm">
                      –
                    </Text>
                  ) : (
                    <Group gap="xs" wrap="wrap">
                      <Text ff="monospace" size="sm">
                        {connection.panelVersion}
                      </Text>
                      {support === null ? null : support.status === 'supported' ? (
                        <StatusBadge kind="ok">
                          {t('connection.version.supported', { range: support.range })}
                        </StatusBadge>
                      ) : (
                        <StatusBadge kind="err">{t('connection.version.unsupported')}</StatusBadge>
                      )}
                    </Group>
                  )}
                </DataList.ItemValue>
              </DataList.Item>
              {support?.status === 'unsupported' && support.reason !== null ? (
                <DataList.Item>
                  <DataList.ItemLabel>{t('connection.rows.versionWhy')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    <Text size="sm">{support.reason}</Text>
                  </DataList.ItemValue>
                </DataList.Item>
              ) : null}
              {connection.token === null ? null : <TokenRows token={connection.token} />}
              <DataList.Item>
                <DataList.ItemLabel>{t('connection.rows.lastCheck')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Text size="sm">
                    {connection.lastCheckedAt === null
                      ? t('common:never')
                      : formatTime(connection.lastCheckedAt)}
                  </Text>
                </DataList.ItemValue>
              </DataList.Item>
              {latencyMs === undefined ? null : (
                <DataList.Item>
                  <DataList.ItemLabel>{t('connection.rows.latency')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    <Text size="sm">{t('connection.test.latency', { ms: latencyMs })}</Text>
                  </DataList.ItemValue>
                </DataList.Item>
              )}
              <DataList.Item>
                <DataList.ItemLabel>{t('connection.rows.ownCa')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Text size="sm">{connection.trustedCa ? t('common:yes') : t('common:no')}</Text>
                </DataList.ItemValue>
              </DataList.Item>
            </DataList>

            {connection.warnings.map((warning) => (
              <Callout color="orange" icon={<TbInfoCircle size={20} />} key={warning.code}>
                <WarningText token={connection.token} warning={warning} />
              </Callout>
            ))}

            {connection.lastError === null ||
            // The reason a version is not supported is in the row above; say it once.
            connection.lastError.message === support?.reason ? null : (
              <ErrorMessageBlock
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                message={connection.lastError.message}
              />
            )}
          </Stack>
        ) : (
          <Text c="dimmed" size="sm">
            {t('connection.status.empty')}
          </Text>
        )}
      </SettingsCard.Content>

      {connected ? (
        <SettingsCard.Bottom>
          <Group justify="space-between">
            <Tooltip disabled={canWrite} label={noWriteTip}>
              <span>
                <Button
                  color="cyan"
                  disabled={!canWrite}
                  leftSection={<TbPlugConnected size={18} />}
                  loading={test.isPending}
                  onClick={() => {
                    test.mutate();
                  }}
                  size="md"
                  variant="light"
                >
                  {t('connection.test.button')}
                </Button>
              </span>
            </Tooltip>
            <Tooltip disabled={canWrite} label={noWriteTip}>
              <span>
                <Button
                  color="red"
                  disabled={!canWrite}
                  loading={disconnect.isPending}
                  onClick={askDisconnect}
                  size="md"
                  variant="soft"
                >
                  {t('connection.disconnect.button')}
                </Button>
              </span>
            </Tooltip>
          </Group>
        </SettingsCard.Bottom>
      ) : null}
    </SettingsCard.Container>
  );
}

/** What the token can read: one chip per kind of object, found by reading each once. */
function CapabilitiesCard({ connection }: { connection: PanelConnectionView }) {
  const { t } = useTranslation(['panel', 'common']);
  const formatTime = useDateTime();
  const capabilities = connection.capabilities;
  return (
    <SettingsCard.Container>
      <SettingsCard.Header
        description={t('connection.capabilities.description')}
        icon={<TbShieldCheck size={24} />}
        iconColor="teal"
        title={t('connection.capabilities.title')}
      />
      <SettingsCard.Content>
        {capabilities === null ? (
          <Text c="dimmed" size="sm">
            {t('connection.capabilities.none')}
          </Text>
        ) : (
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {PANEL_RESOURCES.map((resource: PanelResource) => {
                const state = capabilities.resources[resource];
                const normal = resource === 'apiTokens' && state === 'denied';
                return (
                  <Card key={resource} p="sm" withBorder>
                    <Group gap="xs" justify="space-between" wrap="nowrap">
                      <Text fw={500} size="sm" truncate>
                        {t(`connection.resources.${resource}`)}
                      </Text>
                      <Tooltip
                        disabled={state !== 'failed' || connection.lastError === null}
                        label={connection.lastError?.message}
                        multiline
                        w={320}
                        withArrow
                      >
                        <span>
                          <StatusBadge kind={normal ? 'wait' : CAPABILITY_KIND[state]}>
                            {t(`connection.capabilities.${state}`)}
                          </StatusBadge>
                        </span>
                      </Tooltip>
                    </Group>
                  </Card>
                );
              })}
            </SimpleGrid>
            <Text c="dimmed" fz="xs">
              {t('connection.capabilities.apiTokensNote')}
            </Text>
            <Text c="dimmed" fz="xs">
              {t('connection.capabilities.checkedAt', { time: formatTime(capabilities.checkedAt) })}
            </Text>
          </Stack>
        )}
      </SettingsCard.Content>
    </SettingsCard.Container>
  );
}

/** The form that connects, or connects again with another address or token. */
function ConnectCard({
  connection,
  permissions,
}: {
  connection: PanelConnectionView;
  permissions: readonly Permission[];
}) {
  const { t } = useTranslation(['panel', 'common', 'vault', 'errors']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const canWrite = permissions.includes('panel:write');
  const canManageVault = permissions.includes('vault:manage');
  const canReadVault = permissions.includes('vault:read');
  const connected = connection.state !== 'unconfigured';

  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? '');
  const [mode, setMode] = useState<TokenMode>('vault');
  const [secretId, setSecretId] = useState<string | null>(connection.token?.secretId ?? null);
  const [token, setToken] = useState('');
  const [secretName, setSecretName] = useState<string>(t('connection.form.defaultSecretName'));
  const [trustedCa, setTrustedCa] = useState('');
  const [removeCa, setRemoveCa] = useState(false);
  const [touched, setTouched] = useState(false);

  const secrets = useQuery({
    queryKey: ['vault', 'secrets'],
    queryFn: listSecrets,
    enabled: canReadVault,
    retry: false,
  });
  const options = (secrets.data?.secrets ?? [])
    .filter((secret) => secret.type === 'panel_token')
    .map((secret) => ({ value: secret.id, label: secret.name }));

  const urlOk = baseUrl.trim().length >= 8;
  const secretOk = secretId !== null && options.some((option) => option.value === secretId);
  const tokenOk = token.trim().length >= 16;
  const nameOk = secretName.trim().length >= 1 && secretName.trim().length <= 100;
  const valid = urlOk && (mode === 'vault' ? secretOk : tokenOk && nameOk);

  /** `null` takes an authority of its own away, text sets it, nothing leaves what is there. */
  const caField = (): { trustedCa?: string | null } => {
    if (removeCa) {
      return { trustedCa: null };
    }
    return trustedCa.trim() === '' ? {} : { trustedCa: trustedCa.trim() };
  };

  const connect = useMutation({
    mutationFn: () =>
      mode === 'vault'
        ? connectPanel({ baseUrl: baseUrl.trim(), tokenSecretId: secretId ?? '', ...caField() })
        : step.run(() =>
            connectPanelWithToken({
              baseUrl: baseUrl.trim(),
              token: token.trim(),
              secretName: secretName.trim(),
              ...caField(),
            }),
          ),
    onSuccess: (view) => {
      queryClient.setQueryData(CONNECTION_KEY, view);
      // Everything read before came from the old connection.
      void queryClient.invalidateQueries({ queryKey: ['panel'] });
      void queryClient.invalidateQueries({ queryKey: ['vault'] });
      // The token is in the vault now; it does not stay in the page.
      setToken('');
      setTrustedCa('');
      setRemoveCa(false);
      setTouched(false);
      setMode('vault');
      setSecretId(view.token?.secretId ?? null);
      const title = t(`connection.states.${view.state}`);
      if (view.state === 'connected') {
        notifySuccess(title, t('connection.form.connected'));
      } else {
        notifyWarning(title, t(`connection.stateHints.${view.state}`));
      }
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('connection.form.failed'),
        error,
        t('signInAgain'),
        t('connection.noWrite'),
      );
    },
  });

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (canWrite && valid) {
      connect.mutate();
    }
  };

  const disabled = !canWrite;

  return (
    <form onSubmit={submit} style={{ display: 'contents' }}>
      <SettingsCard.Container>
        <SettingsCard.Header
          description={t('connection.form.description')}
          icon={<TbPlugConnected size={24} />}
          title={connected ? t('connection.form.titleChange') : t('connection.form.titleConnect')}
        />

        <SettingsCard.Content>
          <Stack gap="md">
            {canWrite ? null : (
              <Callout color="blue" icon={<TbInfoCircle size={20} />}>
                {t('connection.noWrite')}
              </Callout>
            )}

            <TextInput
              autoComplete="off"
              data-autofocus
              description={t('connection.form.addressHint')}
              disabled={disabled}
              error={touched && !urlOk ? t('connection.form.addressError') : undefined}
              label={t('connection.form.address')}
              onChange={(event) => {
                setBaseUrl(event.currentTarget.value);
              }}
              placeholder="https://panel.example.com"
              required
              value={baseUrl}
            />

            <Stack gap={4}>
              <Text fw={500} size="sm">
                {t('connection.form.tokenSource')}
              </Text>
              <SegmentedControl
                data={[
                  { value: 'vault', label: t('connection.form.fromVault') },
                  { value: 'paste', label: t('connection.form.paste'), disabled: !canManageVault },
                ]}
                disabled={disabled}
                onChange={(value) => {
                  setMode(value === 'paste' ? 'paste' : 'vault');
                }}
                value={mode}
              />
              {canManageVault ? null : (
                <Text c="dimmed" size="xs">
                  {t('connection.form.pasteNeedsVault')}
                </Text>
              )}
            </Stack>

            {mode === 'vault' ? (
              <Select
                allowDeselect={false}
                data={options}
                description={t('connection.form.secretHint')}
                disabled={disabled || !canReadVault}
                error={
                  touched && !secretOk
                    ? t('connection.form.secretError')
                    : secrets.isError
                      ? t('connection.form.secretsFailed')
                      : undefined
                }
                label={t('connection.form.secret')}
                nothingFoundMessage={t('connection.form.noSecrets', {
                  kind: t('vault:types.panel_token'),
                })}
                onChange={setSecretId}
                placeholder={t('connection.form.chooseSecret')}
                required
                searchable
                value={secretId}
              />
            ) : (
              <>
                <PasswordInput
                  autoComplete="off"
                  description={t('connection.form.tokenHint')}
                  disabled={disabled}
                  error={touched && !tokenOk ? t('connection.form.tokenError') : undefined}
                  label={t('connection.form.token')}
                  onChange={(event) => {
                    setToken(event.currentTarget.value);
                  }}
                  required
                  value={token}
                />
                <TextInput
                  autoComplete="off"
                  description={t('connection.form.secretNameHint')}
                  disabled={disabled}
                  error={touched && !nameOk ? t('connection.form.secretNameError') : undefined}
                  label={t('connection.form.secretName')}
                  maxLength={100}
                  onChange={(event) => {
                    setSecretName(event.currentTarget.value);
                  }}
                  required
                  value={secretName}
                />
              </>
            )}

            <Accordion variant="separated">
              <Accordion.Item value="advanced">
                <Accordion.Control
                  icon={
                    <ThemeIcon color="gray" size="lg" variant="light">
                      <TbCertificate size={20} />
                    </ThemeIcon>
                  }
                >
                  {t('connection.form.advanced')}
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="md">
                    <Textarea
                      autosize
                      description={t('connection.form.caHint')}
                      disabled={disabled || removeCa}
                      label={t('connection.form.ca')}
                      maxRows={10}
                      minRows={4}
                      onChange={(event) => {
                        setTrustedCa(event.currentTarget.value);
                      }}
                      placeholder="-----BEGIN CERTIFICATE-----"
                      spellCheck={false}
                      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                      value={trustedCa}
                    />
                    {connection.trustedCa ? (
                      <Checkbox
                        checked={removeCa}
                        disabled={disabled}
                        label={t('connection.form.removeCa')}
                        onChange={(event) => {
                          setRemoveCa(event.currentTarget.checked);
                        }}
                      />
                    ) : null}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Stack>
        </SettingsCard.Content>

        <SettingsCard.Bottom>
          <Group justify="flex-start">
            <Tooltip disabled={canWrite} label={t('connection.noWrite')}>
              <span>
                <Button
                  color="teal"
                  disabled={disabled}
                  leftSection={<PiFloppyDiskDuotone size="16px" />}
                  loading={connect.isPending}
                  size="md"
                  type="submit"
                  variant="soft"
                >
                  {connected ? t('connection.form.save') : t('connection.form.connect')}
                </Button>
              </span>
            </Tooltip>
          </Group>
        </SettingsCard.Bottom>
      </SettingsCard.Container>
    </form>
  );
}

/** What the token needs, in a few lines: the panel decides it, so this says where to look. */
function TokenHelpCard({ canReadVault }: { canReadVault: boolean }) {
  const { t } = useTranslation('panel');
  return (
    <SettingsCard.Container>
      <SettingsCard.Header
        description={t('connection.help.description')}
        icon={<TbInfoCircle size={24} />}
        iconColor="blue"
        title={t('connection.help.title')}
      />
      <SettingsCard.Content>
        <Stack gap="xs">
          <Text size="sm">{t('connection.help.scopes')}</Text>
          <Text size="sm">{t('connection.help.readOnly')}</Text>
          <Text size="sm">{t('connection.help.apiTokens')}</Text>
          <Text size="sm">
            <Trans
              components={{
                vault: (
                  <Text c="cyan" component={Link} inherit to={ROUTES.DASHBOARD.SECURITY.VAULT} />
                ),
              }}
              i18nKey={canReadVault ? 'connection.help.vault' : 'connection.help.vaultNoRight'}
              ns="panel"
            />
          </Text>
        </Stack>
      </SettingsCard.Content>
    </SettingsCard.Container>
  );
}

/**
 * Panel > Connection: where the Remnawave panel is, with which token (a secret of the vault), and what the last check
 * found. A panel that does not answer is a state of the page, not a failure of it.
 */
export function ConnectionPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['panel', 'common', 'errors']);
  const [latencyMs, setLatencyMs] = useState<number | undefined>(undefined);
  const canWrite = permissions.includes('panel:write');

  const query = useQuery({ queryKey: CONNECTION_KEY, queryFn: getPanelConnection, retry: false });

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            />
          </HeaderActions>
        }
        description={t('connection.description')}
        icon={<TbPlugConnected size={24} />}
        title={t('connection.title')}
      />

      {query.isPending ? (
        <LoadingScreen height="60vh" />
      ) : query.isError ? (
        <QueryErrorCard
          message={describeError(t, query.error, t('signInAgain'), t('readForbidden'))}
          onRetry={() => void query.refetch()}
          title={t('connection.loadFailed')}
        />
      ) : (
        <Stack gap="md">
          <StatusCard
            canWrite={canWrite}
            connection={query.data}
            latencyMs={latencyMs}
            onTested={setLatencyMs}
          />
          {query.data.state === 'unconfigured' ? null : (
            <CapabilitiesCard connection={query.data} />
          )}
          <ConnectCard
            connection={query.data}
            key={query.data.baseUrl ?? 'none'}
            permissions={permissions}
          />
          <TokenHelpCard canReadVault={permissions.includes('vault:read')} />
        </Stack>
      )}
    </>
  );
}
