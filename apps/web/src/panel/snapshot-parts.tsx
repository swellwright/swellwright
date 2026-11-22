// New in Swellwright. The small pieces the snapshot screens share: how a snapshot is named, how its source and its "changes
// since" are drawn (the panel's status chips: `Badge size="lg" variant="soft"` with an icon and a word), the names of the
// kinds of objects, and a relative time for the Overview card.
import { Badge, Group, Text, Tooltip } from '@mantine/core';
import {
  IconClockPlay,
  IconFileImport,
  IconHistory,
  IconUser,
  type TablerIcon,
} from '@tabler/icons-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiWarningCircle } from 'react-icons/pi';

import {
  PANEL_SNAPSHOT_OBJECT_KINDS,
  type PanelSnapshotKind,
  type PanelSnapshotObjectKind,
  type PanelSnapshotSummary,
} from '@swellwright/contracts';

import { useDateTime } from '../format.js';

const SOURCE_STYLE: Record<PanelSnapshotKind, { icon: TablerIcon; color: string }> = {
  manual: { icon: IconUser, color: 'teal' },
  scheduled: { icon: IconClockPlay, color: 'cyan' },
  before_change: { icon: IconHistory, color: 'violet' },
  imported: { icon: IconFileImport, color: 'gray' },
};

/** Where a snapshot came from, as a soft chip with its glyph. */
export function SourceBadge({ kind }: { kind: PanelSnapshotKind }) {
  const { t } = useTranslation('snapshots');
  const { icon: Icon, color } = SOURCE_STYLE[kind];
  return (
    <Badge color={color} leftSection={<Icon aria-hidden size={18} />} size="lg" variant="soft">
      {t(`source.${kind}`)}
    </Badge>
  );
}

/** The name a snapshot is shown under: the one it was given, or its time. */
export function useSnapshotName(): (
  snapshot: Pick<PanelSnapshotSummary, 'label' | 'createdAt'>,
) => string {
  const { t } = useTranslation('snapshots');
  const formatTime = useDateTime();
  return (snapshot) => snapshot.label ?? t('untitled', { time: formatTime(snapshot.createdAt) });
}

/** The plural and the singular names of the kinds of object, in the language of the console. */
export function useKindNames(): {
  many: (kind: PanelSnapshotObjectKind) => string;
  one: (kind: PanelSnapshotObjectKind) => string;
} {
  const { t } = useTranslation('snapshots');
  return useMemo(
    () => ({
      many: (kind) => t(`kinds.${kind}`),
      one: (kind) => t(`kindsOne.${kind}`),
    }),
    [t],
  );
}

/** The kinds a snapshot could not read, as one sentence; null when it is complete. */
export function useIncompleteText(): (snapshot: PanelSnapshotSummary) => string | null {
  const { t } = useTranslation('snapshots');
  const names = useKindNames();
  return (snapshot) => {
    const missing = PANEL_SNAPSHOT_OBJECT_KINDS.filter((kind) => snapshot.coverage[kind] !== 'ok');
    return missing.length === 0
      ? null
      : t('incomplete', { kinds: missing.map((kind) => names.many(kind)).join(', ') });
  };
}

/** How many objects differed when the panel was last compared with the snapshot: a chip, or a dash when never compared. */
export function ChangesSince({
  snapshot,
}: {
  snapshot: Pick<PanelSnapshotSummary, 'changesSince' | 'checkedAt'>;
}) {
  const { t } = useTranslation('snapshots');
  const formatTime = useDateTime();
  if (snapshot.changesSince === null) {
    return (
      <Tooltip label={t('since.unknown')} withArrow>
        <Text c="dimmed" fz="sm">
          –
        </Text>
      </Tooltip>
    );
  }
  const none = snapshot.changesSince === 0;
  const text = none ? t('since.none') : String(snapshot.changesSince);
  const label = [
    none ? t('since.none') : t('since.differ', { count: snapshot.changesSince }),
    snapshot.checkedAt === null
      ? null
      : t('since.checked', { time: formatTime(snapshot.checkedAt) }),
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <Tooltip label={label} withArrow>
      <Badge color={none ? 'teal' : 'orange'} size="lg" variant="soft">
        {text}
      </Badge>
    </Tooltip>
  );
}

/** The warning glyph that says a snapshot does not hold every kind of object. */
export function IncompleteMark({ text }: { text: string }) {
  return (
    <Tooltip label={text} multiline w={260} withArrow>
      <Group component="span" gap={0} style={{ color: 'var(--mantine-color-orange-4)' }}>
        <PiWarningCircle aria-label={text} role="img" size={16} />
      </Group>
    </Tooltip>
  );
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "3 hours ago", in the language of the console, from the largest unit that fits. */
export function useRelativeTime(): (value: string | number | Date) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
    return (value) => {
      const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
      for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size) {
          return format.format(Math.trunc(seconds / size), unit);
        }
      }
      return format.format(Math.trunc(seconds / 60), 'minute');
    };
  }, [language]);
}
