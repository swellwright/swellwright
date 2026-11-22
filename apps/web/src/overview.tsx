// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/pages/dashboard/home/components/home.page.tsx.
// Changes (ADR 0047): the Home page of the console is a dashboard. It opens with what needs attention (the card of the
// attention feed), then the sections the panel's Home has, in one order (the connected panel, the fleet with its health table,
// the checks, the snapshots, the system), each read from its own endpoint so that one that fails shows its own error and the
// page stays, and each left out when the role may not read its source or nothing is set up for it. The page reads again
// every minute while it is visible and has a refresh button on its first card.
import { Stack } from '@mantine/core';

import { AttentionCard } from './dashboard/attention-card.js';
import { FleetSection } from './dashboard/fleet-section.js';
import {
  ChecksSection,
  PanelSection,
  SnapshotsSection,
  SystemSection,
} from './dashboard/sections.js';
import { useConsole } from './shell/console-context.js';

export function Overview() {
  const { session } = useConsole();
  return (
    <Stack gap="sm">
      <AttentionCard />
      <PanelSection />
      {session.permissions.includes('servers:read') ? <FleetSection /> : null}
      <ChecksSection />
      <SnapshotsSection />
      <SystemSection />
    </Stack>
  );
}
