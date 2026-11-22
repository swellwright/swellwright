import { PanelUnsupportedResponseError } from '../errors.js';
import { PanelHttp, type PanelHttpOptions } from '../http.js';
import type { MaskOptions } from '../mask.js';
import { type ConsoleMaskProfile, maskConsoleJson, maskConsoleText } from './mask.js';
import type { PreparedConsoleRequest } from './request.js';

// The one place that sends a request of the API console (ADR 0046). It takes a request that was prepared from the
// catalogue (so the path is a catalogue path and the parameters were checked), sends it as a GET through the same
// transport as every read of the panel (address policy, TLS, timeouts, size cap, retries for a GET only), and turns the
// answer into something safe to show: the headers that are allowed, the body masked and cut to a size. The token is in
// the one header of the request and nowhere else.

export interface ConsoleClientOptions extends PanelHttpOptions {
  /** Key of the fingerprint in a mask (see `MaskOptions`). */
  readonly maskKey?: MaskOptions['fingerprintKey'];
  /** The most of the answer that is returned, in bytes; the rest is cut and `truncated` says so. */
  readonly maxBodyBytes: number;
}

export interface ConsoleResult {
  readonly status: number;
  readonly durationMs: number;
  readonly attempts: number;
  /** Only the headers that are safe and useful: content type and length, rate-limit headers, `retry-after`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  readonly bodyFormat: 'json' | 'text' | 'empty';
  /** The masked body: JSON indented by two spaces, or the masked text. Empty for no body. */
  readonly body: string;
  /** The size of the answer of the panel, before masking and cutting. */
  readonly bodyBytes: number;
  readonly truncated: boolean;
  readonly maskedCount: number;
}

const ALLOWED_HEADERS = /^(content-type|content-length|retry-after|x-ratelimit-[a-z0-9-]{1,40})$/u;
// eslint-disable-next-line no-control-regex -- finding control characters is the point of it
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

export function allowedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (ALLOWED_HEADERS.test(key)) {
      out[key] = value.replace(CONTROL, ' ').slice(0, 200);
    }
  }
  return out;
}

const TEXT_TYPES =
  /^(text\/|application\/(json|[a-z0-9.+-]*\+json|ya?ml|x-ya?ml|xml|[a-z0-9.+-]*\+xml)\b)/iu;

/** The most of a text that fits `limit` bytes, cut at a line when there is one near the end and never inside a character. */
export function cutToBytes(
  text: string,
  limit: number,
): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limit) {
    return { text, truncated: false, bytes };
  }
  let cut = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  // A character split by the cut decodes to U+FFFD at the end: drop it.
  while (cut.endsWith(String.fromCharCode(0xfffd))) {
    cut = cut.slice(0, -1);
  }
  const line = cut.lastIndexOf('\n');
  if (line > cut.length - 2048 && line > 0) {
    cut = cut.slice(0, line);
  }
  return { text: cut, truncated: true, bytes };
}

export class ConsoleClient {
  private readonly http: PanelHttp;
  private readonly maskKey: MaskOptions['fingerprintKey'];
  private readonly maxBodyBytes: number;
  readonly #token: string;

  constructor(options: ConsoleClientOptions) {
    this.http = new PanelHttp(options);
    this.maskKey = options.maskKey;
    this.maxBodyBytes = options.maxBodyBytes;
    this.#token = options.token;
  }

  /**
   * Takes the token itself out of a text, wherever it is. Nothing in the masking can know a token that a panel echoes
   * back under a name nobody predicted; this client holds the token, so it can. The count is of what was taken out.
   */
  private scrub(text: string): { text: string; count: number } {
    // A token shorter than this is not a token: scrubbing every "a" of an answer would be worse than useless.
    if (this.#token.length < 12 || !text.includes(this.#token)) {
      return { text, count: 0 };
    }
    const parts = text.split(this.#token);
    return { text: parts.join('[masked]'), count: parts.length - 1 };
  }

  close(): void {
    this.http.close();
  }

  /** Sends one prepared request and returns what may be shown of the answer. */
  async send(prepared: PreparedConsoleRequest): Promise<ConsoleResult> {
    const { operation } = prepared;
    const raw = await this.http.getRaw(operation.operationId, prepared.pathAndQuery);
    const headers = Object.fromEntries(
      Object.entries(allowedHeaders(raw.headers)).map(([name, value]) => [
        name,
        this.scrub(value).text,
      ]),
    );
    const contentType = raw.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? null;
    const common = {
      status: raw.status,
      durationMs: raw.durationMs,
      attempts: raw.attempts,
      headers,
      contentType,
      bodyBytes: raw.body.length,
    };
    if (raw.body.length === 0) {
      return { ...common, bodyFormat: 'empty', body: '', truncated: false, maskedCount: 0 };
    }
    if (contentType !== null && !TEXT_TYPES.test(contentType)) {
      throw new PanelUnsupportedResponseError(operation.operationId, contentType);
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw.body);
    } catch {
      throw new PanelUnsupportedResponseError(operation.operationId, contentType);
    }
    if (decoded.includes('\u0000')) {
      throw new PanelUnsupportedResponseError(operation.operationId, contentType);
    }
    const profile: ConsoleMaskProfile =
      operation.availability === 'user_data' ? 'personal' : 'standard';
    const scrubbed = this.scrub(decoded);
    decoded = scrubbed.text;
    let parsed: { readonly value: unknown } | undefined;
    try {
      parsed = { value: JSON.parse(decoded) as unknown };
    } catch {
      parsed = undefined;
    }
    let shown: string;
    let maskedCount: number;
    if (parsed === undefined) {
      const masked = maskConsoleText(decoded, profile, this.maskKey);
      shown = masked.value;
      maskedCount = masked.count;
    } else {
      const masked = maskConsoleJson(parsed.value, profile, this.maskKey);
      shown = JSON.stringify(masked.value, null, 2);
      maskedCount = masked.count;
    }
    const cut = cutToBytes(shown, this.maxBodyBytes);
    return {
      ...common,
      bodyFormat: parsed === undefined ? 'text' : 'json',
      body: cut.text,
      truncated: cut.truncated,
      maskedCount: maskedCount + scrubbed.count,
    };
  }
}
