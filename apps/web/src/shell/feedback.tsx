import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';

import { sessionQueryClients } from '../auth/session-cache.js';

/**
 * Feedback the way the panel gives it: a toast at the top right (teal for what worked, red for what did not) and a
 * confirmation dialog with a red soft confirm button and a subtle cancel. Inline banners are not used for these.
 */

/** A toast for something that worked. */
export function notifySuccess(title: string, message?: string): void {
  notifications.show({ title, message: message ?? '', color: 'teal' });
}

/** A toast for something that did not work. Stays long enough to read. */
export function notifyError(title: string, message: string): void {
  notifications.show({ title, message, color: 'red', autoClose: 8000 });
}

/** A toast for a warning the person should see but can act on later. */
export function notifyWarning(title: string, message: string): void {
  notifications.show({ title, message, color: 'orange', autoClose: 8000 });
}

/**
 * Asks before something that cannot be taken back (or that people regret). `danger` colors the confirm button red,
 * as the panel does for deletions; otherwise it is teal.
 */
export function confirmAction({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  modals.openConfirmModal({
    title,
    // The panel hands the text over as it is, so it is drawn at the body size; wrapping it would shrink it.
    children: message,
    labels: { confirm: confirmLabel, cancel: cancelLabel },
    centered: true,
    cancelProps: { variant: 'subtle' },
    confirmProps: { color: danger ? 'red' : 'teal', variant: 'soft' },
    // Bound to the session that opened the dialog: confirmed after that session ended, it does nothing.
    onConfirm: sessionQueryClients.fence(onConfirm),
  });
}

/** A session ends: its dialogs close and its toasts go, so nothing of it stays over the next screen. */
export function closeSessionFeedback(): void {
  modals.closeAll();
  notifications.clean();
}
