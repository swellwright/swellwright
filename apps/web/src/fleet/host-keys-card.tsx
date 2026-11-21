// The look of this card follows the panel's drawer cards (src/shared/ui/section-card, src/shared/ui/overlays/
// base-overlay-header and the `DataList` rows of its record drawers). The pinning of host keys has no counterpart in the
// panel; the form is the panel's text input, select and soft teal button.
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  DataList,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconFingerprint, IconPin, IconScan, IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FingerprintSchema,
  HostKeyAlgorithmSchema,
  type ServerHostKey,
  type ServerView,
} from '@swellwright/contracts';
import { CopyableDataListItem, OverlayHeader, SectionCard } from '@swellwright/ui';

import { acceptHostKey, pinHostKey, revokeHostKey, scanHostKey } from '../api.js';
import { useTimeFirst } from '../security/time-first.js';
import { notifyFailure } from '../security/notify-failure.js';
import { HostKeyScanDialog } from './host-key-scan-dialog.js';
import { notifySshFailure } from './ssh-errors.js';
import { confirmAction, notifySuccess } from '../shell/feedback.js';

/** The key types OpenSSH servers have, in the order a person is most likely to need them. */
const ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

export function HostKeysCard({
  server,
  canWrite,
  onChanged,
}: {
  server: ServerView;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['servers', 'common']);
  const formatTime = useTimeFirst();
  const queryClient = useQueryClient();
  const [algorithm, setAlgorithm] = useState<string>('ssh-ed25519');
  const [fingerprint, setFingerprint] = useState('');
  const [touched, setTouched] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const fingerprintOk = FingerprintSchema.safeParse(fingerprint).success;
  const algorithmOk = HostKeyAlgorithmSchema.safeParse(algorithm).success;

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['servers'] });
    void queryClient.invalidateQueries({ queryKey: ['server', server.id] });
    onChanged();
  };

  const pin = useMutation({
    mutationFn: () =>
      pinHostKey(server.id, {
        algorithm: algorithm.trim(),
        fingerprintSha256: fingerprint.trim(),
      }),
    onSuccess: () => {
      notifySuccess(t('toast.success'), t('hostKeys.pinned', { name: server.name }));
      setFingerprint('');
      setTouched(false);
      done();
    },
    onError: (error) => {
      notifyFailure(t, t('hostKeys.pinFailed'), error, t('signInAgain'), t('hostKeys.forbidden'));
    },
  });

  // Reading the key sends no credential, but it opens a connection: only when the person asks, never by itself.
  const scan = useMutation({
    mutationFn: () => scanHostKey(server.id),
    onError: (error) => {
      notifySshFailure(
        t,
        t('hostKeys.scan.scanFailed'),
        error,
        t('signInAgain'),
        t('hostKeys.forbidden'),
      );
    },
  });

  const accept = useMutation({
    mutationFn: (request: { fingerprint: string; replace: boolean }) =>
      acceptHostKey(server.id, {
        fingerprintSha256: request.fingerprint,
        ...(request.replace ? { replace: true } : {}),
      }),
    onSuccess: (accepted) => {
      notifySuccess(
        t('toast.success'),
        accepted.replaced > 0
          ? t('hostKeys.scan.replaced', { name: server.name })
          : t('hostKeys.scan.accepted', { name: server.name }),
      );
      setScanOpen(false);
      done();
    },
    onError: (error) => {
      // The dialog shows the reason next to what was asked; a toast says that it did not go through.
      notifySshFailure(
        t,
        t('hostKeys.scan.acceptFailed'),
        error,
        t('signInAgain'),
        t('hostKeys.forbidden'),
      );
    },
  });

  const startScan = () => {
    accept.reset();
    scan.mutate();
  };

  const revoke = useMutation({
    mutationFn: (key: ServerHostKey) => revokeHostKey(server.id, key.id),
    onSuccess: () => {
      notifySuccess(t('toast.success'), t('hostKeys.revoked'));
      done();
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('hostKeys.revokeFailed'),
        error,
        t('signInAgain'),
        t('hostKeys.forbidden'),
      );
    },
  });

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (fingerprintOk && algorithmOk) {
      pin.mutate();
    }
  };

  const askRevoke = (key: ServerHostKey) => {
    confirmAction({
      title: t('hostKeys.revokeTitle'),
      message: (
        <Stack gap="xs">
          <Text fw={600} size="sm">
            {t('hostKeys.revokeIrreversible')}
          </Text>
          <Text size="sm">{t('hostKeys.revokeWarning', { name: server.name })}</Text>
          <Code block>{key.fingerprintSha256}</Code>
        </Stack>
      ),
      confirmLabel: t('hostKeys.revoke'),
      cancelLabel: t('common:cancel'),
      onConfirm: () => {
        revoke.mutate(key);
      },
    });
  };

  return (
    <>
      <SectionCard.Root>
        <SectionCard.Section>
          <Group align="center" justify="space-between" wrap="wrap">
            <OverlayHeader
              icon={IconFingerprint}
              iconColor={server.hostKeys.length > 0 ? 'teal' : 'orange'}
              subtitle={t('hostKeys.subtitle')}
              title={t('hostKeys.title')}
              titleOrder={5}
            />
            <Group gap="xs" wrap="wrap">
              <Badge
                color={server.hostKeys.length > 0 ? 'teal' : 'orange'}
                size="lg"
                variant="soft"
              >
                {server.hostKeys.length > 0
                  ? t('hostKeys.count', { count: server.hostKeys.length })
                  : t('hostKeys.none')}
              </Badge>
              {canWrite ? (
                <Button
                  color="teal"
                  leftSection={<IconScan size={16} />}
                  onClick={() => {
                    setScanOpen(true);
                    startScan();
                  }}
                  variant="soft"
                >
                  {t('hostKeys.scan.button')}
                </Button>
              ) : null}
            </Group>
          </Group>
        </SectionCard.Section>

        {server.hostKeys.map((key) => (
          <SectionCard.Section key={key.id}>
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Badge color="gray" size="lg" variant="soft">
                  {key.algorithm}
                </Badge>
                {canWrite ? (
                  <Tooltip label={t('hostKeys.revoke')} withArrow>
                    <ActionIcon
                      aria-label={t('hostKeys.revokeNamed', { fingerprint: key.fingerprintSha256 })}
                      color="red"
                      loading={revoke.isPending && revoke.variables.id === key.id}
                      onClick={() => {
                        askRevoke(key);
                      }}
                      size="lg"
                      variant="soft"
                    >
                      <IconTrash size={18} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </Group>
              <DataList orientation="vertical" withDivider>
                <CopyableDataListItem
                  copiedLabel={t('common:copied')}
                  copyLabel={t('common:copy')}
                  label={t('hostKeys.fingerprint')}
                  monospace
                  value={key.fingerprintSha256}
                />
                <DataList.Item>
                  <DataList.ItemLabel>{t('hostKeys.pinnedBy')}</DataList.ItemLabel>
                  <DataList.ItemValue>
                    {key.acceptedBy ?? t('hostKeys.unknownUser')}, {formatTime(key.acceptedAt)}
                  </DataList.ItemValue>
                </DataList.Item>
              </DataList>
            </Stack>
          </SectionCard.Section>
        ))}

        {server.hostKeys.length === 0 ? (
          <SectionCard.Section>
            <Text c="dimmed" size="sm">
              {t('hostKeys.empty')}
            </Text>
          </SectionCard.Section>
        ) : null}

        {canWrite ? (
          <SectionCard.Section>
            <form onSubmit={submit}>
              <Stack gap="md">
                <Text c="dimmed" size="sm">
                  {t('hostKeys.howTo')}{' '}
                  <Code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</Code>
                </Text>
                <Select
                  allowDeselect={false}
                  data={ALGORITHMS}
                  label={t('hostKeys.algorithm')}
                  onChange={(value) => {
                    setAlgorithm(value ?? 'ssh-ed25519');
                  }}
                  styles={{ label: { fontWeight: 500 } }}
                  value={algorithm}
                />
                <TextInput
                  autoComplete="off"
                  error={touched && !fingerprintOk ? t('hostKeys.fingerprintError') : undefined}
                  label={t('hostKeys.fingerprint')}
                  onChange={(event) => {
                    setFingerprint(event.currentTarget.value);
                  }}
                  placeholder="SHA256:…"
                  spellCheck={false}
                  styles={{
                    input: { fontFamily: 'var(--mantine-font-family-monospace)' },
                    label: { fontWeight: 500 },
                  }}
                  value={fingerprint}
                />
                <Group justify="flex-end">
                  <Button
                    color="teal"
                    leftSection={<IconPin size={16} />}
                    loading={pin.isPending}
                    type="submit"
                    variant="soft"
                  >
                    {t('hostKeys.pin')}
                  </Button>
                </Group>
              </Stack>
            </form>
          </SectionCard.Section>
        ) : null}
      </SectionCard.Root>
      <HostKeyScanDialog
        confirm={{ isPending: accept.isPending, error: accept.error }}
        onClose={() => {
          setScanOpen(false);
        }}
        onConfirm={(fingerprint, replace) => {
          accept.mutate({ fingerprint, replace });
        }}
        onScanAgain={startScan}
        opened={scanOpen}
        scan={{ data: scan.data, isPending: scan.isPending, error: scan.error }}
        server={server}
      />
    </>
  );
}
