/**
 * Panel > API console (apps/web/src/panel/api-console, ADR 0046): the operations of the connected panel's API, a form to
 * send a read, the masked answer, and the last calls and samples of this browser. The names of the panel's own API
 * (operations, groups, parameters) are the panel's English and are shown as they are.
 */
export const apiConsole = {
  title: 'API console',
  description: 'Explore the API of the connected panel with read requests. Every answer is masked.',
  loadFailed: 'The operations could not be loaded',

  list: {
    title: 'Operations',
    subtitle: '{{n}} operations of the panel API',
    search: 'Search operations',
    scope: 'Which operations to list',
    reads: 'Reads ({{n}})',
    all: 'All ({{n}})',
    noMatch: 'No operation matches',
    noMatchText: 'Try another word, or list all operations, writes included.',
  },

  marker: {
    write:
      'This operation changes the panel. The console only reads: writes arrive with the approvals of a later release.',
    blockedShort: 'Blocked',
    blockedSecret:
      'This operation returns a key or a link that works as a credential, so the console never sends it.',
    blockedSideEffect:
      'This operation creates something on the panel when it is asked for, so the console never sends it.',
    userData:
      'About the people who use the panel. Off unless the installation allows it; then it needs the permission to reveal secrets and a fresh code.',
    userDataShort: 'About people',
  },

  badge: {
    userData: 'About people',
    blocked: 'Blocked',
    write: 'Needs approvals (later)',
    adminOnly: 'Administrator session only',
    public: 'No token needed',
    deprecated: 'Deprecated',
  },

  note: {
    writeTitle: 'Not sent from here',
    write:
      'This operation changes the panel. The console only reads; operations that change the panel arrive with the approvals of a later release. You can read what it needs below.',
    blockedTitle: 'Never sent',
    peopleTitle: 'About people',
    people:
      'This is about the people who use the panel. It needs the permission to reveal secrets and a fresh code. What comes back has names, mail addresses, device ids and addresses masked, and the call is recorded before the answer is shown.',
    peopleOffTitle: 'Off on this installation',
    peopleOff:
      'This is about the people who use the panel. The installation does not allow it: set SW_PANEL_CONSOLE_USER_DATA=true on the server to allow it.',
    adminTitle: 'Administrator session only',
    admin:
      'The panel answers an API token with 403 for this operation; only an administrator session can read it. The answer you get here is the panel’s own.',
    noRole:
      'Your role can browse the operations but not send them: sending needs the permission for the API console.',
    noReveal:
      'Your role can send the other operations but not this one: an operation about people also needs the permission to reveal secrets.',
    notConnectedTitle: 'No panel is connected',
    notConnected: 'Connect a panel before sending a request.',
    connectLink: 'Open the connection',
  },

  request: {
    inPath: 'in the path',
    inQuery: 'in the query',
    structured:
      'A structured value (the table state of the panel’s pages). The console does not send it.',
    range: 'From {{min}} to {{max}}',
    default: 'Default {{value}}',
    noParams: 'This operation has no parameters.',
    copyCurl: 'Copy as curl',
    curlCopied: 'The command uses $PANEL_TOKEN: put your own token there.',
    send: 'Send',
    missing: 'Fill in: {{names}}',
  },

  response: {
    title: 'Response',
    subtitle: 'What the panel answered, masked',
    copy: 'Copy the masked answer',
    download: 'Download the masked answer',
    saveSample: 'Save as a sample',
    sampleNotPeople: 'Answers about people are not kept in the browser.',
    tabResponse: 'Response',
    tabSchema: 'Response schema',
    tabBodySchema: 'Request body schema',
    maskedNote:
      'Secrets are masked before the answer leaves the server: a value like [masked:1a2b3c4d] stands for a key, a password, a short id or a link that works as a credential. The same value always gets the same code.',
    editorHint: 'Read only. Ctrl+F searches, the margin folds.',
    editorLabel: 'The masked answer of the panel',
    showHeaders: 'Show headers ({{n}})',
    hideHeaders: 'Hide headers ({{n}})',
    attempts_one: 'Tried {{count}} time',
    attempts_other: 'Tried {{count}} times',
    maskedHint:
      'How many values in the answer were replaced by a mask. Only the headers content-type, content-length, retry-after and x-ratelimit-* are shown.',
    masked_one: '{{count}} value masked',
    masked_other: '{{count}} values masked',
    nothingMasked: 'Nothing to mask',
    personal: 'People hidden',
    truncatedTitle: 'The answer was cut',
    truncated:
      'The panel answered {{size}}; only the first part is shown, and a copy or a download holds only that part.',
    empty: 'The panel answered with no body.',
    failedTitle: 'No answer',
    none: 'No request sent yet',
    noneText: 'Fill in the parameters and press Send. The answer appears here.',
    noSchema: 'The description of the panel has no schema for {{operation}}.',
  },

  history: {
    title: 'History and samples',
    description: 'Kept in this browser only, never on the server',
    clear: 'Clear the history',
    tabHistory: 'Last calls ({{n}})',
    tabSamples: 'Samples ({{n}})',
    at: 'Sent',
    operation: 'Operation',
    status: 'Status',
    duration: 'Time',
    size: 'Size',
    noAnswer: 'No answer',
    empty: 'Nothing sent yet',
    again: 'Ask again',
    openOperation: 'Open the operation',
    againAria: 'Ask {{path}} again',
  },

  samples: {
    name: 'Name',
    saved: 'Saved',
    empty: 'No samples saved',
    open: 'Show the sample',
    openAria: 'Show the sample {{name}}',
    remove: 'Remove the sample',
    removeAria: 'Remove the sample {{name}}',
    dialogTitle: 'Save as a sample',
    dialogText:
      'The masked answer is kept in this browser under this name, so that it can be shown again. Nothing is stored on the server.',
    save: 'Save',
    failed: 'The sample was not saved',
    failedText: 'It is too large, or this browser refused to keep it.',
  },

  errors: {
    noRole: 'Your role cannot send requests from the API console.',
    unknownOperation: 'The panel API has no such operation.',
    blocked: 'The console does not send this operation.',
    userDataDisabled:
      'Operations about people are off on this installation (SW_PANEL_CONSOLE_USER_DATA).',
    tooLarge: 'The answer is larger than this server reads.',
    unsupported:
      'The panel answered with something that is not JSON or text, which the console does not show.',
  },
} as const;
