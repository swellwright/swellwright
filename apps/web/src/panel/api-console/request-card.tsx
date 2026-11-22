// New in Swellwright (ADR 0046). Built from the panel's pieces: a `SectionCard` whose first section is an `OverlayHeader`,
// the form fields of its settings pages (`TextInput` and `Select` with a label and a description under it), the primary
// action `Button color="teal" variant="soft"` and the amber/blue/red notes the panel draws as `Callout`s. The fields are
// made from the parameters the description of the panel's API lists for the operation, so a value is typed before it is
// sent; the server checks it again.
import { Button, Code, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import {
  IconApi,
  IconBan,
  IconCopy,
  IconInfoCircle,
  IconLock,
  IconPlugConnectedX,
  IconSend,
  IconShieldLock,
  IconUsers,
} from '@tabler/icons-react';
import type { ReactNode, SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { PanelConsoleOperation, PanelConsoleParam } from '@swellwright/contracts';
import { Callout, OverlayHeader, SectionCard } from '@swellwright/ui';

import { ROUTES } from '../../routes.js';
import { type FormValues, paramKey } from './console-model.js';
import { OperationBadges } from './console-parts.js';

const PLACEHOLDER: Record<string, string> = {
  uuid: '00000000-0000-4000-8000-000000000000',
  date: 'YYYY-MM-DD',
  'date-time': '2026-01-31T12:00:00Z',
  email: 'name@example.com',
};

function ParamField({
  param,
  value,
  error,
  disabled,
  onChange,
}: {
  param: PanelConsoleParam;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('apiConsole');
  const label = (
    <>
      <Text component="span" ff="monospace" fz="sm">
        {param.name}
      </Text>{' '}
      <Text c="dimmed" component="span" fz="xs">
        {param.in === 'path' ? t('request.inPath') : t('request.inQuery')}
      </Text>
    </>
  );
  const description =
    param.kind === 'structured'
      ? t('request.structured')
      : [
          param.description,
          param.minimum !== null || param.maximum !== null
            ? t('request.range', { min: param.minimum ?? '–', max: param.maximum ?? '–' })
            : null,
          param.default !== null ? t('request.default', { value: String(param.default) }) : null,
        ]
          .filter((part): part is string => part !== null && part !== '')
          .join(' · ') || undefined;
  const common = {
    label,
    description,
    withAsterisk: param.required,
    disabled: disabled || param.kind === 'structured',
    ...(error === undefined ? {} : { error }),
  };
  if (param.enum !== null || param.kind === 'boolean') {
    return (
      <Select
        {...common}
        clearable={!param.required}
        data={param.enum ?? ['true', 'false']}
        onChange={(next) => {
          onChange(next ?? '');
        }}
        value={value === '' ? null : value}
      />
    );
  }
  return (
    <TextInput
      {...common}
      inputMode={param.kind === 'number' ? 'decimal' : undefined}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
      placeholder={
        param.default !== null
          ? String(param.default)
          : (PLACEHOLDER[param.format ?? ''] ?? (param.kind === 'number' ? '0' : undefined))
      }
      value={value}
    />
  );
}

/** The request of the selected operation: its path, its notes, the fields for its parameters and the Send button. */
export function RequestCard({
  operation,
  values,
  onChange,
  issues,
  canSend,
  userDataEnabled,
  connected,
  sending,
  missing,
  onSend,
  onCopyCurl,
}: {
  operation: PanelConsoleOperation;
  values: FormValues;
  onChange: (key: string, value: string) => void;
  /** What the server said is wrong, by `in:name`. */
  issues: Readonly<Record<string, string>>;
  /** The role may send (`panel:console`). */
  canSend: boolean;
  userDataEnabled: boolean;
  /** Whether a panel is connected: `undefined` while that is not known yet. */
  connected: boolean | undefined;
  sending: boolean;
  /** The names of the required parameters that have no value yet. */
  missing: readonly string[];
  onSend: () => void;
  onCopyCurl: () => void;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  const sendable = operation.availability === 'open' || operation.availability === 'user_data';

  const notes: ReactNode[] = [];
  if (operation.availability === 'write') {
    notes.push(
      <Callout
        color="gray"
        icon={<IconLock size={20} />}
        key="write"
        title={t('apiConsole:note.writeTitle')}
      >
        {t('apiConsole:note.write')}
      </Callout>,
    );
  }
  if (operation.availability === 'blocked') {
    notes.push(
      <Callout
        color="red"
        icon={<IconBan size={20} />}
        key="blocked"
        title={t('apiConsole:note.blockedTitle')}
      >
        {operation.blockedReason === 'side_effect'
          ? t('apiConsole:marker.blockedSideEffect')
          : t('apiConsole:marker.blockedSecret')}
      </Callout>,
    );
  }
  if (operation.availability === 'user_data') {
    notes.push(
      userDataEnabled ? (
        <Callout
          color="orange"
          icon={<IconUsers size={20} />}
          key="people"
          title={t('apiConsole:note.peopleTitle')}
        >
          {t('apiConsole:note.people')}
        </Callout>
      ) : (
        <Callout
          color="orange"
          icon={<IconUsers size={20} />}
          key="people"
          title={t('apiConsole:note.peopleOffTitle')}
        >
          {t('apiConsole:note.peopleOff')}
        </Callout>
      ),
    );
  }
  if (operation.adminOnly) {
    notes.push(
      <Callout
        color="violet"
        icon={<IconShieldLock size={20} />}
        key="admin"
        title={t('apiConsole:note.adminTitle')}
      >
        {t('apiConsole:note.admin')}
      </Callout>,
    );
  }
  if (sendable && !canSend) {
    notes.push(
      <Callout color="blue" icon={<IconInfoCircle size={20} />} key="role">
        {t('apiConsole:note.noRole')}
      </Callout>,
    );
  }
  if (sendable && connected === false) {
    notes.push(
      <Callout
        color="yellow"
        icon={<IconPlugConnectedX size={20} />}
        key="connect"
        title={t('apiConsole:note.notConnectedTitle')}
      >
        {t('apiConsole:note.notConnected')}{' '}
        <Link to={ROUTES.DASHBOARD.PANEL.CONNECTION}>{t('apiConsole:note.connectLink')}</Link>
      </Callout>,
    );
  }

  const blocked =
    !sendable ||
    !canSend ||
    connected !== true ||
    (operation.availability === 'user_data' && !userDataEnabled);
  const disabledFields = !sendable;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!blocked && missing.length === 0 && !sending) {
      onSend();
    }
  };

  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Stack gap="xs">
          <OverlayHeader
            icon={IconApi}
            iconColor={operation.availability === 'open' ? 'teal' : 'gray'}
            iconSize={18}
            subtitle={
              <Text component="span" ff="monospace" fz="xs">
                {operation.operationId}
              </Text>
            }
            title={operation.summary}
            titleOrder={5}
          />
          <OperationBadges operation={operation} />
          <Code block>{`${operation.method.toUpperCase()} ${operation.path}`}</Code>
          {operation.description === null ? null : (
            <Text c="dimmed" size="sm">
              {operation.description}
            </Text>
          )}
        </Stack>
      </SectionCard.Section>
      {notes.length === 0 ? null : (
        <SectionCard.Section>
          <Stack gap="xs">{notes}</Stack>
        </SectionCard.Section>
      )}
      <SectionCard.Section>
        <form onSubmit={submit}>
          <Stack gap="md">
            {operation.parameters.length === 0 ? (
              <Text c="dimmed" size="sm">
                {t('apiConsole:request.noParams')}
              </Text>
            ) : (
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                {operation.parameters.map((param) => (
                  <ParamField
                    disabled={disabledFields}
                    error={issues[paramKey(param)]}
                    key={paramKey(param)}
                    onChange={(value) => {
                      onChange(paramKey(param), value);
                    }}
                    param={param}
                    value={values[paramKey(param)] ?? ''}
                  />
                ))}
              </SimpleGrid>
            )}
            <Group gap="md" justify="flex-end" wrap="wrap">
              <Button
                leftSection={<IconCopy size={16} />}
                onClick={onCopyCurl}
                type="button"
                variant="default"
              >
                {t('apiConsole:request.copyCurl')}
              </Button>
              <Button
                color="teal"
                disabled={blocked || missing.length > 0}
                leftSection={<IconSend size={16} />}
                loading={sending}
                type="submit"
                variant="soft"
              >
                {t('apiConsole:request.send')}
              </Button>
            </Group>
            {missing.length > 0 && !blocked ? (
              <Text c="dimmed" size="xs" ta="right">
                {t('apiConsole:request.missing', { names: missing.join(', ') })}
              </Text>
            ) : null}
          </Stack>
        </form>
      </SectionCard.Section>
    </SectionCard.Root>
  );
}
