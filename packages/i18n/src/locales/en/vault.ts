/**
 * The Vault page (apps/web/src/security/vault-page.tsx): setting it up, sealing and unsealing, the list of
 * secrets and the dialogs that change them. The `types` names are keyed by the id of the secret type
 * (`SECRET_TYPES` in the contracts); the id itself stays the data the API works with.
 */
export const vault = {
  header: {
    title: 'Vault',
    description: 'Secrets are encrypted before they reach the database, and values are write-only',
    sealNow: 'Seal now',
    addSecret: 'Add a secret',
  },

  states: {
    unsealed: 'Unsealed',
    sealed: 'Sealed',
    uninitialized: 'Not set up',
  },

  signInAgain: 'Sign in again to continue.',

  /** The kinds of secret, by id. */
  types: {
    panel_token: 'Panel token',
    ssh_key: 'SSH key',
    ssh_password: 'SSH password',
    ssh_ca: 'SSH CA',
    dns_oauth: 'DNS OAuth',
    provider_token: 'Provider token',
    telegram: 'Telegram',
    generic: 'Generic',
  },

  /** The bar under the passphrase: how far it is from comfortable. */
  strength: {
    tooShort_one: 'At least {{count}} character. Words in a row are fine.',
    tooShort_other: 'At least {{count}} characters. Words in a row are fine.',
    acceptable: 'Acceptable. A longer phrase is better.',
    long: 'Long enough.',
  },

  setup: {
    title: 'Set up the vault',
    intro:
      'Choose a passphrase. It protects every secret Swellwright keeps. The vault starts sealed after every restart, and you open it with this passphrase. There is no way to recover it except the recovery key you get next.',
    passphraseLabel: 'Passphrase',
    repeatLabel: 'Repeat the passphrase',
    mismatch: 'The passphrases differ.',
    forbidden: 'Your role may not set the vault up.',
    submit: 'Create the vault',
    ownerNeeded: 'The vault is not set up yet. An owner has to set it up.',
  },

  /** Shown once, right after the vault is created. */
  recoveryKey: {
    title: 'Save the recovery key now',
    warning:
      'It opens the vault if you lose the passphrase, and nothing else can. It is shown once and kept nowhere on this server. Write it down or put it in a password manager, away from this machine.',
    storedLabel: 'I have stored the recovery key outside this server',
    open: 'Open the vault',
  },

  sealed: {
    title: 'The vault is sealed',
    ownerNeeded: 'An owner has to unseal it before anything that uses a secret can run.',
  },

  unseal: {
    notice:
      'Runs that use a secret, and anything scheduled, wait until the vault is unsealed. The list below shows names and dates only.',
    passphraseLabel: 'Vault passphrase',
    recoveryKeyLabel: 'Recovery key',
    recoveryKeyDescription: 'Thirteen groups of four, like ABCD-EFGH-…',
    wrongPassphrase:
      'That passphrase is not right. Ten wrong attempts in a quarter of an hour lock unsealing for everyone.',
    wrongRecoveryKey: 'That recovery key is not right.',
    forbidden: 'Your role may not unseal the vault.',
    useRecoveryKey: 'Lost the passphrase? Use the recovery key',
    usePassphrase: 'Use the passphrase instead',
    submit: 'Unseal',
  },

  seal: {
    forbidden: 'Your role may not seal the vault.',
  },

  summary: {
    secrets: 'Secrets',
    keyVersion: 'Key version',
    setUp: 'Set up',
  },

  list: {
    title: 'Secrets',
    actions: 'Actions',
    name: 'Name',
    kind: 'Kind',
    version: 'Version',
    expires: 'Expires',
    valueChanged: 'Value changed',
    empty: 'No secrets yet.',
    expired: '{{date}} (expired)',
    revealAria: 'Reveal the value of {{name}}',
    changeAria: 'Change {{name}}',
    deleteAria: 'Delete {{name}}',
    loadFailed: 'Your role may not see the secrets.',
    statusFailed: 'Your role may not see the vault.',
  },

  /** The expiry of a secret: a secret that has expired is refused by everything that would use it (ADR 0042). */
  expiry: {
    expired: 'Expired',
    inDays_one: 'Expires in {{count}} day',
    inDays_other: 'Expires in {{count}} days',
    expiredSuffix: ' (expired)',
    filter: {
      expired: 'Expired',
      soon: 'Expires soon',
      ok: 'Valid',
      none: 'No expiry',
    },
    notice_one:
      '{{count}} secret has expired. Nothing can use it until its expiry is renewed or the secret is replaced.',
    notice_other:
      '{{count}} secrets have expired. Nothing can use them until their expiry is renewed or the secrets are replaced.',
  },

  /** Toasts after a change that has no screen of its own to show it. */
  toast: {
    created: 'The secret was stored.',
    updated: 'The secret was changed.',
    deleted: 'The secret was deleted.',
  },

  /** The titles of the error cards that stand in for a part of the page that could not be loaded. */
  error: {
    statusTitle: 'The vault could not be loaded',
  },

  menu: {
    reveal: 'Reveal',
    change: 'Change',
  },

  form: {
    addTitle: 'Add a secret',
    editTitle: 'Change {{name}}',
    name: 'Name',
    kind: 'Kind',
    kindLocked: 'The kind cannot change.',
    value: 'Value',
    newValue: 'New value',
    valueHintCreate: 'Write-only: it can be revealed later, never listed.',
    valueHintEdit: 'Leave empty to keep the current value. A new one makes a new version.',
    description: 'Description',
    expiresOn: 'Expires on',
    expiresHint: 'Optional. The console warns before it.',
    forbidden: 'Your role may not change secrets.',
    submitCreate: 'Store the secret',
  },

  reveal: {
    expiredNotice:
      'This secret has expired, so nothing but you can read it now. Renew its expiry or replace the value to use it again.',
    hiddenIn_one: 'Hidden in {{count}} second. This was recorded in the audit log.',
    hiddenIn_other: 'Hidden in {{count}} seconds. This was recorded in the audit log.',
    forbidden: 'Your role may not reveal secrets.',
  },

  delete: {
    title: 'Delete {{name}}',
    warning:
      'The secret and its value are gone for good. Anything that still uses it will stop working.',
    forbidden: 'Your role may not delete secrets.',
  },

  /** The key-rotation card and the dialogs it opens. */
  rotation: {
    title: 'Key rotation',
    description:
      'Replace the passphrase and the keys that protect the secrets. None of this changes what a secret says.',
    lastDone: 'Last done: {{date}}',
    never: 'Not done since the vault was set up',
    needsOpen: 'Unseal the vault first.',
    passphraseLabel: 'Vault passphrase',
    wrongPassphrase:
      'That passphrase is not right. Wrong attempts count towards the same limit as unsealing.',

    passphrase: {
      title: 'Passphrase',
      description:
        'Change the passphrase that unseals the vault. Nothing is re-encrypted and the recovery key stays valid.',
      action: 'Change passphrase',
      intro:
        'Enter the current passphrase and choose a new one. The new one unseals the vault from now on. This works while the vault is sealed too.',
      currentLabel: 'Current passphrase',
      newLabel: 'New passphrase',
      repeatLabel: 'Repeat the new passphrase',
      submit: 'Change passphrase',
      forbidden: 'Your role may not change the passphrase.',
      done: 'The passphrase was changed. Use the new one to unseal the vault from now on.',
    },

    recoveryKey: {
      title: 'Recovery key',
      description: 'Issue a new recovery key. The old one stops working at once.',
      action: 'Rotate recovery key',
      intro:
        'Enter the passphrase to issue a new recovery key. The old one stops working at once, so replace the copy you keep outside this server. No secret is re-encrypted.',
      submit: 'Issue a new key',
      forbidden: 'Your role may not rotate the recovery key.',
    },

    kek: {
      title: 'Key-encryption key (KEK)',
      description: 'Replace the key that wraps every data key. The secrets stay readable.',
      action: 'Rotate KEK',
      intro:
        'Replaces the key that wraps every data key. All secrets stay readable and the key version goes up. A new recovery key is issued, and the old one stops working at once. Either everything changes or nothing does.',
      submit: 'Rotate KEK',
      forbidden: 'Your role may not rotate the key-encryption key.',
    },

    dataKeys: {
      title: 'Data keys',
      description: 'Encrypt every secret again under a fresh data key.',
      action: 'Rotate data keys',
      intro:
        'Every secret is decrypted in memory and encrypted again under a fresh data key. Values and versions do not change.',
      submit: 'Rotate data keys',
      forbidden: 'Your role may not rotate the data keys.',
      done_one: '{{count}} secret re-encrypted under a fresh data key.',
      done_other: '{{count}} secrets re-encrypted, each under a fresh data key.',
    },

    /** Shown once, right after a rotation issued a new recovery key. */
    newKey: {
      title: 'Save the new recovery key now',
      warning:
        'The old recovery key no longer works. The new one is shown once and kept nowhere on this server. Write it down or put it in a password manager, away from this machine, and replace the old copy.',
    },
  },
} as const;
