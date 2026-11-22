// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the drawers that open an object of a list
// (src/shared/_modals/hosts/edit-host-modal/edit-host.modal.tsx, src/shared/_modals/nodes/edit-node-modal, the
// external-squads and config-profile drawers): a 700 px `Drawer` on the right titled with a soft icon, the name and the id
// (copy on a click), and the body in cards. Changes: one shell for every read-only drawer of the connected panel (no
// footer with a save button, nothing to save); the object stays on screen while the drawer fades out.
import { Drawer } from '@mantine/core';
import type { ElementType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { OverlayHeader } from '@swellwright/ui';

import { useLastDefined } from '../security/use-last-defined.js';

export interface PanelDrawerHeader {
  icon: ElementType<{ size?: number }>;
  iconColor?: string;
  title: string;
  /** The uuid of the object; it copies on a click. */
  subtitle?: string;
}

/** A read-only drawer for one object of a list: closed while `item` is undefined. */
export function PanelDrawer<T>({
  item,
  onClose,
  header,
  size = '700px',
  children,
}: {
  item: T | undefined;
  onClose: () => void;
  header: (item: T) => PanelDrawerHeader;
  size?: string;
  children: (item: T) => ReactNode;
}) {
  const { t } = useTranslation('common');
  const shown = useLastDefined(item);
  const head = shown === undefined ? undefined : header(shown);
  return (
    <Drawer
      // The first thing to take the focus is the close button, as in the panel (whose title cannot be focused).
      closeButtonProps={{ 'aria-label': t('close'), ...{ 'data-autofocus': true } }}
      onClose={onClose}
      opened={item !== undefined}
      padding="lg"
      position="right"
      size={size}
      title={
        head === undefined ? null : (
          <OverlayHeader
            icon={head.icon}
            iconColor={head.iconColor ?? 'teal'}
            title={head.title}
            truncateTitle
            {...(head.subtitle === undefined ? {} : { subtitle: head.subtitle, withCopy: true })}
          />
        )
      }
    >
      {shown === undefined ? null : children(shown)}
    </Drawer>
  );
}
