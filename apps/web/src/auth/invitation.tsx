import { Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiSignpostDuotone } from 'react-icons/pi';

import { PASSWORD_MIN_LENGTH, PasswordSchema } from '@swellwright/contracts';

import { acceptInvitation } from '../api.js';
import { notifyError } from '../shell/feedback.js';
import { describeError } from './messages.js';
import { useAuthTickets } from './auth-tickets.js';
import { type AuthTicket, startedWith, SupersededError } from './session-transitions.js';

const HASH_PREFIX = '#invite=';

let taken: { token: string | undefined } | undefined;

/**
 * The invitation token from the address (`#invite=<token>`), removed from it so it does not stay in the
 * history or get copied along with the address. Undefined when the address has none.
 */
export function takeInvitationFromAddress(): string | undefined {
  // Read once and remembered: React may run an initializer twice, and the second look finds the address bare.
  if (!taken) {
    const { hash } = window.location;
    let token: string | undefined;
    if (hash.startsWith(HASH_PREFIX)) {
      try {
        token = decodeURIComponent(hash.slice(HASH_PREFIX.length)).trim() || undefined;
      } catch {
        token = undefined;
      }
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    taken = { token };
  }
  return taken.token;
}

/** The link an owner hands over: the console's own address with the token in the fragment. */
export const invitationLink = (token: string): string =>
  `${window.location.origin}/${HASH_PREFIX}${encodeURIComponent(token)}`;

/** Choosing a password with an invitation; the authenticator is set up next. */
export function AcceptInvitationForm({
  initialToken,
  onAccepted,
  onBack,
}: {
  initialToken: string | undefined;
  onAccepted: (ticket: AuthTicket) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('auth');
  const tickets = useAuthTickets();
  const [token, setToken] = useState(initialToken ?? '');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);

  const passwordCheck = PasswordSchema.safeParse(password);
  const mismatch = repeat.length > 0 && repeat !== password;
  const valid = token.length > 0 && passwordCheck.success && repeat === password;

  const mutation = useMutation({
    mutationFn: (sent: { ticket: AuthTicket; token: string; password: string }) =>
      startedWith(tickets, sent.ticket, () =>
        acceptInvitation({ token: sent.token, password: sent.password }),
      ),
    onSuccess: ({ ticket }) => {
      setPassword('');
      setRepeat('');
      onAccepted(ticket);
    },
    onError: (error) => {
      // A step superseded before it was sent (another account was read meanwhile) is not an error to show.
      if (error instanceof SupersededError) {
        return;
      }
      notifyError(t('invitation.title'), describeError(t, error, t('invitation.invalid')));
    },
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (valid) {
      mutation.mutate({ ticket: tickets.ticket(), token, password });
    }
  };

  return (
    <form onSubmit={submit}>
      <TextInput
        autoComplete="off"
        description={t('invitation.tokenHint')}
        label={t('invitation.tokenLabel')}
        onChange={(e) => {
          setToken(e.currentTarget.value.trim());
        }}
        placeholder={t('invitation.tokenLabel')}
        required
        size="md"
        value={token}
      />
      <Stack mt="md">
        <PasswordInput
          autoComplete="new-password"
          autoFocus={token.length > 0}
          description={t('shared.passwordHint', { count: PASSWORD_MIN_LENGTH })}
          error={touched && !passwordCheck.success ? t('shared.passwordTooShort') : undefined}
          label={t('invitation.passwordLabel')}
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
        {t('invitation.submit')}
      </Button>
      <Text c="dimmed" fz="xs" mt="md" ta="center">
        {t('invitation.next')}
      </Text>
      <Stack align="center" mt="xs">
        <Anchor c="dimmed" component="button" fz="xs" onClick={onBack} type="button">
          {t('invitation.backToSignIn')}
        </Anchor>
      </Stack>
    </form>
  );
}
