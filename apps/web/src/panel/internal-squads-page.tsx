// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/internal-squads/components/
// internal-squads.page.component.tsx (the header card with the icon-only actions, the grid of cards under a tag filter
// bar), src/widgets/dashboard/internal-squads/internal-squad-card/internal-squad-card.widget.tsx (the card: a rail that
// is cyan while the squad has members, a soft icon, the name in monospace, tags, a blue badge with the number of inbounds
// and a teal one with the number of users, a menu) and src/shared/_modals/internal-squads/internal-squads-inbounds-drawer
// (the inbounds of a squad). Changes: read-only (no create, reorder, rename, tag editing, add or remove of users, or delete);
// the members are a count, no user is read; the drawer lists the inbounds the squad opens.
import {
  Badge,
  Card,
  DataList,
  Group,
  Menu,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiTag, PiUsers } from 'react-icons/pi';
import { TbCirclesRelation, TbEye } from 'react-icons/tb';

import type { PanelInternalSquadView } from '@swellwright/contracts';
import {
  CopyableDataListItem,
  EmptyPageLayout,
  EntityCard,
  HeaderAction,
  HeaderActions,
  OverlayHeader,
  PageHeader,
  SectionCard,
} from '@swellwright/ui';

import { useDateTime, useNumber } from '../format.js';
import { usePanelNames } from './host-lookups.js';
import { CopyMenuItem, TaggedGrid } from './entity-grid.js';
import { PanelBoundary } from './panel-data.js';
import { PanelDrawer } from './panel-drawer.js';
import { useInternalSquadsRead } from './panel-reads.js';

function SquadCard({
  squad,
  onOpen,
}: {
  squad: PanelInternalSquadView;
  onOpen: (squad: PanelInternalSquadView) => void;
}) {
  const { t } = useTranslation('panel');
  const number = useNumber();
  const active = squad.membersCount > 0;
  return (
    <EntityCard.Root
      aria-label={t('internalSquads.openAria', { name: squad.name })}
      isActive={active}
      onClick={() => {
        onOpen(squad);
      }}
    >
      <EntityCard.Header>
        <EntityCard.Icon highlight={active}>
          <TbCirclesRelation size={22} />
        </EntityCard.Icon>
        <EntityCard.Content
          badges={
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t('internalSquads.inbounds')}>
                <Badge color="blue" leftSection={<PiTag size={12} />} size="lg" variant="soft">
                  {number(squad.inboundsCount)}
                </Badge>
              </Tooltip>
              <Tooltip label={t('internalSquads.users')}>
                <Badge
                  color={active ? 'teal' : 'gray'}
                  leftSection={<PiUsers size={12} />}
                  size="lg"
                  variant="soft"
                >
                  {number(squad.membersCount)}
                </Badge>
              </Tooltip>
            </Group>
          }
          tags={squad.tags}
          title={squad.name}
        />
      </EntityCard.Header>
      <EntityCard.Actions>
        <EntityCard.Menu label={t('internalSquads.menuAria', { name: squad.name })}>
          <Menu.Item
            leftSection={<TbEye size={18} />}
            onClick={() => {
              onOpen(squad);
            }}
          >
            {t('internalSquads.view')}
          </Menu.Item>
          <CopyMenuItem label={t('copyUuid')} value={squad.uuid} />
          <CopyMenuItem label={t('copyHash')} value={squad.hash} />
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}

function SquadBody({ squad }: { squad: PanelInternalSquadView }) {
  const { t } = useTranslation(['panel', 'common']);
  const formatTime = useDateTime();
  const number = useNumber();
  const names = usePanelNames();
  return (
    <Stack gap="md">
      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbCirclesRelation}
            iconColor="teal"
            iconSize={18}
            title={t('panel:internalSquads.drawer.overview')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:internalSquads.drawer.name')} value={squad.name} />
            <TagsInput disabled label={t('panel:internalSquads.drawer.tags')} value={squad.tags} />
            <DataList orientation="vertical" withDivider>
              <DataList.Item>
                <DataList.ItemLabel>{t('panel:internalSquads.users')}</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Text size="sm">{number(squad.membersCount)}</Text>
                </DataList.ItemValue>
              </DataList.Item>
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:internalSquads.drawer.hash')}
                monospace
                value={squad.hash}
              />
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:internalSquads.drawer.created')}
                value={formatTime(squad.createdAt)}
              />
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:internalSquads.drawer.updated')}
                value={formatTime(squad.updatedAt)}
              />
            </DataList>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiTag}
            iconColor="blue"
            iconSize={18}
            title={t('panel:internalSquads.drawer.inbounds', { count: squad.inbounds.length })}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          {squad.inbounds.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('panel:internalSquads.drawer.noInbounds')}
            </Text>
          ) : (
            <Stack gap="xs">
              {squad.inbounds.map((inbound) => {
                const parts = [inbound.type, inbound.network, inbound.security].filter(
                  (part): part is string => part !== null && part !== '',
                );
                return (
                  <Card key={inbound.uuid} p="sm" withBorder>
                    <Stack gap={6}>
                      <Group gap="xs" justify="space-between" wrap="nowrap">
                        <Group gap="xs" miw={0} wrap="nowrap">
                          <PiTag
                            aria-hidden
                            size={16}
                            style={{ color: 'var(--mantine-color-blue-5)', flexShrink: 0 }}
                          />
                          <Text ff="monospace" fw={500} size="sm" truncate>
                            {inbound.tag}
                          </Text>
                        </Group>
                        <Group gap={6} wrap="nowrap">
                          {parts.map((part) => (
                            <Badge color="gray" key={part} size="md" variant="light">
                              {part}
                            </Badge>
                          ))}
                          {inbound.port === null ? null : (
                            <Badge color="cyan" size="md" variant="light">
                              {inbound.port}
                            </Badge>
                          )}
                        </Group>
                      </Group>
                      <Text c="dimmed" size="xs">
                        {t('panel:internalSquads.drawer.ofProfile', {
                          name: names.of(names.profiles, inbound.profileUuid),
                        })}
                      </Text>
                    </Stack>
                  </Card>
                );
              })}
            </Stack>
          )}
        </SectionCard.Section>
      </SectionCard.Root>
    </Stack>
  );
}

/** The internal squads of the connected panel. */
export function InternalSquadsPage() {
  const { t } = useTranslation(['panel', 'common']);
  const squads = useInternalSquadsRead();
  const [opened, setOpened] = useState<PanelInternalSquadView | undefined>(undefined);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={squads.refreshing || squads.query.isFetching}
              onClick={() => void squads.refresh()}
            />
          </HeaderActions>
        }
        icon={<TbCirclesRelation size={24} />}
        title={t('panel:internalSquads.title')}
      />

      <PanelBoundary query={squads.query}>
        {(data) =>
          data.internalSquads.length === 0 ? (
            <EmptyPageLayout
              description={t('panel:internalSquads.emptyText')}
              icon={<TbCirclesRelation size="2rem" />}
              mih="30vh"
              title={t('panel:internalSquads.empty')}
            />
          ) : (
            <TaggedGrid
              items={data.internalSquads}
              renderItem={(squad) => <SquadCard onOpen={setOpened} squad={squad} />}
            />
          )
        }
      </PanelBoundary>

      <PanelDrawer
        header={(item) => ({ icon: TbCirclesRelation, title: item.name, subtitle: item.uuid })}
        item={opened}
        onClose={() => {
          setOpened(undefined);
        }}
      >
        {(item) => <SquadBody squad={item} />}
      </PanelDrawer>
    </>
  );
}
