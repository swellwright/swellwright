// New in Swellwright (ADR 0046). The panel has no API console; this is its closest pattern: the titled card of the panel's
// pages (`SectionCard` with an `OverlayHeader`), a search field and a segmented switch as the panel's table tools are
// built, and a menu-like list of `NavLink`s grouped under the panel's own grouping of its API (the tag of each operation).
import {
  Badge,
  Box,
  Group,
  NavLink,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconApi, IconBan, IconLock, IconSearch, IconUsers } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PanelConsoleOperation } from '@swellwright/contracts';
import { EmptyPageLayout, OverlayHeader, SectionCard } from '@swellwright/ui';

import { MethodBadge } from './console-parts.js';

type Scope = 'reads' | 'all';

const matches = (operation: PanelConsoleOperation, needle: string): boolean =>
  needle === '' ||
  `${operation.summary} ${operation.path} ${operation.operationId} ${operation.group}`
    .toLowerCase()
    .includes(needle);

/** The icon and the tooltip that say why an operation is not a plain read, or nothing for one that is. */
function Marker({ operation }: { operation: PanelConsoleOperation }) {
  const { t } = useTranslation('apiConsole');
  if (operation.availability === 'write') {
    return (
      <Tooltip label={t('marker.write')} multiline w={260} withArrow>
        <IconLock aria-label={t('marker.write')} color="var(--mantine-color-dimmed)" size={16} />
      </Tooltip>
    );
  }
  if (operation.availability === 'blocked') {
    return (
      <Tooltip
        label={
          operation.blockedReason === 'side_effect'
            ? t('marker.blockedSideEffect')
            : t('marker.blockedSecret')
        }
        multiline
        w={260}
        withArrow
      >
        <IconBan
          aria-label={t('marker.blockedShort')}
          color="var(--mantine-color-red-5)"
          size={16}
        />
      </Tooltip>
    );
  }
  if (operation.availability === 'user_data') {
    return (
      <Tooltip label={t('marker.userData')} multiline w={260} withArrow>
        <IconUsers
          aria-label={t('marker.userDataShort')}
          color="var(--mantine-color-orange-5)"
          size={16}
        />
      </Tooltip>
    );
  }
  return null;
}

/** The searchable list of the operations of the panel's API, grouped by the panel's own groups. */
export function OperationList({
  operations,
  selected,
  onSelect,
  height,
}: {
  operations: readonly PanelConsoleOperation[];
  selected: string | undefined;
  onSelect: (operationId: string) => void;
  /** The height of the scrolling list. */
  height: number | string;
}) {
  const { t } = useTranslation(['apiConsole', 'common']);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('reads');
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const needle = search.trim().toLowerCase();

  const groups = useMemo(() => {
    const byGroup = new Map<string, PanelConsoleOperation[]>();
    for (const operation of operations) {
      if (scope === 'reads' && operation.method !== 'get') {
        continue;
      }
      if (!matches(operation, needle)) {
        continue;
      }
      byGroup.set(operation.group, [...(byGroup.get(operation.group) ?? []), operation]);
    }
    return [...byGroup]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({
        name,
        list: [...list].sort(
          (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
        ),
      }));
  }, [operations, scope, needle]);

  const reads = operations.filter((o) => o.method === 'get').length;
  const shown = groups.reduce((sum, group) => sum + group.list.length, 0);

  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Stack gap="md">
          <OverlayHeader
            icon={IconApi}
            iconColor="cyan"
            iconSize={18}
            subtitle={t('apiConsole:list.subtitle', { n: operations.length })}
            title={t('apiConsole:list.title')}
            titleOrder={5}
          />
          <TextInput
            aria-label={t('apiConsole:list.search')}
            leftSection={<IconSearch size={16} />}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
            placeholder={t('apiConsole:list.search')}
            value={search}
          />
          <SegmentedControl
            aria-label={t('apiConsole:list.scope')}
            data={[
              { value: 'reads', label: t('apiConsole:list.reads', { n: reads }) },
              { value: 'all', label: t('apiConsole:list.all', { n: operations.length }) },
            ]}
            fullWidth
            onChange={(value) => {
              setScope(value);
            }}
            size="xs"
            value={scope}
          />
        </Stack>
      </SectionCard.Section>
      <SectionCard.Section>
        {shown === 0 ? (
          <EmptyPageLayout
            description={t('apiConsole:list.noMatchText')}
            icon={<IconSearch size="2rem" />}
            title={t('apiConsole:list.noMatch')}
          />
        ) : (
          <Box
            aria-label={t('apiConsole:list.title')}
            component="nav"
            mah={height}
            style={{ overflowX: 'hidden', overflowY: 'auto' }}
          >
            {groups.map(({ name, list }) => {
              const open = needle !== '' || !closed.has(name);
              return (
                <NavLink
                  childrenOffset={0}
                  component="button"
                  key={name}
                  label={
                    <Group gap="xs" justify="space-between" wrap="nowrap">
                      <Text fw={600} size="sm" truncate>
                        {name}
                      </Text>
                      <Badge size="sm" variant="soft">
                        {list.length}
                      </Badge>
                    </Group>
                  }
                  onClick={() => {
                    setClosed((previous) => {
                      const next = new Set(previous);
                      if (next.has(name)) {
                        next.delete(name);
                      } else {
                        next.add(name);
                      }
                      return next;
                    });
                  }}
                  opened={open}
                >
                  {list.map((operation) => (
                    <NavLink
                      active={operation.operationId === selected}
                      aria-current={operation.operationId === selected ? 'true' : undefined}
                      component="button"
                      description={
                        <Text ff="monospace" fz={11} truncate>
                          {operation.path}
                        </Text>
                      }
                      key={operation.operationId}
                      label={
                        <Group gap={6} justify="space-between" wrap="nowrap">
                          <Text
                            {...(operation.availability === 'open' ? {} : { c: 'dimmed' })}
                            size="sm"
                            truncate
                          >
                            {operation.summary}
                          </Text>
                          <Marker operation={operation} />
                        </Group>
                      }
                      leftSection={<MethodBadge method={operation.method} />}
                      onClick={() => {
                        onSelect(operation.operationId);
                      }}
                      styles={{ body: { minWidth: 0 }, label: { minWidth: 0 } }}
                      style={operation.availability === 'write' ? { opacity: 0.65 } : undefined}
                      variant="light"
                    />
                  ))}
                </NavLink>
              );
            })}
          </Box>
        )}
      </SectionCard.Section>
    </SectionCard.Root>
  );
}
