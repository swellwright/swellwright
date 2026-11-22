/** The Overview page (apps/web/src/overview.tsx). */
export const overview = {
  title: 'Overview',

  sections: {
    panel: 'Remnawave panel',
    fleet: 'Fleet',
    checks: 'Checks',
    snapshots: 'Snapshots',
    system: 'System',
  },

  /** The Fleet section: the servers of the inventory by their health (the numbers of `GET /dashboard/fleet`). */
  fleet: {
    servers: 'Servers',
    serversOk: 'In order: {{ok}}',
    serversNone: 'The inventory is empty',
    critical: 'Critical',
    warning: 'With warnings',
    unknown: 'Not known yet',
  },

  /** The Checks section: the last reconciliation of the panel with the inventory. */
  reconciliation: {
    title: 'Reconciliation',
    notYet: 'Not run yet',
    notYetHint: 'Run it on the Checks page',
    clean: 'The panel and the inventory agree',
    breakdown: 'Drifting: {{drift}}, missing: {{missing}}, extra: {{extra}}',
  },

  /** The Snapshots section. */
  snapshots: {
    changes: 'Changes since the snapshot',
    changesNone: 'None',
    changesUnknown: 'Not known',
  },

  stats: {
    api: 'API',
    alive: 'Alive',
    dependencies: 'Dependencies',
    ready: 'Ready',
    notReady: 'Not ready',
    version: 'Version',
    dependenciesSummary: '{{up}} of {{total}} up',
  },

  /** The block of the connected Remnawave panel (apps/web/src/panel/overview-block.tsx). */
  panel: {
    title: 'Remnawave panel',
    connect: 'Connect a panel',
    notConnectedTitle: 'No panel is connected',
    notConnectedText:
      'Connect your Remnawave panel to see its nodes, hosts, profiles and users here.',
    notConnectedTextNoRight:
      'Ask someone who may change the connection to connect a Remnawave panel.',
    version: 'Panel version',
    supported: 'Supported: {{range}}',
    unsupported: 'Not supported by this release',
    nodesOnline: 'Online nodes',
    ofTotal: 'of {{total}}',
    nodesTrouble: 'Problem nodes',
    health: 'Health',
    healthOk: 'OK',
    healthUnknown: 'Unknown',
    instances_one: '{{count}} process reports',
    instances_other: '{{count}} processes report',
    hosts: 'Hosts',
    profiles: 'Config profiles',
    users: 'Users',
    usersOnline_one: '{{count}} online now',
    usersOnline_other: '{{count}} online now',
    token: 'Token expires in',
    tokenDays_one: '{{count}} day',
    tokenDays_other: '{{count}} days',
    tokenExpired: 'Expired',
    tokenNoExpiry: 'No expiry date',
    snapshot: 'Last snapshot',
    snapshotNone: 'None yet',
    snapshotNoneHint: 'Take one on the Snapshots page',
    snapshotChanges_one: '{{count}} object changed since',
    snapshotChanges_other: '{{count}} objects changed since',
    snapshotSame: 'The panel is as it was',
    snapshotUnknown: 'Not compared with the panel yet',
  },

  checks: {
    title: 'Dependency checks',
    apiDescription: 'API description',
    noneTitle: 'Nothing to check yet',
    none: 'No dependencies are configured yet. Set SW_DATABASE_URL and SW_VALKEY_URL to have them checked here.',
    up: 'Up',
    down: 'Down',
    latencyValue: '{{ms}} ms',
  },

  error: {
    unreachableTitle: 'The API does not answer',
    unreachableText:
      'Start the API (pnpm --filter @swellwright/api start) or check the reverse proxy, then try again.',
    unexpectedTitle: 'The API answered with something unexpected',
    unexpectedText:
      'The response does not match the API contract. The API and the console are probably from different versions.',
  },
} as const;
