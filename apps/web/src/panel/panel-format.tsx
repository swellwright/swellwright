// New in Swellwright. The words and glyphs the pages of the connected panel share: how a connection state or a node state
// is drawn (the panel's status chips: `Badge size="lg" variant="soft"`, an icon and a word), and the formats the
// panel uses for traffic and durations (src/shared/utils/bytes and time-utils).
import { ActionIcon, ThemeIcon } from '@mantine/core';
import {
  PiCloudArrowUpDuotone,
  PiProhibit,
  PiProhibitDuotone,
  PiPulse,
  PiPulseDuotone,
  PiWarningCircle,
} from 'react-icons/pi';
import { TbEyeOff } from 'react-icons/tb';

import type { PanelConnectionState, PanelNodeState } from '@swellwright/contracts';
import type { StatusKind } from '@swellwright/ui';

/** The kind of chip a connection state is drawn with. */
export const CONNECTION_STATE_KIND: Record<PanelConnectionState, StatusKind> = {
  unconfigured: 'wait',
  connected: 'ok',
  degraded: 'warn',
  unreachable: 'err',
  unauthorized: 'err',
  unsupported: 'err',
};

/** The glyph and colour of a node state: the panel's `NodeStatusSimplfiedBadgeWidget`, which the Nodes table shows. */
const NODE_STATE_ICON: Record<
  PanelNodeState,
  { color: string; glyph: string; Icon: typeof PiPulseDuotone }
> = {
  online: { color: 'teal', glyph: 'var(--mantine-color-teal-6)', Icon: PiPulseDuotone },
  connecting: {
    color: 'var(--mantine-color-yellow-3)',
    glyph: 'var(--mantine-color-yellow-3)',
    Icon: PiCloudArrowUpDuotone,
  },
  disabled: { color: 'gray', glyph: 'var(--mantine-color-gray-6)', Icon: PiProhibitDuotone },
  offline: { color: 'red', glyph: 'var(--mantine-color-red-3)', Icon: PiWarningCircle },
};

/** The outlined square icon of a node state in a table row. */
export function NodeStateIcon({ state }: { state: PanelNodeState }) {
  const { color, glyph, Icon } = NODE_STATE_ICON[state];
  return (
    <ThemeIcon color={color} size="md" variant="outline">
      <Icon size={18} style={{ color: glyph }} />
    </ThemeIcon>
  );
}

/** The colour and glyph of a node state, for a menu entry that names it. */
export function nodeStateAppearance(state: PanelNodeState): {
  Icon: typeof PiPulseDuotone;
  glyph: string;
} {
  const { Icon, glyph } = NODE_STATE_ICON[state];
  return { Icon, glyph };
}

const DASH = '–';

/** A duration as the panel prints it: the two largest units (`3d 4h`, `2h 5m`, `45s`). */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds <= 0) {
    return DASH;
  }
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return `${String(days)}d ${String(hours)}h`;
  }
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m`;
  }
  if (minutes > 0) {
    return `${String(minutes)}m ${String(seconds % 60)}s`;
  }
  return `${String(seconds)}s`;
}

/** The first eight characters of a hash: enough to tell two apart, with the whole value on a click or a tooltip. */
export const shortHash = (hash: string): string => hash.slice(0, 8);

/** An en dash for nothing, as everywhere in the console. */
export const orDash = (value: null | number | string | undefined): string =>
  value === null || value === undefined || value === '' ? DASH : String(value);

export type HostStatus = 'disabled' | 'enabled' | 'hidden';

/** The status of a host as the panel draws it: a soft square icon, teal when it is served, gray when disabled, violet when hidden. */
export function StatusGlyph({ status }: { status: HostStatus }) {
  const color = status === 'disabled' ? 'gray' : status === 'hidden' ? 'violet' : 'teal';
  const Icon = status === 'disabled' ? PiProhibit : status === 'hidden' ? TbEyeOff : PiPulse;
  return (
    <ActionIcon color={color} component="div" size="lg" style={{ flexShrink: 0 }} variant="soft">
      <Icon size={16} />
    </ActionIcon>
  );
}
