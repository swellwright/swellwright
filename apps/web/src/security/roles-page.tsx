import { Badge, DataList, Group, Stack, Table, Text, ThemeIcon } from '@mantine/core';
import { IconUserShield, IconUsersGroup } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PiCheckCircleDuotone, PiXCircleDuotone } from 'react-icons/pi';

import type { Permission, UserRole } from '@swellwright/contracts';
import type { resources } from '@swellwright/i18n';
import { LoadingScreen, OverlayHeader, PageHeader, SectionCard } from '@swellwright/ui';

import { getRoles } from '../api.js';
import { describeError } from '../auth/messages.js';
import { QueryErrorCard } from './query-error.js';

type PermissionKey = keyof (typeof resources)['en']['roles']['permissionDescriptions'];

/**
 * The key of the text of each permission. A colon cannot be part of a key, so `servers:read` is `serversRead`.
 * Typed against both sides: a permission added to the contracts without a text here fails the build.
 */
const PERMISSION_KEY = {
  'servers:read': 'serversRead',
  'servers:write': 'serversWrite',
  'servers:exec': 'serversExec',
  'panel:read': 'panelRead',
  'panel:write': 'panelWrite',
  'panel:console': 'panelConsole',
  'runs:read': 'runsRead',
  'runs:execute': 'runsExecute',
  'vault:read': 'vaultRead',
  'vault:manage': 'vaultManage',
  'vault:reveal': 'vaultReveal',
  'terminal:use': 'terminalUse',
  'users:read': 'usersRead',
  'users:write': 'usersWrite',
  'roles:read': 'rolesRead',
  'audit:read': 'auditRead',
  'audit:verify': 'auditVerify',
  'audit:export': 'auditExport',
  'sessions:read': 'sessionsRead',
  'sessions:revoke': 'sessionsRevoke',
  'tokens:create': 'tokensCreate',
  'tokens:read': 'tokensRead',
  'tokens:revoke': 'tokensRevoke',
  'plugins:read': 'pluginsRead',
  'plugins:manage': 'pluginsManage',
} as const satisfies Record<Permission, PermissionKey>;

/**
 * The texts the console has for a role or a permission, by id. The id is typed, so a wrong key fails the build
 * (a `defaultValue` would switch that check off, hence `exists`). An id the console does not know yet, because
 * the server is newer, shows the text the API sent.
 */
export function useCatalogText() {
  const { t, i18n } = useTranslation('roles');
  return {
    roleName: (id: UserRole): string => (i18n.exists(`roles:names.${id}`) ? t(`names.${id}`) : id),
    roleDescription: (id: UserRole, sent: string): string =>
      i18n.exists(`roles:roleDescriptions.${id}`) ? t(`roleDescriptions.${id}`) : sent,
    permissionDescription: (id: Permission, sent: string): string => {
      const key = PERMISSION_KEY[id];
      return i18n.exists(`roles:permissionDescriptions.${key}`)
        ? t(`permissionDescriptions.${key}`)
        : sent;
    },
  };
}

/** The marker of the role the viewer holds. */
function YouBadge({ label }: { label: string }) {
  return (
    <Badge color="cyan" size="lg" variant="soft">
      {label}
    </Badge>
  );
}

/**
 * The built-in roles and what each may do, as a matrix. Read-only: the sets are fixed in code (ADR 0015).
 */
export function RolesPage({ currentRole }: { currentRole: UserRole }) {
  const { t } = useTranslation(['roles', 'common']);
  const text = useCatalogText();
  const catalog = useQuery({ queryKey: ['roles'], queryFn: getRoles, retry: false });

  return (
    <>
      <PageHeader
        description={t('header.description')}
        icon={<IconUserShield size={24} />}
        title={t('header.title')}
      />

      {catalog.isPending ? (
        <LoadingScreen height="60vh" />
      ) : catalog.isError ? (
        <QueryErrorCard
          icon={IconUserShield}
          message={describeError(t, catalog.error, t('signInAgain'), t('forbidden'))}
          onRetry={() => void catalog.refetch()}
          title={t('matrix.title')}
        />
      ) : (
        <Stack gap="md">
          <SectionCard.Root>
            <SectionCard.Section>
              <OverlayHeader
                icon={IconUserShield}
                iconColor="cyan"
                subtitle={t('matrix.subtitle')}
                title={t('matrix.title')}
                titleOrder={5}
              />
            </SectionCard.Section>
            <SectionCard.Section>
              <Table.ScrollContainer minWidth={680}>
                <Table highlightOnHover striped withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('permissionColumn')}</Table.Th>
                      {catalog.data.roles.map((role) => (
                        <Table.Th key={role.id} ta="center">
                          <Group gap="xs" justify="center" wrap="nowrap">
                            {text.roleName(role.id)}
                            {role.id === currentRole ? <YouBadge label={t('you')} /> : null}
                          </Group>
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {catalog.data.permissions.map((permission) => (
                      <Table.Tr key={permission.id}>
                        <Table.Td>
                          <Text ff="monospace" fw={500} size="sm">
                            {permission.id}
                          </Text>
                          <Text c="dimmed" size="xs">
                            {text.permissionDescription(permission.id, permission.description)}
                          </Text>
                        </Table.Td>
                        {catalog.data.roles.map((role) => {
                          const held = role.permissions.includes(permission.id);
                          const names = {
                            role: text.roleName(role.id),
                            permission: permission.id,
                          };
                          return (
                            <Table.Td key={role.id} ta="center">
                              <ThemeIcon
                                aria-label={held ? t('held', names) : t('notHeld', names)}
                                color={held ? 'teal' : 'gray'}
                                role="img"
                                size="md"
                                variant="light"
                              >
                                {held ? (
                                  <PiCheckCircleDuotone size={18} />
                                ) : (
                                  <PiXCircleDuotone size={18} />
                                )}
                              </ThemeIcon>
                            </Table.Td>
                          );
                        })}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </SectionCard.Section>
          </SectionCard.Root>

          <SectionCard.Root>
            <SectionCard.Section>
              <OverlayHeader
                icon={IconUsersGroup}
                iconColor="blue"
                title={t('descriptions.title')}
                titleOrder={5}
              />
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" withDivider>
                {catalog.data.roles.map((role) => (
                  <DataList.Item key={role.id}>
                    <DataList.ItemLabel>
                      <Group gap="xs" wrap="wrap">
                        {text.roleName(role.id)}
                        {role.id === currentRole ? <YouBadge label={t('you')} /> : null}
                      </Group>
                    </DataList.ItemLabel>
                    <DataList.ItemValue>
                      {text.roleDescription(role.id, role.description)}
                    </DataList.ItemValue>
                  </DataList.Item>
                ))}
              </DataList>
            </SectionCard.Section>
            <SectionCard.Section>
              <Text c="dimmed" size="xs">
                {t('note')}
              </Text>
            </SectionCard.Section>
          </SectionCard.Root>
        </Stack>
      )}
    </>
  );
}
