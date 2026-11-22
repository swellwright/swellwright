// Adapted from the Remnawave panel frontend 3.4.11 (AGPL-3.0-only): the small create dialogs of the panel (for example
// src/shared/_modals/config-profiles/create-config-profile-modal and the tag and squad name modals): a `Modal` with an
// `OverlayHeader`, a form of one or two fields, and a footer with a subtle cancel and a soft teal primary action. Changes:
// the action reads the panel on the server, so the dialog says what is kept and that secrets are not; the dialog stays
// open while the request runs and shows its failure as a toast.
import { Button, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconCamera } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PANEL_SNAPSHOT_LABEL_MAX } from '@swellwright/contracts';
import { ModalFooter, OverlayHeader } from '@swellwright/ui';

import { createPanelSnapshot } from '../api.js';
import { notifyFailure } from '../security/notify-failure.js';
import { notifySuccess } from '../shell/feedback.js';
import { panelKey } from './panel-data.js';

/** Takes a snapshot of the panel: an optional name, then the server reads the panel and keeps what it holds. */
export function TakeSnapshotDialog({
  opened,
  onClose,
  onTaken,
}: {
  opened: boolean;
  onClose: () => void;
  /** Called with the id of the snapshot that was taken. */
  onTaken?: (id: string) => void;
}) {
  const { t } = useTranslation(['snapshots', 'common', 'panel']);
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');

  const mutation = useMutation({
    mutationFn: () => createPanelSnapshot(label.trim() === '' ? undefined : label.trim()),
    onSuccess: (snapshot) => {
      void queryClient.invalidateQueries({ queryKey: panelKey('snapshots') });
      notifySuccess(
        t('snapshots:take.done'),
        t('snapshots:take.doneText', { count: snapshot.objectCount }),
      );
      onTaken?.(snapshot.id);
      close();
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('snapshots:take.failed'),
        error,
        t('panel:signInAgain'),
        t('snapshots:noWrite'),
      );
    },
  });

  function close() {
    mutation.reset();
    setLabel('');
    onClose();
  }
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <Modal
      centered
      closeOnClickOutside={!mutation.isPending}
      closeOnEscape={!mutation.isPending}
      onClose={close}
      opened={opened}
      title={<OverlayHeader icon={IconCamera} iconColor="teal" title={t('snapshots:take.title')} />}
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            {t('snapshots:take.text')}
          </Text>
          <TextInput
            data-autofocus
            description={t('snapshots:take.labelHint')}
            label={t('snapshots:take.labelLabel')}
            maxLength={PANEL_SNAPSHOT_LABEL_MAX}
            onChange={(event) => {
              setLabel(event.currentTarget.value);
            }}
            placeholder={t('snapshots:take.labelPlaceholder')}
            value={label}
          />
        </Stack>
        <ModalFooter>
          <Button disabled={mutation.isPending} onClick={close} variant="subtle">
            {t('common:cancel')}
          </Button>
          <Button
            color="teal"
            leftSection={<IconCamera size={16} />}
            loading={mutation.isPending}
            size="md"
            type="submit"
            variant="soft"
          >
            {t('snapshots:take.submit')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
