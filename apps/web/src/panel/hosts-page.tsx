// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/hosts/ui/components/
// hosts.page.component.tsx and src/widgets/dashboard/hosts/hosts-datatable/{hosts-datatable.widget.tsx,
// use-hosts-table-widget.tsx}: the header card with the icon-only actions and the page-level datatable whose columns come
// from three lists of fields (text, select and yes/no), each with its own filter, most of them hidden until asked for.
// Changes: read-only (no cards view, no selection bar, no create or edit actions: a click on a row opens a drawer with
// disabled fields); the names behind uuids (profiles, inbounds, nodes, squads, templates) come from the console's reads of
// those objects; the texts come from the console's catalogue.
import { ActionIcon, Group, MultiSelect, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconRefresh } from '@tabler/icons-react';
import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiListChecks } from 'react-icons/pi';
import { TbEye, TbSearch } from 'react-icons/tb';

import type { PanelHostView } from '@swellwright/contracts';
import {
  BooleanCell,
  type BooleanFilterValue,
  BooleanFilterControl,
  type DataTableColumn,
  EllipsisCell,
  HeaderAction,
  HeaderActions,
  PageHeader,
  SelectFilter,
  TextSearchFilter,
} from '@swellwright/ui';

import { type PanelNames, usePanelNames } from './host-lookups.js';
import { HostDrawer } from './host-drawer.js';
import { PanelBoundary } from './panel-data.js';
import { PanelDataTable } from './panel-datatable.js';
import { type HostStatus, StatusGlyph } from './panel-format.js';
import { useHostsRead } from './panel-reads.js';

/** Bump the number when the columns change: a width or an order kept for other columns would not fit. */
const HOSTS_CACHE_KEY = 'panel-hosts-datatable-v1';

type PanelT = TFunction<['panel', 'common']>;
const statusOf = (host: PanelHostView): HostStatus =>
  host.isDisabled ? 'disabled' : host.isHidden ? 'hidden' : 'enabled';

/** A JSON part of a host that is set: the panel keeps `null` for nothing. */
const isSet = (value: unknown): boolean => value !== null && value !== undefined;

interface TextField {
  accessor: string;
  key: string;
  label: string;
  value: (host: PanelHostView) => null | number | string | undefined;
  hidden?: boolean;
  primary?: boolean;
}

interface SelectField {
  accessor: string;
  key: string;
  label: string;
  values: (host: PanelHostView) => string[];
  /** What a value is called; the value itself when the object is not known. */
  name?: (value: string) => string;
  hidden?: boolean;
  sortable?: boolean;
}

interface BooleanField {
  accessor: string;
  key: string;
  label: string;
  value: (host: PanelHostView) => boolean;
  hidden?: boolean;
  sortable?: boolean;
}

function textFields(t: PanelT): TextField[] {
  return [
    {
      accessor: 'remark',
      key: 'remark',
      label: t('panel:hosts.fields.remark'),
      value: (h) => h.remark,
      primary: true,
    },
    {
      accessor: 'address',
      key: 'address',
      label: t('panel:hosts.fields.address'),
      value: (h) => h.address,
    },
    { accessor: 'port', key: 'port', label: t('panel:hosts.fields.port'), value: (h) => h.port },
    { accessor: 'sni', key: 'sni', label: 'SNI', value: (h) => h.sni },
    {
      accessor: 'host',
      key: 'host',
      label: t('panel:hosts.fields.host'),
      value: (h) => h.host,
      hidden: true,
    },
    {
      accessor: 'path',
      key: 'path',
      label: t('panel:hosts.fields.path'),
      value: (h) => h.path,
      hidden: true,
    },
    {
      accessor: 'serverDescription',
      key: 'serverDescription',
      label: t('panel:hosts.fields.serverDescription'),
      value: (h) => h.serverDescription,
      hidden: true,
    },
    {
      accessor: 'vlessRouteId',
      key: 'vlessRouteId',
      label: 'VLESS Route ID',
      value: (h) => h.vlessRouteId,
      hidden: true,
    },
    {
      accessor: 'pinnedPeerCertSha256',
      key: 'pinnedPeerCertSha256',
      label: t('panel:hosts.fields.pinnedPeerCert'),
      value: (h) => h.pinnedPeerCertSha256,
      hidden: true,
    },
    {
      accessor: 'verifyPeerCertByName',
      key: 'verifyPeerCertByName',
      label: t('panel:hosts.fields.verifyPeerCertByName'),
      value: (h) => h.verifyPeerCertByName,
      hidden: true,
    },
  ];
}

function selectFields(t: PanelT, names: PanelNames): SelectField[] {
  const nameFrom = (map: ReadonlyMap<string, string>) => (value: string) => map.get(value) ?? value;
  return [
    {
      accessor: 'inbound.configProfileUuid',
      key: 'configProfile',
      label: t('panel:hosts.fields.profile'),
      values: (h) => (h.inbound.configProfileUuid === null ? [] : [h.inbound.configProfileUuid]),
      name: nameFrom(names.profiles),
    },
    {
      accessor: 'inbound.configProfileInboundUuid',
      key: 'inbound',
      label: t('panel:hosts.fields.inbound'),
      values: (h) =>
        h.inbound.configProfileInboundUuid === null ? [] : [h.inbound.configProfileInboundUuid],
      name: nameFrom(names.inbounds),
    },
    {
      accessor: 'tags',
      key: 'tags',
      label: t('panel:hosts.fields.tags'),
      values: (h) => h.tags,
      sortable: true,
    },
    {
      accessor: 'securityLayer',
      key: 'securityLayer',
      label: t('panel:hosts.fields.securityLayer'),
      values: (h) => (h.securityLayer ? [h.securityLayer] : []),
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'alpn',
      key: 'alpn',
      label: 'ALPN',
      values: (h) => (h.alpn ? [h.alpn] : []),
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'fingerprint',
      key: 'fingerprint',
      label: t('panel:hosts.fields.fingerprint'),
      values: (h) => (h.fingerprint ? [h.fingerprint] : []),
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'mihomoIpVersion',
      key: 'mihomoIpVersion',
      label: 'Mihomo IP Version',
      values: (h) => (h.mihomoIpVersion ? [h.mihomoIpVersion] : []),
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'excludeFromSubscriptionTypes',
      key: 'excludeFromSubscriptionTypes',
      label: t('panel:hosts.fields.excludeFromSubscriptionTypes'),
      values: (h) => h.excludeFromSubscriptionTypes,
      hidden: true,
    },
    {
      accessor: 'nodeUuids',
      key: 'nodes',
      label: t('panel:hosts.fields.nodes'),
      values: (h) => h.nodeUuids,
      name: nameFrom(names.nodes),
      hidden: true,
    },
    {
      accessor: 'internalSquads.squadUuids',
      key: 'internalSquads',
      label: t('panel:hosts.fields.internalSquads'),
      values: (h) => h.internalSquads.squadUuids,
      name: nameFrom(names.internalSquads),
      hidden: true,
    },
    {
      accessor: 'internalSquads.mode',
      key: 'internalSquadsMode',
      label: t('panel:hosts.fields.overrideType'),
      values: (h) => (h.internalSquads.mode ? [h.internalSquads.mode] : []),
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'xrayJsonTemplateUuid',
      key: 'xrayJsonTemplate',
      label: t('panel:hosts.fields.xrayJsonTemplate'),
      values: (h) => (h.xrayJsonTemplateUuid === null ? [] : [h.xrayJsonTemplateUuid]),
      name: nameFrom(names.templates),
      hidden: true,
    },
  ];
}

function booleanFields(t: PanelT): BooleanField[] {
  return [
    {
      accessor: 'overrideSniFromAddress',
      key: 'overrideSniFromAddress',
      label: t('panel:hosts.fields.overrideSniFromAddress'),
      value: (h) => h.overrideSniFromAddress,
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'keepSniBlank',
      key: 'keepSniBlank',
      label: t('panel:hosts.fields.keepSniBlank'),
      value: (h) => h.keepSniBlank,
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'shuffleHost',
      key: 'shuffleHost',
      label: t('panel:hosts.fields.shuffleHost'),
      value: (h) => h.shuffleHost,
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'mihomoX25519',
      key: 'mihomoX25519',
      label: t('panel:hosts.fields.mihomoX25519'),
      value: (h) => h.mihomoX25519,
      hidden: true,
      sortable: true,
    },
    {
      accessor: 'finalMask',
      key: 'finalMask',
      label: 'Final Mask',
      value: (h) => isSet(h.finalMask),
      hidden: true,
    },
    {
      accessor: 'muxParams',
      key: 'muxParams',
      label: 'Mux Params',
      value: (h) => isSet(h.muxParams),
      hidden: true,
    },
    {
      accessor: 'sockoptParams',
      key: 'sockoptParams',
      label: 'Sockopt Params',
      value: (h) => isSet(h.sockoptParams),
      hidden: true,
    },
    {
      accessor: 'xhttpExtraParams',
      key: 'xhttpExtraParams',
      label: t('panel:hosts.fields.xhttpExtra'),
      value: (h) => isSet(h.xhttpExtraParams),
      hidden: true,
    },
  ];
}

/** The state the filters of the table keep. */
interface HostFilters {
  text: Record<string, string>;
  select: Record<string, string[]>;
  boolean: Record<string, BooleanFilterValue>;
  statuses: HostStatus[];
}

/** The Hosts page of the panel, over the hosts of the connected panel. */
export function PanelHostsPage() {
  const { t } = useTranslation(['panel', 'common']);
  const hosts = useHostsRead();
  const names = usePanelNames();
  const [opened, setOpened] = useState<PanelHostView | undefined>(undefined);

  return (
    <>
      <PageHeader
        actions={
          <HeaderActions>
            <HeaderAction
              icon={IconRefresh}
              label={t('common:refresh')}
              loading={hosts.refreshing || hosts.query.isFetching}
              onClick={() => void hosts.refresh()}
            />
          </HeaderActions>
        }
        icon={<PiListChecks size={24} />}
        title={t('panel:hosts.title')}
      />

      <PanelBoundary query={hosts.query}>
        {(data) => <HostsTable hosts={data.hosts} names={names} onOpen={setOpened} />}
      </PanelBoundary>

      <HostDrawer
        host={opened}
        names={names}
        onClose={() => {
          setOpened(undefined);
        }}
      />
    </>
  );
}

function HostsTable({
  hosts,
  names,
  onOpen,
}: {
  hosts: PanelHostView[];
  names: PanelNames;
  onOpen: (host: PanelHostView) => void;
}) {
  const { t } = useTranslation(['panel', 'common']);

  const [filters, setFilters] = useState<HostFilters>({
    text: {},
    select: {},
    boolean: {},
    statuses: [],
  });
  const [debouncedText] = useDebouncedValue(filters.text, 200);

  const texts = useMemo(() => textFields(t), [t]);
  const selects = useMemo(() => selectFields(t, names), [t, names]);
  const booleans = useMemo(() => booleanFields(t), [t]);

  const optionsFor = (field: SelectField): { label: string; value: string }[] => {
    const values = new Set(hosts.flatMap((host) => field.values(host)));
    return [...values]
      .map((value) => ({ label: field.name?.(value) ?? value, value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const visible = useMemo(
    () =>
      hosts.filter((host) => {
        for (const field of texts) {
          const query = (debouncedText[field.key] ?? '').toLowerCase();
          if (
            query &&
            !String(field.value(host) ?? '')
              .toLowerCase()
              .includes(query)
          ) {
            return false;
          }
        }
        for (const field of selects) {
          const chosen = filters.select[field.key] ?? [];
          if (chosen.length > 0 && !field.values(host).some((value) => chosen.includes(value))) {
            return false;
          }
        }
        for (const field of booleans) {
          const chosen = filters.boolean[field.key] ?? 'all';
          if (chosen !== 'all' && field.value(host) !== (chosen === 'yes')) {
            return false;
          }
        }
        return filters.statuses.length === 0 || filters.statuses.includes(statusOf(host));
      }),
    [
      hosts,
      texts,
      selects,
      booleans,
      debouncedText,
      filters.select,
      filters.boolean,
      filters.statuses,
    ],
  );

  const setText = (key: string, value: string) => {
    setFilters((previous) => ({ ...previous, text: { ...previous.text, [key]: value } }));
  };
  const setSelect = (key: string, value: string[]) => {
    setFilters((previous) => ({ ...previous, select: { ...previous.select, [key]: value } }));
  };
  const setBoolean = (key: string, value: BooleanFilterValue) => {
    setFilters((previous) => ({ ...previous, boolean: { ...previous.boolean, [key]: value } }));
  };

  const textColumn = (field: TextField): DataTableColumn<PanelHostView> => ({
    accessor: field.accessor,
    defaultToggle: field.hidden !== true,
    sortable: true,
    title: field.label,
    toggleable: field.primary !== true,
    ...(field.primary === true ? { draggable: false } : {}),
    filter: (
      <TextSearchFilter
        clearLabel={t('common:clear')}
        label={field.label}
        onChange={(value) => {
          setText(field.key, value);
        }}
        value={filters.text[field.key] ?? ''}
      />
    ),
    filtering: (filters.text[field.key] ?? '') !== '',
    render: (host) => <EllipsisCell>{String(field.value(host) ?? '–')}</EllipsisCell>,
  });

  const selectColumn = (field: SelectField): DataTableColumn<PanelHostView> => ({
    accessor: field.accessor,
    defaultToggle: field.hidden !== true,
    sortable: field.sortable === true,
    title: field.label,
    filter: (
      <SelectFilter
        data={optionsFor(field)}
        label={field.label}
        onChange={(value) => {
          setSelect(field.key, value);
        }}
        value={filters.select[field.key] ?? []}
      />
    ),
    filtering: (filters.select[field.key] ?? []).length > 0,
    render: (host) => {
      const labels = field.values(host).map((value) => field.name?.(value) ?? value);
      return <EllipsisCell>{labels.length > 0 ? labels.join(', ') : '–'}</EllipsisCell>;
    },
  });

  const booleanColumn = (field: BooleanField): DataTableColumn<PanelHostView> => ({
    accessor: field.accessor,
    defaultToggle: field.hidden !== true,
    sortable: field.sortable === true,
    textAlign: 'center',
    title: field.label,
    filter: (
      <BooleanFilterControl
        allLabel={t('common:datatable.all')}
        label={field.label}
        noLabel={t('common:no')}
        onChange={(value) => {
          setBoolean(field.key, value);
        }}
        value={filters.boolean[field.key] ?? 'all'}
        yesLabel={t('common:yes')}
      />
    ),
    filtering: (filters.boolean[field.key] ?? 'all') !== 'all',
    render: (host) => (
      <BooleanCell
        labels={{ yes: t('common:yes'), no: t('common:no') }}
        value={field.value(host)}
      />
    ),
  });

  const statusColumn: DataTableColumn<PanelHostView> = {
    accessor: 'isDisabled',
    sortable: true,
    title: '',
    toggleable: true,
    filter: (
      <MultiSelect<HostStatus>
        clearable
        comboboxProps={{ withinPortal: false }}
        data={(['disabled', 'enabled', 'hidden'] as const).map((value) => ({
          label: t(`panel:hosts.statuses.${value}`),
          value,
        }))}
        label={t('panel:hosts.fields.status')}
        leftSection={<TbSearch size={16} />}
        onChange={(statuses) => {
          setFilters((previous) => ({ ...previous, statuses }));
        }}
        renderOption={({ option }) => (
          <Group gap="xs" wrap="nowrap">
            <StatusGlyph status={option.value} />
            <Text size="sm">{option.label}</Text>
          </Group>
        )}
        searchable
        value={filters.statuses}
      />
    ),
    filtering: filters.statuses.length > 0,
    render: (host) => <StatusGlyph status={statusOf(host)} />,
  };

  const [remarkField, ...otherTexts] = texts;
  const columns: DataTableColumn<PanelHostView>[] = [
    ...(remarkField === undefined ? [] : [textColumn(remarkField)]),
    statusColumn,
    ...otherTexts.map(textColumn),
    ...selects.map(selectColumn),
    ...booleans.map(booleanColumn),
    {
      accessor: 'actions',
      cellsStyle: () => ({ backgroundColor: 'var(--mantine-color-dark-7)' }),
      draggable: false,
      resizable: false,
      textAlign: 'right',
      title: (
        <Group c="dimmed" gap={4} justify="flex-end" pr={4} wrap="nowrap">
          <TbEye aria-label={t('panel:hosts.open')} size={18} />
        </Group>
      ),
      titleStyle: { backgroundColor: 'var(--mantine-color-dark-7)' },
      toggleable: false,
      render: (host) => (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          <ActionIcon
            aria-label={t('panel:hosts.openNamed', { name: host.remark })}
            color="teal"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(host);
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
      cacheKey={HOSTS_CACHE_KEY}
      columns={columns}
      defaultSort={{ columnAccessor: 'remark', direction: 'asc' }}
      emptyText={t('panel:hosts.empty')}
      extraLabels={{ isDisabled: t('panel:hosts.fields.status') }}
      onOpen={onOpen}
      records={visible}
    />
  );
}
