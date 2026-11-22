/** Snapshots of the connected panel and the comparison of two (apps/web/src/panel/snapshots-page.tsx and its parts). */
export const snapshots = {
  title: 'Snapshots',
  description:
    'The configuration of the panel at a moment: compare one with the panel now, or two of them, to see what changed. Secrets are not kept.',

  list: {
    title: 'History',
    scheduleOn:
      'The panel is checked every {{interval}} while it is connected and the vault is open; a snapshot is taken when it changed.',
    scheduleOff: 'The background job is off, so snapshots are taken by hand.',
    retention_one: 'The newest snapshot is kept, and the newest of each of the last {{days}} days.',
    retention_other:
      'The newest {{count}} snapshots are kept, and the newest of each of the last {{days}} days.',
    noPanelNote: 'No panel is connected: the snapshots are shown, but a new one cannot be taken.',
    empty: 'No snapshots yet',
    emptyText:
      'Take one now, or wait for the background job. A snapshot keeps the configuration of the panel and later shows what changed.',
    loadFailed: 'The snapshots could not be loaded',
  },

  columns: {
    taken: 'Taken',
    name: 'Name',
    source: 'Source',
    version: 'Panel version',
    objects: 'Objects',
    since: 'Changes since',
    size: 'Size',
  },

  source: {
    manual: 'Manual',
    scheduled: 'Scheduled',
    before_change: 'Before a change',
    imported: 'Imported',
  },
  by: 'By {{name}}',
  byJob: 'The background job',
  unnamed: 'No name',
  untitled: 'Snapshot of {{time}}',
  hoursShort: 'h',
  noWrite: 'Your role can read snapshots but not take or delete them.',

  kinds: {
    nodes: 'Nodes',
    hosts: 'Hosts',
    configProfiles: 'Config profiles',
    internalSquads: 'Internal squads',
    externalSquads: 'External squads',
    subscriptionTemplates: 'Subscription templates',
    subscriptionSettings: 'Subscription settings',
    snippets: 'Snippets',
    nodePlugins: 'Node plugins',
    infraProviders: 'Infra providers',
    billingNodes: 'Billing nodes',
  },
  kindsOne: {
    nodes: 'Node',
    hosts: 'Host',
    configProfiles: 'Config profile',
    internalSquads: 'Internal squad',
    externalSquads: 'External squad',
    subscriptionTemplates: 'Subscription template',
    subscriptionSettings: 'Subscription settings',
    snippets: 'Snippet',
    nodePlugins: 'Node plugin',
    infraProviders: 'Infra provider',
    billingNodes: 'Billing node',
  },
  coverage: {
    ok: 'Read',
    denied: 'No access',
    failed: 'Could not be read',
  },
  incomplete: 'Not complete: the token could not read {{kinds}}.',
  objectsOf_one: '{{count}} object',
  objectsOf_other: '{{count}} objects',

  since: {
    unknown: 'Not compared yet',
    none: 'None',
    differ_one: '{{count}} object differs',
    differ_other: '{{count}} objects differ',
    checked: 'Checked {{time}}',
  },

  actions: {
    view: 'Details',
    viewAria: 'Details of {{name}}',
    compareLive: 'Compare with the panel now',
    compareLiveAria: 'Compare {{name}} with the panel now',
    export: 'Download as JSON',
    exportAria: 'Download {{name}} as JSON',
    delete: 'Delete',
    deleteAria: 'Delete {{name}}',
    compare: 'Compare',
    compareNeedsSnapshot: 'Take a snapshot first',
    noPanel: 'No panel is connected',
  },

  take: {
    button: 'Take a snapshot',
    title: 'Take a snapshot',
    text: 'The panel is read now, and every object the token may read is kept: nodes, hosts, config profiles, squads, templates, settings, snippets, plugins and billing. Secrets are masked and never kept.',
    labelLabel: 'Name',
    labelPlaceholder: 'Before the key rotation',
    labelHint: 'Optional. It helps to find the snapshot later.',
    submit: 'Take snapshot',
    done: 'Snapshot taken',
    doneText_one: '{{count}} object of the panel was kept.',
    doneText_other: '{{count}} objects of the panel were kept.',
    failed: 'The snapshot was not taken',
  },

  drawer: {
    sectionSnapshot: 'Snapshot',
    sectionContents: 'Contents',
    sectionHashes: 'Hashes',
    taken: 'Taken',
    by: 'Taken by',
    source: 'Source',
    panel: 'Panel',
    version: 'Panel version',
    checked: 'Last compared with the panel',
    size: 'Size',
    sizeValue: '{{stored}} stored, {{raw}} before compression',
    overall: 'The whole snapshot',
    hashHint:
      'Two snapshots with the same hash hold the same configuration. A hash covers masked values, so it changes when a secret changes.',
    compareLive: 'Compare with the panel now',
    compareOther: 'Compare with another',
  },

  compare: {
    title: 'Compare',
    description: 'Seen from the first snapshot to the second one, or to the panel as it is now.',
    from: 'Snapshot',
    against: 'Compare with',
    live: 'The panel now',
    liveAt: 'The panel now, read {{time}}',
    pick: 'Choose a snapshot',
    askAgain: 'Ask the panel again',
    showUnchanged: 'Show objects that did not change',
    sameChoice: 'The two sides are the same snapshot.',
    failed: 'The comparison failed',
    loading: 'Comparing…',
    noDifferencesTitle: 'No differences',
    noDifferencesText:
      'The two hold the same configuration, object by object. What a node does by itself (online state, counters) is not compared.',
    summary: {
      added: 'Added',
      removed: 'Removed',
      changed: 'Changed',
      unchanged: 'Unchanged',
      fields_one: '{{count}} change in the fields',
      fields_other: '{{count}} changes in the fields',
    },
    objects: 'Objects that differ',
    objectsDescription: 'Open a row to see what changed in it.',
    columns: {
      kind: 'Kind',
      object: 'Object',
      status: 'Status',
      changes: 'Changes',
    },
    status: {
      added: 'Added',
      removed: 'Removed',
      changed: 'Changed',
      unchanged: 'Unchanged',
    },
    notes: {
      kind_not_covered: 'Not compared, because one of the two could not read them: {{kinds}}.',
      mask_key_differs:
        'The two were masked with different keys, so a secret that was rotated cannot be told from one that was not. Masked values are treated as equal; everything else was compared.',
      panel_version_differs: 'The panel was updated between the two: its version differs.',
      noise_only_one:
        '{{count}} object has another hash, but only in fields that a comparison leaves out (timestamps, the order of tags).',
      noise_only_other:
        '{{count}} objects have another hash, but only in fields that a comparison leaves out (timestamps, the order of tags).',
      objects_cut_one:
        'The list is cut: {{count}} more object is not shown. The counts above are complete.',
      objects_cut_other:
        'The list is cut: {{count}} more objects are not shown. The counts above are complete.',
    },
    fields: {
      path: 'Field',
      op: 'Change',
      before: 'Before',
      after: 'After',
      truncated_one: '{{count}} more change is not shown.',
      truncated_other: '{{count}} more changes are not shown.',
      wholeObject: 'The whole object',
      added: 'Added',
      removed: 'Removed',
      changed: 'Changed',
    },
    value: {
      masked: 'secret',
      maskedHint:
        'A secret: its keyed fingerprint changed, so the secret was changed. The value is not known here.',
      hidden: 'Not shown',
      items_one: '{{count}} item',
      items_other: '{{count}} items',
      lines: '{{removed}} lines out, {{added}} in',
      cut: 'cut',
      empty: 'empty',
      none: 'none',
    },
    peer: 'From {{from}} to {{to}}',
  },

  deleteConfirm: {
    title: 'Delete the snapshot?',
    message:
      'The snapshot "{{name}}" and its content are removed from this server. The panel is not changed. This cannot be undone.',
    confirm: 'Delete',
    done: 'Snapshot deleted',
    failed: 'The snapshot was not deleted',
  },

  notice: {
    exportDone: 'The file is being downloaded.',
  },
} as const;
