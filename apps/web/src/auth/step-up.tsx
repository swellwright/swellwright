import { Anchor, Button, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { ModalFooter, OverlayHeader } from '@swellwright/ui';

import { ApiRequestError, StepUpCancelledError, stepUp } from '../api.js';
import { notifyError } from '../shell/feedback.js';
import { CODE_LENGTH, CodeInput } from './code-input.js';
import { describeError } from './messages.js';
import { StepUpWaiters } from './step-up-waiters.js';

interface StepUp {
  /**
   * Runs a call that may need a freshly verified second factor. When the server answers `step_up_required`,
   * asks for a code once and runs the call again; a closed dialog fails it with `StepUpCancelledError`.
   */
  readonly run: <T>(action: () => Promise<T>) => Promise<T>;
}

const StepUpContext = createContext<StepUp | undefined>(undefined);

export function useStepUp(): StepUp {
  const context = useContext(StepUpContext);
  if (!context) {
    throw new Error('useStepUp needs a StepUpProvider above it.');
  }
  return context;
}

/** Holds the confirmation dialog and the helper that every sensitive call goes through. */
export function StepUpProvider({ children }: { children: ReactNode }) {
  // Every call that needs the code waits on the one dialog; none replaces another.
  const [waiters] = useState(() => new StepUpWaiters());
  const opened = useSyncExternalStore(waiters.subscribe, waiters.isPending);
  // The console goes away (signed out, the session ended): nothing is left waiting for a dialog that is gone, and a
  // request that asks for the code later fails at once instead of waiting for ever.
  useEffect(() => {
    waiters.activate();
    return () => {
      waiters.dispose(new StepUpCancelledError());
    };
  }, [waiters]);

  const run = useCallback(
    <T,>(action: () => Promise<T>): Promise<T> =>
      waiters.run(
        action,
        (error) => error instanceof ApiRequestError && error.code === 'step_up_required',
      ),
    [waiters],
  );
  const value = useMemo<StepUp>(() => ({ run }), [run]);

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpDialog
        onCancel={() => {
          waiters.rejectAll(new StepUpCancelledError());
        }}
        onDone={() => {
          waiters.resolveAll();
        }}
        opened={opened}
      />
    </StepUpContext.Provider>
  );
}

function StepUpDialog({
  opened,
  onDone,
  onCancel,
}: {
  opened: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const mutation = useMutation({
    mutationFn: (value: string) => stepUp(value),
    onSuccess: () => {
      setCode('');
      setRecovery(false);
      onDone();
    },
    onError: (error) => {
      setCode('');
      notifyError(
        t('stepUp.title'),
        describeError(t, error, recovery ? t('totp.recoveryInvalid') : t('stepUp.codeWrong')),
      );
    },
  });
  // Six digits send themselves.
  const { mutate, isPending, reset } = mutation;
  useEffect(() => {
    if (opened && !recovery && code.length === CODE_LENGTH && !isPending) {
      mutate(code);
    }
  }, [opened, code, recovery, isPending, mutate]);

  const cancel = () => {
    reset();
    setCode('');
    setRecovery(false);
    onCancel();
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (code.trim().length > 0) {
      mutate(code);
    }
  };

  return (
    <Modal
      centered
      onClose={cancel}
      opened={opened}
      title={<OverlayHeader icon={IconShieldLock} iconColor="blue" title={t('stepUp.title')} />}
      zIndex={300}
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <Text c="dimmed" fz="sm">
            {t('stepUp.intro')}
          </Text>
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
          <Anchor
            c="dimmed"
            component="button"
            fz="xs"
            onClick={() => {
              setRecovery(!recovery);
              setCode('');
              reset();
            }}
            type="button"
          >
            {recovery ? t('totp.useAuthenticator') : t('totp.useRecovery')}
          </Anchor>
        </Stack>
        <ModalFooter>
          <Button onClick={cancel} variant="subtle">
            {t('common:cancel')}
          </Button>
          <Button
            color="teal"
            leftSection={<IconShieldLock size={16} />}
            loading={isPending}
            size="md"
            type="submit"
            variant="soft"
          >
            {t('common:confirm')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
