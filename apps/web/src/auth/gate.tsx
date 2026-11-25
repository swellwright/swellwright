import { Button, Stack, Text } from '@mantine/core';
import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiArrowClockwiseDuotone } from 'react-icons/pi';

import type { PendingSession, SessionInfo } from '@swellwright/contracts';

import {
  ApiRequestError,
  ApiUnreachableError,
  getMe,
  getSetupStatus,
  logout,
  onUnauthorized,
} from '../api.js';
import { closeSessionFeedback, notifyWarning } from '../shell/feedback.js';
import { LoadingProgress } from '../shell/loading-progress.js';
import { sessionQueryClients } from './session-cache.js';
import {
  announceSessionChange,
  createSessionWatch,
  onReturnToTab,
  onSessionChange,
} from './session-watch.js';
import { AuthTicketsContext } from './auth-tickets.js';
import {
  AuthState,
  reconcileEnrollment,
  type AuthTicket,
  ME_KEY,
  type RecoveryCodesFor,
  visibleRecoveryCodes,
  watchSessionTransitions,
} from './session-transitions.js';
import { EnrollmentStep, RecoveryCodes } from './enrollment.js';
import { LoginForm, SetupForm, TotpForm } from './forms.js';
import { AcceptInvitationForm, takeInvitationFromAddress } from './invitation.js';
import { AuthLayout } from './layout.js';

type Step = 'login' | 'setup' | 'totp' | 'enroll' | 'invite';

/**
 * Shows the console only to a signed-in person. Before that it walks through what the server asks for:
 * first-run setup, the password, then the authenticator (or its enrollment).
 */
export function AuthGate({
  children,
}: {
  children: (session: SessionInfo, signOut: () => Promise<void>) => ReactNode;
}) {
  const queryClient = useQueryClient();
  // The one writer of the gate's query: this tab's sign-in and sign-out win over any answer still on its way, and a
  // sign-in step takes its ticket here when it starts.
  const [auth] = useState(() => new AuthState(queryClient));
  useEffect(() => {
    auth.follow();
    return () => {
      auth.dispose();
    };
  }, [auth]);
  return (
    <AuthTicketsContext.Provider value={auth}>
      <Gate auth={auth}>{children}</Gate>
    </AuthTicketsContext.Provider>
  );
}

function Gate({
  auth,
  children,
}: {
  auth: AuthState;
  children: (session: SessionInfo, signOut: () => Promise<void>) => ReactNode;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const queryClient = useQueryClient();
  // Asked again only by the watch below (and by this tab's own sign-in and sign-out), never by TanStack on its own
  // after a reconnect or a focus: every answer about who is signed in goes through the same path.
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: getMe,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const signedOut = me.data === null;
  const setup = useQuery({
    queryKey: ['auth', 'setup'],
    queryFn: getSetupStatus,
    enabled: signedOut,
    retry: false,
  });
  // A link with an invitation opens its screen first; the token leaves the address bar at once.
  const [invitation] = useState(takeInvitationFromAddress);
  const [step, setStep] = useState<Step | undefined>(invitation ? 'invite' : undefined);
  // The recovery codes belong to the account they were made for, and are shown to it only.
  const [heldCodes, setHeldCodes] = useState<RecoveryCodesFor | undefined>(undefined);

  const signedInAs = me.data?.user.id;
  const recoveryCodes = visibleRecoveryCodes(heldCodes, signedInAs);

  // Whenever the account named by the gate's query changes away from one (to nobody or to another account, by any
  // path: a sign-out, the watch, a refetch, another tab), that session is torn down before the next screen is drawn:
  // its dialogs and toasts, its cache and the callbacks of its late answers, and what the gate kept for that person.
  useEffect(
    () =>
      watchSessionTransitions({
        outer: queryClient,
        sessions: sessionQueryClients,
        closeFeedback: closeSessionFeedback,
        resetLocal: () => {
          setHeldCodes(undefined);
          setStep(undefined);
        },
      }),
    [queryClient],
  );

  const toSignInScreens = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['auth', 'setup'] });
  }, [queryClient]);

  // The browser's session may change under this console: a 401 from any call (expired, revoked), another tab that
  // signed out or in as somebody else (it says so on a channel), or simply the tab coming back into view. Each asks
  // the server who is signed in; "nobody" ends this console, another account replaces it.
  useEffect(() => {
    if (signedInAs === undefined) {
      // Signed out here: another tab that signs in makes this one ask again.
      return onSessionChange(() => {
        void queryClient.invalidateQueries({ queryKey: ME_KEY });
      });
    }
    const watch = createSessionWatch({
      userId: signedInAs,
      current: () => auth.check(getMe),
      // The watch publishes every answer itself (also one about the same account, whose role or permissions may have
      // changed), through the check's own guarded publish; these only say what happened.
      onEnded: () => {
        toSignInScreens();
        notifyWarning(t('gate.sessionEndedTitle'), t('gate.sessionEnded'));
      },
      onChanged: () => {
        notifyWarning(t('gate.accountChangedTitle'), t('gate.accountChanged'));
      },
    });
    const stops = [
      onUnauthorized(watch.check),
      onSessionChange(watch.check),
      onReturnToTab(watch.check),
      // The network is back: the session may have expired meanwhile.
      onlineManager.subscribe((online) => {
        if (online) {
          watch.check();
        }
      }),
    ];
    return () => {
      watch.dispose();
      for (const stop of stops) {
        stop();
      }
    };
  }, [signedInAs, auth, toSignInScreens, queryClient, t]);

  // Signing out counts once the server confirms it. A call that does not get through leaves the person signed in (the
  // cookie still works) and fails, so the console can say so and offer to try again. A 401 means it is over already.
  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 401)) {
        throw error;
      }
    }
    auth.commit(null);
    toSignInScreens();
    announceSessionChange();
  }, [auth, toSignInScreens]);
  // A sign-in step answered after the session changed (another tab signed in, the watch read somebody else) is not
  // acted on: the gate asks the server who is signed in instead.
  const reconcile = () => {
    void queryClient.invalidateQueries({ queryKey: ME_KEY });
  };
  const signedIn = (session: SessionInfo, ticket: AuthTicket): boolean => {
    // Whatever another account left in this tab is torn down by the watch of transitions before this one is shown,
    // and an older answer still on its way (a refetch another tab caused) cannot undo this one.
    if (!auth.commitIf(ticket, session)) {
      reconcile();
      return false;
    }
    announceSessionChange();
    return true;
  };
  /** A step that only moves the screens on, from an answer that is still current. */
  const stepTo = (target: Step, ticket: AuthTicket) => {
    if (!auth.isCurrent(ticket)) {
      reconcile();
      return;
    }
    setStep(target);
  };
  const next = (result: PendingSession['next'], ticket: AuthTicket) => {
    stepTo(result === 'totp' ? 'totp' : 'enroll', ticket);
  };
  const backToPassword = () => {
    // The password-only session is of no use now; drop it so nothing is left behind.
    void logout().catch(() => undefined);
    setStep('login');
  };

  if (recoveryCodes) {
    return (
      <AuthLayout
        description={t('recoveryCodes.description')}
        pageTitle={t('recoveryCodes.title')}
        title={t('recoveryCodes.title')}
      >
        <RecoveryCodes
          codes={recoveryCodes}
          onDone={() => {
            setHeldCodes(undefined);
          }}
        />
      </AuthLayout>
    );
  }
  if (me.isPending) {
    return <LoadingProgress />;
  }
  if (me.isError) {
    const unreachable = me.error instanceof ApiUnreachableError;
    return (
      <AuthLayout
        pageTitle={unreachable ? t('gate.apiDownTitle') : t('gate.somethingWrongTitle')}
        status={unreachable ? t('gate.apiDownTitle') : t('gate.somethingWrongTitle')}
      >
        <Stack gap="md">
          <Text c="dimmed" size="sm" ta="center">
            {unreachable ? t('gate.apiDownHint') : t('gate.versionMismatchHint')}
          </Text>
          <Button
            fullWidth
            leftSection={<PiArrowClockwiseDuotone size="16px" />}
            onClick={() => {
              void me.refetch();
            }}
            variant="default"
          >
            {t('common:retry')}
          </Button>
        </Stack>
      </AuthLayout>
    );
  }
  if (me.data) {
    return <>{children(me.data, signOut)}</>;
  }

  // Nobody is signed in. A server without a database cannot say whether it has an owner.
  if (setup.isPending) {
    return <LoadingProgress />;
  }
  if (setup.isError) {
    const noDatabase = setup.error instanceof ApiRequestError && setup.error.code === 'not_ready';
    return (
      <AuthLayout
        pageTitle={noDatabase ? t('gate.noDatabaseTitle') : t('gate.apiDownTitle')}
        status={noDatabase ? t('gate.noDatabaseTitle') : t('gate.apiDownTitle')}
      >
        <Text c="dimmed" size="sm" ta="center">
          {noDatabase ? t('gate.noDatabaseHint') : t('gate.serverDownHint')}
        </Text>
      </AuthLayout>
    );
  }

  const current: Step = step ?? (setup.data.initialized ? 'login' : 'setup');
  switch (current) {
    case 'invite':
      return (
        <AuthLayout
          description={t('invitation.description')}
          pageTitle={t('invitation.title')}
          title={t('invitation.title')}
        >
          <AcceptInvitationForm
            initialToken={invitation}
            onAccepted={(ticket) => {
              stepTo('enroll', ticket);
            }}
            onBack={() => {
              setStep('login');
            }}
          />
        </AuthLayout>
      );
    case 'setup':
      return (
        <AuthLayout
          description={t('setup.description')}
          pageTitle={t('setup.title')}
          title={t('setup.title')}
        >
          <SetupForm
            onCreated={(ticket) => {
              stepTo('enroll', ticket);
            }}
          />
        </AuthLayout>
      );
    case 'login':
      return (
        <AuthLayout pageTitle={t('login.title')}>
          <LoginForm onNext={next} />
        </AuthLayout>
      );
    case 'totp':
      return (
        <AuthLayout pageTitle={t('totp.title')}>
          <TotpForm onBack={backToPassword} onSignedIn={signedIn} />
        </AuthLayout>
      );
    case 'enroll':
      return (
        <AuthLayout
          description={t('enrollment.description')}
          pageTitle={t('enrollment.title')}
          title={t('enrollment.title')}
        >
          <EnrollmentStep
            onConfirmed={(result, ticket) => {
              const committed = signedIn(
                {
                  user: result.user,
                  permissions: result.permissions,
                  expiresAt: result.expiresAt,
                },
                ticket,
              );
              const codes = { userId: result.user.id, codes: result.recoveryCodes };
              if (committed) {
                setHeldCodes(codes);
                return;
              }
              // Superseded: the server may already have been asked and named this very account (its cookie is set).
              // The codes cannot be read again, so they are kept for it, and dropped only for another account.
              void reconcileEnrollment(auth, result.user.id, getMe).then((mine) => {
                if (mine) {
                  setHeldCodes(codes);
                }
              });
            }}
          />
        </AuthLayout>
      );
  }
}
