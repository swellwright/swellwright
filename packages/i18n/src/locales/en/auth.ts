/** The screens before the console and the dialogs that confirm who you are (apps/web/src/auth). */
export const auth = {
  /** Used on more than one of those screens. */
  shared: {
    loginName: 'Username',
    password: 'Password',
    repeatPassword: 'Repeat the password',
    passwordHint_one: 'At least {{count}} character. A passphrase is fine.',
    passwordHint_other: 'At least {{count}} characters. A passphrase is fine.',
    passwordTooShort: 'The password is too short.',
    passwordsDiffer: 'The passwords differ.',
    signInAgain: 'Sign in again to continue.',
  },

  /** The second step: six digits or a recovery code. Shared by sign-in and the confirmation dialog. */
  totp: {
    title: 'Two-step verification',
    codeInputLabel: 'Six-digit code',
    codeLabel: 'Code from your authenticator',
    codeWrong: 'That code is not right. Wait for the next one and try again.',
    recoveryLabel: 'Recovery code',
    recoveryHint: 'A recovery code looks like ABCD-EFGH-JKLM. It works once.',
    recoveryInvalid: 'That recovery code is not valid, or was used already.',
    useRecovery: 'Use a recovery code',
    useAuthenticator: 'Use the authenticator instead',
    submit: 'Sign in',
    backToPassword: 'Back to the password',
  },

  /** What the gate shows when the API cannot be used. */
  gate: {
    apiDownTitle: 'The API does not answer',
    apiDownHint:
      'Start the API (pnpm --filter @swellwright/api start) or check the reverse proxy, then try again.',
    somethingWrongTitle: 'Something is wrong',
    versionMismatchHint:
      'The API answered with something unexpected. The API and the console are probably from different versions.',
    noDatabaseTitle: 'No database yet',
    noDatabaseHint:
      'The server is running without a database, so nobody can sign in yet. Set SW_DATABASE_URL, apply the migrations and restart it.',
    serverDownHint: 'Check that the server is running, then reload this page.',
    accountChangedTitle: 'Another account',
    accountChanged:
      'This browser was signed in as another account in another tab. The console now shows that account.',
    sessionEndedTitle: 'Signed out',
    sessionEnded: 'Your session has ended: it expired or was closed. Sign in again to continue.',
  },

  login: {
    title: 'Sign in',
    submit: 'Sign in',
    passwordPlaceholder: 'Your password',
    wrongCredentials: 'Wrong username or password.',
  },

  setup: {
    title: 'First-run setup',
    description:
      'No one owns this instance yet. Create the owner account, then set up an authenticator.',
    tokenLabel: 'Setup token',
    tokenHint: 'The server printed it to its log when it started.',
    tokenWrong: 'The setup token is not right.',
    tokenPlaceholder: 'Paste the setup token',
    passwordPlaceholder: 'A long passphrase',
    generate: 'Generate and copy',
    passwordCopied: 'Password copied',
    passwordCopiedMessage: 'The password was copied to the clipboard',
    passwordCopyFailed: 'The password could not be copied to the clipboard',
    usernameHint: 'Lower-case letters, digits, dot, dash or underscore. 2 to 32 characters.',
    usernameInvalid: 'This username is not allowed.',
    submit: 'Create the owner',
  },

  enrollment: {
    title: 'Set up two-step verification',
    description: 'Sign-in needs a second step. Set up an authenticator app now.',
    addTitle: '1. Add Swellwright to an authenticator app',
    addHint:
      'Scan the code with any app that supports time-based codes (TOTP), or type the key in.',
    qrLabel: 'QR code with the authenticator key',
    keyLabel: 'Key, for typing it in',
    copyKey: 'Copy the key',
    enterTitle: '2. Enter the six-digit code it shows',
    submit: 'Confirm and continue',
  },

  recoveryCodes: {
    title: 'Recovery codes',
    description: 'Your authenticator works. Save the recovery codes before you go on.',
    intro:
      'Each code signs you in once if you lose your authenticator. Keep them somewhere safe and separate from your password. They are not shown again.',
    copyAll: 'Copy all',
    saved: 'I have saved these codes',
    continue: 'Continue to the console',
  },

  invitation: {
    title: 'Accept the invitation',
    description: 'Choose a password for your account. You will set up an authenticator next.',
    tokenLabel: 'Invitation',
    tokenHint: 'The owner gave it to you, or it came with the link.',
    passwordLabel: 'Choose a password',
    invalid:
      'This invitation is not valid, was used already, or has expired. Ask the owner for a new one.',
    submit: 'Set the password',
    next: 'Next you will set up an authenticator app.',
    backToSignIn: 'Back to sign in',
  },

  changePassword: {
    title: 'Change your password',
    success: 'Your password was changed. Your other sessions were signed out.',
    done: 'Done',
    currentLabel: 'Current password',
    currentWrong: 'The current password is not right.',
    newLabel: 'New password',
    newHint_one: 'At least {{count}} character.',
    newHint_other: 'At least {{count}} characters.',
    repeatLabel: 'Repeat the new password',
    lockoutNote:
      'After five wrong current passwords this page has to wait a while. Your sign-in and other sessions are not affected.',
    submit: 'Change the password',
  },

  stepUp: {
    title: 'Confirm it is you',
    intro:
      'This action needs a fresh code from your authenticator. It stays confirmed for a few minutes.',
    codeWrong: 'That code is not right, or was used already. Wait for the next one.',
  },
} as const;
