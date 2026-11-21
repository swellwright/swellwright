import {
  type PanelCapabilities,
  PanelCapabilitiesSchema,
  type PanelConnectionState,
  type PanelConnectionView,
  PANEL_RESOURCES,
  PANEL_TOKEN_WARNING_DAYS,
  type PanelTokenInfo,
  type PanelWarning,
} from '@swellwright/contracts';
import type { Prisma } from '@swellwright/db';
import {
  assessPanelVersion,
  daysUntil,
  PanelAuthError,
  PanelContractError,
  PanelForbiddenError,
  PanelTimeoutError,
  PanelUnavailableError,
  PanelVersionError,
  type PanelProbe,
} from '@swellwright/remnawave';

import { lastErrorOf } from './panel-errors.js';

/** The states a stored connection can be in: `unconfigured` is the absence of a row. */
export type StoredState = Exclude<PanelConnectionState, 'unconfigured'>;

export interface Assessment {
  readonly state: StoredState;
  readonly lastError: { readonly code: string; readonly message: string } | null;
}

/**
 * What a probe says about the connection (ADR 0040). The panel is `unauthorized` when it refuses the token (or the
 * token has no scope for even its version), `unsupported` when its version is outside the window or it answers in a
 * shape this release does not know, `unreachable` when it does not answer. Otherwise it is usable: `degraded` when the
 * token cannot read some resource or one failed, `connected` when everything can be read. The list of API tokens is
 * not counted: the panel never lets an API token read it, which is not a defect of the connection.
 */
export function assessProbe(probe: PanelProbe): Assessment {
  const { fatal } = probe;
  if (fatal) {
    const lastError = lastErrorOf(fatal);
    if (fatal instanceof PanelAuthError || fatal instanceof PanelForbiddenError) {
      return { state: 'unauthorized', lastError };
    }
    if (fatal instanceof PanelVersionError || fatal instanceof PanelContractError) {
      return { state: 'unsupported', lastError };
    }
    if (fatal instanceof PanelUnavailableError || fatal instanceof PanelTimeoutError) {
      return { state: 'unreachable', lastError };
    }
    return { state: 'unreachable', lastError };
  }
  for (const resource of PANEL_RESOURCES) {
    if (resource === 'apiTokens') {
      continue;
    }
    const capability = probe.capabilities[resource];
    if (capability !== undefined && capability !== 'ok') {
      const failure = probe.failures[resource];
      return {
        state: 'degraded',
        lastError: failure ? { code: failure.code, message: failure.message.slice(0, 500) } : null,
      };
    }
  }
  return { state: 'connected', lastError: null };
}

/** The capabilities of a probe as they are stored; null when the probe could not ask (no version, no token). */
export function capabilitiesOf(probe: PanelProbe, checkedAt: Date): PanelCapabilities | null {
  const entries = PANEL_RESOURCES.flatMap((resource) => {
    const state = probe.capabilities[resource];
    return state === undefined ? [] : [[resource, state] as const];
  });
  if (entries.length === 0) {
    return null;
  }
  return {
    checkedAt: checkedAt.toISOString(),
    resources: Object.fromEntries(entries) as PanelCapabilities['resources'],
  };
}

/** The row of a connection with the name of its secret, as the view needs it. */
export interface ConnectionRow {
  readonly id: string;
  readonly baseUrl: string;
  readonly tokenSecretId: string;
  readonly tokenSecret: { readonly id: string; readonly name: string };
  readonly state: StoredState;
  readonly panelVersion: string | null;
  readonly capabilities: Prisma.JsonValue | null;
  readonly trustedCa: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const UNCONFIGURED: PanelConnectionView = {
  state: 'unconfigured',
  baseUrl: null,
  panelVersion: null,
  versionSupport: null,
  capabilities: null,
  token: null,
  warnings: [],
  lastCheckedAt: null,
  lastError: null,
  trustedCa: false,
  createdAt: null,
  updatedAt: null,
};

export function tokenInfo(row: ConnectionRow, now: Date): PanelTokenInfo {
  const days = row.tokenExpiresAt === null ? null : daysUntil(row.tokenExpiresAt, now);
  return {
    secretId: row.tokenSecret.id,
    secretName: row.tokenSecret.name,
    expiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    daysLeft: days,
    expiryWarning: days !== null && days <= PANEL_TOKEN_WARNING_DAYS,
  };
}

export function warningsOf(
  row: ConnectionRow,
  capabilities: PanelCapabilities | null,
  token: PanelTokenInfo,
): PanelWarning[] {
  const warnings: PanelWarning[] = [];
  if (token.expiryWarning && token.daysLeft !== null) {
    warnings.push({
      code: 'token_expiring',
      message:
        token.daysLeft < 0
          ? 'The token of the panel has expired.'
          : `The token of the panel expires in ${String(token.daysLeft)} days. Create a new one and connect with it before then.`,
    });
  }
  if (capabilities) {
    const limited = PANEL_RESOURCES.filter(
      (resource) => resource !== 'apiTokens' && capabilities.resources[resource] !== 'ok',
    );
    if (limited.length > 0 && row.state !== 'unreachable' && row.state !== 'unauthorized') {
      warnings.push({
        code: 'capabilities_limited',
        message: `The token cannot read everything: ${limited.join(', ')}.`,
      });
    }
  }
  return warnings;
}

export function viewOf(row: ConnectionRow | null, now: Date): PanelConnectionView {
  if (!row) {
    return UNCONFIGURED;
  }
  const parsed = PanelCapabilitiesSchema.safeParse(row.capabilities);
  const capabilities = parsed.success ? parsed.data : null;
  const token = tokenInfo(row, now);
  const warnings = warningsOf(row, capabilities, token);
  // A token about to expire makes a working connection `degraded` at the moment of looking, with nothing written.
  const state: PanelConnectionState =
    row.state === 'connected' && warnings.length > 0 ? 'degraded' : row.state;
  return {
    state,
    baseUrl: row.baseUrl,
    panelVersion: row.panelVersion,
    versionSupport: row.panelVersion === null ? null : assessPanelVersion(row.panelVersion),
    capabilities,
    token,
    warnings,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError:
      row.lastErrorCode === null
        ? null
        : { code: row.lastErrorCode, message: row.lastErrorMessage ?? '' },
    trustedCa: row.trustedCa !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
