// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the drawers that open a record of a list (the
// audit-style event drawer of this console, which follows the panel's request-history drawer: cards with a soft-icon
// header and a `DataList` of copyable rows) and the sticky footer of the panel's edit drawers (`DrawerFooter`).
// Changes: read-only, with the actions that start from a snapshot in the footer (compare, download).
import { Badge, Button, DataList, Group, Stack, Text } from '@mantine/core';
import { IconDownload, IconGitCompare } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PiHashDuotone, PiInfoDuotone, PiListBulletsDuotone } from 'react-icons/pi';
import { TbCamera } from 'react-icons/tb';

import {
  PANEL_SNAPSHOT_OBJECT_KINDS,
  type PanelSnapshotCoverage,
  type PanelSnapshotSummary,
} from '@swellwright/contracts';
import {
  CopyableDataListItem,
  DrawerFooter,
  OverlayHeader,
  SectionCard,
  StatusBadge,
  type StatusKind,
} from '@swellwright/ui';

import { panelSnapshotExportPath } from '../api.js';
import { useBytes, useDateTime, useNumber } from '../format.js';
import { PanelDrawer } from './panel-drawer.js';
import {
  ChangesSince,
  SourceBadge,
  useIncompleteText,
  useKindNames,
  useSnapshotName,
} from './snapshot-parts.js';

const COVERAGE_KIND: Record<PanelSnapshotCoverage, StatusKind> = {
  ok: 'ok',
  denied: 'warn',
  failed: 'err',
};

/** One snapshot in full: when and by whom, what it holds per kind, and its hashes; compare and download start here. */
export function SnapshotDrawer({
  snapshot,
  onClose,
  canCompareLive,
  onCompareLive,
  onCompareOther,
}: {
  snapshot: PanelSnapshotSummary | undefined;
  onClose: () => void;
  /** False while no panel is connected. */
  canCompareLive: boolean;
  onCompareLive: (snapshot: PanelSnapshotSummary) => void;
  onCompareOther: (snapshot: PanelSnapshotSummary) => void;
}) {
  const { t } = useTranslation(['snapshots', 'common']);
  const formatTime = useDateTime();
  const number = useNumber();
  const bytes = useBytes();
  const nameOf = useSnapshotName();
  const kindNames = useKindNames();
  const incompleteText = useIncompleteText();
  const copy = { copiedLabel: t('common:copied'), copyLabel: t('common:copy') };

  return (
    <PanelDrawer
      header={(shown) => ({
        icon: TbCamera,
        iconColor: 'teal',
        title: nameOf(shown),
        subtitle: shown.id,
      })}
      item={snapshot}
      onClose={onClose}
    >
      {(shown) => (
        <Stack gap="md">
          <SectionCard.Root>
            <SectionCard.Section>
              <Group align="center" justify="space-between">
                <OverlayHeader
                  icon={PiInfoDuotone}
                  iconColor="blue"
                  title={t('snapshots:drawer.sectionSnapshot')}
                />
                <SourceBadge kind={shown.kind} />
              </Group>
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" withDivider>
                <CopyableDataListItem
                  label={t('snapshots:drawer.taken')}
                  monospace
                  value={formatTime(shown.createdAt)}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('snapshots:drawer.by')}
                  value={shown.createdBy?.name ?? t('snapshots:byJob')}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('snapshots:drawer.panel')}
                  monospace
                  value={shown.panelUrl}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('snapshots:drawer.version')}
                  monospace
                  value={shown.panelVersion}
                  {...copy}
                />
                <CopyableDataListItem
                  label={t('snapshots:drawer.size')}
                  value={t('snapshots:drawer.sizeValue', {
                    stored: bytes(shown.sizeBytes),
                    raw: bytes(shown.rawBytes),
                  })}
                  {...copy}
                />
                <DataList.Item>
                  <DataList.ItemLabel>{t('snapshots:drawer.checked')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    <Group gap="xs">
                      <ChangesSince snapshot={shown} />
                      {shown.checkedAt === null ? null : (
                        <Text c="dimmed" ff="monospace" fz="sm">
                          {formatTime(shown.checkedAt)}
                        </Text>
                      )}
                    </Group>
                  </DataList.ItemValue>
                </DataList.Item>
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>

          <SectionCard.Root>
            <SectionCard.Section>
              <Group align="center" justify="space-between">
                <OverlayHeader
                  icon={PiListBulletsDuotone}
                  iconColor="violet"
                  title={t('snapshots:drawer.sectionContents')}
                />
                <Badge color="gray" size="lg" variant="soft">
                  {t('snapshots:objectsOf', { count: shown.objectCount })}
                </Badge>
              </Group>
              {incompleteText(shown) === null ? null : (
                <Text c="orange.4" fz="sm" mt="xs">
                  {incompleteText(shown)}
                </Text>
              )}
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="horizontal" withDivider>
                {PANEL_SNAPSHOT_OBJECT_KINDS.map((kind) => (
                  <DataList.Item key={kind}>
                    <DataList.ItemLabel>{kindNames.many(kind)}</DataList.ItemLabel>
                    <DataList.ItemValue>
                      <Group gap="sm" justify="flex-end" wrap="nowrap">
                        {shown.coverage[kind] === 'ok' ? (
                          <Text ff="monospace" fz="sm">
                            {number(shown.counts[kind])}
                          </Text>
                        ) : (
                          <StatusBadge kind={COVERAGE_KIND[shown.coverage[kind]]}>
                            {t(`snapshots:coverage.${shown.coverage[kind]}`)}
                          </StatusBadge>
                        )}
                      </Group>
                    </DataList.ItemValue>
                  </DataList.Item>
                ))}
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>

          <SectionCard.Root>
            <SectionCard.Section>
              <OverlayHeader
                icon={PiHashDuotone}
                iconColor="gray"
                title={t('snapshots:drawer.sectionHashes')}
              />
              <Text c="dimmed" fz="sm" mt="xs">
                {t('snapshots:drawer.hashHint')}
              </Text>
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" withDivider>
                <CopyableDataListItem
                  label={t('snapshots:drawer.overall')}
                  monospace
                  value={shown.overallHash}
                  {...copy}
                />
                {PANEL_SNAPSHOT_OBJECT_KINDS.flatMap((kind) => {
                  const hash = shown.kindHashes[kind];
                  return hash === undefined
                    ? []
                    : [
                        <CopyableDataListItem
                          key={kind}
                          label={kindNames.many(kind)}
                          monospace
                          value={hash}
                          {...copy}
                        />,
                      ];
                })}
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>

          <DrawerFooter>
            <Button
              component="a"
              download
              href={panelSnapshotExportPath(shown.id)}
              leftSection={<IconDownload size={18} />}
              variant="light"
            >
              {t('snapshots:actions.export')}
            </Button>
            <Button
              leftSection={<IconGitCompare size={18} />}
              onClick={() => {
                onCompareOther(shown);
              }}
              variant="light"
            >
              {t('snapshots:drawer.compareOther')}
            </Button>
            <Button
              color="teal"
              disabled={!canCompareLive}
              leftSection={<IconGitCompare size={18} />}
              onClick={() => {
                onCompareLive(shown);
              }}
              variant="soft"
            >
              {t('snapshots:drawer.compareLive')}
            </Button>
          </DrawerFooter>
        </Stack>
      )}
    </PanelDrawer>
  );
}
