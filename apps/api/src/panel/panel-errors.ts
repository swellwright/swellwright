import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PanelAuthError,
  PanelContractError,
  PanelError,
  PanelForbiddenError,
  PanelNotFoundError,
  PanelRateLimitedError,
  PanelTimeoutError,
  PanelUnavailableError,
  PanelUrlError,
  PanelVersionError,
} from '@swellwright/remnawave';

import { CodedHttpException } from '../http.js';

export interface MapOptions {
  /** A 404 means "there is no such object" (a detail route), not "this is not a panel" (a list route). */
  readonly notFoundIsObject?: string;
}

/**
 * What an error of the panel client means for the API (ADR 0040). The messages come from the client, which never puts
 * the token, a header or a value from a response in one. A panel that is slow, refuses us or answers in a shape this
 * release does not know is a failure of the panel out there, so it is a 5xx with its own code; only a missing
 * object, a refused address or an unsupported version are the caller's.
 */
export function panelException(error: PanelError, options: MapOptions = {}): Error {
  if (error instanceof PanelNotFoundError) {
    if (options.notFoundIsObject !== undefined) {
      return new NotFoundException(`The panel has no such ${options.notFoundIsObject}.`);
    }
    return new CodedHttpException(
      502,
      'panel_contract_changed',
      `The panel has no ${error.endpoint} (404). Is the address the panel's own, and not a page in front of it?`,
      { endpoint: error.endpoint },
    );
  }
  if (error instanceof PanelAuthError) {
    return new CodedHttpException(
      502,
      'panel_unauthorized',
      'The panel rejected the token: it may be expired, revoked or mistyped.',
      { endpoint: error.endpoint },
    );
  }
  if (error instanceof PanelForbiddenError) {
    return new CodedHttpException(
      502,
      'panel_forbidden',
      `The token has no permission for this (${error.endpoint}). Give it a scope for it in the panel, or use a token with more.`,
      { endpoint: error.endpoint },
    );
  }
  if (error instanceof PanelRateLimitedError) {
    return new CodedHttpException(
      429,
      'panel_rate_limited',
      error.message,
      { endpoint: error.endpoint },
      error.retryAfterSeconds,
    );
  }
  if (error instanceof PanelTimeoutError) {
    return new CodedHttpException(504, 'panel_timeout', error.message, {
      endpoint: error.endpoint,
      phase: error.phase,
    });
  }
  if (error instanceof PanelUnavailableError) {
    if (error.reason === 'address_not_allowed') {
      return new CodedHttpException(409, 'address_not_allowed', error.message, {
        endpoint: error.endpoint,
      });
    }
    return new CodedHttpException(502, 'panel_unreachable', error.message, {
      endpoint: error.endpoint,
      reason: error.reason,
    });
  }
  if (error instanceof PanelContractError) {
    return new CodedHttpException(502, 'panel_contract_changed', error.message, {
      endpoint: error.endpoint,
      field: error.fieldPath,
    });
  }
  if (error instanceof PanelVersionError) {
    return new CodedHttpException(409, 'panel_unsupported_version', error.message, {
      version: error.version,
      range: error.range,
    });
  }
  if (error instanceof PanelUrlError) {
    // The address itself is wrong (not https, credentials in it, not a URL): the caller can fix it.
    return new BadRequestException(error.message);
  }
  return error;
}

/** The code and message a connection keeps as its last error. */
export function lastErrorOf(error: PanelError): { code: string; message: string } {
  return { code: error.code, message: error.message.slice(0, 500) };
}
