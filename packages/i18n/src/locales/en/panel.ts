/**
 * The pages of the connected Remnawave panel (apps/web/src/panel): Panel > Connection, and the read-only pages of its
 * nodes, hosts, config profiles, squads, templates and snippets (ADR 0041). The names of the panel's own objects
 * follow the panel's English (nodes, hosts, config profiles, internal and external squads, templates, snippets).
 */
export const panel = {
  signInAgain: 'Sign in again to continue.',
  readForbidden: 'Your role cannot read the connected panel.',
  refreshFailed: 'The panel was not asked again',
  copyUuid: 'Copy UUID',
  copyHash: 'Copy hash',

  /** The note above every configuration shown in a code viewer. */
  masked:
    'Secrets are masked. A value like [masked:1a2b3c4d] stands for a key, password or id that Swellwright never shows; the same value always gets the same code, so a change is visible.',

  filter: {
    all: 'All',
    untagged: 'Untagged',
  },

  /** A page of the panel when no panel is connected. */
  notConnected: {
    title: 'No panel is connected',
    text: 'Swellwright reads the nodes, hosts, profiles and squads of your Remnawave panel. Connect a panel to see them here.',
    textNoRight:
      'Swellwright reads the nodes, hosts, profiles and squads of your Remnawave panel. Ask someone who may change the connection to connect a panel.',
    connect: 'Connect a panel',
  },

  /** The card a page shows when the panel could not be read. */
  errorCard: {
    title: 'The panel could not be read',
    testLink: 'Test the connection',
  },

  connection: {
    title: 'Connection',
    description: 'The Remnawave panel that Swellwright reads from',
    loadFailed: 'The connection could not be loaded',
    noWrite: 'Your role can read the panel but not change the connection.',

    status: {
      title: 'Status',
      empty: 'No panel is connected yet. Fill in the form below to connect one.',
    },

    /** The state the last check found. */
    states: {
      unconfigured: 'Not connected',
      connected: 'Connected',
      degraded: 'Connected, with limits',
      unreachable: 'Unreachable',
      unauthorized: 'Token refused',
      unsupported: 'Unsupported version',
    },
    stateHints: {
      unconfigured: 'Nothing is connected.',
      connected: 'The panel answers, the token works and every kind of object can be read.',
      degraded: 'It works, but the token cannot read some kinds of object, or it expires soon.',
      unreachable: 'The panel did not answer: network, certificate, timeout or a server error.',
      unauthorized: 'The panel refused the token: it may be expired, revoked or mistyped.',
      unsupported: 'The version of the panel is outside what this release is tested against.',
    },

    rows: {
      state: 'State',
      address: 'Address',
      version: 'Panel version',
      versionWhy: 'Why',
      token: 'Token (vault secret)',
      tokenExpires: 'Token expires',
      lastCheck: 'Last check',
      latency: 'Response time',
      ownCa: 'Own certificate authority',
    },

    version: {
      supported: 'Supported: {{range}}',
      unsupported: 'Not supported',
    },

    token: {
      noExpiry: 'This token carries no expiry date',
      expired: 'Expired',
      daysLeft_one: '{{count}} day left',
      daysLeft_other: '{{count}} days left',
    },

    warnings: {
      tokenExpiring_one:
        'The token expires in {{count}} day. Make a new one in the panel and connect with it.',
      tokenExpiring_other:
        'The token expires in {{count}} days. Make a new one in the panel and connect with it.',
      capabilitiesLimited:
        'The token cannot read some kinds of object. Pages that need them will say so; give the token those scopes in the panel to read them.',
    },

    test: {
      button: 'Test connection',
      done: 'The panel answered in {{ms}} ms.',
      latency: '{{ms}} ms',
      failed: 'The connection was not tested',
    },

    disconnect: {
      button: 'Disconnect',
      title: 'Disconnect from the panel?',
      text: 'Swellwright forgets this connection and what it read. The token stays in the vault and nothing is changed on the panel.',
      confirm: 'Disconnect',
      done: 'Disconnected',
      doneText: 'The token stays in the vault.',
      failed: 'The panel was not disconnected',
    },

    capabilities: {
      title: 'What the token can read',
      description: 'Found by reading each kind of object once.',
      none: 'Not checked yet. Test the connection to find out.',
      ok: 'Readable',
      denied: 'No scope',
      failed: 'Failed',
      apiTokensNote:
        'The panel never lets an API token list API tokens, so "No scope" on that line is normal.',
      checkedAt: 'Checked {{time}}',
    },

    /** The kinds of object this release reads, by `PANEL_RESOURCES`. */
    resources: {
      system: 'System',
      nodes: 'Nodes',
      hosts: 'Hosts',
      configProfiles: 'Config profiles',
      internalSquads: 'Internal squads',
      externalSquads: 'External squads',
      subscriptionTemplates: 'Subscription templates',
      subscriptionSettings: 'Subscription settings',
      snippets: 'Snippets',
      nodePlugins: 'Node plugins',
      infra: 'Infra billing',
      apiTokens: 'API tokens',
    },

    form: {
      titleConnect: 'Connect a panel',
      titleChange: 'Change the connection',
      description: 'The address of the panel and the API token Swellwright reads it with.',
      address: 'Panel address',
      addressHint: 'The address people open the panel at. https only, with no login in it.',
      addressError: 'Enter the address of the panel.',
      tokenSource: 'Token',
      fromVault: 'From the vault',
      paste: 'Paste a new token',
      pasteNeedsVault:
        'Pasting a token stores it in the vault, which needs the permission to manage secrets. Ask an owner, or choose a token that is in the vault already.',
      secret: 'Vault secret',
      secretHint: 'A secret of the kind "Panel token". The token itself is never shown.',
      chooseSecret: 'Choose a secret',
      noSecrets: 'No secret of the kind {{kind}} in the vault.',
      secretError: 'Choose the secret that holds the token.',
      secretsFailed: 'The secrets of the vault could not be read.',
      token: 'API token',
      tokenHint: 'As the panel showed it. It goes into the vault and is not kept anywhere else.',
      tokenError: 'The token is too short.',
      secretName: 'Name in the vault',
      secretNameHint: 'The secret is stored under this name, as a Panel token.',
      secretNameError: 'Enter a name of up to 100 characters.',
      defaultSecretName: 'Panel token',
      advanced: 'Advanced',
      ca: 'Own certificate authority',
      caHint:
        'For a panel with a private or self-signed certificate: the certificate authority in PEM form. It is public, not a secret. Leave empty to use the system trust store.',
      removeCa: 'Remove the certificate authority that is set',
      connect: 'Connect',
      save: 'Save and test',
      connected: 'The panel answered, and the connection is saved.',
      failed: 'The panel was not connected',
    },

    help: {
      title: 'What the token needs',
      description: 'Made in the panel, with read scopes only.',
      scopes:
        'Make an API token in the panel that can read what you want to see here: nodes, hosts, config profiles, squads, subscription templates, snippets. A token with fewer scopes still works; the pages that need more say so.',
      readOnly: 'Swellwright only sends read requests to the panel. Nothing is changed there.',
      apiTokens:
        'The panel does not let a token list API tokens, so that line stays "No scope". The expiry date is read from the token itself.',
      vault:
        'The token is kept in the <vault>vault</vault>, encrypted, and the connection names it by its secret.',
      vaultNoRight:
        'The token is kept in the vault, encrypted, and the connection names it by its secret.',
    },
  },

  nodes: {
    title: 'Nodes',
    empty: 'No nodes found.',
    open: 'View',
    openNamed: 'Open node {{name}}',

    metrics: {
      online: 'Online nodes',
      trouble: 'Problem nodes',
      users: 'Users online',
      traffic: 'Traffic used',
    },

    states: {
      online: 'Connected',
      connecting: 'Connecting',
      offline: 'Disconnected',
      disabled: 'Disabled',
    },

    columns: {
      name: 'Name',
      status: 'Status',
      online: 'Online',
      address: 'Address',
      port: 'Port',
      ips: 'IP addresses',
      trafficUsed: 'Traffic used',
      profile: 'Config profile',
      inbounds: 'Inbounds',
      consumption: 'User consumption multiplier',
      nodeConsumption: 'Node consumption multiplier',
      xray: 'Xray v.',
      xrayUptime: 'Xray uptime',
      node: 'Node v.',
      provider: 'Provider',
      tags: 'Tags',
      cpus: 'CPU cores',
      ramUsed: 'Used RAM',
      ramTotal: 'Total RAM',
      serverUptime: 'Server uptime',
      release: 'OS release',
    },

    drawer: {
      status: 'Status',
      statusChanged: 'Status changed',
      general: 'General',
      country: 'Country',
      note: 'Note',
      profile: 'Config profile',
      noInbounds: 'No active inbounds.',
      traffic: 'Traffic',
      tracking: 'Traffic tracking',
      limit: 'Traffic limit',
      noLimit: 'No limit',
      resetDay: 'Reset day',
      notifyPercent: 'Notify at',
      noIps: 'The panel lists no IP addresses for this node.',
      system: 'System',
      hostname: 'Host name',
      platform: 'Platform',
      memory: 'Memory (used / total)',
      uptime: 'Uptime',
      load: 'Load average',
      ids: 'Record',
      created: 'Created',
      updated: 'Updated',
    },
  },

  hosts: {
    title: 'Hosts',
    empty: 'No hosts found.',
    open: 'View',
    openNamed: 'Open host {{name}}',

    statuses: {
      enabled: 'Enabled',
      disabled: 'Disabled',
      hidden: 'Hidden',
    },

    fields: {
      status: 'Status',
      remark: 'Remark',
      address: 'Address',
      port: 'Port',
      host: 'Host',
      path: 'Path',
      serverDescription: 'Server description',
      pinnedPeerCert: 'Pinned peer cert',
      verifyPeerCertByName: 'Verify peer cert by name',
      profile: 'Config profile',
      inbound: 'Inbound',
      tags: 'Tags',
      securityLayer: 'Security layer',
      fingerprint: 'Fingerprint',
      excludeFromSubscriptionTypes: 'Exclude from subscription type',
      nodes: 'Nodes',
      internalSquads: 'Internal squads',
      overrideType: 'Override type',
      xrayJsonTemplate: 'Xray JSON template',
      overrideSniFromAddress: 'Override SNI from address',
      keepSniBlank: 'Keep SNI blank',
      shuffleHost: 'Shuffle host',
      mihomoX25519: 'Enable X25519MLKEM768',
      xhttpExtra: 'Extra XHTTP',
    },

    groups: {
      assignment: 'Assignment',
      security: 'Security',
      transport: 'Transport',
      subscription: 'Subscription',
      advanced: 'Advanced',
      client: 'Client',
    },

    /** The options of a host that is set, by their name in the panel's form. */
    options: {
      tags: 'Tags',
      nodes: 'Nodes',
      internalSquads: 'Internal squads',
      sni: 'SNI',
      overrideSniFromAddress: 'Override SNI from address',
      keepSniBlank: 'Keep SNI blank',
      securityLayer: 'Security layer',
      fingerprint: 'Fingerprint',
      vlessRouteId: 'VLESS Route ID',
      host: 'Host',
      path: 'Path',
      alpn: 'ALPN',
      serverDescription: 'Server description',
      excludeFromSubscriptionTypes: 'Exclude from subscription type',
      includeInSrrRules: 'Include in response rules',
      isHidden: 'Hidden',
      shuffleHost: 'Shuffle host',
      xrayJsonTemplate: 'Xray JSON template',
      mapper: 'Mapper',
      muxParams: 'Mux parameters',
      finalMask: 'Final mask',
      xhttpExtraParams: 'Extra XHTTP parameters',
      sockoptParams: 'Sockopt parameters',
      pinnedPeerCertSha256: 'Pinned peer cert (SHA-256)',
      verifyPeerCertByName: 'Verify peer cert by name',
      mihomoX25519: 'Enable X25519MLKEM768',
      mihomoIpVersion: 'Mihomo IP version',
    },

    drawer: {
      visibility: 'Host visibility',
      options: 'Options',
      noOptions: 'No options are set on this host.',
      noInbound: 'No inbound selected',
    },
  },

  profiles: {
    title: 'Config profiles',
    empty: 'No config profiles',
    emptyText: 'The panel has no config profile yet.',
    openAria: 'Open config profile {{name}}',
    menuAria: 'Actions for config profile {{name}}',
    view: 'View configuration',
    inbounds: 'Inbounds',
    nodes: 'Nodes',

    drawer: {
      overview: 'Profile',
      name: 'Name',
      tags: 'Tags',
      hash: 'Hash',
      hashNote:
        'The hash covers the masked configuration. When it changes, somebody edited the profile; it does not change when a node restarts.',
      created: 'Created',
      updated: 'Updated',
      inbounds_one: '{{count}} inbound',
      inbounds_other: '{{count}} inbounds',
      noInbounds: 'This profile has no inbounds.',
      nodes_one: 'Runs on {{count}} node',
      nodes_other: 'Runs on {{count}} nodes',
      noNodes: 'This profile is not active on any node.',
      configuration: 'Configuration',
      configurationHint: 'The Xray configuration of the profile, as the panel keeps it.',
      computed: 'Computed',
      computedHint: 'The configuration as the panel computes it for its nodes.',
      maskedCount_one: '{{count}} value is masked.',
      maskedCount_other: '{{count}} values are masked.',
    },
  },

  internalSquads: {
    title: 'Internal squads',
    empty: 'No internal squads',
    emptyText: 'The panel has no internal squad yet.',
    openAria: 'Open internal squad {{name}}',
    menuAria: 'Actions for internal squad {{name}}',
    view: 'View inbounds',
    inbounds: 'Inbounds',
    users: 'Users',

    drawer: {
      overview: 'Squad',
      name: 'Name',
      tags: 'Tags',
      hash: 'Hash',
      created: 'Created',
      updated: 'Updated',
      inbounds_one: '{{count}} inbound',
      inbounds_other: '{{count}} inbounds',
      noInbounds: 'This squad opens no inbound.',
      ofProfile: 'Profile: {{name}}',
    },
  },

  externalSquads: {
    title: 'External squads',
    empty: 'No external squads',
    emptyText: 'The panel has no external squad yet.',
    openAria: 'Open external squad {{name}}',
    menuAria: 'Actions for external squad {{name}}',
    view: 'View squad',
    users: 'Users',
    notOverridden: 'Not overridden',

    drawer: {
      hash: 'Hash',
    },

    tabs: {
      templates: 'Templates',
      settings: 'Settings',
      hosts: 'Hosts',
      responseHeaders: 'Response headers',
      remarks: 'Remarks',
    },

    templates: {
      title: 'Subscription templates',
      description:
        'The template this squad uses for each kind of client. A kind without a choice uses the default template.',
      default: 'Default template in use',
    },

    settings: {
      title: 'Subscription settings',
      description: 'What this squad changes about the subscription, compared with the panel.',
      serveJson: 'Serve JSON at the base subscription',
      showRemarks: 'Show custom remarks',
      randomizeHosts: 'Randomize hosts',
    },

    hosts: {
      title: 'Host overrides',
      description: 'What this squad changes about every host in its subscription.',
      serverDescription: 'Server description',
    },

    headers: {
      title: 'Response headers',
      description:
        'Headers added to or removed from the subscription response of this squad. Values that carry credentials are masked.',
      none: 'This squad changes no response header.',
      added: 'Added',
      removed: 'Removed',
    },

    hwid: {
      title: 'HWID settings',
      description: 'How many devices a user of this squad may have.',
      enabled: 'Limit devices',
      limit: 'Fallback device limit',
      announce: 'Announced maximum of devices',
    },

    remarks: {
      title: 'Custom remarks',
      description: 'Lines shown to the user by the client, by language.',
      none: 'This squad has no custom remarks.',
    },
  },

  templates: {
    title: 'Subscription templates',
    empty: 'No subscription templates',
    emptyText: 'The panel has no subscription template.',
    openAria: 'Open template {{name}}',
    menuAria: 'Actions for template {{name}}',
    view: 'View template',

    drawer: {
      overview: 'Template',
      name: 'Name',
      type: 'Kind of client',
      tags: 'Tags',
      hash: 'Hash',
      body: 'Template body',
      bodyHint:
        'A template for a local proxy often carries its login and password: those are masked here, and comments in a YAML template are dropped.',
      bodyNotLoaded:
        'The body of this template was not read: the panel leaves the bodies out of its list of templates. Refresh to read it.',
    },
  },

  nodePlugins: {
    title: 'Node plugins',
    empty: 'No node plugins',
    emptyText: 'The panel has no node plugin.',
    openAria: 'Open node plugin {{name}}',
    menuAria: 'Actions for node plugin {{name}}',
    view: 'View plugin',
    activeOn: 'Active on nodes',

    drawer: {
      overview: 'Plugin',
      name: 'Name',
      tags: 'Tags',
      hash: 'Hash',
      activeOn_one: 'Active on {{count}} node',
      activeOn_other: 'Active on {{count}} nodes',
      noNodes: 'This plugin is not active on any node.',
      config: 'Plugin configuration',
      configHint: 'The configuration the panel sends to the nodes that run this plugin.',
      configNotLoaded:
        'The configuration of this plugin was not read: the panel may leave it out of its list of plugins. Refresh to read it.',
    },
  },

  snippets: {
    title: 'Snippets',
    empty: 'No snippets',
    emptyText: 'The panel has no snippet.',
    openAria: 'Open snippet {{name}}',
    menuAria: 'Actions for snippet {{name}}',
    view: 'View snippet',
    items: 'Items',
    copyName: 'Copy name',

    drawer: {
      overview: 'Snippet',
      name: 'Name',
      hash: 'Hash',
      body: 'Snippet body',
      bodyHint: 'The JSON that the templates insert by this name.',
    },
  },
} as const;
