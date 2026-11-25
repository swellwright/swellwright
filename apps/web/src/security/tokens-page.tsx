import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Checkbox,
  CopyButton,
  Flex,
  Group,
  Input,
  Menu,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconBan,
  IconCheck,
  IconClearAll,
  IconCopy,
  IconDots,
  IconEye,
  IconPlus,
  IconRefresh,
  IconWorld,
} from '@tabler/icons-react';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, type SyntheticEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiEmpty } from 'react-icons/pi';
import { TbCheck, TbClipboard, TbCookie, TbCopy } from 'react-icons/tb';

import {
  type CreatedToken,
  type CreateTokenInput,
  CreateTokenRequestSchema,
  type Permission,
  permissionsOf,
  TOKEN_DEFAULT_DAYS,
  TOKEN_GRANTABLE_PERMISSIONS,
  TOKEN_MAX_ACTIVE,
  TOKEN_MAX_DAYS,
  type TokenState,
  type TokenView,
  type UserRole,
} from '@swellwright/contracts';
import {
  Callout,
  CalloutEmphasis,
  CopyableCodeBlock,
  ErrorMessageBlock,
  HeaderAction,
  HeaderActions,
  LoaderModal,
  ModalFooter,
  OverlayHeader,
  PageHeader,
  SettingsCard,
  type StatusKind,
  StatusText,
} from '@swellwright/ui';

import { createToken, listMyTokens, listTokens, revokeMyToken, revokeToken } from '../api.js';
import { describeError } from '../auth/messages.js';
import { useStepUp } from '../auth/step-up.js';
import { confirmAction, notifyError, notifySuccess } from '../shell/feedback.js';
import { useIsMobile } from '../shell/use-is-mobile.js';
import { FilterPopover } from './filter-popover.js';
import { notifyFailure } from './notify-failure.js';
import { NOT_RETAINED } from './secret-form.js';
import {
  groupByResource,
  kindOf,
  type PermissionGroup,
  type PermissionKind,
  PermissionRows,
} from './token-permissions.js';
import './tokens-page.css';
import { useTimeFirst } from './time-first.js';
import { useLastDefined } from './use-last-defined.js';

/** Matches the limit in `CreateTokenRequestSchema`; the whole request is checked against that schema as well. */
const NAME_MAX = 64;

const STATE_KIND: Record<TokenState, StatusKind> = {
  active: 'ok',
  expired: 'warn',
  revoked: 'wait',
};

/** The array behind `ipAllowlist` and one entry of it: the same checks as the server makes. */
const ADDRESS_LIST = CreateTokenRequestSchema.shape.ipAllowlist.unwrap();

/** One address or range per line, or separated by commas; empty lines and repeats are dropped. */
function parseAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/u).filter((part) => part.length > 0))];
}

/** A fact of a token in the grid of its details: a small caption over the value. */
function MetaCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sw-meta-cell">
      <Text className="sw-token-col-label">{label}</Text>
      <div className="sw-meta-value">{children}</div>
    </div>
  );
}

/** What a token is and what it may do, read-only. Opened from the menu of a row. */
function TokenDetails({ token, onClose }: { token: TokenView; onClose: () => void }) {
  const { t } = useTranslation(['tokens', 'common']);
  const formatDate = useTimeFirst();
  const groups = useMemo(() => groupByResource(token.permissions), [token.permissions]);

  return (
    <Stack gap="md">
      <div className="sw-meta-grid">
        <MetaCell label={t('columns.created')}>
          <Text c="gray.2" inherit title={token.createdAt}>
            {formatDate(token.createdAt)}
          </Text>
        </MetaCell>
        <MetaCell label={t('columns.expires')}>
          <Text c={token.state === 'expired' ? 'red.5' : 'gray.2'} inherit title={token.expiresAt}>
            {formatDate(token.expiresAt)}
          </Text>
        </MetaCell>
        <MetaCell label={t('columns.lastUsed')}>
          {token.lastUsedAt ? (
            <>
              <Text c="gray.2" inherit title={token.lastUsedAt}>
                {formatDate(token.lastUsedAt)}
              </Text>
              {token.lastUsedIp ? (
                <Text c="dimmed" ff="monospace" size="xs">
                  {token.lastUsedIp}
                </Text>
              ) : null}
            </>
          ) : (
            <Text c="dimmed" inherit>
              {t('table.neverUsed')}
            </Text>
          )}
        </MetaCell>
        <MetaCell label={t('columns.state')}>
          <Group gap="xs">
            <StatusText kind={STATE_KIND[token.state]}>{t(`states.${token.state}`)}</StatusText>
            {token.revokedAt ? (
              <Text c="dimmed" size="xs">
                {t('table.revokedOn', { when: formatDate(token.revokedAt) })}
              </Text>
            ) : null}
          </Group>
        </MetaCell>
        <MetaCell label={t('columns.user')}>
          <Text c="gray.2" inherit>
            {token.username}
          </Text>
        </MetaCell>
        <MetaCell label={t('columns.id')}>
          <div className="sw-meta-id">
            <Text className="sw-meta-id-text" truncate="end">
              {token.id}
            </Text>
            <CopyButton timeout={1600} value={token.id}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? t('common:copied') : t('common:copy')}>
                  <ActionIcon
                    aria-label={copied ? t('common:copied') : t('common:copy')}
                    color={copied ? 'teal' : 'gray'}
                    onClick={copy}
                    size="xs"
                    variant="subtle"
                  >
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </div>
        </MetaCell>
      </div>

      <Stack gap={6}>
        <Text className="sw-token-col-label">{t('columns.addresses')}</Text>
        {token.ipAllowlist.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t('table.anywhere')}
          </Text>
        ) : (
          <Group gap="xs">
            {token.ipAllowlist.map((address) => (
              <Badge ff="monospace" key={address} radius="sm" tt="none" variant="soft">
                {address}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>

      <Stack gap={6}>
        <Text className="sw-token-col-label">{t('columns.permissions')}</Text>
        <PermissionRows groups={groups} initiallyOpen picked={token.permissions} />
      </Stack>

      <ModalFooter>
        <ActionIcon.Group ml="auto">
          <CopyButton timeout={1600} value={token.permissions.join('\n')}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? t('common:copied') : t('view.copyPermissions')}>
                <ActionIcon
                  aria-label={copied ? t('common:copied') : t('view.copyPermissions')}
                  color={copied ? 'teal' : 'gray'}
                  onClick={copy}
                  size="input-md"
                  variant="soft"
                >
                  {copied ? <IconCheck size={24} /> : <IconCopy size={24} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </ActionIcon.Group>
        <Button color="teal" onClick={onClose} size="md" variant="light">
          {t('common:close')}
        </Button>
      </ModalFooter>
    </Stack>
  );
}

function TokenViewDialog({
  token,
  onClose,
}: {
  token: TokenView | undefined;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const shown = useLastDefined(token);
  return (
    <Modal
      fullScreen={isMobile}
      onClose={onClose}
      opened={token !== undefined}
      size="min(800px, 90vw)"
      title={
        <OverlayHeader
          icon={TbCookie}
          iconColor="teal"
          subtitle={
            shown ? (
              <Text component="span" ff="monospace" inherit>
                {shown.prefix}…
              </Text>
            ) : undefined
          }
          title={shown?.name ?? ''}
        />
      }
    >
      {shown ? <TokenDetails onClose={onClose} token={shown} /> : null}
    </Modal>
  );
}

/**
 * The new token, shown once. Only its hash is kept, so the person has to say they saved it before the
 * dialog can be closed, like the recovery codes.
 */
function CreatedNotice({ created, onClose }: { created: CreatedToken; onClose: () => void }) {
  const { t } = useTranslation(['tokens', 'common']);
  const formatDate = useTimeFirst();
  const [saved, setSaved] = useState(false);
  const example = `curl -H "Authorization: Bearer ${created.token}" ${window.location.origin}/api/v1/auth/me`;
  return (
    <Stack gap="md">
      <Text fz="sm">
        {t('created.intro', {
          name: created.view.name,
          when: formatDate(created.view.expiresAt),
        })}
      </Text>
      <Callout>
        {t('created.warningBefore')}{' '}
        <CalloutEmphasis>{t('created.warningEmphasis')}</CalloutEmphasis>
        {t('created.warningAfter')}
      </Callout>
      <CopyableCodeBlock
        copiedLabel={t('common:copied')}
        copyLabel={t('created.copy')}
        inputWrapperProps={{ label: t('created.valueLabel') }}
        value={created.token}
      />
      <CopyableCodeBlock
        copiedLabel={t('common:copied')}
        copyLabel={t('created.copyExample')}
        inputWrapperProps={{
          label: t('created.exampleLabel'),
          description: t('created.exampleHint'),
        }}
        size="small"
        value={example}
      />
      <Checkbox
        checked={saved}
        label={t('created.saved')}
        onChange={(e) => {
          setSaved(e.currentTarget.checked);
        }}
      />
      <ModalFooter>
        <Button color="teal" disabled={!saved} onClick={onClose} size="md" variant="light">
          {t('common:close')}
        </Button>
      </ModalFooter>
    </Stack>
  );
}

/** The form for a new token, and, once it is made, the one time its value is shown. */
function CreateDialog({
  opened,
  role,
  onClose,
}: {
  opened: boolean;
  role: UserRole;
  onClose: () => void;
}) {
  const { t } = useTranslation(['tokens', 'common']);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const step = useStepUp();
  const [name, setName] = useState('');
  const [days, setDays] = useState<number | string>(TOKEN_DEFAULT_DAYS);
  const [addresses, setAddresses] = useState('');
  const [picked, setPicked] = useState<Permission[]>([]);
  const [touched, setTouched] = useState(false);

  // What a token may carry: what the role has, minus what needs a fresh code (a token has none to give).
  const available = useMemo(
    () =>
      TOKEN_GRANTABLE_PERMISSIONS.filter((permission) => permissionsOf(role).includes(permission)),
    [role],
  );
  const groups = useMemo(() => groupByResource(available), [available]);

  const list = parseAddresses(addresses);
  const invalid = list.filter((entry) => !ADDRESS_LIST.element.safeParse(entry).success);
  const addressError =
    invalid.length > 0
      ? t('create.addressesInvalid', { list: invalid.join(', ') })
      : ADDRESS_LIST.safeParse(list).success
        ? undefined
        : t('create.addressesTooMany');
  const daysNumber = typeof days === 'number' ? days : Number.NaN;
  const check = CreateTokenRequestSchema.safeParse({
    name,
    permissions: picked,
    expiresInDays: daysNumber,
    ipAllowlist: list,
  });
  const nameOk = CreateTokenRequestSchema.shape.name.safeParse(name).success;
  const daysOk = CreateTokenRequestSchema.shape.expiresInDays.safeParse(daysNumber).success;

  // The value of the token stays out of the cache once the dialog is closed (`gcTime: 0`).
  const mutation = useMutation({
    ...NOT_RETAINED,
    mutationFn: (request: CreateTokenInput) => step.run(() => createToken(request)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (error) => {
      notifyFailure(t, t('create.title'), error, t('signInAgain'), t('create.forbidden'));
    },
  });
  const created = mutation.data;

  // The form and the value are cleared once the dialog has faded out, so they do not change while it closes. A
  // request still on its way when the dialog is closed is dropped at once.
  const close = () => {
    if (mutation.isPending) {
      mutation.reset();
    }
    onClose();
  };
  const reset = () => {
    mutation.reset();
    setName('');
    setDays(TOKEN_DEFAULT_DAYS);
    setAddresses('');
    setPicked([]);
    setTouched(false);
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (check.success) {
      mutation.mutate(check.data);
    }
  };

  /** Keeps the permissions in the order of the list, whatever order they were ticked in. */
  const choose = (next: readonly Permission[]) => {
    setPicked(available.filter((permission) => next.includes(permission)));
  };
  const toggle = (permission: Permission) => {
    choose(
      picked.includes(permission)
        ? picked.filter((p) => p !== permission)
        : [...picked, permission],
    );
  };
  /** Takes the permissions from a JSON list on the clipboard, as the panel's paste button does for its scopes. */
  const paste = async () => {
    try {
      const parsed: unknown = JSON.parse(await navigator.clipboard.readText());
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('not a list of strings');
      }
      const wanted: readonly unknown[] = parsed;
      const next = available.filter((permission) => wanted.includes(permission));
      choose(next);
      notifySuccess(t('create.pasted'), t('create.pastedCount', { count: next.length }));
    } catch {
      notifyError(t('create.pasteInvalid'), t('create.pasteInvalidHint'));
    }
  };
  const toggleKind = (group: PermissionGroup, kind: PermissionKind) => {
    const keys = group.permissions.filter((permission) => kindOf(permission) === kind);
    const allOn = keys.every((permission) => picked.includes(permission));
    choose(allOn ? picked.filter((p) => !keys.includes(p)) : [...picked, ...keys]);
  };

  return (
    <Modal
      closeOnClickOutside={created === undefined}
      closeOnEscape={created === undefined}
      fullScreen={isMobile}
      onClose={close}
      onExitTransitionEnd={reset}
      opened={opened}
      size="min(800px, 90vw)"
      title={
        <OverlayHeader
          icon={TbCookie}
          iconColor="teal"
          title={created ? t('created.title') : t('create.title')}
        />
      }
      withCloseButton={created === undefined}
    >
      {created ? (
        <CreatedNotice created={created} onClose={close} />
      ) : (
        <form onSubmit={submit}>
          <Stack gap="md">
            <Callout>
              {t('create.onceBefore')} <CalloutEmphasis>{t('create.onceEmphasis')}</CalloutEmphasis>
              {t('create.onceAfter')}
            </Callout>

            <Flex
              align={isMobile ? 'stretch' : 'flex-start'}
              direction={isMobile ? 'column' : 'row'}
              gap="xs"
            >
              <TextInput
                autoComplete="off"
                data-autofocus
                description={t('create.nameDescription')}
                error={touched && !nameOk ? t('create.nameError', { max: NAME_MAX }) : undefined}
                flex={isMobile ? undefined : 1}
                label={t('create.nameLabel')}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                }}
                placeholder={t('create.namePlaceholder')}
                required
                value={name}
              />
              <NumberInput
                allowDecimal={false}
                allowNegative={false}
                description={t('create.expiresDescription', { max: TOKEN_MAX_DAYS })}
                error={
                  touched && !daysOk ? t('create.expiresError', { max: TOKEN_MAX_DAYS }) : undefined
                }
                label={t('create.expiresLabel')}
                max={TOKEN_MAX_DAYS}
                min={1}
                onChange={setDays}
                required
                value={days}
                w={isMobile ? '100%' : 300}
              />
            </Flex>

            <Textarea
              autoComplete="off"
              autosize
              description={t('create.addressesDescription')}
              error={touched ? addressError : undefined}
              label={t('create.addressesLabel')}
              maxRows={6}
              minRows={2}
              onChange={(e) => {
                setAddresses(e.currentTarget.value);
              }}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              value={addresses}
            />

            {available.length === 0 ? (
              <Text c="dimmed" fz="sm">
                {t('create.permissionsEmpty')}
              </Text>
            ) : (
              <Input.Wrapper
                description={t('create.permissionsDescription')}
                error={touched && picked.length === 0 ? t('create.permissionsError') : undefined}
                label={t('create.permissionsLabel')}
              >
                <Stack gap="xs" mt="xs">
                  <Group gap="xs">
                    <Button
                      leftSection={<IconEye size={16} />}
                      onClick={() => {
                        choose(available.filter((permission) => kindOf(permission) === 'read'));
                      }}
                      size="xs"
                      variant="default"
                    >
                      {t('create.presetRead')}
                    </Button>
                    <Button
                      leftSection={<IconWorld size={16} />}
                      onClick={() => {
                        choose(available);
                      }}
                      size="xs"
                      variant="default"
                    >
                      {t('create.presetAll')}
                    </Button>
                  </Group>
                  <PermissionRows
                    groups={groups}
                    onToggle={toggle}
                    onToggleKind={toggleKind}
                    picked={picked}
                  />
                </Stack>
              </Input.Wrapper>
            )}

            <ModalFooter>
              <ActionIcon.Group ml="auto">
                <Tooltip label={t('create.clear')}>
                  <ActionIcon
                    aria-label={t('create.clear')}
                    color="gray"
                    onClick={() => {
                      setPicked([]);
                    }}
                    size="input-md"
                    variant="soft"
                  >
                    <IconClearAll size={24} />
                  </ActionIcon>
                </Tooltip>
                <CopyButton timeout={1600} value={JSON.stringify(picked, null, 2)}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? t('common:copied') : t('create.copyPermissions')}>
                      <ActionIcon
                        aria-label={copied ? t('common:copied') : t('create.copyPermissions')}
                        color={copied ? 'teal' : 'gray'}
                        onClick={copy}
                        size="input-md"
                        variant="soft"
                      >
                        {copied ? <TbCheck size={24} /> : <TbCopy size={24} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
                <Tooltip label={t('create.pastePermissions')}>
                  <ActionIcon
                    aria-label={t('create.pastePermissions')}
                    color="gray"
                    onClick={() => void paste()}
                    size="input-md"
                    variant="soft"
                  >
                    <TbClipboard size={24} />
                  </ActionIcon>
                </Tooltip>
              </ActionIcon.Group>
              <Button
                color="teal"
                leftSection={<TbCookie size="24px" />}
                loading={mutation.isPending}
                size="md"
                type="submit"
                variant="soft"
              >
                {t('common:create')}
              </Button>
            </ModalFooter>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

/** The row of a token in the list: its state, name, how much it may do, when it ends, and a menu. */
function TokenRow({
  token,
  kind,
  revoking,
  onView,
  onRevoke,
}: {
  token: TokenView;
  kind: 'mine' | 'all';
  revoking: boolean;
  onView: (token: TokenView) => void;
  /** Left out when the viewer may not revoke any of these. */
  onRevoke: ((token: TokenView) => void) | undefined;
}) {
  const { t } = useTranslation('tokens');
  const formatDate = useTimeFirst();
  const active = token.state === 'active';

  return (
    <div className="sw-token-row" role="row">
      <Group gap="sm" role="cell" style={{ minWidth: 0 }} wrap="nowrap">
        <span
          aria-hidden
          className="sw-token-dot"
          style={{
            background: active ? 'var(--mantine-color-teal-5)' : 'var(--mantine-color-dark-3)',
          }}
        />
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fw={500} size="sm" truncate="end">
            {token.name}
          </Text>
          <Text c="dimmed" ff="monospace" size="xs" truncate="end">
            {kind === 'all' ? `${token.username} · ` : ''}
            {token.prefix}…
          </Text>
        </Stack>
      </Group>

      <Text c="dimmed" ff="monospace" role="cell" size="xs" truncate="end">
        {t('table.permissionCount', { count: token.permissions.length })}
      </Text>

      <Text
        c={token.state === 'expired' ? 'red.5' : 'dimmed'}
        className="sw-token-expires"
        fw={token.state === 'expired' ? 600 : 400}
        role="cell"
        size="xs"
        truncate="end"
      >
        {active ? formatDate(token.expiresAt) : t(`states.${token.state}`)}
      </Text>

      <div role="cell">
        <Menu position="bottom-end" trigger="click-hover" width={190}>
          <Menu.Target>
            <ActionIcon
              aria-label={t('table.actionsFor', { name: token.name })}
              color="gray"
              size="md"
              variant="subtle"
            >
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconEye size={15} />}
              onClick={() => {
                onView(token);
              }}
            >
              {t('table.view')}
            </Menu.Item>
            {onRevoke && active ? (
              <>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  disabled={revoking}
                  leftSection={<IconBan size={15} />}
                  onClick={() => {
                    onRevoke(token);
                  }}
                >
                  {t('table.revoke')}
                </Menu.Item>
              </>
            ) : null}
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );
}

/** The panel's list of tokens: a header row of captions and the rows in a box that scrolls. */
function TokenTable({
  tokens,
  kind,
  revokingId,
  onView,
  onRevoke,
}: {
  tokens: readonly TokenView[];
  kind: 'mine' | 'all';
  revokingId: string | undefined;
  onView: (token: TokenView) => void;
  onRevoke: ((token: TokenView) => void) | undefined;
}) {
  const { t } = useTranslation('tokens');
  return (
    <div
      aria-label={kind === 'mine' ? t('mine.title') : t('all.title')}
      className="sw-token-table"
      role="table"
    >
      <div className="sw-token-header-row" role="row">
        <Text className="sw-token-col-label" role="columnheader">
          {t('columns.name')}
        </Text>
        <Text className="sw-token-col-label" role="columnheader">
          {t('columns.permissions')}
        </Text>
        <Text className="sw-token-col-label sw-token-expires" role="columnheader">
          {t('columns.expires')}
        </Text>
        <span />
      </div>
      <ScrollArea.Autosize mah={300} mih={300}>
        <Stack gap={0}>
          {tokens.map((token) => (
            <TokenRow
              key={token.id}
              kind={kind}
              onRevoke={onRevoke}
              onView={onView}
              revoking={revokingId === token.id}
              token={token}
            />
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </div>
  );
}

/** The empty list of a card: the panel's large empty glyph and a line or two of text. */
function EmptyTokens({ children }: { children: ReactNode }) {
  return (
    <Center h="300px">
      <Stack align="center" gap="xs">
        <PiEmpty aria-hidden size={48} />
        {children}
      </Stack>
    </Center>
  );
}

/** Your own tokens: any signed-in user may list and revoke them, and with `tokens:create` make more. */
function MyTokens({ role, canCreate }: { role: UserRole; canCreate: boolean }) {
  const { t } = useTranslation(['tokens', 'common']);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<TokenView | undefined>(undefined);
  const list = useQuery({ queryKey: ['tokens', 'mine'], queryFn: listMyTokens, retry: false });
  const revoke = useMutation({
    mutationFn: (token: TokenView) => revokeMyToken(token.id),
    onSuccess: (_result, token) => {
      notifySuccess(t('toast.success'), t('revoke.done', { name: token.name }));
      return queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (error) => {
      notifyFailure(t, t('revoke.submit'), error, t('signInAgain'), t('mine.revokeForbidden'));
    },
  });
  const askRevoke = (token: TokenView) => {
    confirmAction({
      title: t('revoke.title', { name: token.name }),
      message: t('revoke.warning'),
      confirmLabel: t('revoke.submit'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        revoke.mutate(token);
      },
    });
  };

  const tokens = list.data?.tokens ?? [];

  return (
    <SettingsCard.Container>
      <SettingsCard.Header
        description={t('mine.description', { max: TOKEN_MAX_ACTIVE })}
        icon={<TbCookie size={24} />}
        title={t('mine.title')}
      />

      <SettingsCard.Content>
        {list.isPending ? (
          <LoaderModal label={t('common:loading')} mih="300px" />
        ) : list.isError ? (
          <ErrorMessageBlock
            copiedLabel={t('common:copied')}
            copyLabel={t('common:copy')}
            message={describeError(t, list.error, t('signInAgain'))}
          />
        ) : tokens.length === 0 ? (
          <EmptyTokens>
            <Text c="dimmed" size="sm" ta="center">
              {t('mine.empty')}
            </Text>
            {canCreate ? (
              <Text c="dimmed" size="sm" ta="center">
                {t('mine.emptyHint')}
              </Text>
            ) : null}
          </EmptyTokens>
        ) : (
          <>
            <TokenTable
              kind="mine"
              onRevoke={askRevoke}
              onView={setViewing}
              revokingId={revoke.isPending ? revoke.variables.id : undefined}
              tokens={tokens}
            />
            <Text c="dimmed" fz="xs">
              {t('mine.valueNote')}
            </Text>
          </>
        )}
      </SettingsCard.Content>

      <SettingsCard.Bottom>
        <Group justify="space-between">
          <HeaderAction
            icon={IconRefresh}
            label={t('common:refresh')}
            loading={list.isRefetching}
            onClick={() => void list.refetch()}
          />
          {canCreate ? (
            <HeaderAction
              color="teal"
              icon={IconPlus}
              label={t('mine.create')}
              onClick={() => {
                setCreating(true);
              }}
            />
          ) : null}
        </Group>
      </SettingsCard.Bottom>

      <CreateDialog
        onClose={() => {
          setCreating(false);
        }}
        opened={creating}
        role={role}
      />
      <TokenViewDialog
        onClose={() => {
          setViewing(undefined);
        }}
        token={viewing}
      />
    </SettingsCard.Container>
  );
}

/** The tokens of every user (`tokens:read`). Revoking them needs `tokens:revoke` and a fresh code. */
function AllTokens({ canRevoke }: { canRevoke: boolean }) {
  const { t } = useTranslation(['tokens', 'common']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const [userId, setUserId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<TokenView | undefined>(undefined);
  const list = useQuery({
    queryKey: ['tokens', 'all'],
    queryFn: () => listTokens({}),
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: (token: TokenView) => step.run(() => revokeToken(token.id)),
    onSuccess: (_result, token) => {
      notifySuccess(t('toast.success'), t('revoke.done', { name: token.name }));
      return queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (error) => {
      notifyFailure(t, t('revoke.submit'), error, t('signInAgain'), t('all.revokeForbidden'));
    },
  });
  const askRevoke = (token: TokenView) => {
    confirmAction({
      title: t('revoke.title', { name: token.name }),
      message: t('revoke.warningOther', { username: token.username }),
      confirmLabel: t('revoke.submit'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        revoke.mutate(token);
      },
    });
  };

  const all = list.data?.tokens;
  // The users for the filter come from the tokens themselves: someone without a token has nothing to show.
  const users = useMemo(() => {
    const names = new Map<string, string>();
    for (const token of all ?? []) {
      names.set(token.userId, token.username);
    }
    return [...names]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [all]);
  const selected = users.find((user) => user.value === userId);
  const shown = selected
    ? (all ?? []).filter((token) => token.userId === selected.value)
    : (all ?? []);

  return (
    <SettingsCard.Container>
      <SettingsCard.Header
        description={t('all.description')}
        icon={<TbCookie size={24} />}
        title={t('all.title')}
      />

      <SettingsCard.Content>
        {list.isPending ? (
          <LoaderModal label={t('common:loading')} mih="300px" />
        ) : list.isError ? (
          <ErrorMessageBlock
            copiedLabel={t('common:copied')}
            copyLabel={t('common:copy')}
            message={describeError(t, list.error, t('signInAgain'), t('all.loadFailed'))}
          />
        ) : shown.length === 0 ? (
          <EmptyTokens>
            <Text c="dimmed" size="sm" ta="center">
              {selected ? t('all.emptyFiltered') : t('all.empty')}
            </Text>
          </EmptyTokens>
        ) : (
          <TokenTable
            kind="all"
            onRevoke={canRevoke ? askRevoke : undefined}
            onView={setViewing}
            revokingId={revoke.isPending ? revoke.variables.id : undefined}
            tokens={shown}
          />
        )}
      </SettingsCard.Content>

      <SettingsCard.Bottom>
        <Group justify="space-between">
          <HeaderAction
            icon={IconRefresh}
            label={t('common:refresh')}
            loading={list.isRefetching}
            onClick={() => void list.refetch()}
          />
          <FilterPopover active={selected !== undefined} label={t('all.userFilterLabel')}>
            <Select
              aria-label={t('all.userFilterLabel')}
              clearable
              comboboxProps={{ withinPortal: false }}
              data={users}
              onChange={setUserId}
              placeholder={t('all.userFilterPlaceholder')}
              searchable
              value={selected?.value ?? null}
            />
          </FilterPopover>
        </Group>
      </SettingsCard.Bottom>

      <TokenViewDialog
        onClose={() => {
          setViewing(undefined);
        }}
        token={viewing}
      />
    </SettingsCard.Container>
  );
}

/**
 * The API tokens. Everyone sees and can revoke their own, and with `tokens:create` makes more; seeing everyone's
 * needs `tokens:read`, and revoking theirs needs `tokens:revoke` and a fresh confirmation with a code.
 */
export function TokensPage({
  role,
  permissions,
}: {
  role: UserRole;
  permissions: readonly Permission[];
}) {
  const { t } = useTranslation(['tokens', 'common']);
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ queryKey: ['tokens'] }) > 0;

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={fetching}
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['tokens'] })}
            />
          </HeaderActions>
        }
        description={t('header.description')}
        icon={<TbCookie size={24} />}
        title={t('header.title')}
      />

      <Stack gap="md">
        <MyTokens canCreate={permissions.includes('tokens:create')} role={role} />
        {permissions.includes('tokens:read') ? (
          <AllTokens canRevoke={permissions.includes('tokens:revoke')} />
        ) : null}
      </Stack>
    </>
  );
}
