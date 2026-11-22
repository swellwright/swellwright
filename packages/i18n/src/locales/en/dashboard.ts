/** The dashboard on the Overview page: the attention feed and the health of the fleet (apps/web/src/dashboard/*, ADR 0047). */
export const dashboard = {
  signInAgain: 'Your session has ended. Sign in again.',
  readForbidden: 'Your role does not allow this.',

  attention: {
    title: 'Needs attention',
    description: 'What to look at first, from what this server already knows.',
    empty: {
      title: 'Nothing needs attention',
      text: 'Everything your role can see is in order.',
    },
    groups: {
      critical: 'Critical',
      warning: 'Warnings',
      info: 'For information',
    },
    since: 'since {{when}}',
    open: 'Open',
    hide: 'Hide for this browser',
    hiddenCount: 'Hidden in this browser: {{count}}',
    showMore: 'Show {{count}} more',
    showLess: 'Show fewer',
    showHidden: 'Show them again',
    andMore: 'and {{count}} more',
    failedSources: 'Could not read: {{sources}}. The rest is shown.',
    loadFailed: 'Could not read what needs attention',
    sources: {
      vault: 'the vault',
      panel: 'the panel connection',
      conventions: 'the conventions',
      reconciliation: 'the reconciliation',
      snapshots: 'the snapshots',
      baseline: 'the baseline checks',
      servers: 'the servers',
      runs: 'the runs',
      audit: 'the audit log',
      plugins: 'the plugins',
      updates: 'the updates',
    },
    /** The texts of each kind of item (`kinds` of the API contract); the server sends English texts too. */
    kinds: {
      vault: {
        secrets_expired: {
          title: 'Expired vault secrets: {{count}}',
          detail:
            'Anything that uses an expired secret is refused: {{names}}. Renew or replace them.',
        },
        secrets_expiring: {
          title: 'Vault secrets that expire soon: {{count}}',
          detail: 'Days left on the first one: {{soonestDays}}. {{names}}.',
        },
        sealed: {
          title: 'The vault is sealed',
          detail:
            'Server logins, runs and the panel connection cannot work until someone unseals it.',
        },
        uninitialized: {
          title: 'The vault is not set up',
          detail: 'Set it up to keep the secrets of your servers and your panel.',
        },
      },
      panel: {
        unauthorized: {
          title: 'The panel refuses the token',
          detail: 'The token is expired, revoked or wrong. Connect with a new one.',
        },
        token_expired: {
          title: 'The panel token has expired',
          detail: 'Create a new token in the panel and connect with it.',
        },
        unreachable: {
          title: 'The panel does not answer',
          detail:
            'The last check could not reach it: network, certificate, timeout or a server error.',
        },
        unsupported: {
          title: 'The panel version is not supported',
          detail: 'The version of the panel is outside what this release reads.',
        },
        degraded: {
          title: 'The panel connection is limited',
          detail: 'It works, but the token cannot read everything, or a read failed.',
        },
        token_expiring: {
          title: 'The panel token expires soon',
          detail:
            'Days left: {{daysLeft}}. Create a new token in the panel and connect with it before then.',
        },
        not_connected: {
          title: 'No panel is connected',
          detail: 'Connect a Remnawave panel to see its nodes, hosts and profiles here.',
        },
      },
      conventions: {
        errors: {
          title: 'Convention errors in the panel: {{errors}}',
          detail: 'In the last run, errors: {{errors}}, warnings: {{warnings}}.',
        },
        warnings: {
          title: 'Convention warnings in the panel: {{warnings}}',
          detail: 'The last run found no errors.',
        },
        not_run: {
          title: 'The conventions have not been checked yet',
          detail: 'Run the checks to see whether the panel follows your rules.',
        },
      },
      reconciliation: {
        drift: {
          title: 'Differences between the panel and the inventory: {{total}}',
          detail:
            'In the last reconciliation, drifting: {{drift}}, missing: {{missing}}, extra: {{extra}}.',
        },
        undecided: {
          title: 'Comparisons that could not be decided: {{unknown}}',
          detail: 'A name did not resolve in time, or nothing serves an inbound.',
        },
      },
      snapshots: {
        stale: {
          title: 'The last snapshot of the panel is old',
          detail: 'Hours since a snapshot was taken or compared: {{ageHours}}.',
        },
        none: {
          title: 'No snapshot of the panel yet',
          detail: 'Take one to be able to see what changes.',
        },
        changed: {
          title: 'Changes in the panel since the last snapshot: {{changes}}',
          detail: 'Compare the panel with the snapshot to see what changed.',
        },
      },
      baseline: {
        host_key_mismatch: {
          title: 'Servers whose host key changed: {{count}}',
          detail:
            'The check refused to log in: {{names}}. Find out why before you pin the new key.',
        },
        failing: {
          title: 'Servers that fail their baseline: {{servers}}',
          detail: 'Failed checks: {{checks}}. {{names}}.',
        },
        unreachable: {
          title: 'Servers that could not be checked: {{count}}',
          detail: 'The last check could not observe {{names}}.',
        },
        stale: {
          title: 'Servers not checked lately: {{count}}',
          detail: 'The newest check is past the {{days}}-day limit: {{names}}.',
        },
        warnings: {
          title: 'Servers with baseline warnings: {{servers}}',
          detail: 'Checks that warn: {{checks}}. {{names}}.',
        },
        never_checked: {
          title: 'Servers that were never checked: {{count}}',
          detail: 'A baseline applies, but no check has finished: {{names}}.',
        },
      },
      servers: {
        not_ready: {
          title: 'Servers not ready to be managed: {{count}}',
          detail:
            'Without a pinned host key: {{noKey}}. Without an access entry: {{noAccess}}. {{names}}.',
        },
        facts_stale: {
          title: 'Servers with old or missing facts: {{count}}',
          detail:
            'Past the {{days}}-day limit: {{stale}}. Never collected: {{missing}}. {{names}}.',
        },
      },
      runs: {
        failed: {
          title: 'Failed runs of commands: {{count}}',
          detail:
            'Within a {{hours}}-hour window. Open the history to see which servers failed and why.',
        },
      },
      audit: {
        chain_failed: {
          title: 'The last check of the audit chain failed',
          detail:
            'The chain does not verify: a record is missing or was changed. Treat it as an incident and check it again.',
        },
        verify_overdue: {
          title: 'The audit chain has not been verified for a while',
          detail: 'Verify it from time to time to know that the log was not changed.',
        },
      },
      plugins: {
        switched_off: {
          title: 'Plugins that were switched off: {{count}}',
          detail:
            'Their files are gone, unusable or changed since they were approved: {{names}}. Review and enable them again.',
        },
      },
      updates: {
        available: {
          title: 'Version {{latest}} is available',
          detail: 'This server runs {{current}}.',
        },
      },
    },
  },

  fleet: {
    title: 'Fleet health',
    description:
      'One row per server, from what this server has stored. Nothing here connects to a server.',
    refresh: 'Refresh the fleet',
    openServers: 'Open the servers',
    loadFailed: 'Could not read the health of the fleet',
    empty: 'No servers in the inventory yet.',
    emptyFiltered: 'No server matches the filters.',
    asOfPanel: 'As of the reconciliation at {{when}}',
    columns: {
      server: 'Server',
      health: 'Health',
      baseline: 'Baseline',
      lastCheck: 'Last check',
      facts: 'Facts',
      hostKey: 'Host key',
      access: 'Access',
      node: 'Panel node',
      flags: 'Flags',
    },
    health: {
      critical: 'Critical',
      warning: 'Warning',
      ok: 'In order',
      unknown: 'Not known yet',
    },
    baselineStatus: {
      pass: 'Passes',
      warn: 'Warnings',
      fail: 'Fails',
      unreachable: 'Not reached',
      never: 'Never checked',
      unassigned: 'No baseline',
    },
    baselineCounts: '{{fail}} failed, {{warn}} warn',
    never: 'Never',
    hostKeyPinned: 'Pinned',
    hostKeyMissing: 'Not pinned',
    access: {
      none: 'No entry',
      usable: '{{usable}} of {{entries}} usable',
      expired: 'All expired',
      failed: 'Last try failed',
    },
    node: {
      online: 'Online',
      offline: 'Offline',
      connecting: 'Connecting',
      disabled: 'Disabled',
    },
    factsNone: 'None yet',
    flags: {
      no_host_key: 'No pinned host key',
      no_access: 'No access entry',
      access_expired: 'An access secret has expired',
      access_failed: 'Every access entry failed its last try',
      facts_missing: 'Facts never collected',
      facts_stale: 'Facts are old',
      baseline_failing: 'Fails its baseline',
      baseline_warning: 'Baseline warnings',
      baseline_unreachable: 'Could not be checked',
      baseline_stale: 'Not checked lately',
      baseline_never_checked: 'Never checked',
      host_key_mismatch: 'The host key changed',
      node_offline: 'Its node is offline',
      check_running: 'A check is running',
    },
    row: {
      openServer: 'Open the server',
      openBaseline: 'Open the baseline results',
    },
  },
} as const;
