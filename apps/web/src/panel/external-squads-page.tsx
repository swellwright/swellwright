// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/external-squads/components/
// external-squads.page.component.tsx (the header card with the icon-only actions, the grid of cards under a tag filter
// bar), src/widgets/dashboard/external-squads/external-squad-card/external-squad-card.widget.tsx (the card) and
// src/shared/_modals/external-squads/external-squads-drawer/{external-squads.drawer.tsx,tabs/*} (a 600 px drawer: a card
// with the squad's icon, name, users and copyable uuid, then cyan tabs for the templates, settings, host overrides,
// response headers, HWID settings and remarks, each a card). Changes: read-only (no create, reorder, rename, tag editing,
// clone, add or remove of users, or delete; every field is disabled and there is no save button); the templates are shown
// by name; the squad's page of the subscription is not read.
import {
  Badge,
  Box,
  Card,
  DataList,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  px,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiIdentificationBadge, PiListChecks, PiUsers } from 'react-icons/pi';
import { TbFolder, TbListLetters, TbPrescription, TbSettings, TbWebhook } from 'react-icons/tb';
import { Menu } from '@mantine/core';
import { TbEye } from 'react-icons/tb';

import type { PanelExternalSquadView } from '@swellwright/contracts';
import {
  CopyableField,
  EmptyPageLayout,
  EntityCard,
  HeaderAction,
  HeaderActions,
  PageHeader,
} from '@swellwright/ui';

import { useNumber } from '../format.js';
import { CopyMenuItem, TaggedGrid } from './entity-grid.js';
import { usePanelNames } from './host-lookups.js';
import { PanelBoundary } from './panel-data.js';
import { PanelDrawer } from './panel-drawer.js';
import { useExternalSquadsRead } from './panel-reads.js';

const TEMPLATE_TYPES = ['XRAY_JSON', 'MIHOMO', 'STASH', 'SINGBOX', 'CLASH'] as const;
const TEMPLATE_TYPE_LABEL: Record<string, string> = {
  XRAY_JSON: 'Xray JSON',
  XRAY_BASE64: 'Xray Base64',
  MIHOMO: 'Mihomo',
  STASH: 'Stash',
  SINGBOX: 'Sing-box',
  CLASH: 'Clash',
};

type TabId = 'templates' | 'settings' | 'hosts' | 'responseHeaders' | 'hwid' | 'remarks';

function SquadCard({
  squad,
  onOpen,
}: {
  squad: PanelExternalSquadView;
  onOpen: (squad: PanelExternalSquadView) => void;
}) {
  const { t } = useTranslation('panel');
  const number = useNumber();
  const active = squad.membersCount > 0;
  return (
    <EntityCard.Root
      aria-label={t('externalSquads.openAria', { name: squad.name })}
      isActive={active}
      onClick={() => {
        onOpen(squad);
      }}
    >
      <EntityCard.Header>
        <EntityCard.Icon highlight={active}>
          <TbWebhook size={22} />
        </EntityCard.Icon>
        <EntityCard.Content
          badges={
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t('externalSquads.users')}>
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
        <EntityCard.Menu label={t('externalSquads.menuAria', { name: squad.name })}>
          <Menu.Item
            leftSection={<TbEye size={18} />}
            onClick={() => {
              onOpen(squad);
            }}
          >
            {t('externalSquads.view')}
          </Menu.Item>
          <CopyMenuItem label={t('copyUuid')} value={squad.uuid} />
          <CopyMenuItem label={t('copyHash')} value={squad.hash} />
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}

/** A tab's card: a bold title, a dimmed description, then the fields (the panel's `Card p="md" withBorder`). */
function TabCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card p="md" withBorder>
      <Stack gap="md">
        <Text fw={600} size="md">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text c="dimmed" size="sm">
            {description}
          </Text>
        )}
        {children}
      </Stack>
    </Card>
  );
}

function SquadBody({ squad }: { squad: PanelExternalSquadView }) {
  const { t } = useTranslation(['panel', 'common']);
  const number = useNumber();
  const names = usePanelNames();
  const [tab, setTab] = useState<TabId>('templates');
  const active = squad.membersCount > 0;

  const assigned = new Map(
    squad.templates.map((template) => [template.templateType, template.templateUuid]),
  );
  const remarks = Object.entries(squad.customRemarks);
  const headers = Object.entries(squad.responseHeadersAdd);

  return (
    <Stack gap="md" h="100%">
      <Card p="md" withBorder>
        <Group gap="md" wrap="nowrap">
          <Stack gap={6} miw={0} style={{ flex: 1 }}>
            <Text ff="monospace" fw={700} lineClamp={1} size="lg" title={squad.name}>
              {squad.name}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t('panel:externalSquads.users')}>
                <Badge
                  color={active ? 'teal' : 'gray'}
                  leftSection={<PiUsers size={12} />}
                  size="lg"
                  variant="light"
                >
                  {number(squad.membersCount)}
                </Badge>
              </Tooltip>
            </Group>
          </Stack>
        </Group>
      </Card>

      <Tabs
        color="cyan"
        keepMounted={false}
        onChange={(value) => {
          if (value !== null) {
            setTab(value as TabId);
          }
        }}
        value={tab}
      >
        <Tabs.List>
          <Tabs.Tab leftSection={<TbFolder size={px('1.2rem')} />} value="templates">
            {t('panel:externalSquads.tabs.templates')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<TbSettings size={px('1.2rem')} />} value="settings">
            {t('panel:externalSquads.tabs.settings')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<PiListChecks size={px('1.2rem')} />} value="hosts">
            {t('panel:externalSquads.tabs.hosts')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<TbPrescription size={px('1.2rem')} />} value="responseHeaders">
            {t('panel:externalSquads.tabs.responseHeaders')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<PiIdentificationBadge size={px('1.2rem')} />} value="hwid">
            HWID
          </Tabs.Tab>
          <Tabs.Tab leftSection={<TbListLetters size={px('1.2rem')} />} value="remarks">
            {t('panel:externalSquads.tabs.remarks')}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel pt="xl" value="templates">
          <TabCard
            description={t('panel:externalSquads.templates.description')}
            title={t('panel:externalSquads.templates.title')}
          >
            <Stack gap="sm">
              {TEMPLATE_TYPES.map((type) => {
                const uuid = assigned.get(type);
                return (
                  <Select
                    data={
                      uuid === undefined
                        ? []
                        : [{ value: uuid, label: names.of(names.templates, uuid) }]
                    }
                    disabled
                    key={type}
                    label={TEMPLATE_TYPE_LABEL[type]}
                    placeholder={t('panel:externalSquads.templates.default')}
                    value={uuid ?? null}
                  />
                );
              })}
            </Stack>
          </TabCard>
        </Tabs.Panel>

        <Tabs.Panel pt="xl" value="settings">
          <TabCard
            description={t('panel:externalSquads.settings.description')}
            title={t('panel:externalSquads.settings.title')}
          >
            <Stack gap="md">
              <TriState
                label={t('panel:externalSquads.settings.serveJson')}
                value={squad.subscriptionSettings.serveJsonAtBaseSubscription}
              />
              <TriState
                label={t('panel:externalSquads.settings.showRemarks')}
                value={squad.subscriptionSettings.isShowCustomRemarks}
              />
              <TriState
                label={t('panel:externalSquads.settings.randomizeHosts')}
                value={squad.subscriptionSettings.randomizeHosts}
              />
            </Stack>
          </TabCard>
        </Tabs.Panel>

        <Tabs.Panel pt="xl" value="hosts">
          <TabCard
            description={t('panel:externalSquads.hosts.description')}
            title={t('panel:externalSquads.hosts.title')}
          >
            <TextInput
              disabled
              label={t('panel:externalSquads.hosts.serverDescription')}
              placeholder={t('panel:externalSquads.notOverridden')}
              value={squad.hostOverrides.serverDescription ?? ''}
            />
            <TextInput
              disabled
              label="VLESS Route ID"
              placeholder={t('panel:externalSquads.notOverridden')}
              value={
                squad.hostOverrides.vlessRouteId === null
                  ? ''
                  : String(squad.hostOverrides.vlessRouteId)
              }
            />
          </TabCard>
        </Tabs.Panel>

        <Tabs.Panel pt="xl" value="responseHeaders">
          <TabCard
            description={t('panel:externalSquads.headers.description')}
            title={t('panel:externalSquads.headers.title')}
          >
            {headers.length === 0 && squad.responseHeadersRemove.length === 0 ? (
              <Text c="dimmed" size="sm">
                {t('panel:externalSquads.headers.none')}
              </Text>
            ) : (
              <Stack gap="md">
                {headers.length === 0 ? null : (
                  <Stack gap="xs">
                    <Text fw={500} size="sm">
                      {t('panel:externalSquads.headers.added')}
                    </Text>
                    <DataList orientation="horizontal" withDivider>
                      {headers.map(([name, value]) => (
                        <DataList.Item key={name}>
                          <DataList.ItemLabel>{name}</DataList.ItemLabel>
                          <DataList.ItemValue>
                            <Text ff="monospace" size="sm">
                              {value}
                            </Text>
                          </DataList.ItemValue>
                        </DataList.Item>
                      ))}
                    </DataList>
                  </Stack>
                )}
                {squad.responseHeadersRemove.length === 0 ? null : (
                  <Stack gap="xs">
                    <Text fw={500} size="sm">
                      {t('panel:externalSquads.headers.removed')}
                    </Text>
                    <Group gap="xs">
                      {squad.responseHeadersRemove.map((name) => (
                        <Badge color="gray" key={name} size="lg" variant="light">
                          {name}
                        </Badge>
                      ))}
                    </Group>
                  </Stack>
                )}
              </Stack>
            )}
          </TabCard>
        </Tabs.Panel>

        <Tabs.Panel pt="xl" value="hwid">
          <TabCard
            description={t('panel:externalSquads.hwid.description')}
            title={t('panel:externalSquads.hwid.title')}
          >
            <Switch
              checked={squad.hwidSettings.enabled}
              color="teal.8"
              disabled
              label={t('panel:externalSquads.hwid.enabled')}
              size="md"
            />
            <NumberInput
              disabled
              hideControls
              label={t('panel:externalSquads.hwid.limit')}
              value={squad.hwidSettings.fallbackDeviceLimit}
            />
            <TextInput
              disabled
              label={t('panel:externalSquads.hwid.announce')}
              value={squad.hwidSettings.maxDevicesAnnounce ?? ''}
            />
          </TabCard>
        </Tabs.Panel>

        <Tabs.Panel pt="xl" value="remarks">
          <TabCard
            description={t('panel:externalSquads.remarks.description')}
            title={t('panel:externalSquads.remarks.title')}
          >
            {remarks.length === 0 ? (
              <Text c="dimmed" size="sm">
                {t('panel:externalSquads.remarks.none')}
              </Text>
            ) : (
              <Stack gap="md">
                {remarks.map(([language, lines]) => (
                  <Stack gap={4} key={language}>
                    <Text fw={500} size="sm">
                      {language}
                    </Text>
                    {lines.map((line, index) => (
                      <Box key={`${language}:${String(index)}`}>
                        <Text c="dimmed" ff="monospace" size="sm">
                          {line}
                        </Text>
                      </Box>
                    ))}
                  </Stack>
                ))}
              </Stack>
            )}
          </TabCard>
        </Tabs.Panel>
      </Tabs>

      <CopyableField
        aria-label={t('panel:externalSquads.drawer.hash')}
        copiedLabel={t('common:copied')}
        copyLabel={t('common:copy')}
        label={t('panel:externalSquads.drawer.hash')}
        value={squad.hash}
      />
    </Stack>
  );
}

/** A switch that the squad may leave to the panel's own settings: on, off, or not overridden. */
function TriState({ label, value }: { label: string; value: boolean | null }) {
  const { t } = useTranslation('panel');
  return (
    <Group gap="md" justify="space-between" wrap="nowrap">
      <Text size="sm">{label}</Text>
      {value === null ? (
        <Badge color="gray" size="lg" variant="light">
          {t('externalSquads.notOverridden')}
        </Badge>
      ) : (
        <Switch aria-label={label} checked={value} color="teal.8" disabled size="md" />
      )}
    </Group>
  );
}

/** The external squads of the connected panel. */
export function ExternalSquadsPage() {
  const { t } = useTranslation(['panel', 'common']);
  const squads = useExternalSquadsRead();
  const [opened, setOpened] = useState<PanelExternalSquadView | undefined>(undefined);

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
        icon={<TbWebhook size={24} />}
        title={t('panel:externalSquads.title')}
      />

      <PanelBoundary query={squads.query}>
        {(data) =>
          data.externalSquads.length === 0 ? (
            <EmptyPageLayout
              description={t('panel:externalSquads.emptyText')}
              icon={<TbWebhook size="2rem" />}
              mih="30vh"
              title={t('panel:externalSquads.empty')}
            />
          ) : (
            <TaggedGrid
              items={data.externalSquads}
              renderItem={(squad) => <SquadCard onOpen={setOpened} squad={squad} />}
            />
          )
        }
      </PanelBoundary>

      <PanelDrawer
        header={(item) => ({ icon: TbWebhook, title: item.name, subtitle: item.uuid })}
        item={opened}
        onClose={() => {
          setOpened(undefined);
        }}
        size="600px"
      >
        {(item) => <SquadBody key={item.uuid} squad={item} />}
      </PanelDrawer>
    </>
  );
}
