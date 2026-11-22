import {
  PanelAuthError,
  PanelContractError,
  PanelForbiddenError,
  PanelNotFoundError,
  PanelRateLimitedError,
  PanelTimeoutError,
  PanelUnavailableError,
  PanelUrlError,
  type UnavailableReason,
} from './errors.js';
import {
  type AddressGuard,
  createNodeTransport,
  type Transport,
  TransportError,
} from './transport.js';
import { parsePanelUrl, type ParsedPanelUrl } from './url.js';

/** What the HTTP layer of the client needs to know. Every field has a safe default. */
export interface PanelHttpOptions {
  readonly baseUrl: string;
  /** The API token. Sent only in the `Authorization` header of a request to the origin of `baseUrl`. */
  readonly token: string;
  /** Per attempt, from the request to the last byte of the response. Default 15 000 ms. */
  readonly timeoutMs?: number;
  /** For opening the connection (TCP and TLS). Default 5 000 ms. */
  readonly connectTimeoutMs?: number;
  /** A response larger than this is refused. Default 16 MiB. */
  readonly maxResponseBytes?: number;
  /** Tries per request, the first included, for a GET that failed in a way that may pass. Default 3. */
  readonly maxAttempts?: number;
  /** Requests in flight at the same time. Default 4. */
  readonly concurrency?: number;
  /** The first wait before a retry; it doubles each time up to `backoffMaxMs`. Default 250 ms. */
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  /** The longest `Retry-After` the client waits for. A longer one is reported as `PanelRateLimitedError`. Default 10 s. */
  readonly maxRetryAfterMs?: number;
  /** See `parsePanelUrl`: plain http for loopback and private addresses only, and only when set. */
  readonly allowInsecureHttp?: boolean;
  readonly trustedCa?: string;
  readonly allowInsecureTls?: boolean;
  readonly addressGuard?: AddressGuard;
  /** Replaces the network (tests). */
  readonly transport?: Transport;
  /** Replaces the waiting and the randomness of the backoff (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface PanelHttpDefaults {
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxAttempts: number;
  readonly concurrency: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly maxRetryAfterMs: number;
}

export const DEFAULTS: PanelHttpDefaults = {
  timeoutMs: 15_000,
  connectTimeoutMs: 5_000,
  maxResponseBytes: 16 * 1024 * 1024,
  maxAttempts: 3,
  concurrency: 4,
  backoffBaseMs: 250,
  backoffMaxMs: 4_000,
  maxRetryAfterMs: 10_000,
};

const MAX_REDIRECTS = 3;
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A counting semaphore: at most `limit` holders at the same time, the rest wait in order. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

/** Seconds from a `Retry-After` header: a number of seconds or an HTTP date. Undefined when it says nothing usable. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  if (/^\d{1,9}$/u.test(text)) {
    return Number(text);
  }
  // An HTTP date names a month or a day; anything else (a negative number, say) is not one, whatever Date.parse thinks.
  const date = /[A-Za-z]{3}/u.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - now) / 1000));
}

const UNAVAILABLE: Readonly<Record<string, { reason: UnavailableReason; text: string }>> = {
  dns: { reason: 'dns', text: 'The name of the panel cannot be resolved.' },
  refused: { reason: 'refused', text: 'The panel refused the connection.' },
  reset: { reason: 'network', text: 'The connection to the panel was cut.' },
  tls: {
    reason: 'tls',
    text: 'The certificate of the panel was not accepted. A private certificate authority can be configured for the panel.',
  },
  address: { reason: 'address_not_allowed', text: 'The address of the panel is not allowed.' },
  other: { reason: 'network', text: 'The panel could not be reached.' },
  encoding: { reason: 'network', text: 'The panel answered in a way that cannot be read.' },
};

/**
 * GET requests to one panel, with the limits of ADR 0041: a deadline per attempt, a cap on the response, a bounded
 * number of requests at the same time, retries only for GET and only for failures that may pass (a network error,
 * 429, 5xx), `Retry-After` obeyed, and no redirect that leaves the origin. Nothing here knows what an endpoint
 * means; `PanelClient` does. The token appears in one header and nowhere else, not even in an error.
 */
export class PanelHttp {
  readonly target: ParsedPanelUrl;
  private readonly transport: Transport;
  private readonly semaphore: Semaphore;
  readonly #authorization: string;
  private readonly settings: PanelHttpDefaults;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: PanelHttpOptions) {
    if (options.token.length === 0 || /[\r\n\0]/u.test(options.token)) {
      throw new PanelUrlError('The token is empty or contains characters that cannot be sent.');
    }
    this.target = parsePanelUrl(options.baseUrl, {
      allowInsecureHttp: options.allowInsecureHttp === true,
    });
    this.settings = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
      maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs,
    };
    this.semaphore = new Semaphore(this.settings.concurrency);
    this.#authorization = `Bearer ${options.token}`;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.transport =
      options.transport ??
      createNodeTransport({
        trustedCa: options.trustedCa,
        allowInsecureTls: options.allowInsecureTls,
        addressGuard: options.addressGuard,
        maxSockets: this.settings.concurrency,
      });
  }

  close(): void {
    this.transport.close();
  }

  /** `/api/nodes?x=1` under the base address of the panel. */
  private urlFor(pathAndQuery: string): URL {
    return new URL(`${this.target.base}${pathAndQuery}`);
  }

  /**
   * GETs a path and returns the parsed JSON body of a 2xx answer. `endpoint` names the request in errors. Every
   * other outcome is a `PanelError`.
   */
  getJson(endpoint: string, pathAndQuery: string): Promise<unknown> {
    return this.semaphore.run(() => this.attempts(endpoint, this.urlFor(pathAndQuery)));
  }

  private backoff(attempt: number): number {
    const exp = Math.min(
      this.settings.backoffMaxMs,
      this.settings.backoffBaseMs * 2 ** (attempt - 1),
    );
    // Half to full of the computed wait, so that many clients do not retry in step.
    return Math.round(exp * (0.5 + this.random() / 2));
  }

  private async attempts(endpoint: string, url: URL): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt += 1) {
      try {
        return await this.once(endpoint, url);
      } catch (error) {
        lastError = error;
        const last = attempt === this.settings.maxAttempts;
        if (last) {
          break;
        }
        const wait = this.retryWait(error, attempt);
        if (wait === undefined) {
          break;
        }
        await this.sleep(wait);
      }
    }
    throw lastError;
  }

  /** How long to wait before the next try, or undefined when this failure is not worth another one. */
  private retryWait(error: unknown, attempt: number): number | undefined {
    if (error instanceof PanelRateLimitedError) {
      const ms = error.retryAfterSeconds * 1000;
      // A wait the client is not willing to sit through is reported at once instead of after a pause.
      return ms > this.settings.maxRetryAfterMs ? undefined : Math.max(ms, this.backoff(attempt));
    }
    if (error instanceof PanelUnavailableError) {
      if (error.reason === 'http_5xx' || error.reason === 'network' || error.reason === 'refused') {
        return this.backoff(attempt);
      }
    }
    return undefined;
  }

  private async once(endpoint: string, start: URL): Promise<unknown> {
    let url = start;
    for (let hops = 0; ; hops += 1) {
      let response;
      try {
        response = await this.transport.get({
          url,
          headers: {
            authorization: this.#authorization,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'user-agent': 'swellwright-panel-client',
          },
          connectTimeoutMs: this.settings.connectTimeoutMs,
          timeoutMs: this.settings.timeoutMs,
          maxBytes: this.settings.maxResponseBytes,
        });
      } catch (error) {
        throw this.mapTransportError(endpoint, error);
      }
      const { status } = response;
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers['location'];
        let next: URL | undefined;
        try {
          next = location === undefined ? undefined : new URL(location, url);
        } catch {
          next = undefined;
        }
        if (next?.origin !== this.target.origin) {
          throw new PanelUnavailableError(
            endpoint,
            'redirect_refused',
            `The panel redirected ${endpoint} to another address. Redirects that leave the panel's origin are not followed; use the final address of the panel.`,
            status,
          );
        }
        if (hops >= MAX_REDIRECTS) {
          throw new PanelUnavailableError(
            endpoint,
            'redirect_refused',
            `The panel redirected ${endpoint} too many times.`,
            status,
          );
        }
        url = next;
        continue;
      }
      if (status >= 200 && status < 300) {
        return this.parseBody(endpoint, response.body, response.headers['content-type']);
      }
      throw this.mapStatus(endpoint, status, response.headers['retry-after']);
    }
  }

  private mapTransportError(endpoint: string, error: unknown): Error {
    if (!(error instanceof TransportError)) {
      return new PanelUnavailableError(
        endpoint,
        'network',
        `The panel could not be reached (${endpoint}).`,
      );
    }
    switch (error.kind) {
      case 'connect_timeout':
        return new PanelTimeoutError(endpoint, 'connect', this.settings.connectTimeoutMs);
      case 'timeout':
        return new PanelTimeoutError(endpoint, 'response', this.settings.timeoutMs);
      case 'too_large':
        return new PanelContractError(endpoint, [
          {
            path: '',
            problem: `is larger than the limit of ${String(this.settings.maxResponseBytes)} bytes`,
          },
        ]);
      default: {
        const known = UNAVAILABLE[error.kind] ?? UNAVAILABLE['other'];
        return new PanelUnavailableError(
          endpoint,
          known?.reason ?? 'network',
          `${known?.text ?? 'The panel could not be reached.'} (${endpoint})`,
        );
      }
    }
  }

  private mapStatus(endpoint: string, status: number, retryAfter: string | undefined): Error {
    if (status === 401) {
      return new PanelAuthError(endpoint);
    }
    if (status === 403) {
      return new PanelForbiddenError(endpoint);
    }
    if (status === 404) {
      return new PanelNotFoundError(endpoint);
    }
    if (status === 429) {
      return new PanelRateLimitedError(endpoint, parseRetryAfter(retryAfter) ?? 1);
    }
    if (RETRY_STATUSES.has(status) || status >= 500) {
      return new PanelUnavailableError(
        endpoint,
        'http_5xx',
        `The panel answered ${endpoint} with an error (HTTP ${String(status)}).`,
        status,
      );
    }
    return new PanelContractError(
      endpoint,
      [{ path: '', problem: `was refused with HTTP ${String(status)}` }],
      `The panel refused the request for ${endpoint} (HTTP ${String(status)}). This release may not match the panel.`,
    );
  }

  private parseBody(endpoint: string, body: Uint8Array, contentType: string | undefined): unknown {
    if (body.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      const html = /html/iu.test(contentType ?? '');
      throw new PanelContractError(endpoint, [
        {
          path: '',
          problem: html
            ? 'is a web page, not JSON (is a login page or a proxy answering in place of the panel?)'
            : 'is not JSON',
        },
      ]);
    }
  }
}
