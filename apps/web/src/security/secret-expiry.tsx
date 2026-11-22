import { useTranslation } from 'react-i18next';

import { SECRET_EXPIRY_WARN_DAYS } from '@swellwright/contracts';
import { StatusBadge } from '@swellwright/ui';

/** What the expiry of a secret looks like to a person: nothing to say, a date that is near, or one that has passed. */
export type ExpiryState = 'none' | 'ok' | 'soon' | 'expired';

export interface ExpiryFacts {
  readonly expiresAt: string | null;
  readonly expired: boolean;
  readonly expiresInDays: number | null;
}

/** Worked out by the server (its clock, ADR 0042); the console only names the state. */
export function expiryState(secret: ExpiryFacts): ExpiryState {
  if (secret.expiresAt === null) {
    return 'none';
  }
  if (secret.expired) {
    return 'expired';
  }
  return (secret.expiresInDays ?? Number.POSITIVE_INFINITY) <= SECRET_EXPIRY_WARN_DAYS
    ? 'soon'
    : 'ok';
}

/**
 * The badge a secret shows wherever it is listed: red "Expired" once the expiry has passed, orange "Expires in N days"
 * for the last two weeks, and nothing before that (a calm secret is not decorated).
 */
export function SecretExpiryBadge({ secret }: { secret: ExpiryFacts }) {
  const { t } = useTranslation('vault');
  const state = expiryState(secret);
  if (state === 'expired') {
    return <StatusBadge kind="err">{t('expiry.expired')}</StatusBadge>;
  }
  if (state === 'soon') {
    return (
      <StatusBadge kind="warn">
        {t('expiry.inDays', { count: secret.expiresInDays ?? 0 })}
      </StatusBadge>
    );
  }
  return null;
}
