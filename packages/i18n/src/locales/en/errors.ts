/** What the person sees for a failed call to the API (apps/web/src/auth/messages.ts). */
export const errors = {
  unreachable: 'The API does not answer. Check that the server is running.',
  stepUpCancelled: 'You did not confirm with a code, so nothing was changed.',
  rateLimited_one: 'Too many failed attempts. Try again in about {{count}} minute.',
  rateLimited_other: 'Too many failed attempts. Try again in about {{count}} minutes.',
  rateLimitedShort: 'Too many attempts. Try again in a moment.',
  forbidden: 'The server refused this request.',
  stepUpRequired: 'Confirm with a code from your authenticator, then try again.',
  notReady: 'The server cannot sign anyone in yet: it has no database.',
  vaultSealed: 'The vault is sealed. Unseal it with the passphrase first.',
  validation: 'Some of the values are not valid.',
  server: 'Something went wrong on the server. Try again.',
  generic: 'Something went wrong. Try again.',
  addressNotAllowed: 'The address is not allowed by the policy of this installation.',

  /** The Remnawave panel (ADR 0041): what a read or a connection says when the panel is the problem. */
  panel: {
    notConnected: 'No panel is connected. Connect one on the Connection page.',
    unauthorized: 'The panel rejected the token: it may be expired, revoked or mistyped.',
    forbidden:
      'The token has no scope for this. Give it the scope in the panel, or connect with a token that has more.',
    unreachable:
      'The panel did not answer. Check its address, its certificate and the network between this server and the panel.',
    timeout: 'The panel did not answer in time.',
    unsupportedVersion:
      'The connected panel runs a version this release does not support. The Connection page says which.',
    rateLimited_one: 'The panel asks to slow down. Try again in {{count}} second.',
    rateLimited_other: 'The panel asks to slow down. Try again in {{count}} seconds.',
    rateLimitedShort: 'The panel asks to slow down. Try again in a moment.',
    contractChanged:
      'The panel answered in a shape this release does not know. Its version may have changed the API.',
    contractChangedAt:
      'The panel answered in a shape this release does not know: {{endpoint}}, field {{field}}. Its version may have changed the API.',
  },
  /** Snapshots of the panel (ADR 0043). */
  snapshot: {
    otherPanel:
      'This snapshot is of another panel than the connected one, so it cannot be compared with it.',
    tooLarge:
      'The panel holds more than one snapshot may keep. The limit is set by the installation.',
    corrupt: 'The stored content of this snapshot cannot be read. Delete it and take another one.',
  },
  ssh: {
    hostKeyNotPinned:
      'No host key is pinned for this server. Scan its host key and confirm the fingerprint first.',
    hostKeyMismatch: 'The server shows another host key than the pinned one. No login was sent.',
    hostKeyReplaceRequired:
      'Other host keys are pinned for this server. Confirm that they are to be replaced, or find out why the key changed.',
    addressNotAllowed:
      'The address of this server is not allowed by the policy of this installation.',
    noAccessEntry: 'This server has no way to log in. Add an access entry first.',
    connectFailed: 'The server could not be reached over SSH.',
    authFailed: 'The server did not accept the login.',
    keyInvalid: 'The private key in the vault cannot be used.',
    timeout: 'The server did not answer in time.',
    failed: 'The SSH connection failed.',
    factsUnreadable: 'The server did not answer with the output of the facts script.',
    rateLimited: 'Too many SSH operations. Try again in a minute.',
  },
} as const;
