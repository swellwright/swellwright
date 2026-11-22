// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the read-only drawers of the objects of a list
// (src/shared/_modals/hosts/edit-host-modal, config-profiles/config-profile-inbounds-drawer): a 700 px drawer on the right, the
// object in bordered cards and `DataList` rows. Changes: the drawer shows a finding of the convention linter, a row of the
// reconciliation, and the fix hint they carry (informational: nothing here changes the panel).
import { Anchor, Badge, Card, DataList, Group, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { TbChecklist } from 'react-icons/tb';
import { Link } from 'react-router';

import type {
  CheckFixHint,
  CheckObjectRef,
  ConventionFinding,
  ReconciliationRow,
} from '@swellwright/contracts';
import { Callout, CopyableDataListItem, SectionCard } from '@swellwright/ui';

import { PanelDrawer } from '../panel/panel-drawer.js';
import {
  ObjectLabel,
  pageOfKind,
  ReconciliationStatusBadge,
  SeverityBadge,
  useCheckText,
} from './checks-format.js';
import { PreviewImpactButton } from './preview-impact.js';

/** The hint of a fix: what would change, from what, to what. Informational. */
export function FixHint({ fix }: { fix: CheckFixHint | null }) {
  const { t } = useTranslation('checks');
  if (fix === null) {
    return (
      <Text c="dimmed" size="sm">
        {t('ui.conventions.drawer.noFix')}
      </Text>
    );
  }
  const show = (value: CheckFixHint['from']): string =>
    value === null
      ? t('ui.conventions.drawer.nothing')
      : Array.isArray(value)
        ? value.join(', ')
        : String(value);
  return (
    <Stack gap="xs">
      <Callout color="blue">{t('ui.conventions.drawer.fixNote')}</Callout>
      <DataList orientation="vertical" size="xs" withDivider>
        <CopyableDataListItem
          label={t(`ui.conventions.drawer.op.${fix.op}`)}
          monospace
          value={fix.path}
        />
        <CopyableDataListItem
          emptyValue="–"
          label={t('ui.conventions.drawer.from')}
          monospace
          value={show(fix.from)}
        />
        <CopyableDataListItem
          emptyValue="–"
          label={t('ui.conventions.drawer.to')}
          monospace
          value={show(fix.to)}
        />
      </DataList>
      {fix.note === undefined ? null : (
        <Text c="dimmed" size="xs">
          {fix.note}
        </Text>
      )}
    </Stack>
  );
}

/** A link from an object to the page of the console that lists its kind. */
export function ObjectLink({ object }: { object: CheckObjectRef }) {
  const { t } = useTranslation('checks');
  const to = pageOfKind(object.kind);
  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <ObjectLabel object={object} />
      <Group gap="xs" wrap="nowrap">
        <Badge color="gray" size="sm" variant="light">
          {t(`ui.kind.${object.kind}`)}
        </Badge>
        {to === null ? null : (
          <Anchor component={Link} size="xs" to={to}>
            {t('ui.openObject')}
          </Anchor>
        )}
      </Group>
    </Group>
  );
}

const IMPACT_KINDS = new Set([
  'configProfile',
  'internalSquad',
  'host',
  'node',
  'subscriptionTemplate',
]);

function ObjectsCard({ title, objects }: { title: string; objects: readonly CheckObjectRef[] }) {
  if (objects.length === 0) {
    return null;
  }
  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Text fw={600} size="sm">
          {title}
        </Text>
      </SectionCard.Section>
      <SectionCard.Section>
        <Stack gap="xs">
          {objects.map((object) => (
            <Card key={`${object.kind}:${object.uuid ?? object.name}`} p="sm" withBorder>
              <ObjectLink object={object} />
            </Card>
          ))}
        </Stack>
      </SectionCard.Section>
    </SectionCard.Root>
  );
}

/** A finding of the convention linter. */
export function FindingDrawer({
  finding,
  onClose,
}: {
  finding: ConventionFinding | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('checks');
  const text = useCheckText();
  return (
    <PanelDrawer
      header={(item) => ({
        icon: TbChecklist,
        iconColor:
          item.severity === 'error' ? 'red' : item.severity === 'warning' ? 'orange' : 'blue',
        title: t('ui.conventions.drawer.title'),
        subtitle: item.id,
      })}
      item={finding}
      onClose={onClose}
    >
      {(item) => (
        <Stack gap="md">
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="xs">
                <Group gap="xs">
                  <SeverityBadge severity={item.severity} />
                </Group>
                <Text size="sm">{text(item.messageKey, item.message, item.params)}</Text>
              </Stack>
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" size="xs" withDivider>
                <CopyableDataListItem
                  label={t('ui.conventions.drawer.rule')}
                  monospace
                  value={item.ruleId}
                />
                <CopyableDataListItem
                  label={t('ui.conventions.drawer.code')}
                  monospace
                  value={item.code}
                />
                {item.fields.length === 0 ? null : (
                  <CopyableDataListItem
                    label={t('ui.conventions.drawer.fields')}
                    monospace
                    value={item.fields.join(', ')}
                  />
                )}
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>

          <ObjectsCard objects={[item.object]} title={t('ui.conventions.drawer.object')} />
          <ObjectsCard objects={item.related} title={t('ui.conventions.drawer.related')} />

          <SectionCard.Root>
            <SectionCard.Section>
              <Text fw={600} size="sm">
                {t('ui.conventions.drawer.fix')}
              </Text>
            </SectionCard.Section>
            <SectionCard.Section>
              <FixHint fix={item.fix} />
            </SectionCard.Section>
          </SectionCard.Root>

          {item.object.uuid !== null && IMPACT_KINDS.has(item.object.kind) ? (
            <PreviewImpactButton
              kind={item.object.kind as 'configProfile'}
              label={t('ui.conventions.drawer.previewImpact')}
              uuid={item.object.uuid}
            />
          ) : null}
        </Stack>
      )}
    </PanelDrawer>
  );
}

/** A row of the reconciliation. */
export function ReconciliationDrawer({
  row,
  onClose,
}: {
  row: ReconciliationRow | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('checks');
  const text = useCheckText();
  return (
    <PanelDrawer
      header={(item) => ({
        icon: TbChecklist,
        iconColor: item.status === 'ok' ? 'teal' : item.status === 'unknown' ? 'gray' : 'orange',
        title: t('ui.reconciliation.drawer.title'),
        subtitle: item.id,
      })}
      item={row}
      onClose={onClose}
    >
      {(item) => (
        <Stack gap="md">
          <SectionCard.Root>
            <SectionCard.Section>
              <Stack gap="xs">
                <Group gap="xs">
                  <ReconciliationStatusBadge status={item.status} />
                  <Badge color="gray" size="lg" variant="light">
                    {t(`reconciliation.checks.${item.check}.title`)}
                  </Badge>
                </Group>
                <Text size="sm">{text(item.reasonKey, item.reason, item.params)}</Text>
              </Stack>
            </SectionCard.Section>
            <SectionCard.Section>
              <DataList orientation="vertical" size="xs" withDivider>
                <CopyableDataListItem
                  emptyValue={t('ui.reconciliation.drawer.none')}
                  label={t('ui.reconciliation.drawer.expected')}
                  monospace
                  value={item.expected}
                />
                <CopyableDataListItem
                  emptyValue={t('ui.reconciliation.drawer.none')}
                  label={t('ui.reconciliation.drawer.actual')}
                  monospace
                  value={item.actual}
                />
                {item.ttlSeconds === null ? null : (
                  <CopyableDataListItem
                    label={t('ui.reconciliation.drawer.ttl')}
                    monospace
                    value={t('ui.reconciliation.drawer.seconds', { count: item.ttlSeconds })}
                  />
                )}
              </DataList>
            </SectionCard.Section>
          </SectionCard.Root>

          <ObjectsCard objects={[item.subject]} title={t('ui.reconciliation.drawer.about')} />
          <ObjectsCard
            objects={item.counterpart === null ? [] : [item.counterpart]}
            title={t('ui.reconciliation.drawer.counterpart')}
          />
          <ObjectsCard objects={item.related} title={t('ui.reconciliation.drawer.related')} />

          <SectionCard.Root>
            <SectionCard.Section>
              <Text fw={600} size="sm">
                {t('ui.reconciliation.drawer.fix')}
              </Text>
            </SectionCard.Section>
            <SectionCard.Section>
              <FixHint fix={item.fix} />
            </SectionCard.Section>
          </SectionCard.Root>
        </Stack>
      )}
    </PanelDrawer>
  );
}
