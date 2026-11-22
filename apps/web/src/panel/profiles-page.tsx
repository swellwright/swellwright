// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/config-profiles/components/
// config-profiles.page.component.tsx (the header card with the icon-only actions, the grid of cards under a tag filter
// bar) and src/widgets/dashboard/config-profiles/config-profile-card/config-profile-card.widget.tsx (the card: a rail that
// is cyan while the profile runs on a node, a soft icon, the name in monospace, tags, a blue badge with the number of inbounds
// and a teal one with the number of nodes, a menu). Changes: read-only (no create, reorder, rename, tag editing or delete; the
// menu opens the configuration, copies the uuid and the hash); the badges are plain, the drawer holds what they would open;
// a profile's Xray configuration is read only when its drawer is opened.
import { Badge, Group, Menu, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PiCpu, PiTag } from 'react-icons/pi';
import { TbBraces, TbEye } from 'react-icons/tb';
import { useState } from 'react';

import type { PanelConfigProfileSummary } from '@swellwright/contracts';
import {
  EmptyPageLayout,
  EntityCard,
  HeaderAction,
  HeaderActions,
  PageHeader,
} from '@swellwright/ui';

import { useNumber } from '../format.js';
import { CopyMenuItem, TaggedGrid } from './entity-grid.js';
import { PanelBoundary } from './panel-data.js';
import { useProfilesRead } from './panel-reads.js';
import { ProfileDrawer } from './profile-drawer.js';

function ProfileCard({
  profile,
  onOpen,
}: {
  profile: PanelConfigProfileSummary;
  onOpen: (profile: PanelConfigProfileSummary) => void;
}) {
  const { t } = useTranslation(['panel', 'common']);
  const number = useNumber();
  const active = profile.nodeCount > 0;
  return (
    <EntityCard.Root
      aria-label={t('panel:profiles.openAria', { name: profile.name })}
      isActive={active}
      onClick={() => {
        onOpen(profile);
      }}
    >
      <EntityCard.Header>
        <EntityCard.Icon highlight={active}>
          <TbBraces size={22} />
        </EntityCard.Icon>
        <EntityCard.Content
          badges={
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t('panel:profiles.inbounds')}>
                <Badge color="blue" leftSection={<PiTag size={12} />} size="lg" variant="soft">
                  {number(profile.inbounds.length)}
                </Badge>
              </Tooltip>
              <Tooltip label={t('panel:profiles.nodes')}>
                <Badge
                  color={active ? 'teal' : 'gray'}
                  leftSection={<PiCpu size={12} />}
                  size="lg"
                  variant="soft"
                >
                  {number(profile.nodeCount)}
                </Badge>
              </Tooltip>
            </Group>
          }
          tags={profile.tags}
          title={profile.name}
        />
      </EntityCard.Header>
      <EntityCard.Actions>
        <EntityCard.Menu label={t('panel:profiles.menuAria', { name: profile.name })}>
          <Menu.Item
            leftSection={<TbEye size={18} />}
            onClick={() => {
              onOpen(profile);
            }}
          >
            {t('panel:profiles.view')}
          </Menu.Item>
          <CopyMenuItem label={t('panel:copyUuid')} value={profile.uuid} />
          <CopyMenuItem label={t('panel:copyHash')} value={profile.hash} />
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}

/** The config profiles of the connected panel. */
export function ProfilesPage() {
  const { t } = useTranslation(['panel', 'common']);
  const profiles = useProfilesRead();
  const [opened, setOpened] = useState<PanelConfigProfileSummary | undefined>(undefined);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={profiles.refreshing || profiles.query.isFetching}
              onClick={() => void profiles.refresh()}
            />
          </HeaderActions>
        }
        icon={<TbBraces size={24} />}
        title={t('panel:profiles.title')}
      />

      <PanelBoundary query={profiles.query}>
        {(data) =>
          data.configProfiles.length === 0 ? (
            <EmptyPageLayout
              description={t('panel:profiles.emptyText')}
              icon={<TbBraces size="2rem" />}
              mih="30vh"
              title={t('panel:profiles.empty')}
            />
          ) : (
            <TaggedGrid
              items={data.configProfiles}
              renderItem={(profile) => <ProfileCard onOpen={setOpened} profile={profile} />}
            />
          )
        }
      </PanelBoundary>

      <ProfileDrawer
        onClose={() => {
          setOpened(undefined);
        }}
        profile={opened}
      />
    </>
  );
}
