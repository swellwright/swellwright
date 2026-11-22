// New in Swellwright (ADR 0046): the small pieces the API console shares, in the panel's chips: `Badge` with the soft
// variant, the colours that tell the intent (teal for a read, orange for what is about people, red for what is
// refused, violet for what needs an administrator session).
import { Badge, Group } from '@mantine/core';
import { IconBan, IconLock, IconShieldLock, IconUsers, IconWorld } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

import type { PanelConsoleOperation } from '@swellwright/contracts';

const METHOD_COLOR: Record<PanelConsoleOperation['method'], string> = {
  get: 'teal',
  post: 'blue',
  put: 'orange',
  patch: 'orange',
  delete: 'red',
};

/** `GET`, `POST`...: the method of an operation, in a small soft chip. */
export function MethodBadge({ method }: { method: PanelConsoleOperation['method'] }) {
  return (
    <Badge
      color={METHOD_COLOR[method]}
      ff="monospace"
      miw={52}
      size="sm"
      style={{ flexShrink: 0 }}
      variant="soft"
    >
      {method.toUpperCase()}
    </Badge>
  );
}

/** What is particular about an operation: about people, blocked, not a read, an administrator session, no token. */
export function OperationBadges({ operation }: { operation: PanelConsoleOperation }) {
  const { t } = useTranslation('apiConsole');
  return (
    <Group gap="xs">
      <MethodBadge method={operation.method} />
      {operation.availability === 'user_data' ? (
        <Badge color="orange" leftSection={<IconUsers size={14} />} size="lg" variant="soft">
          {t('badge.userData')}
        </Badge>
      ) : null}
      {operation.availability === 'blocked' ? (
        <Badge color="red" leftSection={<IconBan size={14} />} size="lg" variant="soft">
          {t('badge.blocked')}
        </Badge>
      ) : null}
      {operation.availability === 'write' ? (
        <Badge color="gray" leftSection={<IconLock size={14} />} size="lg" variant="soft">
          {t('badge.write')}
        </Badge>
      ) : null}
      {operation.adminOnly ? (
        <Badge color="violet" leftSection={<IconShieldLock size={14} />} size="lg" variant="soft">
          {t('badge.adminOnly')}
        </Badge>
      ) : null}
      {operation.publicEndpoint ? (
        <Badge color="gray" leftSection={<IconWorld size={14} />} size="lg" variant="soft">
          {t('badge.public')}
        </Badge>
      ) : null}
      {operation.deprecated ? (
        <Badge color="orange" size="lg" variant="soft">
          {t('badge.deprecated')}
        </Badge>
      ) : null}
    </Group>
  );
}
