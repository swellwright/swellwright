// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/_modals/hosts/edit-host-modal/
// {edit-host.modal.tsx,edit-host.modal.content.tsx} and src/shared/ui/forms/hosts/base-host-form/{base-host-form.tsx,
// host-visibility.tsx,options/options.section.tsx,options/option-field.tsx,options/host-option-fields.tsx}, the drawer that
// opens a host: a card with the visibility of the host, its remark, inbound, address and port, and an Options card that
// shows only the options that are set, in the panel's six groups (a divider with the group's name, then the fields).
// Changes: read-only (every input is disabled, there is no footer with the save, clone and delete buttons); the inbound is
// shown by the names of its profile and inbound; the JSON options are read-only code viewers with the secrets masked.
import {
  ActionIcon,
  Card,
  Divider,
  Group,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { PiListChecks, PiProhibit, PiPulse } from 'react-icons/pi';
import { TbAlertTriangle, TbBraces, TbEyeOff } from 'react-icons/tb';

import type { PanelHostView } from '@swellwright/contracts';
import { OverlayHeader, SectionCard } from '@swellwright/ui';

import { PreviewImpactButton } from '../checks/preview-impact.js';
import { CodeEditor } from '../commands/code-editor.js';
import type { PanelNames } from './host-lookups.js';
import { jsonText } from './code-viewer.js';
import { PanelDrawer } from './panel-drawer.js';

type Group6 = 'assignment' | 'security' | 'transport' | 'subscription' | 'advanced' | 'client';

/** The names of the options in the catalogue (`hosts.options`). */
type OptionKey =
  | 'tags'
  | 'nodes'
  | 'internalSquads'
  | 'sni'
  | 'overrideSniFromAddress'
  | 'keepSniBlank'
  | 'securityLayer'
  | 'fingerprint'
  | 'vlessRouteId'
  | 'host'
  | 'path'
  | 'alpn'
  | 'serverDescription'
  | 'excludeFromSubscriptionTypes'
  | 'includeInSrrRules'
  | 'isHidden'
  | 'shuffleHost'
  | 'xrayJsonTemplate'
  | 'mapper'
  | 'muxParams'
  | 'finalMask'
  | 'xhttpExtraParams'
  | 'sockoptParams'
  | 'pinnedPeerCertSha256'
  | 'verifyPeerCertByName'
  | 'mihomoX25519'
  | 'mihomoIpVersion';

type Option =
  | { group: Group6; key: OptionKey; kind: 'text'; value: string }
  | { group: Group6; key: OptionKey; kind: 'tags'; value: string[] }
  | { group: Group6; key: OptionKey; kind: 'switch'; value: boolean }
  | { group: Group6; key: OptionKey; kind: 'json'; value: unknown };

const GROUPS: readonly Group6[] = [
  'assignment',
  'security',
  'transport',
  'subscription',
  'advanced',
  'client',
];

/** `null`, an empty text and an empty list are an option that is not set; the panel shows only the options that are. */
const isFilled = (value: unknown): boolean =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0) &&
  !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

/** The options of a host that are set, in the panel's order and groups (`HOST_OPTION_FIELDS`). */
function optionsOf(host: PanelHostView, names: PanelNames): Option[] {
  const of = (map: ReadonlyMap<string, string>, id: string) => map.get(id) ?? id;
  const all: (Option | null)[] = [
    { group: 'assignment', key: 'tags', kind: 'tags', value: host.tags },
    {
      group: 'assignment',
      key: 'nodes',
      kind: 'tags',
      value: host.nodeUuids.map((id) => of(names.nodes, id)),
    },
    {
      group: 'assignment',
      key: 'internalSquads',
      kind: 'tags',
      value: host.internalSquads.squadUuids.map((id) => of(names.internalSquads, id)),
    },
    { group: 'security', key: 'sni', kind: 'text', value: host.sni ?? '' },
    {
      group: 'security',
      key: 'overrideSniFromAddress',
      kind: 'switch',
      value: host.overrideSniFromAddress,
    },
    { group: 'security', key: 'keepSniBlank', kind: 'switch', value: host.keepSniBlank },
    { group: 'security', key: 'securityLayer', kind: 'text', value: host.securityLayer },
    { group: 'security', key: 'fingerprint', kind: 'text', value: host.fingerprint ?? '' },
    {
      group: 'transport',
      key: 'vlessRouteId',
      kind: 'text',
      value: host.vlessRouteId === null ? '' : String(host.vlessRouteId),
    },
    { group: 'transport', key: 'host', kind: 'text', value: host.host ?? '' },
    { group: 'transport', key: 'path', kind: 'text', value: host.path ?? '' },
    { group: 'transport', key: 'alpn', kind: 'text', value: host.alpn ?? '' },
    {
      group: 'subscription',
      key: 'serverDescription',
      kind: 'text',
      value: host.serverDescription ?? '',
    },
    {
      group: 'subscription',
      key: 'excludeFromSubscriptionTypes',
      kind: 'tags',
      value: host.excludeFromSubscriptionTypes,
    },
    {
      group: 'subscription',
      key: 'includeInSrrRules',
      kind: 'tags',
      value: host.includeInSrrRules,
    },
    { group: 'subscription', key: 'isHidden', kind: 'switch', value: host.isHidden },
    { group: 'subscription', key: 'shuffleHost', kind: 'switch', value: host.shuffleHost },
    {
      group: 'advanced',
      key: 'xrayJsonTemplate',
      kind: 'text',
      value:
        host.xrayJsonTemplateUuid === null ? '' : of(names.templates, host.xrayJsonTemplateUuid),
    },
    { group: 'advanced', key: 'mapper', kind: 'json', value: host.mapper },
    { group: 'advanced', key: 'muxParams', kind: 'json', value: host.muxParams },
    { group: 'advanced', key: 'finalMask', kind: 'json', value: host.finalMask },
    { group: 'advanced', key: 'xhttpExtraParams', kind: 'json', value: host.xhttpExtraParams },
    { group: 'advanced', key: 'sockoptParams', kind: 'json', value: host.sockoptParams },
    {
      group: 'client',
      key: 'pinnedPeerCertSha256',
      kind: 'text',
      value: host.pinnedPeerCertSha256 ?? '',
    },
    {
      group: 'client',
      key: 'verifyPeerCertByName',
      kind: 'text',
      value: host.verifyPeerCertByName ?? '',
    },
    { group: 'client', key: 'mihomoX25519', kind: 'switch', value: host.mihomoX25519 },
    { group: 'client', key: 'mihomoIpVersion', kind: 'text', value: host.mihomoIpVersion ?? '' },
  ];
  // A switch that is off is not set, as a list that is empty; the host's visibility has its own row above.
  return all.filter(
    (option): option is Option =>
      option !== null && (option.kind === 'switch' ? option.value : isFilled(option.value)),
  );
}

function OptionField({ option }: { option: Option }) {
  const { t } = useTranslation('panel');
  const label = t(`hosts.options.${option.key}`);
  switch (option.kind) {
    case 'text':
      return <TextInput disabled label={label} value={option.value} />;
    case 'tags':
      return <TagsInput disabled label={label} value={option.value} />;
    case 'switch':
      return <Switch checked color="teal.8" disabled label={label} size="md" />;
    case 'json':
      return (
        <Stack gap={4}>
          <Text fw={500} size="sm">
            {label}
          </Text>
          <CodeEditor height="220px" label={label} readOnly value={jsonText(option.value)} />
        </Stack>
      );
  }
}

/**
 * The inbound of a host as the panel's form shows it (`HostSelectInboundFeature`): a card with a teal soft icon, the name of
 * the config profile in monospace and, under it, the tag of the inbound. The panel opens a picker from it; here it only reads.
 */
function InboundCard({ host, names }: { host: PanelHostView; names: PanelNames }) {
  const { t } = useTranslation('panel');
  const profile =
    host.inbound.configProfileUuid === null
      ? undefined
      : (names.profiles.get(host.inbound.configProfileUuid) ?? host.inbound.configProfileUuid);
  const inbound =
    host.inbound.configProfileInboundUuid === null
      ? undefined
      : (names.inbounds.get(host.inbound.configProfileInboundUuid) ??
        host.inbound.configProfileInboundUuid);
  const has = profile !== undefined && inbound !== undefined;
  return (
    <Card p="md" radius="md" withBorder>
      <Group gap="sm" wrap="nowrap">
        <ActionIcon
          aria-hidden
          color={has ? 'teal' : 'gray'}
          component="div"
          size="lg"
          variant="light"
        >
          {has ? <TbBraces size={22} /> : <TbAlertTriangle size={20} />}
        </ActionIcon>
        <Stack gap={0} miw={0}>
          <Text {...(has ? { ff: 'monospace' } : {})} fw={600} size="sm" truncate>
            {has ? profile : t('hosts.drawer.noInbound')}
          </Text>
          {has ? (
            <Text c="dimmed" fw={500} size="xs" truncate>
              {inbound}
            </Text>
          ) : null}
        </Stack>
      </Group>
    </Card>
  );
}

function HostBody({ host, names }: { host: PanelHostView; names: PanelNames }) {
  const { t } = useTranslation(['panel', 'common', 'checks']);
  const enabled = !host.isDisabled;
  const options = optionsOf(host, names);

  return (
    <Stack>
      <PreviewImpactButton
        kind="host"
        label={t('checks:ui.impact.previewImpact')}
        uuid={host.uuid}
      />
      <SectionCard.Root>
        <SectionCard.Section>
          <Group gap="sm" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon color={enabled ? 'teal' : 'gray'} size="lg" variant="soft">
                {enabled ? <PiPulse size={22} /> : <PiProhibit size={22} />}
              </ThemeIcon>
              <Stack gap={0}>
                <Text fw={600} size="sm">
                  {t('panel:hosts.drawer.visibility')}
                </Text>
                <Text c={enabled ? 'teal.4' : 'dimmed'} fw={600} size="xs">
                  {enabled ? t('panel:hosts.statuses.enabled') : t('panel:hosts.statuses.disabled')}
                </Text>
              </Stack>
            </Group>
            {host.isHidden ? (
              <Group c="violet.4" gap={6} wrap="nowrap">
                <TbEyeOff size={18} />
                <Text c="violet.4" fw={600} size="xs">
                  {t('panel:hosts.statuses.hidden')}
                </Text>
              </Group>
            ) : null}
          </Group>
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:hosts.fields.remark')} value={host.remark} />
            <InboundCard host={host} names={names} />
            <Group gap="xs" grow justify="space-between" preventGrowOverflow={false} w="100%">
              <TextInput
                disabled
                label={t('panel:hosts.fields.address')}
                value={host.address}
                w="65%"
              />
              <TextInput
                disabled
                label={t('panel:hosts.fields.port')}
                value={String(host.port)}
                w="30%"
              />
            </Group>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root allDividers={false}>
        <SectionCard.Section>
          <Stack gap="md">
            <OverlayHeader
              icon={PiListChecks}
              iconColor="teal"
              iconSize={18}
              title={t('panel:hosts.drawer.options')}
              titleOrder={5}
            />
            <Divider style={{ opacity: 0.3 }} />
          </Stack>
        </SectionCard.Section>
        <SectionCard.Section>
          {options.length === 0 ? (
            <Text c="dimmed" size="sm" ta="center">
              {t('panel:hosts.drawer.noOptions')}
            </Text>
          ) : (
            <Stack gap="md">
              {GROUPS.map((group) => {
                const inGroup = options.filter((option) => option.group === group);
                if (inGroup.length === 0) {
                  return null;
                }
                return (
                  <Stack gap="md" key={group}>
                    <Divider label={t(`panel:hosts.groups.${group}`)} labelPosition="left" />
                    {inGroup.map((option) => (
                      <OptionField key={option.key} option={option} />
                    ))}
                  </Stack>
                );
              })}
            </Stack>
          )}
        </SectionCard.Section>
      </SectionCard.Root>
    </Stack>
  );
}

/** The read-only drawer of a host. */
export function HostDrawer({
  host,
  names,
  onClose,
}: {
  host: PanelHostView | undefined;
  names: PanelNames;
  onClose: () => void;
}) {
  return (
    <PanelDrawer
      header={(item) => ({ icon: PiListChecks, title: item.remark, subtitle: item.uuid })}
      item={host}
      onClose={onClose}
    >
      {(item) => <HostBody host={item} names={names} />}
    </PanelDrawer>
  );
}
