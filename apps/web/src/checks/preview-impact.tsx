// New in Swellwright (ADR 0044): the way from an object of the panel to the dry run of a change to it. The profile and squad
// drawers (and the others) carry this button; it opens the Impact tab of the Checks page with the object chosen.
import { Button } from '@mantine/core';
import { TbChecklist } from 'react-icons/tb';
import { Link } from 'react-router';

import type { ImpactKind } from '@swellwright/contracts';

import { ROUTES } from '../routes.js';
import { useConsole } from '../shell/console-context.js';

/** The address of the Impact tab with an object chosen. */
export const impactLink = (kind: ImpactKind, uuid: string): string =>
  `${ROUTES.DASHBOARD.PANEL.CHECKS}?tab=impact&kind=${kind}&uuid=${uuid}`;

/** A button that opens the dry run for this object. Shown only to someone who may read the panel. */
export function PreviewImpactButton({
  kind,
  uuid,
  label,
  fullWidth = false,
}: {
  kind: ImpactKind;
  uuid: string;
  label: string;
  fullWidth?: boolean;
}) {
  const { session } = useConsole();
  if (!session.permissions.includes('panel:read')) {
    return null;
  }
  return (
    <Button
      color="cyan"
      component={Link}
      fullWidth={fullWidth}
      leftSection={<TbChecklist size={18} />}
      to={impactLink(kind, uuid)}
      variant="light"
    >
      {label}
    </Button>
  );
}
