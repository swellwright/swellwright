// The settings card of `SettingsForm` is adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/_modals/
// external-squads/external-squads-drawer/tabs/external-squads-response-headers.widget.tsx (a `SectionCard` whose header row
// carries the Save button). Changes: the fields are made from the plugin's schema, the Save button waits for a change, and
// the header row wraps on a phone.
import {
  Anchor,
  Button,
  Group,
  List,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconDeviceFloppy,
  IconHash,
  IconKey,
  IconListDetails,
  IconSettings,
  IconTextCaption,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { type SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  type PluginConfigField,
  type PluginConfigView,
  type PluginView,
  SECRET_TYPES,
  type SecretView,
  type UpdatePluginConfigRequest,
} from '@swellwright/contracts';
import {
  Callout,
  ErrorMessageBlock,
  LoaderModal,
  OverlayHeader,
  SectionCard,
} from '@swellwright/ui';

import { ApiRequestError, getPluginConfig, listSecrets, updatePluginConfig } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { useDateTime, useNumber } from '../format.js';
import { ROUTES } from '../routes.js';
import { notifySuccess } from '../shell/feedback.js';
import { useIsMobile } from '../shell/use-is-mobile.js';
import { FailureCard, useCopyLabels, usePluginFailure } from './plugin-shared.js';

/** How many characters of a secret's id are shown when the secrets cannot be listed. */
const SHORT_ID = 8;

/**
 * What a field holds in the form. Text and number inputs keep what was typed (`''` is empty; a number input may hold
 * a half-typed string such as `1.`), a switch a boolean, a list of choices or of secrets the chosen value or `null`.
 */
type Draft = string | number | boolean | null;

/** Where the secrets of the vault stand, for the pickers: not loaded yet, not listable by this person, or here. */
type SecretChoices =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly secrets: readonly SecretView[] };

/**
 * The panel's forms inside a dialog or a drawer (users, nodes) give every field a 500 label (`styles={{ label: {
 * fontWeight: 500 } }}`); only the page-level settings cards keep Mantine's heavier default.
 */
const LABEL_STYLES = { label: { fontWeight: 500 } } as const;

/** Under `['plugins']`, so the page's own refreshes reach it too; what the person typed is not in the cache. */
const pluginConfigKey = (id: string) => ['plugins', id, 'config'] as const;

const shortId = (id: string): string => `${id.slice(0, SHORT_ID)}…`;

/** What the form starts with for a field: the stored value, or the empty state of its input. */
function initialOf(field: PluginConfigField, values: PluginConfigView['values']): Draft {
  const stored = values[field.name];
  switch (field.type) {
    case 'boolean':
      return stored === true;
    case 'integer':
    case 'number':
      return typeof stored === 'number' ? stored : '';
    case 'string':
      if (field.secretKind !== null || field.choices !== null) {
        return typeof stored === 'string' ? stored : null;
      }
      return typeof stored === 'string' ? stored : '';
  }
}

/** What goes to the server for a field. Empty means "not set" (`null`); the server applies the default then. */
function requestValue(
  field: PluginConfigField,
  draft: Draft,
): UpdatePluginConfigRequest['values'][string] {
  if (typeof draft === 'boolean' || typeof draft === 'number' || draft === null) {
    return draft;
  }
  const text = draft.trim();
  if (text === '') {
    return null;
  }
  if (field.type === 'integer' || field.type === 'number') {
    const parsed = Number(text);
    // Not a number: the server says so, in words that name the field.
    return Number.isFinite(parsed) ? parsed : draft;
  }
  return draft;
}

/** The limits of a text or number field, in words (empty when it has none). */
function limitsHint(
  field: PluginConfigField,
  t: TFunction<'plugins'>,
  formatNumber: (value: number) => string,
): string | undefined {
  if (field.type === 'string') {
    const min = field.minLength !== null && field.minLength > 0 ? field.minLength : null;
    const max = field.maxLength;
    if (min !== null && max !== null) {
      return min === max
        ? t('settings.lengthExact', { count: max })
        : t('settings.lengthBoth', { min, count: max });
    }
    if (min !== null) {
      return t('settings.lengthMin', { count: min });
    }
    return max === null ? undefined : t('settings.lengthMax', { count: max });
  }
  if (field.type === 'boolean') {
    return undefined;
  }
  const { minimum, maximum } = field;
  if (minimum !== null && maximum !== null) {
    return t('settings.rangeBoth', { min: formatNumber(minimum), max: formatNumber(maximum) });
  }
  if (minimum !== null) {
    return t('settings.rangeMin', { min: formatNumber(minimum) });
  }
  return maximum === null ? undefined : t('settings.rangeMax', { max: formatNumber(maximum) });
}

/** A picker of the vault's secrets of one kind. A secret is chosen here, never typed, and its value is never shown. */
function SecretPicker({
  field,
  kind,
  label,
  description,
  value,
  disabled,
  choices,
  canReadVault,
  onChange,
}: {
  field: PluginConfigField;
  kind: string;
  label: string;
  description: string | undefined;
  value: Draft;
  disabled: boolean;
  choices: SecretChoices;
  canReadVault: boolean;
  onChange: (value: Draft) => void;
}) {
  const { t } = useTranslation(['plugins', 'vault', 'common']);
  const bound = typeof value === 'string' ? value : null;

  if (choices.status !== 'ready') {
    return (
      <Stack gap={4}>
        <TextInput
          styles={LABEL_STYLES}
          description={description}
          disabled
          label={label}
          leftSection={<IconKey size={16} />}
          placeholder={choices.status === 'loading' ? t('common:loading') : t('settings.notSet')}
          value={bound === null ? '' : shortId(bound)}
          withAsterisk={field.required}
        />
        {choices.status === 'unavailable' ? (
          <Text c="dimmed" fz="xs">
            {t('settings.secretsUnavailable')}
          </Text>
        ) : null}
      </Stack>
    );
  }

  // The vault names its types with underscores, a plugin names the kind with dashes.
  const type = kind.replaceAll('-', '_');
  const known = SECRET_TYPES.find((candidate) => candidate === type);
  const options = choices.secrets
    .filter((secret) => secret.type === type)
    .map((secret) => ({
      value: secret.id,
      // A plugin is not given an expired secret (ADR 0042): the list says which ones those are.
      label: secret.expired ? `${secret.name}${t('vault:expiry.expiredSuffix')}` : secret.name,
    }));
  // What is bound but not in the list (deleted, or of another kind) stays visible, so it is not silently dropped.
  if (bound !== null && !options.some((option) => option.value === bound)) {
    options.unshift({ value: bound, label: t('settings.secretMissing', { id: shortId(bound) }) });
  }

  return (
    <Stack gap={4}>
      <Select
        styles={LABEL_STYLES}
        allowDeselect={!field.required}
        clearable={!field.required}
        data={options}
        description={description}
        disabled={disabled}
        label={label}
        leftSection={<IconKey size={16} />}
        nothingFoundMessage={t('settings.noSecrets', {
          type: known === undefined ? type : t(`vault:types.${known}`),
        })}
        onChange={onChange}
        placeholder={t('settings.notSet')}
        value={bound}
        withAsterisk={field.required}
      />
      <Text c="dimmed" fz="xs">
        {t('settings.secretHint')}{' '}
        {canReadVault ? (
          <Anchor component={Link} fz="xs" to={ROUTES.DASHBOARD.SECURITY.VAULT}>
            {t('settings.secretCreate')}
          </Anchor>
        ) : null}
      </Text>
    </Stack>
  );
}

/** One setting as the input that suits it. */
function SettingInput({
  field,
  value,
  disabled,
  secrets,
  canReadVault,
  onChange,
}: {
  field: PluginConfigField;
  value: Draft;
  disabled: boolean;
  secrets: SecretChoices;
  canReadVault: boolean;
  onChange: (value: Draft) => void;
}) {
  const { t } = useTranslation('plugins');
  const formatNumber = useNumber();
  const label = field.title ?? field.name;
  const { secretKind } = field;
  const hint =
    secretKind !== null || field.choices !== null ? undefined : limitsHint(field, t, formatNumber);
  const parts = [field.description, hint].filter(
    (part): part is string => part !== null && part !== undefined,
  );
  const description = parts.length > 0 ? parts.join(' · ') : undefined;
  const placeholder = field.default === null ? undefined : String(field.default);

  if (secretKind !== null) {
    return (
      <SecretPicker
        canReadVault={canReadVault}
        choices={secrets}
        description={description}
        disabled={disabled}
        field={field}
        kind={secretKind}
        label={label}
        onChange={onChange}
        value={value}
      />
    );
  }
  if (field.type === 'boolean') {
    return (
      <Switch
        checked={value === true}
        description={description}
        disabled={disabled}
        label={label}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />
    );
  }
  if (field.type === 'integer' || field.type === 'number') {
    return (
      <NumberInput
        styles={LABEL_STYLES}
        allowDecimal={field.type === 'number'}
        allowNegative={field.minimum === null || field.minimum < 0}
        description={description}
        disabled={disabled}
        label={label}
        leftSection={<IconHash size={16} />}
        {...(field.maximum === null ? {} : { max: field.maximum })}
        {...(field.minimum === null ? {} : { min: field.minimum })}
        onChange={(next) => {
          // Only a `valueType` of bigint gives a bigint, and this input has none.
          onChange(typeof next === 'bigint' ? String(next) : next);
        }}
        placeholder={placeholder}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        withAsterisk={field.required}
      />
    );
  }
  if (field.choices !== null) {
    return (
      <Select
        styles={LABEL_STYLES}
        allowDeselect={!field.required}
        clearable={!field.required}
        data={field.choices}
        description={description}
        disabled={disabled}
        label={label}
        leftSection={<IconListDetails size={16} />}
        onChange={onChange}
        placeholder={placeholder}
        value={typeof value === 'string' ? value : null}
        withAsterisk={field.required}
      />
    );
  }
  return (
    <TextInput
      styles={LABEL_STYLES}
      autoComplete="off"
      description={description}
      disabled={disabled}
      label={label}
      leftSection={<IconTextCaption size={16} />}
      maxLength={field.maxLength ?? undefined}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
      placeholder={placeholder}
      value={typeof value === 'string' ? value : ''}
      withAsterisk={field.required}
    />
  );
}

/** What the server says is wrong with the stored settings (a field the plugin added since): names are data. */
function ProblemsCallout({ problems }: { problems: PluginConfigView['problems'] }) {
  const { t } = useTranslation('plugins');
  if (problems.length === 0) {
    return null;
  }
  return (
    <Callout
      color="orange"
      icon={<IconAlertTriangle size={20} />}
      title={t('settings.problemsTitle')}
    >
      <List fz="sm" size="sm" spacing={2}>
        {problems.map((problem) => (
          <List.Item key={`${problem.field}:${problem.message}`}>
            <Text component="span" ff="monospace" fz="sm">
              {problem.field}
            </Text>{' '}
            {problem.message}
          </List.Item>
        ))}
      </List>
    </Callout>
  );
}

/**
 * The form. What the person typed is kept apart from what the server holds (`edits` over `view`), so a refetch of
 * the settings never wipes it; a save clears it, and the stored values come back from the server.
 */
function SettingsForm({
  plugin,
  view,
  canManage,
  canReadVault,
}: {
  plugin: PluginView;
  view: PluginConfigView;
  canManage: boolean;
  canReadVault: boolean;
}) {
  const { t } = useTranslation(['plugins', 'common', 'errors']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const fail = usePluginFailure();
  const labels = useCopyLabels();
  const formatDate = useDateTime('short');
  const isMobile = useIsMobile();
  const [edits, setEdits] = useState<ReadonlyMap<string, Draft>>(() => new Map());
  // A 400 names each field the server refused, in its own words (English): shown next to the fields, not as a toast.
  const [rejected, setRejected] = useState<string | undefined>(undefined);

  const needsSecrets = view.fields.some((field) => field.secretKind !== null);
  const vault = useQuery({
    queryKey: ['vault', 'secrets'],
    queryFn: listSecrets,
    retry: false,
    enabled: needsSecrets && canReadVault,
  });
  let secrets: SecretChoices = { status: 'ready', secrets: [] };
  if (needsSecrets) {
    if (!canReadVault || vault.isError) {
      secrets = { status: 'unavailable' };
    } else if (vault.data === undefined) {
      secrets = { status: 'loading' };
    } else {
      secrets = { status: 'ready', secrets: vault.data.secrets };
    }
  }

  const initial = (field: PluginConfigField): Draft => initialOf(field, view.values);
  const current = (field: PluginConfigField): Draft => {
    const edited = edits.get(field.name);
    return edited === undefined ? initial(field) : edited;
  };
  const dirty = view.fields.some((field) => current(field) !== initial(field));

  const save = useMutation({
    mutationFn: (values: UpdatePluginConfigRequest['values']) =>
      step.run(() => updatePluginConfig(plugin.id, values)),
    onMutate: () => {
      setRejected(undefined);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(pluginConfigKey(plugin.id), updated);
      void queryClient.invalidateQueries({ queryKey: pluginConfigKey(plugin.id) });
      setEdits(new Map());
      notifySuccess(t('settings.title'), t('settings.saved'));
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'bad_request') {
        setRejected(error.message);
      } else {
        fail(t('settings.title'), error, t('settings.forbidden'));
      }
    },
  });

  const change = (field: PluginConfigField, value: Draft) => {
    setRejected(undefined);
    setEdits((previous) => new Map(previous).set(field.name, value));
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!canManage || !dirty || save.isPending) {
      return;
    }
    save.mutate(
      Object.fromEntries(
        view.fields.map((field) => [field.name, requestValue(field, current(field))]),
      ),
    );
  };

  // The panel puts a settings-like form inside an overlay into a `SectionCard` whose header row carries the Save button
  // (`external-squads-response-headers.widget.tsx`), not into the page-level `SettingsCard`, so the dialog keeps one
  // look for all its cards.
  return (
    <form onSubmit={submit} style={{ display: 'contents' }}>
      <SectionCard.Root>
        <SectionCard.Section>
          <Group gap="md" justify="space-between" wrap={isMobile ? 'wrap' : 'nowrap'}>
            <OverlayHeader
              icon={IconSettings}
              iconColor="violet"
              subtitle={t('settings.description')}
              title={t('settings.title')}
              titleOrder={5}
            />
            {canManage ? (
              <Button
                color="teal"
                disabled={!dirty}
                leftSection={<IconDeviceFloppy size="1.2rem" />}
                loading={save.isPending}
                size="md"
                style={{ flexShrink: 0 }}
                type="submit"
                variant="soft"
              >
                {t('common:save')}
              </Button>
            ) : null}
          </Group>
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <ProblemsCallout problems={view.problems} />
            {view.fields.map((field) => (
              <SettingInput
                canReadVault={canReadVault}
                disabled={!canManage || save.isPending}
                field={field}
                key={field.name}
                onChange={(value) => {
                  change(field, value);
                }}
                secrets={secrets}
                value={current(field)}
              />
            ))}
            {canManage ? null : (
              <Text c="dimmed" fz="xs">
                {t('settings.readOnly')}
              </Text>
            )}
            {rejected === undefined ? null : (
              <Stack gap="xs" role="alert">
                <Text c="red" size="xs">
                  {t('errors:validation')}
                </Text>
                <ErrorMessageBlock message={rejected} {...labels} />
              </Stack>
            )}
          </Stack>
        </SectionCard.Section>
        <SectionCard.Section>
          <Text c="dimmed" fz="xs">
            {view.updatedAt !== null && view.updatedBy !== null
              ? t('settings.lastChanged', {
                  who: view.updatedBy,
                  when: formatDate(view.updatedAt),
                })
              : t('settings.neverSaved')}
          </Text>
        </SectionCard.Section>
      </SectionCard.Root>
    </form>
  );
}

/**
 * The settings a plugin declares, as a form made from them (ADR 0029). Reading needs `plugins:read`, saving
 * `plugins:manage` and a fresh confirmation with a code. A secret is chosen from the vault, never typed here.
 */
export function PluginSettings({
  plugin,
  canManage,
  canReadVault,
}: {
  plugin: PluginView;
  canManage: boolean;
  canReadVault: boolean;
}) {
  const { t } = useTranslation(['plugins', 'common']);
  const config = useQuery({
    queryKey: pluginConfigKey(plugin.id),
    queryFn: () => getPluginConfig(plugin.id),
    retry: false,
  });
  if (config.data !== undefined) {
    return (
      <SettingsForm
        canManage={canManage}
        canReadVault={canReadVault}
        plugin={plugin}
        view={config.data}
      />
    );
  }
  if (config.isError) {
    return (
      <FailureCard
        height={160}
        message={describeError(t, config.error, t('signInAgain'), t('settings.loadFailed'))}
        onRetry={() => void config.refetch()}
        retrying={config.isRefetching}
        title={t('settings.title')}
      />
    );
  }
  return <LoaderModal label={t('common:loading')} mih="160px" />;
}
