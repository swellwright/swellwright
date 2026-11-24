// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): src/features/auth/login-form/login-form.feature.tsx and
// src/features/auth/register-form/register-form.feature.tsx. Changes: the forms keep their state in React instead of
// `@mantine/form`; the authenticator code step is new (built from the login form's parts); the password generator
// draws without modulo bias; errors are toasts through the console's feedback helper.
import { Anchor, Button, PasswordInput, Stack, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PiShuffleDuotone, PiSignInDuotone, PiSignpostDuotone } from 'react-icons/pi';

import {
  PASSWORD_MIN_LENGTH,
  PasswordSchema,
  type PendingSession,
  type SessionInfo,
  UsernameSchema,
} from '@swellwright/contracts';

import { createOwner, login, verifyTotp } from '../api.js';
import { notifyError, notifySuccess } from '../shell/feedback.js';
import { CODE_LENGTH, CodeInput } from './code-input.js';
import { describeError } from './messages.js';

/**
 * The sign-in form of the panel (src/features/auth/login-form): a labelled username and password with the label
 * repeated as the placeholder, and a full-width default button with a leading icon, 32 px under the last field. A
 * failed sign-in is a red toast, as in the panel.
 */
export function LoginForm({ onNext }: { onNext: (next: PendingSession['next']) => void }) {
  const { t } = useTranslation(['auth', 'common']);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => login({ username, password }),
    onSuccess: (result) => {
      setPassword('');
      onNext(result.next);
    },
    onError: (error) => {
      notifyError(t('login.title'), describeError(t, error, t('login.wrongCredentials')));
    },
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate();
  };
  return (
    <form onSubmit={submit}>
      <TextInput
        autoComplete="username"
        autoFocus
        label={t('shared.loginName')}
        name="username"
        onChange={(e) => {
          setUsername(e.currentTarget.value);
        }}
        placeholder={t('shared.loginName')}
        required
        value={username}
      />
      <PasswordInput
        autoComplete="current-password"
        label={t('shared.password')}
        mt="md"
        name="password"
        onChange={(e) => {
          setPassword(e.currentTarget.value);
        }}
        placeholder={t('login.passwordPlaceholder')}
        required
        value={password}
      />
      <Button
        fullWidth
        leftSection={<PiSignInDuotone size="16px" />}
        loading={mutation.isPending}
        mt="xl"
        type="submit"
        variant="default"
      >
        {t('login.submit')}
      </Button>
    </form>
  );
}

/** The second step: six digits from the authenticator, or one recovery code. Built from the sign-in form's parts. */
export function TotpForm({
  onSignedIn,
  onBack,
}: {
  onSignedIn: (session: SessionInfo) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const mutation = useMutation({
    mutationFn: (value: string) => verifyTotp(value),
    onSuccess: onSignedIn,
    onError: (error) => {
      setCode('');
      notifyError(
        t('totp.title'),
        describeError(t, error, recovery ? t('totp.recoveryInvalid') : t('totp.codeWrong')),
      );
    },
  });
  // Six digits send themselves.
  const { mutate, isPending } = mutation;
  useEffect(() => {
    if (!recovery && code.length === CODE_LENGTH && !isPending) {
      mutate(code);
    }
  }, [code, recovery, isPending, mutate]);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (code.trim().length > 0) {
      mutation.mutate(code);
    }
  };
  return (
    <form onSubmit={submit}>
      {recovery ? (
        <TextInput
          autoComplete="off"
          autoFocus
          description={t('totp.recoveryHint')}
          label={t('totp.recoveryLabel')}
          onChange={(e) => {
            setCode(e.currentTarget.value);
          }}
          placeholder="XXXX-XXXX-XXXX"
          required
          value={code}
        />
      ) : (
        <CodeInput
          busy={isPending}
          label={t('totp.codeLabel')}
          onChange={setCode}
          required
          value={code}
        />
      )}
      <Button
        fullWidth
        leftSection={<PiSignInDuotone size="16px" />}
        loading={mutation.isPending}
        mt="xl"
        type="submit"
        variant="default"
      >
        {t('totp.submit')}
      </Button>
      <Stack align="center" gap={4} mt="md">
        <Anchor
          c="dimmed"
          component="button"
          fz="xs"
          onClick={() => {
            setRecovery(!recovery);
            setCode('');
            mutation.reset();
          }}
          type="button"
        >
          {recovery ? t('totp.useAuthenticator') : t('totp.useRecovery')}
        </Anchor>
        <Anchor c="dimmed" component="button" fz="xs" onClick={onBack} type="button">
          {t('totp.backToPassword')}
        </Anchor>
      </Stack>
    </form>
  );
}

const PASSWORD_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * A random password of 32 letters and digits, as the panel's registration form generates one. Bytes that would
 * favour the first characters of the alphabet are thrown away, so every character is equally likely.
 */
export function generatePassword(): string {
  const limit = 256 - (256 % PASSWORD_CHARSET.length);
  let result = '';
  while (result.length < 32) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && result.length < 32) {
        result += PASSWORD_CHARSET.charAt(byte % PASSWORD_CHARSET.length);
      }
    }
  }
  return result;
}

/**
 * The first-run screen. It is the panel's registration form (src/features/auth/register-form): larger fields, a
 * "Generate and copy" button between the passwords and the submit button, and a toast after the copy.
 */
export function SetupForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation(['auth', 'common']);
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);

  const usernameCheck = UsernameSchema.safeParse(username);
  const passwordCheck = PasswordSchema.safeParse(password);
  const mismatch = repeat.length > 0 && repeat !== password;
  const valid =
    setupToken.length > 0 && usernameCheck.success && passwordCheck.success && repeat === password;

  const mutation = useMutation({
    mutationFn: () => createOwner({ setupToken, username, password }),
    onSuccess: () => {
      setPassword('');
      setRepeat('');
      onCreated();
    },
    onError: (error) => {
      notifyError(
        t('setup.title'),
        describeError(t, error, t('shared.signInAgain'), t('setup.tokenWrong')),
      );
    },
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (valid) {
      mutation.mutate();
    }
  };
  const generate = () => {
    const generated = generatePassword();
    setPassword(generated);
    setRepeat(generated);
    navigator.clipboard.writeText(generated).then(
      () => {
        notifySuccess(t('setup.passwordCopied'), t('setup.passwordCopiedMessage'));
      },
      () => {
        notifyError(t('setup.title'), t('setup.passwordCopyFailed'));
      },
    );
  };
  return (
    <form onSubmit={submit}>
      <TextInput
        autoComplete="off"
        autoFocus
        description={t('setup.tokenHint')}
        label={t('setup.tokenLabel')}
        onChange={(e) => {
          setSetupToken(e.currentTarget.value.trim());
        }}
        placeholder={t('setup.tokenPlaceholder')}
        required
        size="md"
        value={setupToken}
      />
      <TextInput
        autoComplete="username"
        description={t('setup.usernameHint')}
        error={touched && !usernameCheck.success ? t('setup.usernameInvalid') : undefined}
        label={t('shared.loginName')}
        mt="md"
        onChange={(e) => {
          setUsername(e.currentTarget.value);
        }}
        placeholder="owner"
        required
        size="md"
        value={username}
      />

      <Stack mt="md">
        <PasswordInput
          autoComplete="new-password"
          description={t('shared.passwordHint', { count: PASSWORD_MIN_LENGTH })}
          error={touched && !passwordCheck.success ? t('shared.passwordTooShort') : undefined}
          label={t('shared.password')}
          onChange={(e) => {
            setPassword(e.currentTarget.value);
          }}
          placeholder={t('setup.passwordPlaceholder')}
          required
          size="md"
          value={password}
        />
        <PasswordInput
          autoComplete="new-password"
          error={mismatch ? t('shared.passwordsDiffer') : undefined}
          label={t('shared.repeatPassword')}
          onChange={(e) => {
            setRepeat(e.currentTarget.value);
          }}
          placeholder={t('setup.passwordPlaceholder')}
          required
          size="md"
          value={repeat}
        />
        <Button
          fullWidth
          leftSection={<PiShuffleDuotone size="16px" />}
          onClick={generate}
          size="md"
        >
          {t('setup.generate')}
        </Button>
      </Stack>

      <Button
        fullWidth
        leftSection={<PiSignpostDuotone size="16px" />}
        loading={mutation.isPending}
        mt="xl"
        size="md"
        type="submit"
        variant="default"
      >
        {t('setup.submit')}
      </Button>
    </form>
  );
}
