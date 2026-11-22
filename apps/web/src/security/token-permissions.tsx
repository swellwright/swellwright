// The permission rows of the API-token dialogs. Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only):
// src/widgets/remnawave-settings/api-tokens-card/modals/{scope-resource-row.tsx,kind-pill.tsx,scope-endpoint-item.tsx}.
// Changes: the panel's resources and endpoints are our permissions (`resource:action`); the "write" pill is
// "Actions" because a permission can be an action that is not a write (run, export, verify); the endpoint rows are
// checkboxes, so they work from the keyboard; the CSS module became `tokens-page.css`.
import {
  Badge,
  Checkbox,
  Collapse,
  Group,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconApiApp,
  IconBook,
  IconCheck,
  IconChevronRight,
  IconDevices,
  IconLayoutDashboard,
  IconLock,
  IconMinus,
  IconPlayerPlay,
  IconPuzzle,
  IconServer,
  IconTerminal2,
  IconUsers,
  IconUserShield,
  type TablerIcon,
} from '@tabler/icons-react';
import { type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PERMISSION_INFO, type Permission } from '@swellwright/contracts';

import './tokens-page.css';
import { useCatalogText } from './roles-page.js';

type ResourceOf<P extends Permission> = P extends `${infer R}:${string}` ? R : never;
/** The part of a permission before the colon: `servers` for `servers:read`. */
export type Resource = ResourceOf<Permission>;

/**
 * The resource of each permission, for the groups of the lists. Typed against both sides: a permission added to the
 * contracts without a group here fails the build, and so does a resource without a text in `tokens`.
 */
const RESOURCE_OF = {
  'servers:read': 'servers',
  'servers:write': 'servers',
  'servers:exec': 'servers',
  'panel:read': 'panel',
  'panel:write': 'panel',
  'panel:console': 'panel',
  'runs:read': 'runs',
  'runs:execute': 'runs',
  'vault:read': 'vault',
  'vault:manage': 'vault',
  'vault:reveal': 'vault',
  'terminal:use': 'terminal',
  'users:read': 'users',
  'users:write': 'users',
  'roles:read': 'roles',
  'audit:read': 'audit',
  'audit:verify': 'audit',
  'audit:export': 'audit',
  'sessions:read': 'sessions',
  'sessions:revoke': 'sessions',
  'tokens:create': 'tokens',
  'tokens:read': 'tokens',
  'tokens:revoke': 'tokens',
  'plugins:read': 'plugins',
  'plugins:manage': 'plugins',
} as const satisfies { readonly [P in Permission]: ResourceOf<P> };

/** The glyph of each resource, as the panel gives each of its resources one. */
const RESOURCE_ICON: Record<Resource, TablerIcon> = {
  servers: IconServer,
  panel: IconLayoutDashboard,
  runs: IconPlayerPlay,
  vault: IconLock,
  terminal: IconTerminal2,
  users: IconUsers,
  roles: IconUserShield,
  audit: IconBook,
  sessions: IconDevices,
  tokens: IconApiApp,
  plugins: IconPuzzle,
};

export interface PermissionGroup {
  readonly resource: Resource;
  readonly permissions: readonly Permission[];
}

/** The permissions in the order they are listed, grouped under their resource. */
export function groupByResource(permissions: readonly Permission[]): PermissionGroup[] {
  const groups = new Map<Resource, Permission[]>();
  for (const permission of permissions) {
    const resource = RESOURCE_OF[permission];
    groups.set(resource, [...(groups.get(resource) ?? []), permission]);
  }
  return [...groups].map(([resource, list]) => ({ resource, permissions: list }));
}

/** `read` is looking at things; everything else (write, run, export, revoke...) is an action. */
export type PermissionKind = 'read' | 'actions';

export const kindOf = (permission: Permission): PermissionKind =>
  permission.endsWith(':read') ? 'read' : 'actions';

type KindState = 'off' | 'partial' | 'on';

function KindPill({
  label,
  ariaLabel,
  state,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  state: KindState;
  /** Without it the pill only shows the state. */
  onClick: (() => void) | undefined;
}) {
  const active = state !== 'off';
  const content: ReactNode = (
    <>
      {state === 'on' ? <IconCheck aria-hidden size={12} /> : null}
      {state === 'partial' ? <IconMinus aria-hidden size={12} /> : null}
      {label}
    </>
  );
  const className = `sw-kind-pill${active ? ' sw-kind-pill--active' : ''}`;

  if (onClick === undefined) {
    return (
      <span className={className} data-readonly>
        {content}
      </span>
    );
  }
  return (
    <UnstyledButton
      aria-label={ariaLabel}
      aria-pressed={state === 'on' ? true : state === 'partial' ? 'mixed' : false}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      type="button"
    >
      {content}
    </UnstyledButton>
  );
}

function PermissionRow({
  group,
  picked,
  onToggle,
  onToggleKind,
  initiallyOpen,
}: {
  group: PermissionGroup;
  picked: readonly Permission[];
  onToggle: ((permission: Permission) => void) | undefined;
  onToggleKind: ((kind: PermissionKind) => void) | undefined;
  initiallyOpen: boolean;
}) {
  const { t } = useTranslation('tokens');
  const text = useCatalogText();
  const [open, setOpen] = useState(initiallyOpen);
  const listId = useId();
  const Icon = RESOURCE_ICON[group.resource];
  const readOnly = onToggle === undefined;

  const selected = group.permissions.filter((permission) => picked.includes(permission));
  const stateOf = (kind: PermissionKind): KindState | 'none' => {
    const keys = group.permissions.filter((permission) => kindOf(permission) === kind);
    if (keys.length === 0) {
      return 'none';
    }
    const count = keys.filter((permission) => picked.includes(permission)).length;
    return count === 0 ? 'off' : count === keys.length ? 'on' : 'partial';
  };
  const resourceName = t(`resources.${group.resource}`);

  const pill = (kind: PermissionKind) => {
    const state = stateOf(kind);
    if (state === 'none') {
      return null;
    }
    const label = t(`permissionKinds.${kind}`);
    return (
      <KindPill
        ariaLabel={t('permissionKinds.aria', { kind: label, resource: resourceName })}
        label={label}
        onClick={
          onToggleKind === undefined
            ? undefined
            : () => {
                onToggleKind(kind);
              }
        }
        state={state}
      />
    );
  };

  return (
    <div className="sw-perm-row">
      <Group className="sw-perm-header" gap="xs" wrap="nowrap">
        <UnstyledButton
          aria-controls={listId}
          aria-expanded={open}
          className="sw-perm-trigger"
          onClick={() => {
            setOpen((value) => !value);
          }}
          type="button"
        >
          <Group gap="sm" wrap="nowrap">
            <IconChevronRight
              aria-hidden
              className={`sw-perm-chevron${open ? ' sw-perm-chevron--open' : ''}`}
              size={12}
            />
            <ThemeIcon
              aria-hidden
              color={selected.length > 0 ? 'teal' : 'gray'}
              size="md"
              variant={selected.length > 0 ? 'soft' : 'default'}
            >
              <Icon size={15} />
            </ThemeIcon>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text className="sw-perm-name" truncate="end">
                {resourceName}
              </Text>
              {readOnly ? null : (
                <Text c="dimmed" ff="monospace" size="xs">
                  {selected.length}/{group.permissions.length}
                </Text>
              )}
            </Stack>
          </Group>
        </UnstyledButton>

        {pill('read')}
        {pill('actions')}
      </Group>

      <Collapse expanded={open} id={listId}>
        <Stack className="sw-perm-list" gap={4}>
          {group.permissions.map((permission) => {
            const checked = picked.includes(permission);
            const kind = kindOf(permission);
            const description = text.permissionDescription(permission, PERMISSION_INFO[permission]);
            return (
              <div
                className="sw-perm-item"
                data-checked={(!readOnly && checked) || undefined}
                key={permission}
              >
                <Group gap="sm" wrap="nowrap">
                  <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    {readOnly ? (
                      <>
                        <Text className="sw-perm-id">{permission}</Text>
                        <Text c="dimmed" size="xs">
                          {description}
                        </Text>
                      </>
                    ) : (
                      <Checkbox
                        checked={checked}
                        description={description}
                        label={<span className="sw-perm-id">{permission}</span>}
                        onChange={() => {
                          onToggle(permission);
                        }}
                        radius="sm"
                        size="xs"
                      />
                    )}
                  </Stack>
                  <Badge
                    color={kind === 'read' ? 'blue' : 'orange'}
                    ff="monospace"
                    radius="sm"
                    variant="soft"
                  >
                    {t(`permissionKinds.${kind}`)}
                  </Badge>
                </Group>
              </div>
            );
          })}
        </Stack>
      </Collapse>
    </div>
  );
}

/**
 * The permissions as one row per resource. With `onToggle` they can be changed (a checkbox per permission, and the
 * Read and Actions pills tick a whole kind at once); without it the rows only show what a token carries.
 */
export function PermissionRows({
  groups,
  picked,
  onToggle,
  onToggleKind,
  initiallyOpen = false,
}: {
  groups: readonly PermissionGroup[];
  picked: readonly Permission[];
  onToggle?: (permission: Permission) => void;
  onToggleKind?: (group: PermissionGroup, kind: PermissionKind) => void;
  /** Open every row at first, for a list that is only read. */
  initiallyOpen?: boolean;
}) {
  return (
    <Stack gap={6}>
      {groups.map((group) => (
        <PermissionRow
          group={group}
          initiallyOpen={initiallyOpen}
          key={group.resource}
          onToggle={onToggle}
          onToggleKind={
            onToggleKind === undefined
              ? undefined
              : (kind) => {
                  onToggleKind(group, kind);
                }
          }
          picked={picked}
        />
      ))}
    </Stack>
  );
}
