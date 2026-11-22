// Small parts shared by the baseline pages: the chips of a result, the counts of a run, the trend mark, and the words
// for an expectation and for why a server could not be checked. The chips are the panel's (`StatusBadge`, a soft badge
// with an icon and a word, never a colour alone); the counts are the soft badges of its tables.
import { Badge, Group, Text, Tooltip } from '@mantine/core';
import { IconArrowDownRight, IconArrowUpRight, IconEqual } from '@tabler/icons-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { CheckCounts, CheckStatus, Comparator } from '@swellwright/contracts';
import type { Namespace } from '@swellwright/i18n';
import { StatusBadge, type StatusKind } from '@swellwright/ui';

/** Every status is a kind of the panel's status vocabulary: an unknown is violet, so it is not taken for a warning. */
export const STATUS_KIND: Readonly<Record<CheckStatus, StatusKind>> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'err',
  error: 'rollback',
  skipped: 'wait',
};

const COUNT_COLOR: Readonly<Record<keyof CheckCounts, string>> = {
  pass: 'teal',
  warn: 'orange',
  fail: 'red',
  error: 'violet',
  skipped: 'gray',
};

/** The chip of one result: an icon and a word, with a tooltip that says what the status means. */
export function CheckStatusBadge({
  status,
  size = 'md',
}: {
  status: CheckStatus;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { t } = useTranslation('baseline');
  return (
    <Tooltip label={t(`statusHelp.${status}`)} withArrow>
      <span>
        <StatusBadge iconSize={size === 'lg' ? 18 : 14} kind={STATUS_KIND[status]} size={size}>
          {t(`status.${status}`)}
        </StatusBadge>
      </span>
    </Tooltip>
  );
}

/** What a run found, as small counts: only the kinds that are not zero, and the passes when everything passed. */
export function CountBadges({ counts }: { counts: CheckCounts }) {
  const { t } = useTranslation('baseline');
  const shown = (['fail', 'warn', 'error'] as const).filter((key) => counts[key] > 0);
  const keys = shown.length === 0 ? (['pass'] as const) : shown;
  return (
    <Group gap={4} wrap="nowrap">
      {keys.map((key) => (
        <Tooltip key={key} label={t(`status.${key}`)} withArrow>
          <Badge color={COUNT_COLOR[key]} size="lg" tt="none" variant="soft">
            {counts[key]}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}

/** An arrow for better or worse than the check before; a plain dash for the same, nothing for no comparison. */
export function TrendMark({ trend }: { trend: 'better' | 'worse' | 'same' | null }) {
  const { t } = useTranslation('baseline');
  if (trend === null) {
    return (
      <Text c="dimmed" fz="sm">
        –
      </Text>
    );
  }
  const Icon =
    trend === 'better' ? IconArrowUpRight : trend === 'worse' ? IconArrowDownRight : IconEqual;
  const color = trend === 'better' ? 'teal' : trend === 'worse' ? 'red' : 'gray';
  return (
    <Tooltip label={t(`trend.${trend}`)} withArrow>
      <Icon
        aria-label={t(`trend.${trend}`)}
        color={`var(--mantine-color-${color}-4)`}
        role="img"
        size={20}
      />
    </Tooltip>
  );
}

/** A value of a result as a short text: a list is its entries joined, nothing is an en dash. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return '–';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : value.map((entry) => valueText(entry)).join(', ');
  }
  if (typeof value === 'string') {
    return value === '' ? '""' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** What an expectation says, in words: `at most 90`, `equals no`. */
export function expectationText(
  t: TFunction<Namespace[]>,
  comparator: Comparator,
  value: unknown,
): string {
  return t(`baseline:expect.${comparator}`, { value: valueText(value) });
}

/** The codes that have a text of their own. */
const KNOWN_ERRORS = [
  'host_key_mismatch',
  'host_key_not_pinned',
  'no_access_entry',
  'ssh_auth_failed',
  'ssh_key_invalid',
  'ssh_connect_failed',
  'ssh_timeout',
  'ssh_failed',
  'address_not_allowed',
  'secret_expired',
  'vault_sealed',
  'check_timeout',
  'observe_failed',
  'observe_lost',
  'observe_unreadable',
  'baseline_deleted',
  'interrupted',
  'internal_error',
] as const;

/** Why a server could not be checked: the text of its code, or the message the server gave. */
export function runErrorText(
  t: TFunction<Namespace[]>,
  code: string | null,
  message: string | null,
): string {
  if (code !== null && (KNOWN_ERRORS as readonly string[]).includes(code)) {
    return t(`baseline:errors.${code as (typeof KNOWN_ERRORS)[number]}`);
  }
  return message ?? code ?? '';
}
