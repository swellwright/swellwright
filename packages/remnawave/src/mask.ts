import { createHash, createHmac } from 'node:crypto';

// Masking of secrets in what a panel returns (ADR 0041, docs/en/design/05-security.md). One function does it for
// every view that leaves the API: a config profile, an inbound, a host's opaque parameters, a subscription template,
// a snippet, a node plugin, a URL with credentials in it. It is a deny-list (a key whose name says it is a secret, the
// ids of the clients of an inbound, a PEM private key, credentials in a URL, a token) because the Xray configuration is
// free-form and an allow-list would hide most of what an administrator wants to read. Secrets under a name nobody
// predicted are what a deny-list misses; the value rules below catch the shapes that give themselves away, and the
// tests feed it hostile structures. Anything past the depth limit is replaced as a whole: it fails closed.

export const MASK = '[masked]';
const MAX_DEPTH = 64;
/** A string that looks like JSON is read as JSON up to this size, so a secret inside a stringified document is found. */
const MAX_EMBEDDED_JSON = 1_048_576;

export interface MaskOptions {
  /**
   * A key for the fingerprint in a mask: `[masked:1a2b3c4d]` is the first four bytes of an HMAC-SHA256 of the value
   * under this key. The same value gives the same fingerprint, so a rotation shows as a change; without the key
   * nothing can be learned about the value from it. Without a key the mask is the plain `[masked]`.
   */
  readonly fingerprintKey?: Uint8Array | string | undefined;
  /**
   * More names (compared like the built-in ones: case, `-`, `_` and spaces ignored) whose value is secret wherever
   * the name appears. The API console adds the access material and the personal data of the users of a panel
   * (ADR 0046); the objects of the typed reads need none.
   */
  readonly extraSecretKeys?: readonly string[] | undefined;
  /**
   * `xray` (the default) treats the items of `clients`, `users`, `accounts`, `peers` and `proxies` as people of an Xray
   * configuration: their ids and logins are secret. `off` is for an answer of the panel's own API, where `users` is a
   * list of the panel's users and the numeric `id` is what a person addresses them by; the names in
   * `extraSecretKeys` do the masking there.
   */
  readonly people?: 'xray' | 'off' | undefined;
}

export interface Masked<T> {
  readonly value: T;
  /** How many values were replaced by a mask. */
  readonly count: number;
}

const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/gu, '');

/** Names that are a secret wherever they appear. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'privatekey',
  'privatekeypem',
  'shortid',
  'shortids',
  'sid',
  'password',
  'passwd',
  'pass',
  'pwd',
  'passphrase',
  'secret',
  'clientsecret',
  'psk',
  'presharedkey',
  'obfs',
  'obfspassword',
  'seed',
  'mldsa65seed',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'apikey',
  'accesskey',
  'secretkey',
  'credential',
  'credentials',
  'bearer',
  'xapikey',
  'xauthtoken',
  'xapitoken',
]);

/** A name that contains one of these is a secret too (`obfsPassword`, `adminSecret`, `telegramBotToken`). */
const SECRET_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'privatekey',
  'passphrase',
  'apikey',
  'accesstoken',
  'authtoken',
  'bottoken',
];

/** The array keys whose items describe a person or a peer: their ids and logins are secrets, their labels are not. */
const PEOPLE_KEYS: ReadonlySet<string> = new Set([
  'clients',
  'users',
  'accounts',
  'peers',
  'proxies',
]);
const PEOPLE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'uuid',
  'email',
  'user',
  'username',
  'pass',
  'password',
  'secret',
  'auth',
  'token',
  'key',
]);

/** Query parameters of a URL that carry a secret. */
const SECRET_PARAMS: ReadonlySet<string> = new Set([
  'password',
  'pass',
  'pwd',
  'token',
  'key',
  'secret',
  'sid',
  'psk',
  'seed',
  'apikey',
  'accesstoken',
  'obfspassword',
  'privatekey',
  'auth',
]);

const NAME_KEYS: ReadonlySet<string> = new Set(['name', 'key', 'header', 'headername']);

const isSecretName = (key: string): boolean => {
  const n = norm(key);
  return SECRET_KEYS.has(n) || SECRET_SUBSTRINGS.some((part) => n.includes(part));
};

/** `vmess://` carries its whole configuration, id included, in one base64 text; `ss://` can too. The payload is secret. */
const OPAQUE_LINK = /\b(vmess:\/\/|ssr?:\/\/)([A-Za-z0-9+/=_-]{12,})/giu;
const PEM_PRIVATE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@?#"'<>]+)@/giu;
const URL_PARAM = /([?&;])([A-Za-z0-9_.-]{1,40})=([^&#\s"'<>]*)/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/gu;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;

class Masker {
  count = 0;
  private readonly key: Uint8Array | string | undefined;
  private readonly extra: ReadonlySet<string>;
  private readonly people: boolean;

  constructor(options: MaskOptions) {
    this.key = options.fingerprintKey;
    this.extra = new Set((options.extraSecretKeys ?? []).map(norm));
    this.people = options.people !== 'off';
  }

  /** A name that says its value is secret: the built-in rules and the extra names of this call. */
  private secretName(key: string): boolean {
    return isSecretName(key) || this.extra.has(norm(key));
  }

  /** The mask for one value. The fingerprint covers the value's canonical text, so equal values match. */
  private mask(original: unknown): string {
    this.count += 1;
    if (this.key === undefined) {
      return MASK;
    }
    const text =
      typeof original === 'string'
        ? original
        : JSON.stringify(original === undefined ? null : original);
    const digest = createHmac('sha256', this.key).update(text).digest('hex').slice(0, 8);
    return `[masked:${digest}]`;
  }

  /** Replaces every scalar inside a value that is secret as a whole; the shape (how many items) stays visible. */
  private maskAll(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) {
      return this.mask(null);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.maskAll(item, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.maskAll(item, depth + 1)]),
      );
    }
    if (value === null || value === undefined || value === '') {
      return value;
    }
    return this.mask(value);
  }

  /** The value rules for a string: PEM keys, credentials in URLs, JWTs, bearer tokens, embedded JSON. */
  text(input: string, depth = 0): string {
    let out = input;
    const trimmed = out.trimStart();
    if (
      (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
      out.length <= MAX_EMBEDDED_JSON &&
      depth <= MAX_DEPTH
    ) {
      try {
        const parsed: unknown = JSON.parse(out);
        if (parsed !== null && typeof parsed === 'object') {
          const before = this.count;
          const masked = this.walk(parsed, depth + 1, undefined, undefined);
          // Only rewrite the text when something in it was a secret: a document without any is left as it is.
          if (this.count > before) {
            return JSON.stringify(masked);
          }
          return out;
        }
      } catch {
        // Not JSON after all: the rules below still apply.
      }
    }
    out = out.replace(PEM_PRIVATE, () => this.mask('pem'));
    out = out.replace(
      URL_USERINFO,
      (_whole, scheme: string, userinfo: string) => `${scheme}${this.mask(userinfo)}@`,
    );
    out = out.replace(
      OPAQUE_LINK,
      (_whole, scheme: string, payload: string) => `${scheme}${this.mask(payload)}`,
    );
    out = out.replace(URL_PARAM, (whole, sep: string, name: string, value: string) =>
      SECRET_PARAMS.has(norm(name)) && value !== '' ? `${sep}${name}=${this.mask(value)}` : whole,
    );
    out = out.replace(JWT, (whole) => this.mask(whole));
    out = out.replace(BEARER, (_whole, prefix: string) => `${prefix}${this.mask('bearer')}`);
    return out;
  }

  /**
   * One value, with the name it sits under (`undefined` at the top and in an array of plain values) and the name of
   * the array it is an item of, when it is one.
   */
  walk(
    value: unknown,
    depth: number,
    key: string | undefined,
    arrayKey: string | undefined,
  ): unknown {
    if (depth > MAX_DEPTH) {
      return this.mask(null);
    }
    if (typeof value === 'string') {
      return this.text(value, depth);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, depth + 1, undefined, key));
    }
    if (value !== null && typeof value === 'object') {
      return this.object(value as Record<string, unknown>, depth, arrayKey);
    }
    return value;
  }

  private object(
    source: Readonly<Record<string, unknown>>,
    depth: number,
    arrayKey: string | undefined,
  ): Record<string, unknown> {
    const inPeople = this.people && arrayKey !== undefined && PEOPLE_KEYS.has(norm(arrayKey));
    // `{ "name": "Authorization", "value": "..." }` and `{ "key": "x-api-key", "value": "..." }` pairs.
    const hasValue = Object.hasOwn(source, 'value');
    let pairName: string | undefined;
    if (hasValue) {
      for (const candidate of Object.keys(source)) {
        const given = source[candidate];
        if (NAME_KEYS.has(norm(candidate)) && typeof given === 'string') {
          pairName = given;
          break;
        }
      }
    }
    const entries = Object.entries(source).map(([name, item]): [string, unknown] => {
      const n = norm(name);
      if (n === 'auth') {
        // Xray's `"auth": "password"` is a mode, not a secret; a plain mode word stays readable.
        if (typeof item === 'string' && /^(password|noauth|none)$/iu.test(item)) {
          return [name, item];
        }
        if (typeof item === 'boolean') {
          return [name, item];
        }
        return [name, this.maskAll(item, depth + 1)];
      }
      if (n === 'decryption') {
        // A VLESS `decryption` string holds the server's private key; `none` holds nothing.
        return [
          name,
          typeof item === 'string' && item !== 'none'
            ? this.mask(item)
            : this.walk(item, depth + 1, name, undefined),
        ];
      }
      if (n === 'key' && !hasValue) {
        return [name, this.maskAll(item, depth + 1)];
      }
      if (this.secretName(name) && n !== 'key') {
        return [name, this.maskAll(item, depth + 1)];
      }
      if (inPeople && PEOPLE_FIELDS.has(n)) {
        return [name, this.maskAll(item, depth + 1)];
      }
      if (hasValue && n === 'value' && pairName !== undefined && this.secretName(pairName)) {
        return [name, this.maskAll(item, depth + 1)];
      }
      return [name, this.walk(item, depth + 1, name, undefined)];
    });
    return Object.fromEntries(entries);
  }
}

/** Masks every secret in a JSON-like value. The input is not changed; the result shares nothing with it. */
export function maskSecrets<T>(value: T, options: MaskOptions = {}): Masked<T> {
  const masker = new Masker(options);
  const masked = masker.walk(value, 0, undefined, undefined) as T;
  return { value: masked, count: masker.count };
}

/** Masks the credentials and secret parameters in a URL or any text that holds one (a node's proxy URL). */
export function maskText(value: string, options: MaskOptions = {}): Masked<string> {
  const masker = new Masker(options);
  const masked = masker.text(value);
  return { value: masked, count: masker.count };
}

// ---- canonical JSON and the content hash -----------------------------------------------------------------------

/** JSON with the keys of every object in code-unit order and no whitespace: one text for one value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('A number in a value that is hashed must be finite.');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
      }
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError('A value that is hashed must be JSON.');
}

/** SHA-256 (hex) of the canonical JSON of a value that is already masked. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
