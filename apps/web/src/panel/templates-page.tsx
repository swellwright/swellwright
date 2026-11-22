// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/templates/ui/components/
// template-base-page.component.tsx (the header card, the grid of cards under a tag filter bar, one page per template type),
// src/widgets/dashboard/templates/{templates-grid,template-card}/*.widget.tsx (the card: a rail that is cyan for the
// "Default" template, the core's icon, the name in monospace, tags, a menu) and template-editor-page.component..tsx with
// src/widgets/dashboard/templates/subscription-template-editor (the body of a template in a Monaco editor, JSON or YAML).
// Changes: one page with a tab for every type of template instead of a menu item for each (the types a panel has are not
// known in advance); read-only (no create, reorder, rename, tag editing or delete; the editor is a viewer); the body comes
// masked from the server (a template for a local proxy often carries its login and password).
import { Badge, DataList, Menu, Stack, Tabs, TagsInput, TextInput } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiBracketsAngle } from 'react-icons/pi';
import { TbCode, TbEye, TbFolder } from 'react-icons/tb';

import type { PanelSubscriptionTemplateView } from '@swellwright/contracts';
import {
  Callout,
  CopyableDataListItem,
  EmptyPageLayout,
  EntityCard,
  HeaderAction,
  HeaderActions,
  OverlayHeader,
  PageHeader,
  SectionCard,
} from '@swellwright/ui';

import { ConfigViewerCard, jsonText } from './code-viewer.js';
import { CopyMenuItem, TaggedGrid } from './entity-grid.js';
import { PanelBoundary } from './panel-data.js';
import { PanelDrawer } from './panel-drawer.js';
import { useTemplatesRead } from './panel-reads.js';

const TYPE_ORDER = ['XRAY_JSON', 'XRAY_BASE64', 'MIHOMO', 'STASH', 'SINGBOX', 'CLASH'];
const TYPE_LABEL: Record<string, string> = {
  XRAY_JSON: 'Xray JSON',
  XRAY_BASE64: 'Xray Base64',
  MIHOMO: 'Mihomo',
  STASH: 'Stash',
  SINGBOX: 'Sing-box',
  CLASH: 'Clash',
};
const typeLabel = (type: string): string => TYPE_LABEL[type] ?? type;

/** The text a template shows in its viewer: its YAML when it has one, otherwise its JSON. */
const bodyOf = (
  template: PanelSubscriptionTemplateView,
): { text: string; language: 'json' | 'yaml' } =>
  template.templateYaml === null
    ? { text: jsonText(template.templateJson ?? {}), language: 'json' }
    : { text: template.templateYaml, language: 'yaml' };

function TemplateCard({
  template,
  onOpen,
}: {
  template: PanelSubscriptionTemplateView;
  onOpen: (template: PanelSubscriptionTemplateView) => void;
}) {
  const { t } = useTranslation('panel');
  // The panel's own "Default" template is the one that every squad without a choice of its own uses.
  const isDefault = template.name === 'Default';
  return (
    <EntityCard.Root
      aria-label={t('templates.openAria', { name: template.name })}
      isActive={isDefault}
      onClick={() => {
        onOpen(template);
      }}
    >
      <EntityCard.Header>
        <EntityCard.Icon highlight={isDefault}>
          <PiBracketsAngle size={22} />
        </EntityCard.Icon>
        <EntityCard.Content tags={template.tags} title={template.name} />
      </EntityCard.Header>
      <EntityCard.Actions>
        <EntityCard.Menu label={t('templates.menuAria', { name: template.name })}>
          <Menu.Item
            leftSection={<TbEye size={18} />}
            onClick={() => {
              onOpen(template);
            }}
          >
            {t('templates.view')}
          </Menu.Item>
          <CopyMenuItem label={t('copyUuid')} value={template.uuid} />
          <CopyMenuItem label={t('copyHash')} value={template.hash} />
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}

function TemplateBody({ template }: { template: PanelSubscriptionTemplateView }) {
  const { t } = useTranslation(['panel', 'common']);
  const body = bodyOf(template);
  return (
    <Stack gap="md">
      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiBracketsAngle}
            iconColor="teal"
            iconSize={18}
            title={t('panel:templates.drawer.overview')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:templates.drawer.name')} value={template.name} />
            <TextInput
              disabled
              label={t('panel:templates.drawer.type')}
              value={typeLabel(template.templateType)}
            />
            <TagsInput disabled label={t('panel:templates.drawer.tags')} value={template.tags} />
            <DataList orientation="vertical" withDivider>
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:templates.drawer.hash')}
                monospace
                value={template.hash}
              />
            </DataList>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      {template.bodyLoaded ? (
        <ConfigViewerCard
          description={t('panel:templates.drawer.bodyHint')}
          height="560px"
          icon={TbCode}
          language={body.language}
          title={t('panel:templates.drawer.body')}
          value={body.text}
        />
      ) : (
        // The list of the panel has no bodies; an empty viewer would read as "this template is empty".
        <Callout color="orange">{t('panel:templates.drawer.bodyNotLoaded')}</Callout>
      )}
    </Stack>
  );
}

/** The subscription templates of the connected panel, a tab for each type. */
export function TemplatesPage() {
  const { t } = useTranslation(['panel', 'common']);
  const templates = useTemplatesRead();
  const [type, setType] = useState<string | null>(null);
  const [opened, setOpened] = useState<PanelSubscriptionTemplateView | undefined>(undefined);

  const groups = useMemo(() => {
    const byType = new Map<string, PanelSubscriptionTemplateView[]>();
    for (const template of templates.query.data?.templates ?? []) {
      byType.set(template.templateType, [...(byType.get(template.templateType) ?? []), template]);
    }
    return [...byType].sort(([a], [b]) => {
      const rank = (value: string) => {
        const index = TYPE_ORDER.indexOf(value);
        return index === -1 ? TYPE_ORDER.length : index;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  }, [templates.query.data]);

  const active = groups.some(([name]) => name === type) ? type : (groups[0]?.[0] ?? null);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={templates.refreshing || templates.query.isFetching}
              onClick={() => void templates.refresh()}
            />
          </HeaderActions>
        }
        icon={<TbFolder size={24} />}
        title={t('panel:templates.title')}
      />

      <PanelBoundary query={templates.query}>
        {() =>
          groups.length === 0 || active === null ? (
            <EmptyPageLayout
              description={t('panel:templates.emptyText')}
              icon={<TbFolder size="2rem" />}
              mih="30vh"
              title={t('panel:templates.empty')}
            />
          ) : (
            <Tabs color="cyan" keepMounted={false} onChange={setType} value={active}>
              <Tabs.List mb="md">
                {groups.map(([name, list]) => (
                  <Tabs.Tab
                    key={name}
                    leftSection={<PiBracketsAngle size={18} />}
                    rightSection={
                      <Badge color="gray" radius="sm" size="sm" variant="light">
                        {list.length}
                      </Badge>
                    }
                    value={name}
                  >
                    {typeLabel(name)}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {groups.map(([name, list]) => (
                <Tabs.Panel key={name} value={name}>
                  <TaggedGrid
                    items={list}
                    renderItem={(template) => (
                      <TemplateCard onOpen={setOpened} template={template} />
                    )}
                  />
                </Tabs.Panel>
              ))}
            </Tabs>
          )
        }
      </PanelBoundary>

      <PanelDrawer
        header={(item) => ({ icon: PiBracketsAngle, title: item.name, subtitle: item.uuid })}
        item={opened}
        onClose={() => {
          setOpened(undefined);
        }}
      >
        {(item) => <TemplateBody key={item.uuid} template={item} />}
      </PanelDrawer>
    </>
  );
}
