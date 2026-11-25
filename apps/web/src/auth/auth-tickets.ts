import { createContext, useContext } from 'react';

import type { AuthTicket } from './session-transitions.js';

/** Where the sign-in screens take a ticket when a step starts (the gate provides it). */
export interface AuthTickets {
  ticket(): AuthTicket;
  isCurrent(ticket: AuthTicket): boolean;
}

export const AuthTicketsContext = createContext<AuthTickets>({
  ticket: () => 0,
  isCurrent: () => true,
});

export const useAuthTickets = (): AuthTickets => useContext(AuthTicketsContext);
