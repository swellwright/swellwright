// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the config-profile editor (src/widgets/dashboard/
// config-profiles/config-editor: Monaco in a titled card with a bar of actions), the metric cards of its pages and the bordered
// `Card` rows of its inbound drawers. Changes: the editor holds the change to be calculated (the editable form of an object,
// masked), the card of its buttons has "Calculate", and the result is cards: risk, metrics, nodes, rules, references that break,
// affected objects and the convention findings the change would introduce or resolve.
import {
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiCpu, PiLinkBreak, PiListChecks, PiUsers, PiUsersThree } from 'react-icons/pi';
import { TbChecklist, TbPlayerPlay, TbRestore, TbShieldLock } from 'react-icons/tb';

import {
  type CheckObjectRef,
  type ConventionFinding,
  type ImpactKind,
  type ImpactReport,
  IMPACT_KINDS,
} from '@swellwright/contracts';
import {
  Callout,
  EmptyPageLayout,
  LoaderModal,
  MetricCard,
  OverlayHeader,
  SectionCard,
  StatusBadge,
} from '@swellwright/ui';

import { CodeEditor } from '../commands/code-editor.js';
import { useNumber } from '../format.js';
import { PanelReadFailure } from '../panel/panel-data.js';
import {
  useHostsRead,
  useInternalSquadsRead,
  useNodesRead,
  useProfilesRead,
  useTemplatesRead,
} from '../panel/panel-reads.js';
import { notifyFailure } from '../security/notify-failure.js';
import { calculateImpact, getImpactTarget } from './checks-api.js';
import { checksKey } from './checks-data.js';
import {
  kindIcon,
  ObjectLabel,
  RISK_KIND,
  RiskBadge,
  SeverityBadge,
  useCheckText,
} from './checks-format.js';

const IMPACT_KIND_LABEL = {
  configProfile: 'configProfile',
  internalSquad: 'internalSquad',
  host: 'host',
  node: 'node',
  subscriptionTemplate: 'subscriptionTemplate',
} as const satisfies Record<ImpactKind, string>;

interface Option {
  value: string;
  label: string;
}

/** The objects of each kind the person can pick, from the reads the other pages share. */
function useObjectOptions(kind: ImpactKind): { options: Option[]; loading: boolean } {
  const profiles = useProfilesRead(kind === 'configProfile');
  const squads = useInternalSquadsRead(kind === 'internalSquad');
  const hosts = useHostsRead(kind === 'host');
  const nodes = useNodesRead(kind === 'node');
  const templates = useTemplatesRead(kind === 'subscriptionTemplate');
  return useMemo(() => {
    const sort = (options: Option[]): Option[] =>
      options.sort((a, b) => a.label.localeCompare(b.label));
    switch (kind) {
      case 'configProfile':
        return {
          options: sort(
            (profiles.query.data?.configProfiles ?? []).map((p) => ({
              value: p.uuid,
              label: p.name,
            })),
          ),
          loading: profiles.query.isPending,
        };
      case 'internalSquad':
        return {
          options: sort(
            (squads.query.data?.internalSquads ?? []).map((s) => ({
              value: s.uuid,
              label: s.name,
            })),
          ),
          loading: squads.query.isPending,
        };
      case 'host':
        return {
          options: sort(
            (hosts.query.data?.hosts ?? []).map((h) => ({ value: h.uuid, label: h.remark })),
          ),
          loading: hosts.query.isPending,
        };
      case 'node':
        return {
          options: sort(
            (nodes.query.data?.nodes ?? []).map((n) => ({ value: n.uuid, label: n.name })),
          ),
          loading: nodes.query.isPending,
        };
      case 'subscriptionTemplate':
        return {
          options: sort(
            (templates.query.data?.templates ?? []).map((tpl) => ({
              value: tpl.uuid,
              label: tpl.name,
            })),
          ),
          loading: templates.query.isPending,
        };
    }
  }, [kind, profiles.query, squads.query, hosts.query, nodes.query, templates.query]);
}

/** Text of an editor as the change to send: an object, or an array of patch operations. */
function parseChange(
  text: string,
):
  | { ok: true; change: Record<string, unknown> | unknown[] }
  | { ok: false; message: string; shape: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'invalid', shape: false };
  }
  if (Array.isArray(value)) {
    return { ok: true, change: value };
  }
  if (typeof value === 'object' && value !== null) {
    return { ok: true, change: value as Record<string, unknown> };
  }
  return { ok: false, message: '', shape: true };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SectionCard.Root>
      <SectionCard.Section>
        <Text fw={600} size="sm">
          {title}
        </Text>
      </SectionCard.Section>
      <SectionCard.Section>{children}</SectionCard.Section>
    </SectionCard.Root>
  );
}

function ObjectList({ objects }: { objects: readonly CheckObjectRef[] }) {
  return (
    <Group gap="xs">
      {objects.map((object) => (
        <Badge
          color="gray"
          key={`${object.kind}:${object.uuid ?? object.name}`}
          size="lg"
          variant="light"
        >
          <ObjectLabel object={object} />
        </Badge>
      ))}
    </Group>
  );
}

function FindingLines({ findings }: { findings: readonly ConventionFinding[] }) {
  const { t } = useTranslation('checks');
  const text = useCheckText();
  if (findings.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {t('ui.impact.result.noFindings')}
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {findings.map((finding) => (
        <Card key={finding.id} p="sm" withBorder>
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <SeverityBadge severity={finding.severity} />
            <Stack gap={0} miw={0}>
              <Text size="sm">{text(finding.messageKey, finding.message, finding.params)}</Text>
              <Text c="dimmed" size="xs">
                {finding.object.name} · {finding.ruleId}
              </Text>
            </Stack>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

/** What a calculation found, as cards. */
export function ImpactResult({ report }: { report: ImpactReport }) {
  const { t } = useTranslation('checks');
  const text = useCheckText();
  const number = useNumber();
  const known = (value: number | null): string =>
    value === null ? t('ui.impact.result.unknown') : number(value);
  const disturbed = report.restarts.filter((entry) => entry.action !== 'start').length;

  return (
    <Stack gap="md">
      <SectionCard.Root>
        <SectionCard.Section>
          <Group gap="md" justify="space-between" wrap="wrap">
            <Group gap="md">
              <RiskBadge large level={report.risk.level} />
              <Text c="dimmed" size="xs">
                {t('ui.impact.result.rulesVersion', { version: report.rulesVersion })}
                {report.panelVersion === null
                  ? ''
                  : ` · ${t('ui.impact.result.panelVersion', { version: report.panelVersion })}`}
              </Text>
            </Group>
            <ObjectLabel object={report.target} truncate={false} />
          </Group>
        </SectionCard.Section>
        <SectionCard.Section>
          <Stack gap="xs">
            {report.risk.reasons.map((reason) => (
              <Group align="flex-start" gap="sm" key={reason.code} wrap="nowrap">
                <StatusBadge iconSize={16} kind={RISK_KIND[reason.level]} size="md">
                  {t(`ui.risk.${reason.level}`)}
                </StatusBadge>
                <Text size="sm">{text(reason.messageKey, reason.message, reason.params)}</Text>
              </Group>
            ))}
          </Stack>
        </SectionCard.Section>
      </SectionCard.Root>

      {report.changed ? null : <Callout color="teal">{t('ui.impact.result.unchanged')}</Callout>}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 5 }} spacing="xs">
        <MetricCard
          icon={PiCpu}
          iconColor={disturbed > 0 ? 'orange' : 'teal'}
          subtitle={t('ui.impact.result.metrics.nodesHint')}
          title={t('ui.impact.result.metrics.nodes')}
          value={number(disturbed)}
        />
        <MetricCard
          icon={PiUsers}
          iconColor="cyan"
          subtitle={t('ui.impact.result.metrics.onlineHint')}
          title={t('ui.impact.result.metrics.online')}
          value={known(report.users.onlineOnRestartedNodes)}
        />
        <MetricCard
          icon={PiUsersThree}
          iconColor="blue"
          subtitle={t('ui.impact.result.metrics.membersHint')}
          title={t('ui.impact.result.metrics.members')}
          value={known(report.users.squadMembersUpTo)}
        />
        <MetricCard
          icon={PiListChecks}
          iconColor="blue"
          subtitle={t('ui.impact.result.metrics.hostsHint')}
          title={t('ui.impact.result.metrics.hosts')}
          value={number(report.affected.hosts.length)}
        />
        <MetricCard
          icon={PiLinkBreak}
          iconColor={report.dangling.length > 0 ? 'red' : 'gray'}
          subtitle={t('ui.impact.result.metrics.danglingHint')}
          title={t('ui.impact.result.metrics.dangling')}
          value={number(report.dangling.length)}
        />
      </SimpleGrid>

      {report.saferWay === null ? null : (
        <Callout color="teal" title={t('ui.impact.result.saferWay')}>
          {text(report.saferWay.messageKey, report.saferWay.message, report.saferWay.params)}
        </Callout>
      )}

      <Section title={t('ui.impact.result.nodes')}>
        {report.restarts.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t('ui.impact.result.nodesEmpty')}
          </Text>
        ) : (
          <Stack gap="xs">
            {report.restarts.map((entry) => (
              <Card key={entry.node.uuid ?? entry.node.name} p="sm" withBorder>
                <Group gap="sm" justify="space-between" wrap="wrap">
                  <ObjectLabel object={entry.node} />
                  <Group gap="xs" wrap="wrap">
                    <Badge
                      color={
                        entry.action === 'restart'
                          ? 'orange'
                          : entry.action === 'stop'
                            ? 'red'
                            : 'teal'
                      }
                      size="md"
                      variant="soft"
                    >
                      {t(`ui.action.${entry.action}`)}
                    </Badge>
                    <Badge color="gray" size="md" variant="light">
                      {entry.state}
                    </Badge>
                    <Tooltip label={t('ui.impact.result.nodeColumns.users')} withArrow>
                      <Badge color="cyan" size="md" variant="light">
                        {entry.usersOnline === null ? '–' : number(entry.usersOnline)}
                      </Badge>
                    </Tooltip>
                    <Text c="dimmed" ff="monospace" size="xs">
                      {entry.rule}
                    </Text>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
        {report.skipped.length === 0 ? null : (
          <Text c="dimmed" mt="xs" size="xs">
            {t('ui.impact.result.skipped', {
              nodes: report.skipped.map((entry) => entry.node.name).join(', '),
            })}
          </Text>
        )}
      </Section>

      {report.rules.length === 0 ? null : (
        <Section title={t('ui.impact.result.rules')}>
          <Stack gap="xs">
            {report.rules.map((rule) => (
              <Group align="flex-start" gap="sm" key={rule.id} wrap="nowrap">
                <Tooltip label={t(`ui.basisHint.${rule.basis}`)} withArrow>
                  <Badge
                    color={
                      rule.basis === 'assumed'
                        ? 'orange'
                        : rule.basis === 'observed'
                          ? 'teal'
                          : 'blue'
                    }
                    size="md"
                    variant="soft"
                  >
                    {t(`ui.basis.${rule.basis}`)}
                  </Badge>
                </Tooltip>
                <Stack gap={0} miw={0}>
                  <Text size="sm">{text(rule.messageKey, rule.title)}</Text>
                  <Text c="dimmed" ff="monospace" size="xs">
                    {rule.id} · {t(`ui.effect.${rule.effect}`)}
                  </Text>
                </Stack>
              </Group>
            ))}
          </Stack>
        </Section>
      )}

      {report.inbounds === null ? null : (
        <Section title={t('ui.impact.result.inbounds')}>
          <Stack gap="xs">
            {(
              [
                ['inboundsAdded', report.inbounds.added, 'teal'],
                ['inboundsRemoved', report.inbounds.removed, 'red'],
                ['inboundsChanged', report.inbounds.changed, 'orange'],
              ] as const
            ).map(([label, tags, color]) =>
              tags.length === 0 ? null : (
                <Group gap="xs" key={label}>
                  <Text size="sm" w={110}>
                    {t(`ui.impact.result.${label}`)}
                  </Text>
                  {tags.map((tag) => (
                    <Badge color={color} ff="monospace" key={tag} size="md" variant="light">
                      {tag}
                    </Badge>
                  ))}
                </Group>
              ),
            )}
            {report.inbounds.renamed.length === 0 ? null : (
              <Group gap="xs">
                <Text size="sm" w={110}>
                  {t('ui.impact.result.inboundsRenamed')}
                </Text>
                {report.inbounds.renamed.map((pair) => (
                  <Badge color="violet" ff="monospace" key={pair.from} size="md" variant="light">
                    {pair.from} → {pair.to}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
        </Section>
      )}

      {report.dangling.length === 0 ? null : (
        <Section title={t('ui.impact.result.dangling')}>
          <Stack gap="xs">
            {report.dangling.map((entry, index) => (
              <Card
                key={`${entry.from.uuid ?? entry.from.name}:${entry.inbound.tag}:${String(index)}`}
                p="sm"
                withBorder
              >
                <Group gap="sm" justify="space-between" wrap="wrap">
                  <ObjectLabel object={entry.from} />
                  <Group gap="xs">
                    <Badge color="red" ff="monospace" size="md" variant="light">
                      {entry.inbound.tag === '' ? (entry.inbound.uuid ?? '–') : entry.inbound.tag}
                    </Badge>
                    <Text c="dimmed" size="xs">
                      {t(`ui.impact.result.danglingReason.${entry.reason}`)}
                    </Text>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>
        </Section>
      )}

      {report.unserved.length === 0 ? null : (
        <Section title={t('ui.impact.result.unserved')}>
          <Stack gap="xs">
            {report.unserved.map((entry) => (
              <Card key={entry.host.uuid ?? entry.host.name} p="sm" withBorder>
                <Group gap="sm" justify="space-between" wrap="wrap">
                  <ObjectLabel object={entry.host} />
                  <Text c="dimmed" size="xs">
                    {t(`ui.impact.result.unservedReason.${entry.reason}`)}
                  </Text>
                </Group>
              </Card>
            ))}
          </Stack>
        </Section>
      )}

      {report.affected.internalSquads.length +
        report.affected.externalSquads.length +
        report.affected.templates.length +
        report.affected.hosts.length ===
      0 ? null : (
        <Section title={t('ui.impact.result.affected')}>
          <Stack gap="sm">
            {(
              [
                ['affectedSquads', report.affected.internalSquads],
                ['affectedExternal', report.affected.externalSquads],
                ['affectedTemplates', report.affected.templates],
                ['affectedHosts', report.affected.hosts],
              ] as const
            ).map(([label, objects]) =>
              objects.length === 0 ? null : (
                <Stack gap={4} key={label}>
                  <Text c="dimmed" size="xs">
                    {t(`ui.impact.result.${label}`)}
                  </Text>
                  <ObjectList objects={objects} />
                </Stack>
              ),
            )}
          </Stack>
        </Section>
      )}

      <Section title={t('ui.impact.result.findings')}>
        <Stack gap="md">
          <Stack gap="xs">
            <Text fw={500} size="sm">
              {t('ui.impact.result.introduced')}
            </Text>
            <FindingLines findings={report.findings.introduced} />
          </Stack>
          <Stack gap="xs">
            <Text fw={500} size="sm">
              {t('ui.impact.result.fixed')}
            </Text>
            <FindingLines findings={report.findings.fixed} />
          </Stack>
        </Stack>
      </Section>

      {report.changes.length === 0 ? null : (
        <Section title={t('ui.impact.result.changes')}>
          <Stack gap={2}>
            {report.changes.map((change) => (
              <Text ff="monospace" key={`${change.op}:${change.path}`} size="xs">
                {change.op} {change.path}
              </Text>
            ))}
          </Stack>
        </Section>
      )}

      {report.notes.length === 0 ? null : (
        <Stack gap="xs">
          <Text fw={600} size="sm">
            {t('ui.impact.result.notes')}
          </Text>
          {report.notes.map((note) => (
            <Callout color="blue" key={note.code}>
              {text(note.messageKey, note.message, note.params)}
            </Callout>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** The Impact tab: pick an object, write a change, calculate. */
export function ImpactTab({
  initialKind,
  initialUuid,
}: {
  initialKind: ImpactKind | undefined;
  initialUuid: string | undefined;
}) {
  const { t } = useTranslation(['checks', 'panel']);
  const [kind, setKind] = useState<ImpactKind>(initialKind ?? 'configProfile');
  const [uuid, setUuid] = useState<string | null>(initialUuid ?? null);
  const [text, setText] = useState('');
  const loaded = useRef<string | null>(null);
  const objects = useObjectOptions(kind);

  const target = useQuery({
    queryKey: checksKey('target', kind, uuid ?? ''),
    queryFn: () => getImpactTarget(kind, uuid ?? ''),
    enabled: uuid !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // The editor starts from the editable form of the object chosen, once per object.
  const targetData = target.data;
  useEffect(() => {
    if (targetData !== undefined) {
      const key = `${kind}:${uuid ?? ''}:${targetData.target.name}`;
      if (loaded.current !== key) {
        loaded.current = key;
        setText(JSON.stringify(targetData.editable, null, 2));
      }
    }
  }, [targetData, kind, uuid]);

  const parsed = useMemo(() => (text.trim() === '' ? undefined : parseChange(text)), [text]);

  const calculate = useMutation({
    mutationFn: (change: Record<string, unknown> | unknown[]) =>
      calculateImpact({ kind, uuid: uuid ?? '', change: change as Record<string, unknown> }),
    onError: (error) => {
      notifyFailure(
        t,
        t('checks:ui.impact.result.failed'),
        error,
        t('panel:signInAgain'),
        t('panel:readForbidden'),
      );
    },
  });

  const reset = () => {
    loaded.current = null;
    calculate.reset();
    if (targetData !== undefined) {
      loaded.current = `${kind}:${uuid ?? ''}:${targetData.target.name}`;
      setText(JSON.stringify(targetData.editable, null, 2));
    }
  };

  return (
    <Stack gap="md">
      <SectionCard.Root>
        <SectionCard.Section>
          <OverlayHeader
            icon={TbChecklist}
            iconColor="cyan"
            iconSize={18}
            subtitle={t('checks:ui.impact.description')}
            title={t('checks:ui.impact.form.title')}
            titleOrder={5}
          />
        </SectionCard.Section>
        <SectionCard.Section>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Select
              allowDeselect={false}
              data={IMPACT_KINDS.map((value) => ({
                value,
                label: t(`checks:ui.kind.${IMPACT_KIND_LABEL[value]}`),
              }))}
              label={t('checks:ui.impact.form.kind')}
              leftSection={createElement(kindIcon(kind), { size: 18 })}
              onChange={(value) => {
                if (value !== null && (IMPACT_KINDS as readonly string[]).includes(value)) {
                  setKind(value);
                  setUuid(null);
                  setText('');
                  calculate.reset();
                  loaded.current = null;
                }
              }}
              value={kind}
            />
            <Select
              data={objects.options}
              disabled={objects.loading}
              label={t('checks:ui.impact.form.object')}
              nothingFoundMessage={t('checks:ui.impact.form.noObjects')}
              onChange={(value) => {
                setUuid(value);
                setText('');
                calculate.reset();
                loaded.current = null;
              }}
              placeholder={t('checks:ui.impact.form.objectPlaceholder')}
              searchable
              value={uuid}
            />
          </SimpleGrid>
        </SectionCard.Section>
      </SectionCard.Root>

      {uuid === null ? (
        <EmptyPageLayout
          icon={<TbChecklist size="2rem" />}
          mih="20vh"
          title={t('checks:ui.impact.form.pickFirst')}
        />
      ) : target.isPending ? (
        <LoaderModal label={t('checks:ui.impact.form.loading')} mih="200px" />
      ) : target.isError ? (
        <PanelReadFailure
          error={target.error}
          onRetry={() => {
            void target.refetch();
          }}
        />
      ) : (
        <SectionCard.Root>
          <SectionCard.Section>
            <Stack gap="xs">
              <Text fw={600} size="sm">
                {t('checks:ui.impact.form.editor')}
              </Text>
              <Text c="dimmed" size="xs">
                {t('checks:ui.impact.form.hint')}
              </Text>
              {target.data.masked ? (
                <Callout color="blue" icon={<TbShieldLock size={20} />}>
                  {t('checks:ui.impact.form.masked')}
                </Callout>
              ) : null}
            </Stack>
          </SectionCard.Section>
          <SectionCard.Section>
            <Stack gap="xs">
              <CodeEditor
                height="440px"
                label={t('checks:ui.impact.form.editor')}
                language="json"
                onChange={setText}
                value={text}
              />
              {parsed !== undefined && !parsed.ok ? (
                <Text c="red" size="sm">
                  {parsed.shape
                    ? t('checks:ui.impact.form.notObject')
                    : t('checks:ui.impact.form.invalidJson', { message: parsed.message })}
                </Text>
              ) : null}
              <Group gap="xs" justify="flex-end">
                <Button
                  color="gray"
                  leftSection={<TbRestore size={18} />}
                  onClick={reset}
                  variant="subtle"
                >
                  {t('checks:ui.impact.form.reset')}
                </Button>
                <Button
                  color="teal"
                  disabled={!parsed?.ok}
                  leftSection={<TbPlayerPlay size={18} />}
                  loading={calculate.isPending}
                  onClick={() => {
                    if (parsed?.ok === true) {
                      calculate.mutate(parsed.change);
                    }
                  }}
                  variant="soft"
                >
                  {t('checks:ui.impact.form.calculate')}
                </Button>
              </Group>
            </Stack>
          </SectionCard.Section>
        </SectionCard.Root>
      )}

      {calculate.isPending ? (
        <LoaderModal label={t('checks:ui.impact.result.calculating')} mih="160px" />
      ) : null}
      {calculate.data === undefined ? null : <ImpactResult report={calculate.data} />}
    </Stack>
  );
}
