// New in Swellwright (ADR 0044): the small pieces the three tabs of the Checks page share, built from the panel's chips
// (`StatusBadge`), its icons and the texts of the `checks` namespace.
import { Group, Text } from '@mantine/core';
import { IconHexagon } from '@tabler/icons-react';
import { type ElementType } from 'react';
import { useTranslation } from 'react-i18next';
import { HiServer } from 'react-icons/hi';
import { PiListChecks, PiTag } from 'react-icons/pi';
import {
  TbBraces,
  TbCirclesRelation,
  TbCode,
  TbFolder,
  TbPackage,
  TbServerCog,
  TbWebhook,
} from 'react-icons/tb';

import type {
  CheckObjectKind,
  CheckObjectRef,
  CheckParams,
  CheckSeverity,
  ReconciliationStatus,
  RiskLevel,
} from '@swellwright/contracts';
import { StatusBadge, type StatusKind } from '@swellwright/ui';

import { ROUTES } from '../routes.js';

const KIND_ICON: Record<CheckObjectKind, ElementType<{ size?: number }>> = {
  panel: IconHexagon,
  host: PiListChecks,
  node: TbServerCog,
  configProfile: TbBraces,
  inbound: PiTag,
  internalSquad: TbCirclesRelation,
  externalSquad: TbWebhook,
  subscriptionTemplate: TbFolder,
  snippet: TbCode,
  nodePlugin: TbPackage,
  server: HiServer,
};

export const KIND_COLOR: Record<CheckObjectKind, string> = {
  panel: 'gray',
  host: 'blue',
  node: 'teal',
  configProfile: 'violet',
  inbound: 'blue',
  internalSquad: 'cyan',
  externalSquad: 'indigo',
  subscriptionTemplate: 'orange',
  snippet: 'grape',
  nodePlugin: 'pink',
  server: 'teal',
};

export const kindIcon = (kind: CheckObjectKind): ElementType<{ size?: number }> => KIND_ICON[kind];

/** The page of the console that lists objects of a kind, for a link from a row. Null where there is none. */
export function pageOfKind(kind: CheckObjectKind): string | null {
  switch (kind) {
    case 'host':
      return ROUTES.DASHBOARD.PANEL.HOSTS;
    case 'node':
      return ROUTES.DASHBOARD.FLEET.NODES;
    case 'configProfile':
      return ROUTES.DASHBOARD.PANEL.PROFILES;
    case 'internalSquad':
      return ROUTES.DASHBOARD.PANEL.INTERNAL_SQUADS;
    case 'externalSquad':
      return ROUTES.DASHBOARD.PANEL.EXTERNAL_SQUADS;
    case 'subscriptionTemplate':
      return ROUTES.DASHBOARD.PANEL.TEMPLATES;
    case 'snippet':
      return ROUTES.DASHBOARD.PANEL.SNIPPETS;
    case 'nodePlugin':
      return ROUTES.DASHBOARD.PANEL.NODE_PLUGINS;
    case 'server':
      return ROUTES.DASHBOARD.FLEET.SERVERS;
    case 'panel':
      return ROUTES.DASHBOARD.PANEL.CONNECTION;
    case 'inbound':
      return ROUTES.DASHBOARD.PANEL.PROFILES;
  }
}

/** The kinds whose objects the dry run can take a change for. */
export const SEVERITY_KIND: Record<CheckSeverity, StatusKind> = {
  error: 'err',
  warning: 'warn',
  info: 'info',
};

export const STATUS_KIND: Record<ReconciliationStatus, StatusKind> = {
  ok: 'ok',
  drift: 'warn',
  missing: 'err',
  extra: 'rollback',
  unknown: 'wait',
};

export const RISK_KIND: Record<RiskLevel, StatusKind> = { low: 'ok', medium: 'warn', high: 'err' };

export function SeverityBadge({ severity }: { severity: CheckSeverity }) {
  const { t } = useTranslation('checks');
  return (
    <StatusBadge iconSize={16} kind={SEVERITY_KIND[severity]} size="md">
      {t(`ui.severity.${severity}`)}
    </StatusBadge>
  );
}

export function RiskBadge({ level, large = false }: { level: RiskLevel; large?: boolean }) {
  const { t } = useTranslation('checks');
  return (
    <StatusBadge kind={RISK_KIND[level]} size={large ? 'xl' : 'lg'}>
      {t(`ui.risk.${level}`)}
    </StatusBadge>
  );
}

export function ReconciliationStatusBadge({ status }: { status: ReconciliationStatus }) {
  const { t } = useTranslation('checks');
  return (
    <StatusBadge iconSize={16} kind={STATUS_KIND[status]} size="md">
      {t(`ui.status.${status}`)}
    </StatusBadge>
  );
}

/** The kind icon, and the name of the object. */
export function ObjectLabel({
  object,
  truncate = true,
}: {
  object: CheckObjectRef;
  truncate?: boolean;
}) {
  const { t } = useTranslation('checks');
  const Icon = KIND_ICON[object.kind];
  return (
    <Group gap="xs" miw={0} wrap="nowrap">
      <Icon
        aria-hidden
        size={16}
        {...{
          style: { color: `var(--mantine-color-${KIND_COLOR[object.kind]}-4)`, flexShrink: 0 },
        }}
      />
      <Text
        size="sm"
        title={`${t(`ui.kind.${object.kind}`)}: ${object.name}`}
        {...(truncate ? { truncate: 'end' as const } : {})}
      >
        {object.name}
      </Text>
    </Group>
  );
}

/**
 * The text of an engine message in the language of the console: the key the server sent, filled with its parameters, or
 * the English text the server sent when this console does not have the key (a newer server).
 */
export function useCheckText(): (key: string, fallback: string, params?: CheckParams) => string {
  const { t, i18n } = useTranslation('checks');
  const lookup = t as unknown as (key: string, options?: object) => string;
  return (key, fallback, params = {}) =>
    i18n.exists(key, { ns: 'checks' }) ? lookup(key, { ...params }) : fallback;
}
