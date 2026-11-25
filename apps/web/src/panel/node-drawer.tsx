// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/shared/_modals/nodes/edit-node-modal/
// {edit-node.modal.tsx,edit-node.modal.content.tsx} and the cards of src/shared/ui/forms/nodes/base-node-form/
// {node-vitals.card.tsx,node-config-profiles.card.tsx,node-tracking-and-billing.card.tsx,node-consumption.card.tsx,
// node-ips.card.tsx}, the drawer that opens a node: grouped `SectionCard`s with disabled fields and the node's system
// information. Changes: read-only (the inputs are disabled, there is no footer with a save button), the cards hold what the
// server normalised from the panel (`PanelNodeView`), nothing of the panel's live statistics.
import { Badge, DataList, Group, Stack, TagsInput, Text, Textarea, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { HiServer } from 'react-icons/hi';
import { PiCpuDuotone, PiGaugeDuotone, PiListChecksDuotone, PiPulseDuotone } from 'react-icons/pi';
import { TbNetwork, TbSettings } from 'react-icons/tb';

import type { PanelNodeState, PanelNodeView } from '@swellwright/contracts';
import {
  BooleanCell,
  CountryFlag,
  ErrorMessageBlock,
  OverlayHeader,
  SectionCard,
  StatusBadge,
  type StatusKind,
} from '@swellwright/ui';

import { useCountries } from '../fleet/countries.js';
import { useBytes, useDateTime, useNumber } from '../format.js';
import { PreviewImpactButton } from '../checks/preview-impact.js';
import { PanelDrawer } from './panel-drawer.js';
import { formatDuration, orDash } from './panel-format.js';

const STATE_KIND: Record<PanelNodeState, StatusKind> = {
  online: 'ok',
  connecting: 'run',
  offline: 'err',
  disabled: 'wait',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}

function Value({ children }: { children: string }) {
  return <Text size="sm">{children}</Text>;
}

function NodeBody({
  node,
  profileName,
}: {
  node: PanelNodeView;
  /** The name of the node's config profile when the profiles could be read. */
  profileName: string | undefined;
}) {
  const { t } = useTranslation(['panel', 'common', 'checks']);
  const formatTime = useDateTime();
  const formatBytes = useBytes();
  const formatNumber = useNumber();
  const { nameOf } = useCountries();

  const { traffic, system } = node;
  const tracked = traffic.trackingActive;

  return (
    <Stack gap="md">
      <PreviewImpactButton
        kind="node"
        label={t('checks:ui.impact.previewImpact')}
        uuid={node.uuid}
      />
      <SectionCard.Root>
        <SectionCard.Section>
          <Group gap="xs" justify="space-between" wrap="nowrap">
            <OverlayHeader
              icon={PiPulseDuotone}
              iconColor="teal"
              iconSize={18}
              title={t('panel:nodes.drawer.status')}
              titleOrder={5}
            />
            <StatusBadge kind={STATE_KIND[node.state]}>
              {t(`panel:nodes.states.${node.state}`)}
            </StatusBadge>
          </Group>
        </SectionCard.Section>
        {node.lastStatusMessage !== null && node.state !== 'online' ? (
          <SectionCard.Section>
            <ErrorMessageBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('common:copy')}
              message={node.lastStatusMessage}
            />
          </SectionCard.Section>
        ) : null}
        <SectionCard.Section>
          <DataList orientation="vertical" withDivider>
            <Row label={t('panel:nodes.drawer.statusChanged')}>
              <Value>
                {node.lastStatusChange === null ? orDash(null) : formatTime(node.lastStatusChange)}
              </Value>
            </Row>
            <Row label={t('panel:nodes.columns.online')}>
              <Value>
                {node.usersOnline === null ? orDash(null) : formatNumber(node.usersOnline)}
              </Value>
            </Row>
            <Row label={t('panel:nodes.columns.xray')}>
              <Value>{orDash(node.xrayVersion)}</Value>
            </Row>
            <Row label={t('panel:nodes.columns.xrayUptime')}>
              <Value>{formatDuration(node.xrayUptimeSeconds)}</Value>
            </Row>
            <Row label={t('panel:nodes.columns.node')}>
              <Value>{orDash(node.nodeVersion)}</Value>
            </Row>
          </DataList>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={HiServer}
            iconColor="cyan"
            iconSize={18}
            title={t('panel:nodes.drawer.general')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput disabled label={t('panel:nodes.columns.name')} value={node.name} />
            <Group gap="xs" grow justify="space-between" preventGrowOverflow={false} w="100%">
              <TextInput
                disabled
                label={t('panel:nodes.columns.address')}
                value={node.address}
                w="65%"
              />
              <TextInput
                disabled
                label={t('panel:nodes.columns.port')}
                value={node.port === null ? '' : String(node.port)}
                w="30%"
              />
            </Group>
            <TextInput
              disabled
              label={t('panel:nodes.drawer.country')}
              leftSection={<CountryFlag code={node.countryCode} label={nameOf(node.countryCode)} />}
              value={nameOf(node.countryCode)}
            />
            <TextInput
              disabled
              label={t('panel:nodes.columns.provider')}
              value={node.provider?.name ?? ''}
            />
            <TagsInput disabled label={t('panel:nodes.columns.tags')} value={node.tags} />
            {node.note === null || node.note === '' ? null : (
              <Textarea
                autosize
                disabled
                label={t('panel:nodes.drawer.note')}
                maxRows={6}
                minRows={2}
                value={node.note}
              />
            )}
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiListChecksDuotone}
            iconColor="blue"
            iconSize={18}
            title={t('panel:nodes.drawer.profile')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="md">
            <TextInput
              disabled
              label={t('panel:nodes.columns.profile')}
              value={profileName ?? node.configProfile.uuid ?? ''}
            />
            <Stack gap={4}>
              <Text fw={500} size="sm">
                {t('panel:nodes.columns.inbounds')}
              </Text>
              {node.configProfile.inbounds.length === 0 ? (
                <Text c="dimmed" size="sm">
                  {t('panel:nodes.drawer.noInbounds')}
                </Text>
              ) : (
                <Group gap="xs">
                  {[...node.configProfile.inbounds]
                    .sort((a, b) => a.tag.localeCompare(b.tag))
                    .map((inbound) => (
                      <Badge color="blue" key={inbound.uuid} size="lg" variant="soft">
                        {inbound.tag}
                      </Badge>
                    ))}
                </Group>
              )}
            </Stack>
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={PiGaugeDuotone}
            iconColor="indigo"
            iconSize={18}
            title={t('panel:nodes.drawer.traffic')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <DataList orientation="vertical" withDivider>
            <Row label={t('panel:nodes.drawer.tracking')}>
              <BooleanCell labels={{ yes: t('common:yes'), no: t('common:no') }} value={tracked} />
            </Row>
            <Row label={t('panel:nodes.columns.trafficUsed')}>
              <Value>
                {traffic.usedBytes === null ? orDash(null) : formatBytes(traffic.usedBytes)}
              </Value>
            </Row>
            <Row label={t('panel:nodes.drawer.limit')}>
              <Value>
                {traffic.limitBytes === null || traffic.limitBytes === 0
                  ? t('panel:nodes.drawer.noLimit')
                  : formatBytes(traffic.limitBytes)}
              </Value>
            </Row>
            <Row label={t('panel:nodes.drawer.resetDay')}>
              <Value>{orDash(traffic.resetDay)}</Value>
            </Row>
            <Row label={t('panel:nodes.drawer.notifyPercent')}>
              <Value>
                {traffic.notifyPercent === null
                  ? orDash(null)
                  : `${String(traffic.notifyPercent)} %`}
              </Value>
            </Row>
            <Row label={t('panel:nodes.columns.consumption')}>
              <Value>{node.consumptionMultiplier.toFixed(1)}</Value>
            </Row>
            <Row label={t('panel:nodes.columns.nodeConsumption')}>
              <Value>{node.nodeConsumptionMultiplier.toFixed(1)}</Value>
            </Row>
          </DataList>
        </SectionCard.Section>
      </SectionCard.Root>

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbNetwork}
            iconColor="grape"
            iconSize={18}
            title={t('panel:nodes.columns.ips')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          {node.ips.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('panel:nodes.drawer.noIps')}
            </Text>
          ) : (
            <DataList orientation="horizontal" withDivider>
              {node.ips.map((ip) => (
                <Row key={ip.ip} label={ip.ip}>
                  <Value>{ip.status}</Value>
                </Row>
              ))}
            </DataList>
          )}
        </SectionCard.Section>
      </SectionCard.Root>

      {system === null ? null : (
        <SectionCard.Root>
          <SectionCard.Section>
            <OverlayHeader
              icon={PiCpuDuotone}
              iconColor="orange"
              iconSize={18}
              title={t('panel:nodes.drawer.system')}
              titleOrder={5}
            />
          </SectionCard.Section>
          <SectionCard.Section>
            <DataList orientation="vertical" withDivider>
              <Row label={t('panel:nodes.drawer.hostname')}>
                <Value>{orDash(system.hostname)}</Value>
              </Row>
              <Row label={t('panel:nodes.drawer.platform')}>
                <Value>
                  {orDash([system.platform, system.release, system.arch].filter(Boolean).join(' '))}
                </Value>
              </Row>
              <Row label={t('panel:nodes.columns.cpus')}>
                <Value>{system.cpus === null ? orDash(null) : formatNumber(system.cpus)}</Value>
              </Row>
              <Row label={t('panel:nodes.drawer.memory')}>
                <Value>
                  {system.memoryTotal === null
                    ? orDash(null)
                    : system.memoryUsed === null
                      ? formatBytes(system.memoryTotal)
                      : `${formatBytes(system.memoryUsed)} / ${formatBytes(system.memoryTotal)}`}
                </Value>
              </Row>
              <Row label={t('panel:nodes.drawer.uptime')}>
                <Value>{formatDuration(system.uptimeSeconds)}</Value>
              </Row>
              <Row label={t('panel:nodes.drawer.load')}>
                <Value>
                  {system.loadAvg.length === 0
                    ? orDash(null)
                    : system.loadAvg.map((load) => load.toFixed(2)).join(' · ')}
                </Value>
              </Row>
            </DataList>
          </SectionCard.Section>
        </SectionCard.Root>
      )}

      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbSettings}
            iconColor="gray"
            iconSize={18}
            title={t('panel:nodes.drawer.ids')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <DataList orientation="vertical" withDivider>
            <Row label={t('panel:nodes.drawer.created')}>
              <Value>{formatTime(node.createdAt)}</Value>
            </Row>
            <Row label={t('panel:nodes.drawer.updated')}>
              <Value>{formatTime(node.updatedAt)}</Value>
            </Row>
          </DataList>
        </SectionCard.Section>
      </SectionCard.Root>
    </Stack>
  );
}

/** The read-only drawer of a node. */
export function NodeDrawer({
  node,
  profileNames,
  onClose,
}: {
  node: PanelNodeView | undefined;
  profileNames: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  return (
    <PanelDrawer
      header={(item) => ({ icon: HiServer, title: item.name, subtitle: item.uuid })}
      item={node}
      onClose={onClose}
    >
      {(item) => (
        <NodeBody
          node={item}
          profileName={
            item.configProfile.uuid === null ? undefined : profileNames.get(item.configProfile.uuid)
          }
        />
      )}
    </PanelDrawer>
  );
}
