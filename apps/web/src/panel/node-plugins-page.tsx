// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/node-plugins/ui/components/
// node-plugins-base-page.component.tsx (the header card with the icon-only actions, the grid of cards),
// src/widgets/dashboard/node-plugins/{node-plugin-card,active-on-nodes-modal,node-plugin-editor}/* (the card: a soft package
// icon, the name in monospace, tags, a menu with "active on nodes"; the plugin's configuration in an editor) and
// src/pages/dashboard/node-plugins/ui/components/node-plugin-editor-page.component.tsx. Changes: read-only (no create,
// reorder, clone, rename, tag editing or delete; the editor is a viewer); the nodes a plugin is active on are listed in its
// drawer, worked out from the nodes the same panel reports; the configuration comes masked from the server.
import {
  Badge,
  DataList,
  Menu,
  Stack,
  TagsInput,
  TextInput,
  Text,
  Tooltip,
  Card,
  Group,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCpu } from 'react-icons/pi';
import { TbCode, TbEye, TbPackage } from 'react-icons/tb';

import type { PanelNodePluginView } from '@swellwright/contracts';
import {
  Callout,
  CopyableDataListItem,
  CountryFlag,
  EmptyPageLayout,
  EntityCard,
  HeaderAction,
  HeaderActions,
  OverlayHeader,
  PageHeader,
  SectionCard,
} from '@swellwright/ui';

import { useCountries } from '../fleet/countries.js';
import { useNumber } from '../format.js';
import { ConfigViewerCard, jsonText } from './code-viewer.js';
import { CopyMenuItem, TaggedGrid } from './entity-grid.js';
import { PanelBoundary, panelKey, usePanelRead } from './panel-data.js';
import { listPanelNodePlugins } from '../api.js';
import { PanelDrawer } from './panel-drawer.js';
import { useNodesRead } from './panel-reads.js';

function PluginCard({
  plugin,
  activeOn,
  onOpen,
}: {
  plugin: PanelNodePluginView;
  /** How many nodes run this plugin. */
  activeOn: number;
  onOpen: (plugin: PanelNodePluginView) => void;
}) {
  const { t } = useTranslation('panel');
  const number = useNumber();
  return (
    <EntityCard.Root
      aria-label={t('nodePlugins.openAria', { name: plugin.name })}
      onClick={() => {
        onOpen(plugin);
      }}
    >
      <EntityCard.Header>
        <EntityCard.Icon highlight={false}>
          <TbPackage size={22} />
        </EntityCard.Icon>
        <EntityCard.Content
          badges={
            <Tooltip label={t('nodePlugins.activeOn')}>
              <Badge
                color={activeOn > 0 ? 'teal' : 'gray'}
                leftSection={<PiCpu size={12} />}
                size="lg"
                variant="soft"
              >
                {number(activeOn)}
              </Badge>
            </Tooltip>
          }
          tags={plugin.tags}
          title={plugin.name}
        />
      </EntityCard.Header>
      <EntityCard.Actions>
        <EntityCard.Menu label={t('nodePlugins.menuAria', { name: plugin.name })}>
          <Menu.Item
            leftSection={<TbEye size={18} />}
            onClick={() => {
              onOpen(plugin);
            }}
          >
            {t('nodePlugins.view')}
          </Menu.Item>
          <CopyMenuItem label={t('copyUuid')} value={plugin.uuid} />
          <CopyMenuItem label={t('copyHash')} value={plugin.hash} />
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}

function PluginBody({
  plugin,
  nodes,
}: {
  plugin: PanelNodePluginView;
  nodes: { uuid: string; name: string; countryCode: string }[];
}) {
  const { t } = useTranslation(['panel', 'common']);
  const { nameOf } = useCountries();
  return (
    <Stack gap="md">
      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbPackage}
            iconColor="teal"
            iconSize={18}
            title={t('panel:nodePlugins.drawer.overview')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:nodePlugins.drawer.name')} value={plugin.name} />
            <TagsInput disabled label={t('panel:nodePlugins.drawer.tags')} value={plugin.tags} />
            <DataList orientation="vertical" withDivider>
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:nodePlugins.drawer.hash')}
                monospace
                value={plugin.hash}
              />
            </DataList>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiCpu}
            iconColor="teal"
            iconSize={18}
            title={t('panel:nodePlugins.drawer.activeOn', { count: nodes.length })}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          {nodes.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('panel:nodePlugins.drawer.noNodes')}
            </Text>
          ) : (
            <Stack gap="xs">
              {nodes.map((node) => (
                <Card key={node.uuid} p="sm" withBorder>
                  <Group gap="sm" wrap="nowrap">
                    <CountryFlag code={node.countryCode} label={nameOf(node.countryCode)} />
                    <Text fw={500} size="sm" truncate>
                      {node.name}
                    </Text>
                  </Group>
                </Card>
              ))}
            </Stack>
          )}
        </SectionCard.Section>
      </SectionCard.Root>

      {plugin.configLoaded ? (
        <ConfigViewerCard
          description={t('panel:nodePlugins.drawer.configHint')}
          icon={TbCode}
          title={t('panel:nodePlugins.drawer.config')}
          value={jsonText(plugin.pluginConfig ?? {})}
        />
      ) : (
        <Callout color="orange">{t('panel:nodePlugins.drawer.configNotLoaded')}</Callout>
      )}
    </Stack>
  );
}

/** The node plugins of the connected panel. */
export function NodePluginsPage() {
  const { t } = useTranslation(['panel', 'common']);
  const plugins = usePanelRead(panelKey('node-plugins'), listPanelNodePlugins);
  const nodes = useNodesRead();
  const [opened, setOpened] = useState<PanelNodePluginView | undefined>(undefined);

  // How many nodes run each plugin, and which: a node names its active plugin.
  const byPlugin = useMemo(() => {
    const map = new Map<string, { uuid: string; name: string; countryCode: string }[]>();
    for (const node of nodes.query.data?.nodes ?? []) {
      if (node.activePluginUuid !== null) {
        map.set(node.activePluginUuid, [
          ...(map.get(node.activePluginUuid) ?? []),
          { uuid: node.uuid, name: node.name, countryCode: node.countryCode },
        ]);
      }
    }
    return map;
  }, [nodes.query.data]);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={plugins.refreshing || plugins.query.isFetching}
              onClick={() => void plugins.refresh()}
            />
          </HeaderActions>
        }
        icon={<TbPackage size={24} />}
        title={t('panel:nodePlugins.title')}
      />

      <PanelBoundary query={plugins.query}>
        {(data) =>
          data.nodePlugins.length === 0 ? (
            <EmptyPageLayout
              description={t('panel:nodePlugins.emptyText')}
              icon={<TbPackage size="2rem" />}
              mih="30vh"
              title={t('panel:nodePlugins.empty')}
            />
          ) : (
            <TaggedGrid
              items={data.nodePlugins}
              renderItem={(plugin) => (
                <PluginCard
                  activeOn={byPlugin.get(plugin.uuid)?.length ?? 0}
                  onOpen={setOpened}
                  plugin={plugin}
                />
              )}
            />
          )
        }
      </PanelBoundary>

      <PanelDrawer
        header={(item) => ({ icon: TbPackage, title: item.name, subtitle: item.uuid })}
        item={opened}
        onClose={() => {
          setOpened(undefined);
        }}
      >
        {(item) => (
          <PluginBody key={item.uuid} nodes={byPlugin.get(item.uuid) ?? []} plugin={item} />
        )}
      </PanelDrawer>
    </>
  );
}
