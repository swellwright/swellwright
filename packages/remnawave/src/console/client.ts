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

export function allowedHeaders(
  headers: Readonly<Record<string, string>>,
  scrub: (value: string) => string = (value) => value,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (ALLOWED_HEADERS.test(key)) {
      out[key] = scrub(value).replace(CONTROL, ' ').slice(0, 200);
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
    let out = text;
    let count = 0;
    for (const form of this.#tokenForms) {
      if (out.includes(form)) {
        const parts = out.split(form);
        count += parts.length - 1;
        out = parts.join('[masked]');
      }
    }
    return { text: out, count };
  }

  /**
   * The token as it can appear in an answer: itself, in base64 (with and without padding, and the URL form), encoded
   * for a URL and escaped for JSON. A token shorter than 12 characters is not scrubbed: scrubbing every "a" of an
   * answer would be worse than useless.
   */
  get #tokenForms(): string[] {
    const token = this.#token;
    if (token.length < 12) {
      return [];
    }
    const base64 = Buffer.from(token, 'utf8').toString('base64');
    const forms = [
      token,
      base64,
      base64.replace(/=+$/u, ''),
      Buffer.from(token, 'utf8').toString('base64url'),
      encodeURIComponent(token),
      JSON.stringify(token).slice(1, -1),
    ];
    // Longest first, so that a form that contains another is replaced whole.
    return [...new Set(forms)]
      .filter((form) => form.length >= 12)
      .sort((a, b) => b.length - a.length);
  }

  close(): void {
    this.http.close();
  }

  /** Sends one prepared request and returns what may be shown of the answer. */
  async send(prepared: PreparedConsoleRequest): Promise<ConsoleResult> {
    const { operation } = prepared;
    const raw = await this.http.getRaw(operation.operationId, prepared.pathAndQuery);
    const headers = allowedHeaders(raw.headers, (value) => this.scrub(value).text);
    // The raw type decides how the answer is read; what is shown or put in an error is the scrubbed one.
    const rawType = raw.headers['content-type'] ?? null;
    const mediaType = (header: string): string => (header.split(';')[0] ?? '').trim().toLowerCase();
    const contentType = rawType === null ? null : mediaType(this.scrub(rawType).text);
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
    if (rawType !== null && !TEXT_TYPES.test(mediaType(rawType))) {
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
    let parsed: { readonly value: unknown } | undefined;
    try {
      parsed = { value: JSON.parse(decoded) as unknown };
    } catch {
      parsed = undefined;
    }
    let shown: string;
    let maskedCount: number;
    const scrubYaml = (yaml: string) => this.scrub(yaml);
    if (parsed === undefined) {
      const masked = maskConsoleText(decoded, profile, this.maskKey, scrubYaml);
      shown = masked.value;
      maskedCount = masked.count;
    } else {
      const masked = maskConsoleJson(parsed.value, profile, this.maskKey, scrubYaml);
      shown = JSON.stringify(masked.value, null, 2);
      maskedCount = masked.count;
    }
    // Scrub after reading so raw replacements cannot corrupt JSON or base64. Escapes may become a token only
    // on decoding, and the decoded strings and names are what is shown.
    const rescrubbed = this.scrub(shown);
    const cut = cutToBytes(rescrubbed.text, this.maxBodyBytes);
    return {
      ...common,
      bodyFormat: parsed === undefined ? 'text' : 'json',
      body: cut.text,
      truncated: cut.truncated,
      maskedCount: maskedCount + rescrubbed.count,
    };
  }
}
