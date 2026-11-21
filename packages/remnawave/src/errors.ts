// The errors of the panel client (ADR 0040). Each has a stable `code`, which callers branch on, and a message that
// is safe to show and to log: it names the endpoint and, for a contract error, the path of the field, and it never
// contains the token, a header, or a value that came out of a response body.

export type PanelErrorCode =
  | 'panel_url_invalid'
  | 'panel_unauthorized'
  | 'panel_forbidden'
  | 'panel_not_found'
  | 'panel_rate_limited'
  | 'panel_unreachable'
  | 'panel_timeout'
  | 'panel_contract_changed'
  | 'panel_unsupported_version';

export abstract class PanelError extends Error {
  abstract readonly code: PanelErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The address of the panel (or an option of the client) is not acceptable. Nothing was sent. */
export class PanelUrlError extends PanelError {
  readonly code = 'panel_url_invalid';
}

/** 401: the panel does not accept the token (expired, revoked, mistyped, or an admin session was needed). */
export class PanelAuthError extends PanelError {
  readonly code = 'panel_unauthorized';

  constructor(
    readonly endpoint: string,
    message = `The panel rejected the token (${endpoint}).`,
  ) {
    super(message);
  }
}

/** 403: the token is valid but has no scope for this. */
export class PanelForbiddenError extends PanelError {
  readonly code = 'panel_forbidden';

  constructor(
    readonly endpoint: string,
    message = `The token has no permission for ${endpoint}.`,
  ) {
    super(message);
  }
}

/** 404: the object does not exist, or the address is not a panel at all. */
export class PanelNotFoundError extends PanelError {
  readonly code = 'panel_not_found';

  constructor(
    readonly endpoint: string,
    message = `The panel has no such object (${endpoint}).`,
  ) {
    super(message);
  }
}

/** 429 that outlasted the retries, or one that asks to wait longer than the client is willing to. */
export class PanelRateLimitedError extends PanelError {
  readonly code = 'panel_rate_limited';

  constructor(
    readonly endpoint: string,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `The panel asks to slow down (${endpoint}). Try again in ${String(retryAfterSeconds)} seconds.`,
    );
  }
}

export type UnavailableReason =
  | 'network'
  | 'refused'
  | 'dns'
  | 'tls'
  | 'address_not_allowed'
  | 'redirect_refused'
  | 'http_5xx'
  | 'closed';

/** The panel could not be reached or answered with a server error. */
export class PanelUnavailableError extends PanelError {
  readonly code = 'panel_unreachable';

  constructor(
    readonly endpoint: string,
    readonly reason: UnavailableReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type TimeoutPhase = 'connect' | 'response';

/** The panel did not answer in time. Not retried: a panel that is slow is not made faster by asking again. */
export class PanelTimeoutError extends PanelError {
  readonly code = 'panel_timeout';

  constructor(
    readonly endpoint: string,
    readonly phase: TimeoutPhase,
    readonly timeoutMs: number,
  ) {
    super(
      phase === 'connect'
        ? `The panel did not accept the connection within ${String(timeoutMs)} ms (${endpoint}).`
        : `The panel did not answer within ${String(timeoutMs)} ms (${endpoint}).`,
    );
  }
}

export interface ContractIssue {
  /** Path of the field in the response body, for example `response.nodes[3].port`. */
  readonly path: string;
  /** What was wrong, without the value. */
  readonly problem: string;
}

/**
 * The panel answered, but not in the shape this release knows: a field is missing or of another type, the body is not
 * JSON, or it is too large. The endpoint and the path of the first bad field are in the message and in `issues`.
 */
export class PanelContractError extends PanelError {
  readonly code = 'panel_contract_changed';

  constructor(
    readonly endpoint: string,
    readonly issues: readonly ContractIssue[],
    summary?: string,
  ) {
    const first = issues[0];
    super(
      summary ??
        (first
          ? `The panel answered ${endpoint} in a shape this release does not know: ${first.path === '' ? 'the body' : first.path} ${first.problem}${issues.length > 1 ? ` (and ${String(issues.length - 1)} more)` : ''}.`
          : `The panel answered ${endpoint} in a shape this release does not know.`),
    );
  }

  /** The path of the first bad field, for an API error's details. */
  get fieldPath(): string {
    return this.issues[0]?.path ?? '';
  }
}

/** The panel runs a version this release does not support. */
export class PanelVersionError extends PanelError {
  readonly code = 'panel_unsupported_version';

  constructor(
    readonly version: string | null,
    readonly range: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** What a failure looks like to a caller that only wants the stable code and a safe message. */
export function describePanelError(error: unknown): {
  code: PanelErrorCode | 'unknown';
  message: string;
} {
  if (error instanceof PanelError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'unknown', message: 'An unexpected failure while talking to the panel.' };
}
