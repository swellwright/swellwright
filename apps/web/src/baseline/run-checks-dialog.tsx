// The dialog follows the panel's modals (a titled `Modal`, `OverlayHeader`, the sticky `ModalFooter` with a teal soft
// primary button). Starting a check has no counterpart in the panel; the inputs are the panel's.
import {
  Button,
  Group,
  Modal,
  MultiSelect,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconChecklist, IconInfoCircle } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { BaselineSummary, BaselineFleetItem } from '@swellwright/contracts';
import { Callout, ModalFooter, OverlayHeader } from '@swellwright/ui';

import { startBaselineRuns } from '../api.js';
import { useStepUp } from '../auth/step-up.js';
import { notifyFailure } from '../security/notify-failure.js';
import { notifySuccess, notifyWarning } from '../shell/feedback.js';

/** Starts checks for every server that has a baseline, or for chosen servers, against their baselines or a chosen one. */
export function RunChecksDialog({
  opened,
  items,
  baselines,
  initialServerIds,
  onClose,
}: {
  opened: boolean;
  items: readonly BaselineFleetItem[];
  baselines: readonly BaselineSummary[];
  /** When given, the dialog starts with these servers chosen. */
  initialServerIds?: readonly string[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['baseline', 'common']);
  const queryClient = useQueryClient();
  const step = useStepUp();
  const [scope, setScope] = useState<'all' | 'some'>(
    initialServerIds && initialServerIds.length > 0 ? 'some' : 'all',
  );
  const [serverIds, setServerIds] = useState<string[]>([...(initialServerIds ?? [])]);
  const [baselineId, setBaselineId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      step.run(() =>
        startBaselineRuns({
          ...(scope === 'all' ? { all: true as const } : { serverIds }),
          ...(baselineId === null ? {} : { baselineId }),
        }),
      ),
    onSuccess: async (result) => {
      if (result.runs.length === 0) {
        notifyWarning(t('baseline:run.nothing'), '');
      } else {
        notifySuccess(
          result.runs.length === 1
            ? t('baseline:run.started')
            : t('baseline:run.startedFor', { count: result.runs.length }),
          result.skipped.length > 0
            ? t('baseline:run.skippedSome', { count: result.skipped.length })
            : undefined,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ['baseline'] });
      onClose();
    },
    onError: (error) => {
      notifyFailure(
        t,
        t('baseline:run.failed'),
        error,
        t('baseline:signInAgain'),
        t('baseline:noRun'),
      );
    },
  });

  const canStart = scope === 'all' || serverIds.length > 0;
  return (
    <Modal
      centered
      onClose={onClose}
      opened={opened}
      size="lg"
      title={
        <OverlayHeader icon={IconChecklist} iconColor="cyan" title={t('baseline:run.title')} />
      }
    >
      <Stack gap="md">
        <Callout color="blue" icon={<IconInfoCircle size={20} />}>
          {t('baseline:run.readOnly')}
        </Callout>
        <Stack gap={4}>
          <Text fw={500} size="sm">
            {t('baseline:run.scope')}
          </Text>
          <SegmentedControl
            data={[
              { value: 'all', label: t('baseline:run.all') },
              { value: 'some', label: t('baseline:run.some') },
            ]}
            fullWidth
            onChange={(value) => {
              setScope(value === 'some' ? 'some' : 'all');
            }}
            value={scope}
          />
        </Stack>
        {scope === 'some' ? (
          <MultiSelect
            checkIconPosition="right"
            clearable
            data={items.map((item) => ({ value: item.server.id, label: item.server.name }))}
            label={t('baseline:run.servers')}
            onChange={setServerIds}
            placeholder={t('baseline:run.serversPlaceholder')}
            searchable
            value={serverIds}
            withAsterisk
          />
        ) : null}
        <Select
          clearable
          data={baselines.map((baseline) => ({ value: baseline.id, label: baseline.name }))}
          description={t('baseline:run.baselineHint')}
          label={t('baseline:run.baseline')}
          onChange={setBaselineId}
          placeholder={t('baseline:run.baselineAssigned')}
          searchable
          value={baselineId}
        />
      </Stack>
      <ModalFooter>
        <Group gap="xs" justify="flex-end" w="100%">
          <Button onClick={onClose} variant="subtle">
            {t('common:cancel')}
          </Button>
          <Button
            color="teal"
            disabled={!canStart}
            loading={start.isPending}
            onClick={() => {
              start.mutate();
            }}
            variant="light"
          >
            {t('baseline:run.start')}
          </Button>
        </Group>
      </ModalFooter>
    </Modal>
  );
}
