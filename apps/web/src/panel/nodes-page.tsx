// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/nodes/ui/components/
// nodes.page.component.tsx (the strip of four metric cards, the header card with the icon-only actions, the datatable),
// src/widgets/dashboard/nodes/nodes-realtime-metrics/nodes-realtime-metrics.widget.tsx and src/widgets/dashboard/nodes/
// nodes-datatable/{nodes-datatable.widget.tsx,use-nodes-table-widget.tsx}. Changes: read-only (no cards view, no
// selection bar, no restart or create actions); the strip shows what the server reads from the panel (online nodes, nodes
// with a problem, users online, traffic used) instead of the live speeds, which the console does not read; the columns
// are those of `PanelNodeView`.
import { Badge, Group, SimpleGrid, Stack } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconRefresh } from '@tabler/icons-react';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HiServer } from 'react-icons/hi';
import { PiArrowsDownUpDuotone, PiPulse, PiUsersDuotone, PiWarningCircle } from 'react-icons/pi';
import { TbEye } from 'react-icons/tb';
import { ActionIcon, MultiSelect, Text } from '@mantine/core';

import { PANEL_NODE_STATES, type PanelNodeState, type PanelNodeView } from '@swellwright/contracts';
import {
  CountryFlag,
  type DataTableColumn,
  EllipsisCell,
  HeaderAction,
  HeaderActions,
  MetricCard,
  PageHeader,
  SelectFilter,
  TextSearchFilter,
} from '@swellwright/ui';

import { useCountries } from '../fleet/countries.js';
import { useBytes, useNumber } from '../format.js';
import { NodeDrawer } from './node-drawer.js';
import { PanelBoundary } from './panel-data.js';
import { PanelDataTable } from './panel-datatable.js';
import { formatDuration, nodeStateAppearance, NodeStateIcon, orDash } from './panel-format.js';
import { useNodesRead, useProfilesRead } from './panel-reads.js';

/** Bump the number when the columns change: a width or an order kept for other columns would not fit. */
const NODES_CACHE_KEY = 'panel-nodes-datatable-v1';

type TextKey = 'name';
type SelectKey = 'profile' | 'inbound' | 'provider' | 'tags';

interface Filters {
  text: Record<string, string>;
  select: Record<string, string[]>;
  states: PanelNodeState[];
  setText: (key: TextKey, value: string) => void;
  setSelect: (key: SelectKey, value: string[]) => void;
  setStates: (value: PanelNodeState[]) => void;
}

/** The four cards above the list, with the panel's breakpoints and entrance. */
function NodesMetrics({
  nodes,
  isLoading,
}: {
  /** Undefined while the nodes are not there (still loading, or the panel could not be read): the cards show a dash. */
  nodes: PanelNodeView[] | undefined;
  isLoading: boolean;
}) {
  const { t } = useTranslation('panel');
  const bytes = useBytes();
  const known = nodes ?? [];
  const online = known.filter((node) => node.state === 'online').length;
  const trouble = known.filter(
    (node) => node.state === 'offline' || node.state === 'connecting',
  ).length;
  const users = known.reduce((sum, node) => sum + (node.usersOnline ?? 0), 0);
  const traffic = known.reduce((sum, node) => sum + (node.traffic.usedBytes ?? 0), 0);
  const dash = '–';

  const cards = [
    {
      icon: PiPulse,
      iconColor: 'teal',
      title: t('nodes.metrics.online'),
      value: nodes === undefined ? dash : `${String(online)} / ${String(known.length)}`,
    },
    {
      icon: PiWarningCircle,
      iconColor: trouble > 0 ? 'red' : 'gray',
      title: t('nodes.metrics.trouble'),
      value: nodes === undefined ? dash : String(trouble),
    },
    {
      icon: PiUsersDuotone,
      iconColor: 'cyan',
      title: t('nodes.metrics.users'),
      value: nodes === undefined ? dash : String(users),
    },
    {
      icon: PiArrowsDownUpDuotone,
      iconColor: 'indigo',
      title: t('nodes.metrics.traffic'),
      value: nodes === undefined ? dash : bytes(traffic),
    },
  ];

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, sm: 2, xl: 4 }} spacing="xs">
      {cards.map((card, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          initial={{ opacity: 0, y: 0 }}
          key={card.title}
          transition={{ duration: 0.15, delay: index * 0.03, ease: 'easeIn' }}
        >
          <MetricCard
            icon={card.icon}
            iconColor={card.iconColor}
            isLoading={isLoading}
            title={card.title}
            value={card.value}
          />
        </motion.div>
      ))}
    </SimpleGrid>
  );
}

const sorted = <T,>(items: readonly T[], by: (item: T) => string): T[] =>
  [...items].sort((a, b) => by(a).localeCompare(by(b)));

/** The Nodes page of the panel, over what the connected panel reports. */
export function PanelNodesPage() {
  const { t } = useTranslation(['panel', 'common']);
  const nodes = useNodesRead();
  const profiles = useProfilesRead();
  const [opened, setOpened] = useState<PanelNodeView | undefined>(undefined);

  const profileNames = useMemo(
    () =>
      new Map(
        (profiles.query.data?.configProfiles ?? []).map((profile) => [profile.uuid, profile.name]),
      ),
    [profiles.query.data],
  );

  return (
    <>
      <Stack>
        <NodesMetrics isLoading={nodes.query.isPending} nodes={nodes.query.data?.nodes} />
        <PageHeader
          actions={
            <HeaderActions>
              <HeaderAction
                icon={IconRefresh}
                label={t('common:refresh')}
                loading={nodes.refreshing || nodes.query.isFetching}
                onClick={() => void nodes.refresh()}
              />
            </HeaderActions>
          }
          icon={<HiServer size={24} />}
          title={t('panel:nodes.title')}
        />
      </Stack>

      <PanelBoundary query={nodes.query}>
        {(data) => <NodesTable nodes={data.nodes} onOpen={setOpened} profileNames={profileNames} />}
      </PanelBoundary>

      <NodeDrawer
        node={opened}
        onClose={() => {
          setOpened(undefined);
        }}
        profileNames={profileNames}
      />
    </>
  );
}

function NodesTable({
  nodes,
  profileNames,
  onOpen,
}: {
  nodes: PanelNodeView[];
  profileNames: ReadonlyMap<string, string>;
  onOpen: (node: PanelNodeView) => void;
}) {
  const { t } = useTranslation(['panel', 'common']);
  const formatBytes = useBytes();
  const formatNumber = useNumber();
  const { nameOf } = useCountries();

  const [textQueries, setTextQueries] = useState<Record<string, string>>({});
  const [debouncedText] = useDebouncedValue(textQueries, 200);
  const [selectFilters, setSelectFilters] = useState<Record<string, string[]>>({});
  const [states, setStates] = useState<PanelNodeState[]>([]);

  const filters: Filters = {
    text: textQueries,
    select: selectFilters,
    states,
    setText: (key, value) => {
      setTextQueries((previous) => ({ ...previous, [key]: value }));
    },
    setSelect: (key, value) => {
      setSelectFilters((previous) => ({ ...previous, [key]: value }));
    },
    setStates,
  };

  const options = useMemo(() => {
    const asOptions = (values: Iterable<string>) =>
      [...new Set(values)].sort().map((value) => ({ label: value, value }));
    return {
      profile: sorted(
        [...new Set(nodes.map((node) => node.configProfile.uuid).filter((id) => id !== null))],
        (id) => profileNames.get(id) ?? id,
      ).map((id) => ({ label: profileNames.get(id) ?? id, value: id })),
      inbound: asOptions(
        nodes.flatMap((node) => node.configProfile.inbounds.map((inbound) => inbound.tag)),
      ),
      provider: asOptions(
        nodes.flatMap((node) => (node.provider === null ? [] : [node.provider.name])),
      ),
      tags: asOptions(nodes.flatMap((node) => node.tags)),
    };
  }, [nodes, profileNames]);

  const visible = useMemo(() => {
    const nameQuery = (debouncedText['name'] ?? '').toLowerCase();
    return nodes.filter((node) => {
      if (nameQuery && !node.name.toLowerCase().includes(nameQuery)) {
        return false;
      }
      if (states.length > 0 && !states.includes(node.state)) {
        return false;
      }
      const profile = selectFilters['profile'] ?? [];
      if (
        profile.length > 0 &&
        (node.configProfile.uuid === null || !profile.includes(node.configProfile.uuid))
      ) {
        return false;
      }
      const inbound = selectFilters['inbound'] ?? [];
      if (
        inbound.length > 0 &&
        !node.configProfile.inbounds.some((candidate) => inbound.includes(candidate.tag))
      ) {
        return false;
      }
      const provider = selectFilters['provider'] ?? [];
      if (
        provider.length > 0 &&
        (node.provider === null || !provider.includes(node.provider.name))
      ) {
        return false;
      }
      const tags = selectFilters['tags'] ?? [];
      if (tags.length > 0 && !tags.some((tag) => node.tags.includes(tag))) {
        return false;
      }
      return true;
    });
  }, [nodes, debouncedText, selectFilters, states]);

  const selectFilter = (key: SelectKey, label: string) => ({
    filter: (
      <SelectFilter
        data={options[key]}
        label={label}
        onChange={(value) => {
          filters.setSelect(key, value);
        }}
        value={filters.select[key] ?? []}
      />
    ),
    filtering: (filters.select[key] ?? []).length > 0,
  });

  const columns: DataTableColumn<PanelNodeView>[] = [
    {
      accessor: 'name',
      title: t('panel:nodes.columns.name'),
      sortable: true,
      draggable: false,
      resizable: true,
      toggleable: false,
      filter: (
        <TextSearchFilter
          clearLabel={t('common:clear')}
          label={t('panel:nodes.columns.name')}
          onChange={(value) => {
            filters.setText('name', value);
          }}
          value={filters.text['name'] ?? ''}
        />
      ),
      filtering: (filters.text['name'] ?? '') !== '',
      render: ({ name, countryCode }) => (
        <Group gap={6} wrap="nowrap">
          <CountryFlag code={countryCode} label={nameOf(countryCode)} />
          <Text
            size="sm"
            style={{
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </Text>
        </Group>
      ),
    },
    {
      accessor: 'state',
      title: '',
      sortable: true,
      filter: (
        <MultiSelect<PanelNodeState>
          clearable
          comboboxProps={{ withinPortal: false }}
          data={PANEL_NODE_STATES.map((value) => ({
            label: t(`panel:nodes.states.${value}`),
            value,
          }))}
          label={t('panel:nodes.columns.status')}
          onChange={filters.setStates}
          renderOption={({ option }) => {
            const { Icon, glyph } = nodeStateAppearance(option.value);
            return (
              <Group gap="xs" wrap="nowrap">
                <Icon size={16} style={{ color: glyph }} />
                <Text size="sm">{option.label}</Text>
              </Group>
            );
          }}
          searchable
          value={filters.states}
        />
      ),
      filtering: filters.states.length > 0,
      render: ({ state }) => <NodeStateIcon state={state} />,
    },
    {
      accessor: 'usersOnline',
      title: t('panel:nodes.columns.online'),
      sortable: true,
      render: ({ usersOnline }) => (
        <Badge
          color={(usersOnline ?? 0) > 0 ? 'teal' : 'gray'}
          leftSection={<PiUsersDuotone size={14} />}
          miw="10ch"
          size="lg"
          variant="outline"
        >
          {usersOnline === null ? '–' : formatNumber(usersOnline)}
        </Badge>
      ),
    },
    {
      accessor: 'address',
      title: t('panel:nodes.columns.address'),
      sortable: true,
      render: ({ address, port }) => (
        <EllipsisCell>{port === null ? address : `${address}:${String(port)}`}</EllipsisCell>
      ),
    },
    {
      accessor: 'ips',
      title: t('panel:nodes.columns.ips'),
      render: ({ ips }) => (
        <EllipsisCell>{ips.length === 0 ? '–' : ips.map((ip) => ip.ip).join(', ')}</EllipsisCell>
      ),
    },
    {
      accessor: 'traffic.usedBytes',
      title: t('panel:nodes.columns.trafficUsed'),
      sortable: true,
      render: ({ traffic }) => (
        <EllipsisCell>
          {traffic.usedBytes === null ? '–' : formatBytes(traffic.usedBytes)}
        </EllipsisCell>
      ),
    },
    {
      accessor: 'configProfile.uuid',
      title: t('panel:nodes.columns.profile'),
      ...selectFilter('profile', t('panel:nodes.columns.profile')),
      render: ({ configProfile }) => (
        <EllipsisCell>
          {configProfile.uuid === null
            ? '–'
            : (profileNames.get(configProfile.uuid) ?? configProfile.uuid)}
        </EllipsisCell>
      ),
    },
    {
      accessor: 'configProfile.inbounds',
      title: t('panel:nodes.columns.inbounds'),
      ...selectFilter('inbound', t('panel:nodes.columns.inbounds')),
      render: ({ configProfile }) => (
        <EllipsisCell>
          {configProfile.inbounds.length === 0
            ? '–'
            : sorted(configProfile.inbounds, (inbound) => inbound.tag)
                .map((inbound) => inbound.tag)
                .join(', ')}
        </EllipsisCell>
      ),
    },
    {
      accessor: 'consumptionMultiplier',
      title: t('panel:nodes.columns.consumption'),
      defaultToggle: false,
      render: ({ consumptionMultiplier }) => (
        <EllipsisCell>{consumptionMultiplier.toFixed(1)}</EllipsisCell>
      ),
    },
    {
      accessor: 'nodeConsumptionMultiplier',
      title: t('panel:nodes.columns.nodeConsumption'),
      defaultToggle: false,
      render: ({ nodeConsumptionMultiplier }) => (
        <EllipsisCell>{nodeConsumptionMultiplier.toFixed(1)}</EllipsisCell>
      ),
    },
    {
      accessor: 'xrayVersion',
      title: t('panel:nodes.columns.xray'),
      sortable: true,
      render: ({ xrayVersion }) => <EllipsisCell>{orDash(xrayVersion)}</EllipsisCell>,
    },
    {
      accessor: 'xrayUptimeSeconds',
      title: t('panel:nodes.columns.xrayUptime'),
      sortable: true,
      render: ({ xrayUptimeSeconds }) => (
        <EllipsisCell>{formatDuration(xrayUptimeSeconds)}</EllipsisCell>
      ),
    },
    {
      accessor: 'nodeVersion',
      title: t('panel:nodes.columns.node'),
      sortable: true,
      render: ({ nodeVersion }) => <EllipsisCell>{orDash(nodeVersion)}</EllipsisCell>,
    },
    {
      accessor: 'provider.name',
      title: t('panel:nodes.columns.provider'),
      sortable: true,
      ...selectFilter('provider', t('panel:nodes.columns.provider')),
      render: ({ provider }) => (
        <EllipsisCell>{provider === null ? '–' : provider.name}</EllipsisCell>
      ),
    },
    {
      accessor: 'tags',
      title: t('panel:nodes.columns.tags'),
      sortable: true,
      ...selectFilter('tags', t('panel:nodes.columns.tags')),
      render: ({ tags }) => (
        <EllipsisCell>{tags.length === 0 ? '–' : tags.join(', ')}</EllipsisCell>
      ),
    },
    {
      accessor: 'system.cpus',
      title: t('panel:nodes.columns.cpus'),
      sortable: true,
      defaultToggle: false,
      render: ({ system }) => <EllipsisCell>{orDash(system?.cpus)}</EllipsisCell>,
    },
    {
      accessor: 'system.memoryUsed',
      title: t('panel:nodes.columns.ramUsed'),
      sortable: true,
      defaultToggle: false,
      render: ({ system }) => (
        <EllipsisCell>
          {system?.memoryUsed === null || system?.memoryUsed === undefined
            ? '–'
            : formatBytes(system.memoryUsed)}
        </EllipsisCell>
      ),
    },
    {
      accessor: 'system.memoryTotal',
      title: t('panel:nodes.columns.ramTotal'),
      sortable: true,
      defaultToggle: false,
      render: ({ system }) => (
        <EllipsisCell>
          {system?.memoryTotal === null || system?.memoryTotal === undefined
            ? '–'
            : formatBytes(system.memoryTotal)}
        </EllipsisCell>
      ),
    },
    {
      accessor: 'system.uptimeSeconds',
      title: t('panel:nodes.columns.serverUptime'),
      sortable: true,
      defaultToggle: false,
      render: ({ system }) => <EllipsisCell>{formatDuration(system?.uptimeSeconds)}</EllipsisCell>,
    },
    {
      accessor: 'system.release',
      title: t('panel:nodes.columns.release'),
      sortable: true,
      defaultToggle: false,
      render: ({ system }) => <EllipsisCell>{orDash(system?.release)}</EllipsisCell>,
    },
    {
      accessor: 'actions',
      draggable: false,
      resizable: false,
      toggleable: false,
      titleStyle: { backgroundColor: 'var(--mantine-color-dark-7)' },
      cellsStyle: () => ({ backgroundColor: 'var(--mantine-color-dark-7)' }),
      title: (
        <Group c="dimmed" gap={4} justify="flex-end" pr={4} wrap="nowrap">
          <TbEye aria-label={t('panel:nodes.open')} size={18} />
        </Group>
      ),
      textAlign: 'right',
      render: (node) => (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          <ActionIcon
            aria-label={t('panel:nodes.openNamed', { name: node.name })}
            color="teal"
            onClick={(event) => {
              // The row opens the same drawer; do not open it twice.
              event.stopPropagation();
              onOpen(node);
            }}
            size="md"
            variant="outline"
          >
            <TbEye size={18} />
          </ActionIcon>
        </Group>
      ),
    },
  ];

  return (
    <PanelDataTable
      cacheKey={NODES_CACHE_KEY}
      columns={columns}
      defaultSort={{ columnAccessor: 'name', direction: 'asc' }}
      emptyText={t('panel:nodes.empty')}
      height="55vh"
      extraLabels={{ state: t('panel:nodes.columns.status') }}
      onOpen={onOpen}
      records={visible}
    />
  );
}
