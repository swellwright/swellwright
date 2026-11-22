// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/config-profiles/components/
// config-profile-by-uuid.page.component.tsx and src/widgets/dashboard/config-profiles/config-editor/
// config-editor.widget.tsx (the profile with its Xray configuration in a Monaco editor), src/shared/_modals/config-profiles/
// {config-profile-inbounds-drawer,active-nodes-modal} (the inbounds of a profile, the nodes it runs on: bordered cards with a
// flag and a name) and the "view computed" action of the card. Changes: a drawer instead of a page; read-only (the editor
// is a viewer with no save bar); the configuration comes masked from the server, which the card says; the computed
// configuration is a switch above the editor, read when it is asked for.
import {
  Badge,
  DataList,
  Group,
  SegmentedControl,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { Card } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCpu, PiTag } from 'react-icons/pi';
import { TbBraces, TbCode, TbCpu2 } from 'react-icons/tb';

import type { PanelConfigProfileSummary } from '@swellwright/contracts';
import {
  CopyableDataListItem,
  CountryFlag,
  LoaderModal,
  OverlayHeader,
  SectionCard,
} from '@swellwright/ui';

import { getPanelComputedConfig, getPanelConfigProfile } from '../api.js';
import { PreviewImpactButton } from '../checks/preview-impact.js';
import { useCountries } from '../fleet/countries.js';
import { useDateTime } from '../format.js';
import { ConfigViewerCard, jsonText } from './code-viewer.js';
import { PanelReadFailure, panelKey } from './panel-data.js';
import { PanelDrawer } from './panel-drawer.js';

type View = 'config' | 'computed';

function InboundRow({ inbound }: { inbound: PanelConfigProfileSummary['inbounds'][number] }) {
  const parts = [inbound.type, inbound.network, inbound.security].filter(
    (part): part is string => part !== null && part !== '',
  );
  return (
    <Card p="sm" withBorder>
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
    </Card>
  );
}

function ProfileBody({ profile }: { profile: PanelConfigProfileSummary }) {
  const { t } = useTranslation(['panel', 'common', 'checks']);
  const formatTime = useDateTime();
  const { nameOf } = useCountries();
  const [view, setView] = useState<View>('config');

  const detail = useQuery({
    queryKey: panelKey('config-profile', profile.uuid),
    queryFn: () => getPanelConfigProfile(profile.uuid),
    retry: false,
  });
  const computed = useQuery({
    queryKey: panelKey('config-profile', profile.uuid, 'computed'),
    queryFn: () => getPanelComputedConfig(profile.uuid),
    enabled: view === 'computed',
    retry: false,
  });

  const shown = view === 'computed' ? computed : detail;

  return (
    <Stack gap="md">
      <PreviewImpactButton
        kind="configProfile"
        label={t('checks:ui.impact.previewImpact')}
        uuid={profile.uuid}
      />
      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbBraces}
            iconColor="teal"
            iconSize={18}
            title={t('panel:profiles.drawer.overview')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:profiles.drawer.name')} value={profile.name} />
            <TagsInput disabled label={t('panel:profiles.drawer.tags')} value={profile.tags} />
            <DataList orientation="vertical" withDivider>
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:profiles.drawer.hash')}
                monospace
                value={profile.hash}
              />
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:profiles.drawer.created')}
                value={formatTime(profile.createdAt)}
              />
              <CopyableDataListItem
                copiedLabel={t('common:copied')}
                copyLabel={t('common:copy')}
                label={t('panel:profiles.drawer.updated')}
                value={formatTime(profile.updatedAt)}
              />
            </DataList>
            <Text c="dimmed" fz="xs">
              {t('panel:profiles.drawer.hashNote')}
            </Text>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiTag}
            iconColor="blue"
            iconSize={18}
            title={t('panel:profiles.drawer.inbounds', { count: profile.inbounds.length })}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          {profile.inbounds.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('panel:profiles.drawer.noInbounds')}
            </Text>
          ) : (
            <Stack gap="xs">
              {profile.inbounds.map((inbound) => (
                <InboundRow inbound={inbound} key={inbound.uuid} />
              ))}
            </Stack>
          )}
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiCpu}
            iconColor="teal"
            iconSize={18}
            title={t('panel:profiles.drawer.nodes', { count: profile.nodeCount })}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          {profile.nodes.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('panel:profiles.drawer.noNodes')}
            </Text>
          ) : (
            <Stack gap="xs">
              {profile.nodes.map((node) => (
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

      <ConfigViewerCard
        actions={
          <SegmentedControl
            data={[
              { value: 'config', label: t('panel:profiles.drawer.configuration') },
              { value: 'computed', label: t('panel:profiles.drawer.computed') },
            ]}
            onChange={(value) => {
              setView(value === 'computed' ? 'computed' : 'config');
            }}
            size="xs"
            value={view}
          />
        }
        description={
          view === 'computed'
            ? t('panel:profiles.drawer.computedHint')
            : t('panel:profiles.drawer.configurationHint')
        }
        icon={view === 'computed' ? TbCpu2 : TbCode}
        iconColor="violet"
        key={view}
        placeholder={
          shown.isError ? (
            <PanelReadFailure
              error={shown.error}
              onRetry={() => {
                void shown.refetch();
              }}
            />
          ) : (
            <LoaderModal label={t('common:loading')} mih="320px" />
          )
        }
        title={
          view === 'computed'
            ? t('panel:profiles.drawer.computed')
            : t('panel:profiles.drawer.configuration')
        }
        value={shown.isSuccess ? jsonText(shown.data.configProfile.config) : undefined}
      />
      {shown.isSuccess && shown.data.configProfile.masked > 0 ? (
        <Text c="dimmed" fz="xs" ta="right">
          {t('panel:profiles.drawer.maskedCount', { count: shown.data.configProfile.masked })}
        </Text>
      ) : null}
    </Stack>
  );
}

/** The read-only drawer of a config profile: what it is, where it runs, and its masked configuration. */
export function ProfileDrawer({
  profile,
  onClose,
}: {
  profile: PanelConfigProfileSummary | undefined;
  onClose: () => void;
}) {
  return (
    <PanelDrawer
      header={(item) => ({ icon: TbBraces, title: item.name, subtitle: item.uuid })}
      item={profile}
      onClose={onClose}
    >
      {(item) => <ProfileBody key={item.uuid} profile={item} />}
    </PanelDrawer>
  );
}
