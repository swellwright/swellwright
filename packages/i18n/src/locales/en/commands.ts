/**
 * Scripts and commands on servers: the Scripts page, the Runs page, the run dialog and the bar of the servers table
 * (apps/web/src/commands/*, apps/web/src/fleet/servers-bulk-bar.tsx; ADR 0038). No plural forms: counts follow a colon.
 */
export const commands = {
  signInAgain: 'Sign in again to continue.',

  danger: {
    read: 'Read',
    change: 'Change',
    destructive: 'Destructive',
  },
  dangerHint: {
    read: 'Only looks: it changes nothing on the server.',
    change: 'Changes something on the server that can be put back.',
    destructive: 'Removes or overwrites something that cannot be put back.',
  },

  runState: {
    pending: 'Queued',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled',
    partial: 'Partly succeeded',
  },
  targetState: {
    pending: 'Waiting',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    lost: 'Lost',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
  },

  badges: {
    sudo: 'Runs as root',
    builtin: 'Built-in',
    parameters: 'Parameters: {{count}}',
  },

  bar: {
    selected: 'Selected: {{count}}',
    selectAll: 'Select all',
    clear: 'Clear selection',
    run: 'Run script',
  },

  parameters: {
    none: 'This script takes no parameters.',
    add: 'Add a parameter',
    remove: 'Remove the parameter',
    name: 'Name',
    nameDescription:
      'Lower-case letters, digits and underscores. The script reads it as an environment variable.',
    nameHint:
      'Use lower-case letters, digits and underscores, starting with a letter (at most 32).',
    label: 'Label',
    type: 'Type',
    types: {
      string: 'Text',
      integer: 'Whole number',
      enum: 'One of a list',
      boolean: 'Yes or no',
      secret: 'Vault secret',
    },
    secretTypes: 'Kinds of secret',
    secretTypesDescription:
      'The kinds of vault secret a person may choose. The script reads the file named by {{name}}.',
    required: 'Required',
    description: 'Description',
    pattern: 'Pattern',
    patternDescription:
      'A regular expression the whole value must match. Leave it empty to accept any text up to the maximum length.',
    patternHint: 'Form: {{pattern}}',
    maxLength: 'Longest value',
    default: 'Default',
    min: 'Smallest',
    max: 'Largest',
    options: 'Options',
    optionsDescription: 'Type an option and press Enter.',
    hasDefault: 'Has a default',
    defaultOn: 'On by default',
  },

  run: {
    title: 'Run on servers: {{count}}',
    submit: 'Run on servers: {{count}}',
    forbidden: 'Your role may not run commands.',
    builtinGroup: 'Built-in',
    ownGroup: 'Scripts of this instance',
    servers: {
      title: 'Servers',
      description:
        'Up to {{max}} servers. Each one is worked on by itself: one failing does not stop the others.',
      placeholder: 'Choose servers',
      nothing: 'No such server',
      skipped:
        'These servers cannot be used and will be skipped, because their host key is not pinned or they have no way to log in: {{names}}.',
    },
    mode: {
      script: 'Script from the library',
      command: 'Command',
    },
    script: {
      label: 'Script',
      placeholder: 'Choose a script',
      nothing: 'No such script',
      noParameters: 'This script takes no parameters.',
    },
    command: {
      label: 'Command',
      description: 'POSIX sh. Several lines are fine; it runs as one script.',
      secrets:
        'The command is kept with the run, in plain text, and everybody who may read servers can read it. Do not put a password, a key or a token in it: add the secret under Secrets below and read it from its file.',
      sudo: 'Run as root',
      sudoDescription: 'Through sudo, with the sudo password stored for the server.',
      level: 'What it does',
      levelDescription:
        'Swellwright cannot know what a command does, so this is your word. Anything but "Read" has to be confirmed before it starts.',
    },
    secrets: {
      title: 'Secrets',
      description:
        'Hand a secret of the vault to the script as a file. It is written on the server for the length of the run and removed afterwards.',
      notice:
        'The script reads the file named by NAME_FILE, for example "$NODE_KEY_FILE". Nothing goes into the command line, the environment or the stored run. A script can print what it reads, so this needs the permission to reveal secrets and a fresh code. Where the output holds the exact value it shows [secret NAME] instead; a script that changes the value (encodes it, splits it up) is not caught.',
      add: 'Add a secret',
      remove: 'Remove the secret',
      name: 'Name',
      nameDescription: 'The variable is NAME_FILE.',
      secret: 'Secret',
      placeholder: 'Choose a secret',
      nothing: 'No such secret',
      noSecrets: 'The vault has no secret of a kind a run can be given.',
      forbidden:
        'Your role may not hand secrets to a run. It needs the permission to reveal secrets.',
      full: 'Secrets in one run: at most {{count}}.',
      parameterForbidden:
        'This script needs a secret of the vault, and your role may not hand secrets to a run.',
      parameterNoChoice: 'Choose a secret of the vault.',
      errors: {
        name: 'Capital letters, digits and underscores, starting with a letter. Not SW_ or SWELLWRIGHT_.',
        duplicate: 'Another secret of this run has this name.',
        choose: 'Choose a secret.',
        summary: 'Some of the secrets are not valid.',
      },
    },
    timeout: {
      label: 'Time limit',
      description:
        'Per server, counted from the moment the script starts there. After it the script is stopped.',
      unit: 'seconds',
    },
    levelNotice: {
      change: 'This run changes something on the servers. You will be asked to confirm it.',
      destructive: 'This run can destroy data on the servers. You will be asked to confirm it.',
    },
    confirm: {
      title: 'Run on servers: {{count}}?',
      text: {
        change: 'This script changes something on the servers below.',
        destructive:
          'This script removes or overwrites something on the servers below. It cannot be taken back.',
      },
      note: 'Until the approvals of the engine are built, this confirmation is the only check. It is recorded with the run.',
      button: {
        change: 'Run and change',
        destructive: 'Run and destroy',
      },
    },
    errors: {
      noServers: 'Choose at least one server.',
      tooMany: 'Servers in one run: at most {{count}}.',
      noScript: 'Choose a script.',
      parameters: 'Some of the values do not fit the parameters.',
      noCommand: 'Type a command.',
      commandTooLong: 'The command is too long (at most 64 KiB).',
      timeout: 'The time limit is a whole number of seconds from 1 to {{max}}.',
    },
    toast: {
      title: 'Run started',
      text: 'Servers in the run: {{count}}. Its progress is on the Runs page.',
    },
  },

  scripts: {
    title: 'Scripts',
    description:
      'Diagnostics that ship with Swellwright and the scripts of this instance, to run on servers',
    add: 'Add a script',
    run: 'Run on servers',
    edit: 'Edit',
    view: 'View',
    duplicate: 'Make a copy',
    copyHash: 'Copy the SHA-256',
    openAria: 'Open the script {{name}}',
    menuAria: 'Actions for the script {{name}}',
    deleted: 'Script deleted',
    deletedText: 'The script {{name}} was deleted. What it ran stays in the history.',
    deleteTitle: 'Delete the script {{name}}?',
    deleteText:
      'The history keeps the text of every run, so nothing is lost there. A script cannot be brought back; copy the text first if you may need it.',
    forbidden: 'Your role may not change scripts.',
    readForbidden: 'Your role may not see the scripts.',
    loadFailed: 'The scripts could not be loaded',
    readOnlyNotice:
      'You can read the scripts. Writing and running them needs the permission to run commands.',
    filter: {
      all: 'All',
      read: 'Read',
      change: 'Change',
      destructive: 'Destructive',
      builtin: 'Built-in',
      own: 'Of this instance',
    },
  },

  editor: {
    title: 'Script',
    createTitle: 'New script',
    editTitle: 'Change the script {{name}}',
    create: 'Create',
    saved: 'Script saved',
    savedText: 'The script {{name}} was saved.',
    createdText: 'The script {{name}} was added to the library.',
    copySuffix: ' copy',
    builtinNotice:
      'A built-in script is read-only: it is part of Swellwright and is put back as it ships. Make a copy to change it.',
    overview: 'The script',
    name: 'Name',
    nameDescription: 'Letters, digits, spaces, dots, dashes and underscores.',
    descriptionLabel: 'Description',
    level: 'Level of danger',
    sudo: 'Run as root',
    sudoDescription:
      'Through sudo, with the sudo password stored for the server. A login that is root needs none.',
    parameters: 'Parameters',
    parametersDescription:
      'Values reach the script as environment variables named SW_PARAM_ and the name in capitals, never inside its text. A secret parameter is different: the script reads the file that NAME_FILE names, and the value is never in the environment.',
    body: 'Text of the script',
    bodyDescription:
      'POSIX sh, run as "sh script.sh". It is code that runs on your servers, usually as root.',
    errors: {
      name: 'Use 1 to 64 letters, digits, spaces, dots, dashes or underscores.',
      description: 'Say what the script does.',
      body: {
        empty: 'The script is empty.',
        long: 'The script is longer than 256 KiB.',
      },
    },
    version: 'Version',
    hash: 'SHA-256 of the text',
    hashDescription:
      'The history records this hash with every run, so a run can be matched to the text it ran.',
    goneTitle: 'This script is gone',
    goneText: 'It was deleted. The history keeps what it ran.',
    failedTitle: 'The script could not be loaded',
    failedText: 'Try again in a moment.',
  },

  runs: {
    title: 'Runs',
    mode: {
      script: 'Script',
      inline: 'Command',
    },
    metrics: {
      total: 'Runs',
      going: 'Going now',
      problems: 'With problems',
    },
    loaded: 'The table has the newest {{shown}} of {{total}} runs; its filters search only those.',
    loadOlder: 'Load older runs',
    table: {
      state: 'State',
      what: 'What ran',
      level: 'Level',
      servers: 'Servers',
      serversOf: 'Succeeded: {{done}} of {{total}}',
      problems: 'Failed: {{count}}',
      skipped: 'Skipped: {{count}}',
      by: 'Started by',
      started: 'Started',
      duration: 'Duration',
      empty: 'Nothing has been run yet. Select servers on the Servers page and run a script.',
      loadFailed: 'The runs could not be loaded',
    },
  },

  runDetail: {
    title: 'Run',
    by: 'Started by',
    created: 'Started',
    finished: 'Finished',
    duration: 'Duration',
    timeout: 'Time limit',
    seconds: '{{count}} s',
    script: 'Script',
    confirmed: 'Confirmed level',
    secretsNotice:
      'The output below is what the scripts printed. It can contain secrets, and everybody who may read servers can read it.',
    handed: 'Secrets handed to the run',
    handedNote:
      'Written to a file on each server for the length of the run, and removed when the script ended. Where the output holds the exact value it shows [secret NAME] instead.',
    handedDeleted: 'deleted since',
    text: 'The text that ran',
    textNote:
      'This is exactly what was sent to the servers, as it was when the run started. Editing or deleting the script later does not change it.',
    servers: 'Servers: {{count}}',
    exit: 'exit {{code}}',
    stdout: 'Standard output',
    stderr: 'Standard error',
    bytes: 'Bytes: {{count}}',
    showAll: 'Show all',
    onlyEnd: 'Only the end is shown: the last characters ({{count}}).',
    loadFailed: 'The whole output could not be loaded.',
    outputLabel: '{{stream}} of {{name}}',
    truncated:
      'The output was cut at the limit: {{kept}} of {{total}} bytes are kept. The whole of it stays on the server, in the run directory of the SSH user, until somebody removes it.',
    pending: 'This server is waiting for a free slot.',
    took: 'Took {{span}}',
    cancel: 'Stop the run',
    cancelTitle: 'Stop this run?',
    cancelText:
      'Servers that have not started are cancelled at once. On the servers that run, the script is asked to stop and then killed.',
    cancelled: 'Stopping',
    cancelledText: 'The run is being stopped.',
    cancelForbidden: 'Your role may not stop runs.',
    stopping: 'Stopping…',
    goneTitle: 'This run is gone',
    goneText: 'There is no such run.',
    failedTitle: 'The run could not be loaded',
    failedText: 'Try again in a moment.',
  },

  targetError: {
    timeout: 'The time limit passed',
    server_deleted: 'The server was deleted',
    step_lost: 'The record of the run is gone from the server',
    unreachable: 'The server stayed out of reach',
    start_failed: 'The script could not be started',
    host_key_mismatch: 'The host key is not the pinned one',
    host_key_not_pinned: 'No host key is pinned',
    no_access_entry: 'No way to log in',
    ssh_auth_failed: 'The login was refused',
    ssh_key_invalid: 'The private key cannot be used',
    ssh_connect_failed: 'The server could not be reached',
    ssh_timeout: 'The server did not answer in time',
    ssh_failed: 'The SSH connection failed',
    address_not_allowed: 'The address is not allowed',
    secret_unavailable: 'The secret of the access entry cannot be used',
    cancelled: 'Cancelled',
    internal_error: 'Swellwright failed on this server',
  },

  waiting: {
    vault_sealed:
      'The vault is sealed, so Swellwright cannot log in to read this server. The script is not affected. Unseal the vault and the run goes on.',
    ssh_connect_failed:
      'The server cannot be reached for now. The script is not affected; Swellwright keeps trying.',
    ssh_timeout: 'The server is slow to answer. Swellwright keeps trying.',
    ssh_failed: 'The connection to the server failed. Swellwright keeps trying.',
    other: 'Swellwright cannot reach this server for now and keeps trying.',
  },
} as const;
