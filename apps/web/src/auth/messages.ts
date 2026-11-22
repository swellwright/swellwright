import type { TFunction } from 'i18next';

import type { Namespace } from '@swellwright/i18n';

import { ApiRequestError, ApiUnreachableError, StepUpCancelledError } from '../api.js';

/** The endpoint and the field a `panel_contract_changed` error names in its details, when it names them. */
function contractChangedWhere(details: unknown): { endpoint: string; field: string } | undefined {
  if (details === null || typeof details !== 'object') {
    return undefined;
  }
  const { endpoint, field } = details as { endpoint?: unknown; field?: unknown };
  return typeof endpoint === 'string' && typeof field === 'string' && field !== ''
    ? { endpoint, field }
    : undefined;
}

/**
 * What the person sees for a failed call, in the language of the console. `unauthorized` reads differently on
 * each screen, so the caller says what it means there (already translated).
 */
export function describeError(
  t: TFunction<Namespace[]>,
  error: unknown,
  whenUnauthorized: string,
  whenForbidden?: string,
): string {
  if (error instanceof ApiUnreachableError) {
    return t('errors:unreachable');
  }
  if (error instanceof StepUpCancelledError) {
    return t('errors:stepUpCancelled');
  }
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'unauthorized':
        return whenUnauthorized;
      case 'rate_limited': {
        const minutes = error.retryAfterSeconds
          ? Math.ceil(error.retryAfterSeconds / 60)
          : undefined;
        return minutes ? t('errors:rateLimited', { count: minutes }) : t('errors:rateLimitedShort');
      }
      case 'forbidden':
        return whenForbidden ?? t('errors:forbidden');
      case 'vault_sealed':
        return t('errors:vaultSealed');
      case 'step_up_required':
        return t('errors:stepUpRequired');
      case 'not_ready':
        return t('errors:notReady');
      // The Remnawave panel (ADR 0041). The server's message speaks English; these say it in the console's language.
      case 'panel_not_connected':
        return t('errors:panel.notConnected');
      case 'panel_unauthorized':
        return t('errors:panel.unauthorized');
      case 'panel_forbidden':
        return t('errors:panel.forbidden');
      case 'panel_unreachable':
        return t('errors:panel.unreachable');
      case 'panel_timeout':
        return t('errors:panel.timeout');
      case 'panel_unsupported_version':
        return t('errors:panel.unsupportedVersion');
      case 'panel_rate_limited': {
        return error.retryAfterSeconds
          ? t('errors:panel.rateLimited', { count: error.retryAfterSeconds })
          : t('errors:panel.rateLimitedShort');
      }
      case 'panel_contract_changed': {
        const where = contractChangedWhere(error.details);
        return where
          ? t('errors:panel.contractChangedAt', where)
          : t('errors:panel.contractChanged');
      }
      case 'address_not_allowed':
        return t('errors:addressNotAllowed');
      case 'conflict':
      case 'confirmation_required':
      case 'bad_request':
        // The server says what is in the way (a name that is taken, the last owner, a secret of the wrong kind);
        // it speaks English.
        return error.message;
      case 'validation_failed':
        return t('errors:validation');
      default:
        return t('errors:server');
    }
  }
  return t('errors:generic');
}
