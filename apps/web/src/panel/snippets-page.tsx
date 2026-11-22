// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/widgets/dashboard/config-profiles/snippets/
// {snippets-grid.widget.tsx,edit-snippet.modal.tsx,Snippets.module.css} and src/shared/_modals/snippets/snippets-modal
// (the named JSON fragments that the templates reuse: a list of rows with a braces icon, the count of items in each, and
// an editor in a modal), src/shared/ui/tree-browser (the list; a name with slashes is a folder there). Changes: a page of its
// own instead of a modal of the config profiles page, where the console keeps every kind of object; the list is flat
// (the name, with its slashes, is the title; there are few snippets and a tree adds nothing to a read-only list); read-only
// (no create, rename or delete; the editor is a viewer); the body comes masked from the server.
import { Badge, DataList, Menu, Stack, TextInput, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TbBraces, TbCode, TbEye } from 'react-icons/tb';

import type { PanelSnippetView } from '@swellwright/contracts';
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

import { useNumber } from '../format.js';
import { ConfigViewerCard, jsonText } from './code-viewer.js';
import { CopyMenuItem, EntityGrid } from './entity-grid.js';
import { PanelBoundary } from './panel-data.js';
import { PanelDrawer } from './panel-drawer.js';
import { useSnippetsRead } from './panel-reads.js';

/** How many items a snippet holds when it is a list (the panel shows the count in the row). */
const countItems = (snippet: unknown): number | null =>
  Array.isArray(snippet) ? snippet.length : null;

function SnippetCard({
  snippet,
  onOpen,
}: {
  snippet: PanelSnippetView;
  onOpen: (snippet: PanelSnippetView) => void;
}) {
  const { t } = useTranslation('panel');
  const number = useNumber();
  const count = countItems(snippet.snippet);
  return (
    <EntityCard.Root
      aria-label={t('snippets.openAria', { name: snippet.name })}
      onClick={() => {
        onOpen(snippet);
      }}
    >
      <EntityCard.Header>
        <EntityCard.Icon>
          <TbBraces size={22} />
        </EntityCard.Icon>
        <EntityCard.Content
          {...(count === null
            ? {}
            : {
                badges: (
                  <Tooltip label={t('snippets.items')}>
                    <Badge color="blue" size="lg" variant="soft">
                      {number(count)}
                    </Badge>
                  </Tooltip>
                ),
              })}
          title={snippet.name}
        />
      </EntityCard.Header>
      <EntityCard.Actions>
        <EntityCard.Menu label={t('snippets.menuAria', { name: snippet.name })}>
          <Menu.Item
            leftSection={<TbEye size={18} />}
            onClick={() => {
              onOpen(snippet);
            }}
          >
            {t('snippets.view')}
          </Menu.Item>
          <CopyMenuItem label={t('snippets.copyName')} value={snippet.name} />
          <CopyMenuItem label={t('copyHash')} value={snippet.hash} />
        </EntityCard.Menu>
      </EntityCard.Actions>
    </EntityCard.Root>
  );
}

function SnippetBody({ snippet }: { snippet: PanelSnippetView }) {
  const { t } = useTranslation(['panel', 'common']);
  return (
    <Stack gap="md">
      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbBraces}
            iconColor="teal"
            iconSize={18}
            title={t('panel:snippets.drawer.overview')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:snippets.drawer.name')} value={snippet.name} />
            <DataList orientation="vertical" withDivider>
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:snippets.drawer.hash')}
                monospace
                value={snippet.hash}
              />
            </DataList>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <ConfigViewerCard
        description={t('panel:snippets.drawer.bodyHint')}
        icon={TbCode}
        title={t('panel:snippets.drawer.body')}
        value={jsonText(snippet.snippet)}
      />
    </Stack>
  );
}

/** The snippets of the connected panel: named JSON fragments its templates reuse. */
export function SnippetsPage() {
  const { t } = useTranslation(['panel', 'common']);
  const snippets = useSnippetsRead();
  const [opened, setOpened] = useState<PanelSnippetView | undefined>(undefined);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={snippets.refreshing || snippets.query.isFetching}
              onClick={() => void snippets.refresh()}
            />
          </HeaderActions>
        }
        icon={<TbCode size={24} />}
        title={t('panel:snippets.title')}
      />

      <PanelBoundary query={snippets.query}>
        {(data) =>
          data.snippets.length === 0 ? (
            <EmptyPageLayout
              description={t('panel:snippets.emptyText')}
              icon={<TbCode size="2rem" />}
              mih="30vh"
              title={t('panel:snippets.empty')}
            />
          ) : (
            <EntityGrid>
              {[...data.snippets]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((snippet) => (
                  <SnippetCard key={snippet.name} onOpen={setOpened} snippet={snippet} />
                ))}
            </EntityGrid>
          )
        }
      </PanelBoundary>

      <PanelDrawer
        header={(item) => ({ icon: TbBraces, title: item.name })}
        item={opened}
        onClose={() => {
          setOpened(undefined);
        }}
      >
        {(item) => <SnippetBody key={item.name} snippet={item} />}
      </PanelDrawer>
    </>
  );
}
