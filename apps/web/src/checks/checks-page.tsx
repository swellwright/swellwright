// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the header card with icon-only actions that every page
// opens with, and the tabbed pages of the panel (src/widgets/dashboard/subscription-settings/settings/subscription-tabs.widget.tsx:
// `Tabs color="cyan"` with an icon in each tab and `pt="xl"` panels). Changes: the three tabs of the checks of the connected panel
// (conventions, reconciliation, impact of a change); the active tab and the object of the dry run live in the address, so a
// button in a drawer of another page can open the Impact tab with an object chosen.
import { Tabs } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TbArrowsDiff, TbBolt, TbChecklist } from 'react-icons/tb';
import { useSearchParams } from 'react-router';

import { IMPACT_KINDS, type ImpactKind, type Permission } from '@swellwright/contracts';
import { HeaderAction, HeaderActions, PageHeader } from '@swellwright/ui';

import { getPanelConnection } from '../api.js';
import { PanelNotConnected, panelKey } from '../panel/panel-data.js';
import { useConventionRun, useReconciliation } from './checks-data.js';
import { ConventionsTab } from './conventions-tab.js';
import { ImpactTab } from './impact-tab.js';
import { ReconciliationTab } from './reconciliation-tab.js';

const TABS = ['conventions', 'reconciliation', 'impact'] as const;
type Tab = (typeof TABS)[number];

const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab === value);
const isKind = (value: string | null): value is ImpactKind =>
  IMPACT_KINDS.some((kind) => kind === value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The checks of the connected panel: the convention linter, the reconciliation, and the dry run of a change. */
export function ChecksPage({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation(['checks', 'common']);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = isTab(requested) ? requested : 'conventions';
  const kind = params.get('kind');
  const uuid = params.get('uuid');

  const connection = useQuery({
    queryKey: panelKey('connection'),
    queryFn: getPanelConnection,
    retry: false,
  });
  const connected = connection.data !== undefined && connection.data.state !== 'unconfigured';
  const conventions = useConventionRun(connected && tab === 'conventions');
  const reconciliation = useReconciliation(connected && tab === 'reconciliation');
  const active =
    tab === 'conventions' ? conventions : tab === 'reconciliation' ? reconciliation : undefined;

  const header = (
    <PageHeader
      actions={
        <HeaderActions>
          <HeaderAction
            disabled={active === undefined || !connected}
            icon={IconRefresh}
            label={t('common:refresh')}
            loading={active !== undefined && (active.refreshing || active.query.isFetching)}
            onClick={() => {
              void active?.refresh();
            }}
          />
        </HeaderActions>
      }
      description={t('checks:ui.description')}
      icon={<TbChecklist size={24} />}
      title={t('checks:ui.title')}
    />
  );

  if (connection.data?.state === 'unconfigured') {
    return (
      <>
        {header}
        <PanelNotConnected />
      </>
    );
  }

  return (
    <>
      {header}
      <Tabs
        color="cyan"
        keepMounted={false}
        onChange={(value) => {
          if (isTab(value)) {
            setParams({ tab: value });
          }
        }}
        value={tab}
      >
        <Tabs.List>
          <Tabs.Tab leftSection={<TbChecklist size={20} />} value="conventions">
            {t('checks:ui.tabs.conventions')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<TbArrowsDiff size={20} />} value="reconciliation">
            {t('checks:ui.tabs.reconciliation')}
          </Tabs.Tab>
          <Tabs.Tab leftSection={<TbBolt size={20} />} value="impact">
            {t('checks:ui.tabs.impact')}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel pt="xl" value="conventions">
          <ConventionsTab canWrite={permissions.includes('panel:write')} read={conventions} />
        </Tabs.Panel>
        <Tabs.Panel pt="xl" value="reconciliation">
          <ReconciliationTab read={reconciliation} />
        </Tabs.Panel>
        <Tabs.Panel pt="xl" value="impact">
          <ImpactTab
            initialKind={isKind(kind) ? kind : undefined}
            initialUuid={uuid !== null && UUID.test(uuid) ? uuid : undefined}
            key={`${kind ?? ''}:${uuid ?? ''}`}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
