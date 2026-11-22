// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/_modals/hosts/{edit-host-modal,
// create-host-drawer}/*, src/shared/ui/forms/hosts/base-host-form/{base-host-form.tsx,host-visibility.tsx}, the drawer
// that opens a host: a 700 px `Drawer` on the right (full screen on a phone) titled with a soft icon, the name and the id,
// cards of the panel's `SectionCard`, a sticky footer with the teal Save button on the left and the red delete on the
// right. Changes: the first card's switch is a state select (a server has five states, not two); the fields are those of a
// server; host keys, access entries and facts are cards below the form, because they are saved one by one; a server that
// was just created stays open so that its keys and access can be added; nothing in the footer clones.
import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  NumberInput,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HiServer } from 'react-icons/hi';
import { PiFloppyDiskDuotone, PiListChecksDuotone } from 'react-icons/pi';
import { TbMapPin, TbTrash } from 'react-icons/tb';

import {
  type CreateServerRequest,
  CountryCodeSchema,
  type Permission,
  SERVER_STATES,
  ServerAddressSchema,
  ServerNameSchema,
  ServerTagSchema,
  type ServerState,
  type ServerView,
  SshPortSchema,
  type UpdateServerRequest,
} from '@swellwright/contracts';
import {
  CountryFlag,
  DrawerFooter,
  LoaderModal,
  OverlayHeader,
  SectionCard,
  TagInputPill,
} from '@swellwright/ui';

import { ApiRequestError, createServer, deleteServer, getServer, updateServer } from '../api.js';
import { notifyFailure } from '../security/notify-failure.js';
import { QueryErrorCard } from '../security/query-error.js';
import { useLastDefined } from '../security/use-last-defined.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';
import { BaselineCard } from '../baseline/baseline-card.js';
import { AccessCard } from './access-card.js';
import { ArtifactsCard } from './artifacts-card.js';
import { useCountries } from './countries.js';
import { FactsCard } from './facts-card.js';
import { HostKeysCard } from './host-keys-card.js';
import { STATE_COLOR, STATE_ICON } from './server-state.js';

/** What the drawer shows: a blank form for a new server, or a server by id. */
export type DrawerTarget = { kind: 'new' } | { kind: 'edit'; id: string } | undefined;

const FORM_ID = 'server-form';

interface FormValues {
  name: string;
  address: string;
  port: number | string;
  state: ServerState;
  country: string | null;
  provider: string;
  tags: string[];
  notes: string;
}

const BLANK: FormValues = {
  name: '',
  address: '',
  port: 22,
  state: 'draft',
  country: null,
  provider: '',
  tags: [],
  notes: '',
};

const valuesOf = (server: ServerView): FormValues => ({
  name: server.name,
  address: server.address,
  port: server.sshPort,
  state: server.state,
  country: server.country,
  provider: server.provider ?? '',
  tags: server.tags,
  notes: server.notes ?? '',
});

const asState = (value: string | null): ServerState | null =>
  SERVER_STATES.find((known) => known === value) ?? null;

interface Problems {
  name: boolean;
  address: boolean;
  port: boolean;
  tags: boolean;
  provider: boolean;
  notes: boolean;
}

function check(values: FormValues): Problems {
  return {
    name: !ServerNameSchema.safeParse(values.name).success,
    address: !ServerAddressSchema.safeParse(values.address).success,
    port: !SshPortSchema.safeParse(values.port).success,
    tags:
      values.tags.length > 20 || values.tags.some((tag) => !ServerTagSchema.safeParse(tag).success),
    provider: values.provider.trim().length > 64,
    notes: values.notes.trim().length > 2000,
  };
}

const withoutProblems = (problems: Problems): boolean => !Object.values(problems).some(Boolean);

/** The overview of a server: the state, the address and the details. A server of its own is saved by the footer. */
function OverviewCards({
  values,
  problems,
  showErrors,
  readOnly,
  tagSuggestions,
  onChange,
}: {
  values: FormValues;
  problems: Problems;
  showErrors: boolean;
  readOnly: boolean;
  tagSuggestions: string[];
  onChange: (patch: Partial<FormValues>) => void;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const { options, nameOf } = useCountries();
  const Icon = STATE_ICON[values.state];

  return (
    <>
      <SectionCard.Root>
        <SectionCard.Section>
          <Group gap="sm" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon aria-hidden color={STATE_COLOR[values.state]} size="lg" variant="soft">
                <Icon size={22} />
              </ThemeIcon>
              <Stack gap={0}>
                <Text fw={600} size="sm">
                  {t('form.state')}
                </Text>
                <Text c={`${STATE_COLOR[values.state]}.4`} fw={600} size="xs">
                  {t(`states.${values.state}`)}
                </Text>
              </Stack>
            </Group>
            <Select
              allowDeselect={false}
              aria-label={t('form.state')}
              data={SERVER_STATES.map((value) => ({ value, label: t(`states.${value}`) }))}
              disabled={readOnly}
              onChange={(value) => {
                const state = asState(value);
                if (state) {
                  onChange({ state });
                }
              }}
              value={values.state}
              w={180}
            />
          </Group>
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput
              autoComplete="off"
              data-autofocus
              description={t('form.nameHint')}
              disabled={readOnly}
              error={showErrors && problems.name ? t('form.nameError') : undefined}
              label={t('form.name')}
              onChange={(event) => {
                onChange({ name: event.currentTarget.value });
              }}
              required
              styles={{ label: { fontWeight: 600 } }}
              value={values.name}
            />
            <Group gap="xs" grow justify="space-between" preventGrowOverflow={false} w="100%">
              <TextInput
                autoComplete="off"
                description={t('form.addressHint')}
                disabled={readOnly}
                error={showErrors && problems.address ? t('form.addressError') : undefined}
                label={t('form.address')}
                onChange={(event) => {
                  onChange({ address: event.currentTarget.value });
                }}
                placeholder="example.com"
                required
                spellCheck={false}
                styles={{ label: { fontWeight: 600 } }}
                value={values.address}
                w="65%"
              />
              <NumberInput
                allowDecimal={false}
                allowNegative={false}
                clampBehavior="strict"
                decimalScale={0}
                description={t('form.portHint')}
                disabled={readOnly}
                error={showErrors && problems.port ? t('form.portError') : undefined}
                hideControls
                label={t('form.port')}
                max={65535}
                min={1}
                onChange={(port) => {
                  onChange({ port });
                }}
                placeholder="22"
                required
                styles={{ label: { fontWeight: 600 } }}
                value={values.port}
                w="30%"
              />
            </Group>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiListChecksDuotone}
            iconColor="cyan"
            title={t('form.details')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <Select
              clearable
              data={options}
              disabled={readOnly}
              label={t('form.country')}
              leftSection={
                values.country ? (
                  <CountryFlag code={values.country} label={nameOf(values.country)} />
                ) : (
                  <TbMapPin size={16} />
                )
              }
              nothingFoundMessage={t('form.countryNothing')}
              onChange={(value) => {
                onChange({ country: value });
              }}
              placeholder={t('form.countryPlaceholder')}
              renderOption={({ option }) => (
                <Group gap="xs" wrap="nowrap">
                  <CountryFlag code={option.value} label={option.label} />
                  <Text size="sm">{option.label}</Text>
                </Group>
              )}
              searchable
              styles={{ label: { fontWeight: 600 } }}
              value={values.country}
            />
            <TextInput
              autoComplete="off"
              disabled={readOnly}
              error={showErrors && problems.provider ? t('form.providerError') : undefined}
              label={t('form.provider')}
              onChange={(event) => {
                onChange({ provider: event.currentTarget.value });
              }}
              placeholder={t('form.optional')}
              styles={{ label: { fontWeight: 600 } }}
              value={values.provider}
            />
            <TagsInput
              clearable
              data={tagSuggestions}
              description={t('form.tagsHint')}
              disabled={readOnly}
              error={showErrors && problems.tags ? t('form.tagsError') : undefined}
              label={t('form.tags')}
              maxTags={20}
              onChange={(tags) => {
                onChange({ tags: [...new Set(tags)] });
              }}
              placeholder={t('form.tagsPlaceholder')}
              renderPill={({ value, onRemove }) => (
                <TagInputPill
                  removeLabel={t('common:remove')}
                  value={value}
                  {...(onRemove === undefined || readOnly ? {} : { onRemove })}
                />
              )}
              splitChars={[',', ' ', ';']}
              styles={{ label: { fontWeight: 600 } }}
              value={values.tags}
            />
            <Textarea
              autosize
              disabled={readOnly}
              error={showErrors && problems.notes ? t('form.notesError') : undefined}
              label={t('form.notes')}
              minRows={3}
              onChange={(event) => {
                onChange({ notes: event.currentTarget.value });
              }}
              placeholder={t('form.optional')}
              styles={{ label: { fontWeight: 600 } }}
              value={values.notes}
            />
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>
    </>
  );
}

/** The request that makes the server what the form says. Empty optional fields are left out (new) or cleared (change). */
function createRequest(values: FormValues): CreateServerRequest {
  const provider = values.provider.trim();
  const notes = values.notes.trim();
  return {
    name: values.name.trim(),
    address: values.address.trim(),
    sshPort: Number(values.port),
    state: values.state,
    ...(values.country === null ? {} : { country: CountryCodeSchema.parse(values.country) }),
    ...(provider === '' ? {} : { provider }),
    ...(values.tags.length === 0 ? {} : { tags: values.tags }),
    ...(notes === '' ? {} : { notes }),
  };
}

function updateRequest(values: FormValues): UpdateServerRequest {
  const provider = values.provider.trim();
  const notes = values.notes.trim();
  return {
    name: values.name.trim(),
    address: values.address.trim(),
    sshPort: Number(values.port),
    state: values.state,
    country: values.country,
    provider: provider === '' ? null : provider,
    tags: values.tags,
    notes: notes === '' ? null : notes,
  };
}

/** The body of the drawer once there is something to show: the form, the cards under it and the footer. */
function ServerBody({
  server,
  permissions,
  tagSuggestions,
  onSaved,
  onCreated,
  onDeleted,
}: {
  /** Absent for a new server. */
  server: ServerView | undefined;
  permissions: readonly Permission[];
  tagSuggestions: string[];
  onSaved: () => void;
  onCreated: (server: ServerView) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const queryClient = useQueryClient();
  const canWrite = permissions.includes('servers:write');
  const canExec = permissions.includes('servers:exec');
  const canReadVault = permissions.includes('vault:read');
  const initial = useMemo(() => (server ? valuesOf(server) : BLANK), [server]);
  const [values, setValues] = useState<FormValues>(initial);
  const [showErrors, setShowErrors] = useState(false);

  const problems = check(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['servers'] });
    if (server) {
      void queryClient.invalidateQueries({ queryKey: ['server', server.id] });
    }
  };

  const save = useMutation({
    mutationFn: () =>
      server ? updateServer(server.id, updateRequest(values)) : createServer(createRequest(values)),
    onSuccess: (saved) => {
      refreshAll();
      if (server) {
        notifySuccess(t('toast.success'), t('toast.saved', { name: saved.name }));
        onSaved();
      } else {
        notifySuccess(t('toast.success'), t('toast.created', { name: saved.name }));
        onCreated(saved);
      }
    },
    onError: (error) => {
      notifyFailure(
        t,
        server ? t('form.editTitle', { name: server.name }) : t('form.createTitle'),
        error,
        t('signInAgain'),
        t('form.forbidden'),
      );
    },
  });

  const remove = useMutation({
    mutationFn: () => {
      if (!server) {
        throw new Error('Nothing to delete.');
      }
      return deleteServer(server.id);
    },
    onSuccess: () => {
      notifySuccess(t('toast.success'), t('toast.deleted', { name: server?.name ?? '' }));
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      // The server is gone: asking for it again would only answer 404.
      queryClient.removeQueries({ queryKey: ['server', server?.id ?? ''] });
      onDeleted();
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('delete.title', { name: server?.name ?? '' }),
        error,
        t('signInAgain'),
        t('delete.forbidden'),
      );
    },
  });

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (canWrite && withoutProblems(problems)) {
      save.mutate();
    }
  };

  const askDelete = () => {
    if (!server) {
      return;
    }
    confirmAction({
      title: t('delete.title', { name: server.name }),
      message: (
        <Stack gap="xs">
          <Text fw={600} size="sm">
            {t('delete.irreversible')}
          </Text>
          <Text size="sm">{t('delete.warning', { name: server.name })}</Text>
          <Text c="dimmed" size="sm">
            {t('delete.rule')}
          </Text>
        </Stack>
      ),
      confirmLabel: t('delete.submit'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        remove.mutate();
      },
    });
  };

  return (
    <>
      <Stack gap="md">
        <form id={FORM_ID} onSubmit={submit}>
          <Stack gap="md">
            <OverviewCards
              onChange={(patch) => {
                setValues((previous) => ({ ...previous, ...patch }));
              }}
              problems={problems}
              readOnly={!canWrite}
              showErrors={showErrors}
              tagSuggestions={tagSuggestions}
              values={values}
            />
          </Stack>
        </form>
        {server ? (
          <>
            <HostKeysCard canWrite={canWrite} onChanged={refreshAll} server={server} />
            <AccessCard
              canReadVault={canReadVault}
              canWrite={canWrite}
              onChanged={refreshAll}
              server={server}
            />
            <FactsCard canWrite={canWrite} onChanged={refreshAll} server={server} />
            <BaselineCard canExec={canExec} serverId={server.id} serverName={server.name} />
            <ArtifactsCard
              canExec={canExec}
              canWrite={canWrite}
              onChanged={refreshAll}
              server={server}
            />
          </>
        ) : null}
      </Stack>
      {canWrite ? (
        <DrawerFooter>
          <Group gap="xs" justify="space-between" w="100%">
            <Group gap="xs">
              <Button
                color="teal"
                disabled={server !== undefined && !dirty}
                form={FORM_ID}
                leftSection={<PiFloppyDiskDuotone size="16px" />}
                loading={save.isPending}
                size="md"
                type="submit"
                variant="soft"
              >
                {server ? t('common:save') : t('form.create')}
              </Button>
            </Group>
            {server ? (
              <Group gap="xs">
                <Tooltip label={t('delete.submit')}>
                  <ActionIcon
                    aria-label={t('delete.submit')}
                    color="red"
                    loading={remove.isPending}
                    onClick={askDelete}
                    size="xl"
                    variant="soft"
                  >
                    <TbTrash size="24px" />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ) : null}
          </Group>
        </DrawerFooter>
      ) : null}
    </>
  );
}

function EditContent({
  id,
  permissions,
  tagSuggestions,
  onClose,
}: {
  id: string;
  permissions: readonly Permission[];
  tagSuggestions: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const query = useQuery({
    queryKey: ['server', id],
    queryFn: () => getServer(id),
    retry: false,
  });

  if (query.isPending) {
    return <LoaderModal label={t('common:loading')} mih="78vh" />;
  }
  if (query.isError) {
    const gone = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <QueryErrorCard
        message={gone ? t('drawer.goneText') : t('drawer.failedText')}
        onRetry={gone ? onClose : () => void query.refetch()}
        title={gone ? t('drawer.goneTitle') : t('drawer.failedTitle')}
      />
    );
  }
  return (
    <ServerBody
      // A new version of the server (after a pin or a change) must not reset what is typed: the form keeps its own
      // values, and only a different server starts a new form.
      key={query.data.id}
      onCreated={() => undefined}
      onDeleted={onClose}
      onSaved={onClose}
      permissions={permissions}
      server={query.data}
      tagSuggestions={tagSuggestions}
    />
  );
}

/** The panel's edit-host drawer for a server, and its create-host drawer for a new one. */
export function ServerDrawer({
  target,
  permissions,
  tagSuggestions,
  onChange,
}: {
  target: DrawerTarget;
  permissions: readonly Permission[];
  tagSuggestions: string[];
  onChange: (target: DrawerTarget) => void;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const shown = useLastDefined(target);
  const title = useQuery({
    queryKey: ['server', shown?.kind === 'edit' ? shown.id : 'none'],
    queryFn: () => getServer(shown?.kind === 'edit' ? shown.id : ''),
    enabled: shown?.kind === 'edit',
    retry: false,
  });
  const close = () => {
    onChange(undefined);
  };

  return (
    <Drawer
      // The first thing to take the focus is the close button, as in the panel (whose title cannot be focused); the
      // title copies on a click here and would otherwise get the focus ring while the server is still loading.
      closeButtonProps={{
        'aria-label': t('common:close'),
        ...(shown?.kind === 'edit' ? { 'data-autofocus': true } : {}),
      }}
      onClose={close}
      opened={target !== undefined}
      padding="lg"
      position="right"
      size="700px"
      title={
        shown?.kind === 'edit' ? (
          <OverlayHeader
            icon={HiServer}
            iconColor="teal"
            subtitle={shown.id}
            title={title.data?.name ?? t('drawer.title')}
            truncateTitle
            withCopy
          />
        ) : (
          <OverlayHeader icon={HiServer} iconColor="teal" title={t('form.createTitle')} />
        )
      }
    >
      {shown?.kind === 'edit' ? (
        <EditContent
          id={shown.id}
          key={shown.id}
          onClose={close}
          permissions={permissions}
          tagSuggestions={tagSuggestions}
        />
      ) : shown?.kind === 'new' ? (
        <ServerBody
          key="new"
          onCreated={(created) => {
            onChange({ kind: 'edit', id: created.id });
          }}
          onDeleted={close}
          onSaved={close}
          permissions={permissions}
          server={undefined}
          tagSuggestions={tagSuggestions}
        />
      ) : null}
    </Drawer>
  );
}
