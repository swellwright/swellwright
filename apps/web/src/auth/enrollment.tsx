import { Button, Card, Checkbox, CopyButton, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiArrowRightDuotone,
  PiCheckDuotone,
  PiCopyDuotone,
  PiDownloadSimpleDuotone,
  PiShieldCheckDuotone,
} from 'react-icons/pi';

import type { TotpConfirmed } from '@swellwright/contracts';
import { CopyableCodeBlock, ErrorMessageBlock, LoadingScreen } from '@swellwright/ui';

import { confirmTotpEnrollment, startTotpEnrollment } from '../api.js';
import { notifyError } from '../shell/feedback.js';
import { CODE_LENGTH, CodeInput } from './code-input.js';
import { describeError } from './messages.js';
import { useAuthTickets } from './auth-tickets.js';
import { type AuthTicket, startedWith, SupersededError } from './session-transitions.js';
import { QrCode } from './qr.js';

/** Shows the authenticator secret as a QR code and as text, then asks for a code to prove it works. */
export function EnrollmentStep({
  onConfirmed,
}: {
  onConfirmed: (result: TotpConfirmed, ticket: AuthTicket) => void;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const tickets = useAuthTickets();
  const enrollment = useQuery({
    queryKey: ['auth', 'enrollment'],
    queryFn: startTotpEnrollment,
    // The server returns the same secret until it is confirmed; keep it out of the cache afterwards.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: (sent: { ticket: AuthTicket; code: string }) =>
      startedWith(tickets, sent.ticket, () => confirmTotpEnrollment(sent.code)),
    onSuccess: ({ value, ticket }) => {
      onConfirmed(value, ticket);
    },
    onError: (error) => {
      // A step superseded before it was sent (another account was read meanwhile) is not an error to show.
      if (error instanceof SupersededError) {
        return;
      }
      setCode('');
      notifyError(t('enrollment.title'), describeError(t, error, t('totp.codeWrong')));
    },
  });
  // Six digits send themselves.
  const { mutate, isPending } = confirm;
  useEffect(() => {
    if (code.length === CODE_LENGTH && !isPending) {
      mutate({ ticket: tickets.ticket(), code });
    }
  }, [code, isPending, mutate, tickets]);

  if (enrollment.isPending) {
    return <LoadingScreen height="40vh" />;
  }
  if (enrollment.isError) {
    return (
      <ErrorMessageBlock
        copiedLabel={t('common:copied')}
        copyLabel={t('common:copy')}
        message={describeError(t, enrollment.error, t('shared.signInAgain'))}
      />
    );
  }
  const { secret, otpauthUri } = enrollment.data;
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Text fw={600} fz="sm">
          {t('enrollment.addTitle')}
        </Text>
        <Text c="dimmed" fz="sm">
          {t('enrollment.addHint')}
        </Text>
        <Group align="flex-start" gap="lg" wrap="wrap">
          <QrCode label={t('enrollment.qrLabel')} text={otpauthUri} />
          <Stack gap={6} style={{ flex: 1, minWidth: 180 }}>
            <Text c="dimmed" fz="xs">
              {t('enrollment.keyLabel')}
            </Text>
            <CopyableCodeBlock
              copiedLabel={t('common:copied')}
              copyLabel={t('enrollment.copyKey')}
              size="small"
              value={secret}
            />
          </Stack>
        </Group>
      </Stack>
      <CodeInput
        busy={isPending}
        label={t('enrollment.enterTitle')}
        onChange={setCode}
        value={code}
      />
      <Button
        disabled={code.length !== CODE_LENGTH}
        fullWidth
        leftSection={<PiShieldCheckDuotone size="16px" />}
        loading={confirm.isPending}
        mt="sm"
        onClick={() => {
          confirm.mutate({ ticket: tickets.ticket(), code });
        }}
        variant="default"
      >
        {t('enrollment.submit')}
      </Button>
    </Stack>
  );
}

/** The one-time recovery codes. They are shown once, so the person has to say they saved them. */
export function RecoveryCodes({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
  const { t } = useTranslation(['auth', 'common']);
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'swellwright-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Stack gap="lg">
      <Text c="dimmed" fz="sm">
        {t('recoveryCodes.intro')}
      </Text>
      <SimpleGrid cols={2} spacing={8}>
        {codes.map((code, index) => (
          <Card key={code} px="sm" py={6}>
            <Group gap={6} wrap="nowrap">
              <Text c="dimmed" ff="monospace" fz="xs">
                {index + 1}
              </Text>
              <Text ff="monospace" fz="sm">
                {code}
              </Text>
            </Group>
          </Card>
        ))}
      </SimpleGrid>
      <Group gap="xs" grow>
        <CopyButton timeout={2000} value={text}>
          {({ copied, copy }) => (
            <Button
              leftSection={copied ? <PiCheckDuotone size="16px" /> : <PiCopyDuotone size="16px" />}
              onClick={copy}
              variant="default"
            >
              {copied ? t('common:copied') : t('recoveryCodes.copyAll')}
            </Button>
          )}
        </CopyButton>
        <Button
          leftSection={<PiDownloadSimpleDuotone size="16px" />}
          onClick={download}
          variant="default"
        >
          {t('common:download')}
        </Button>
      </Group>
      <Checkbox
        checked={saved}
        label={t('recoveryCodes.saved')}
        onChange={(e) => {
          setSaved(e.currentTarget.checked);
        }}
      />
      <Button
        disabled={!saved}
        fullWidth
        leftSection={<PiArrowRightDuotone size="16px" />}
        mt="sm"
        onClick={onDone}
        variant="default"
      >
        {t('recoveryCodes.continue')}
      </Button>
    </Stack>
  );
}
