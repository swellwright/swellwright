import { ModalsProvider } from '@mantine/modals';
import { QueryClientProvider } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RouterProvider } from 'react-router';

import type { SessionInfo } from '@swellwright/contracts';

import { AuthGate } from './auth/gate.js';
import { sessionQueryClients } from './auth/session-cache.js';
import { StepUpProvider } from './auth/step-up.js';
import { followSavedLanguage } from './i18n.js';
import { createConsoleRouter } from './router.js';
import { ConsoleProvider } from './shell/console-context.js';

/** Made once, the first time the console is shown, and kept when the person signs out and in again. */
let router: ReturnType<typeof createConsoleRouter> | undefined;
const consoleRouter = () => (router ??= createConsoleRouter());

function Console({ session, signOut }: { session: SessionInfo; signOut: () => Promise<void> }) {
  // The language saved on the account wins once, when the session is first known. Later changes in this browser
  // are the person's own and must not be undone by an older value read back from the server. A layout effect
  // switches before the first paint, so the console does not flash in the wrong language.
  const appliedFor = useRef<string | undefined>(undefined);
  const { id: userId, language: savedLanguage } = session.user;
  useLayoutEffect(() => {
    if (appliedFor.current !== userId) {
      appliedFor.current = userId;
      followSavedLanguage(savedLanguage);
    }
  }, [userId, savedLanguage]);

  // The cache of this session only: the gate drops it when the session ends, and another account gets a new one.
  const [queryClient] = useState(() => sessionQueryClients.clientFor(userId));

  const value = useMemo(() => ({ session, signOut }), [session, signOut]);
  return (
    <QueryClientProvider client={queryClient}>
      <ConsoleProvider value={value}>
        {/* The dialogs of a session live and die with it: a confirmation cannot outlast the account that opened it. */}
        <ModalsProvider>
          <StepUpProvider>
            <RouterProvider router={consoleRouter()} />
          </StepUpProvider>
        </ModalsProvider>
      </ConsoleProvider>
    </QueryClientProvider>
  );
}

export function App() {
  return (
    <AuthGate>
      {(session, signOut) => (
        // A different account is a different console: its own cache, dialogs and state.
        <Console key={session.user.id} session={session} signOut={signOut} />
      )}
    </AuthGate>
  );
}
