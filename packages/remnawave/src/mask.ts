import { createHash, createHmac } from 'node:crypto';

import { UNREADABLE_DOCUMENT } from '@swellwright/contracts';

import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  parseAllDocuments,
  stringify as stringifyYaml,
  visit,
} from 'yaml';

// Masking of secrets in what a panel returns (ADR 0041, docs/en/design/05-security.md). One function does it for
// every view that leaves the API: a config profile, an inbound, a host's opaque parameters, a subscription template,
// a snippet, a node plugin, a URL with credentials in it. It is a deny-list (a key whose name says it is a secret, the
// ids of the clients of an inbound, a PEM private key, credentials in a URL, a token) because the Xray configuration is
// free-form and an allow-list would hide most of what an administrator wants to read. Secrets under a name nobody
// predicted are what a deny-list misses; the value rules below catch the shapes that give themselves away, and the
// tests feed it hostile structures. Anything past the depth limit is replaced as a whole: it fails closed.

export const MASK = '[masked]';
const MAX_DEPTH = 64;
const MAX_ENCODED_YAML_CHARS = 2_097_152;

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
  /** Redacts known credentials from a decoded base64 YAML field before it is encoded again. */
  readonly scrubDecodedYaml?: ((text: string) => { text: string; count: number }) | undefined;
}

export interface Masked<T> {
  readonly value: T;
  /** How many values were replaced by a mask. */
  readonly count: number;
}

/**
 * A name as the rules compare it: compatibility forms folded (`ｐａｓｓｗｏｒｄ` is `password`), lower case, and only
 * letters and digits (`api_key`, `api-key`, and `password` with a zero-width space inside all become one name).
 */
const norm = (key: string): string =>
  key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');

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
  'apitoken',
  'idtoken',
  'sessiontoken',
  'cookies',
  'sessionid',
]);

/** A name that contains one of these is a secret too (`obfsPassword`, `adminSecret`, `telegramBotToken`). */
const SECRET_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'privatekey',
  'passphrase',
  'apikey',
  'token',
];

/**
 * A name with `token` in it that names something about a token, not the token: `tokenUrl`, `tokenType`, `tokenName`,
 * `tokenUuid`, `tokenExpiresAt`. A plural (`apiTokens`, `accessTokens`) is a collection: its plain items are masked and
 * its objects are read by their own names (see `isSecretCollectionName`).
 */
const TOKEN_ABOUT =
  /(?:url|uri|endpoint|type|name|names|uuid|id|ids|count|at|expiry|expires|expiresin|scope|scopes|tokens)$/u;

/**
 * A name that ends in `key` is a secret (`apiKey`, `signingKey`, `encryptionKey`, `licenseKey`), except a key that is
 * public by nature. The bare `key` has its own rule (it is also the name half of a name/value pair).
 */
const PUBLIC_KEY_NAMES = /(?:publickey|publickeys|hostkey|pubkey)$/u;

/** A text field that holds a YAML document as base64 (`encodedTemplateYaml` of a subscription template). */
const ENCODED_YAML = /^encoded[a-z0-9]*yaml$/u;

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

/** The properties that name the value of a name/value pair (compared like every name: case and separators ignored). */
const NAME_KEYS: ReadonlySet<string> = new Set([
  'name',
  'key',
  'id',
  'label',
  'field',
  'variable',
  'var',
  'env',
  'header',
  'headername',
  'param',
  'parameter',
  'title',
]);

/**
 * A text that carries no structure: one line, with no `name: value` or `name=value` in it (a `:` inside a word, as
 * in a link or a time, and the `=` padding at the end of base64 are not separators). Such a text keeps the value rules;
 * any other text is read as a document or masked whole.
 */
export function isTrivialText(text: string): boolean {
  const trimmed = text.trim();
  if (startsFlowDocument(trimmed) || /[\r\n\u0085\u2028\u2029]|["'][\t \p{Cf}]*:/u.test(trimmed)) {
    return false;
  }
  const mapped = /^([\p{L}\p{N}\p{Cf}_.\\\t -]+):(\s|$)?/u.exec(trimmed);
  if (mapped?.[1] !== undefined) {
    const key = norm(mapped[1]);
    // YAML needs a delimiter after a plain key, but a credential label is still suspicious without one.
    if (
      mapped[2] !== undefined ||
      key === 'auth' ||
      key === 'decryption' ||
      isSecretName(key) ||
      isSecretCollectionName(key)
    ) {
      return false;
    }
  }
  return !/(?:^|[\s{,"'])[\p{L}\p{N}_.-]+["']?[ \t]*(?::(?:\s|$)|=(?![=\s]*$))/u.test(trimmed);
}

const startsFlowDocument = (trimmed: string): boolean =>
  trimmed.startsWith('{') || trimmed.startsWith('[');

const isSecretName = (key: string): boolean => {
  const n = norm(key);
  if (SECRET_KEYS.has(n)) {
    return true;
  }
  if (n !== 'key' && n.endsWith('key') && !PUBLIC_KEY_NAMES.test(n)) {
    return true;
  }
  return SECRET_SUBSTRINGS.some(
    (part) => n.includes(part) && (part !== 'token' || !TOKEN_ABOUT.test(n)),
  );
};

/**
 * The plural of a secret name (`accessTokens`, `botTokens`, `passwords`): a collection of secrets. A text or a number
 * in it is a secret; an object in it describes one (a token with its name and expiry) and is read by its own names.
 */
const isSecretCollectionName = (key: string): boolean => {
  const n = norm(key);
  return n.length > 1 && n.endsWith('s') && isSecretName(n.slice(0, -1));
};

/**
 * The names whose plain value stays readable inside an object item of a collection of secrets (`apiTokens: [{ name,
 * expiresAt, token }]`): what describes a token, never the token. Everything else under a secret name is masked.
 */
const COLLECTION_METADATA: ReadonlySet<string> = new Set([
  'id',
  'uuid',
  'name',
  'type',
  'createdat',
  'updatedat',
  'expiresat',
  // The panel's own spelling (`GET /api/tokens`: `response.tokens[].expireAt`).
  'expireat',
  'lastusedat',
  'tokentype',
  'tokenname',
  'tokenuuid',
  'tokenid',
  'tokenurl',
  'count',
  'usecount',
]);

/** How many values one call may visit, aliases and embedded documents included: past it the whole value is masked. */
const MAX_VISITS = 2_000_000;
/** Shared containers can expand far beyond their input size. Bound repeat work without lowering the limit for trees. */
const MAX_REPEAT_VISITS = 4096;

class UnsafeMaskStructure extends Error {}

type ContainerMode = 'ordinary' | 'people' | 'all' | 'collection' | 'record';

/**
 * A YAML text larger than this is not read as a document; it gets the whole-text rule of `maskTextFailClosed`. The
 * parser does work that grows faster than the text in places (an alias looks through the anchors before it), so the
 * limit keeps the worst case of one read in milliseconds.
 */
export const MAX_YAML_CHARS = 64 * 1024;
/**
 * A text with more `&` and `*` characters than this (anchors, aliases, or anything that could be one) is not read as
 * YAML either: resolving an alias is linear in the anchors before it, so many of both are quadratic. A subscription
 * template uses a few at most.
 */
const MAX_YAML_ANCHORS_AND_ALIASES = 300;

function anchorsAndAliases(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x26 || code === 0x2a) {
      count += 1;
    }
  }
  return count;
}
/** The most nodes a YAML stream may have before it is converted. */
const MAX_YAML_NODES = 100_000;

/**
 * Every key of every mapping is a plain scalar met once, no alias stands for a scalar, and the stream has at most
 * `MAX_YAML_NODES` nodes. An alias of a scalar is refused because the converted value no longer says where it came
 * from: `password: &p secret` and `message: *p` would show the secret under a name that is not secret. An alias of a
 * mapping or a list is fine: its contents keep their own names.
 */
function plainAndBounded(document: Document, counter: { nodes: number }): boolean {
  let clean = true;
  visit(document, (_key, node) => {
    counter.nodes += 1;
    if (counter.nodes > MAX_YAML_NODES) {
      clean = false;
      return visit.BREAK;
    }
    if (isAlias(node)) {
      const target: unknown = node.resolve(document);
      if (target === undefined || isScalar(target)) {
        clean = false;
        return visit.BREAK;
      }
    }
    if (isMap(node)) {
      const seen = new Set<string>();
      for (const pair of node.items) {
        const key: unknown = pair.key;
        if (!isScalar(key) || (key.value !== null && typeof key.value === 'object')) {
          clean = false;
          return visit.BREAK;
        }
        const name = String(key.value);
        if (seen.has(name)) {
          clean = false;
          return visit.BREAK;
        }
        seen.add(name);
      }
    }
    return undefined;
  });
  return clean;
}

/**
 * The documents of a YAML stream, or undefined when it cannot be read cleanly and within bounds: too large, a syntax
 * error or a warning (an unknown tag), a key that is repeated or is not a plain scalar, too many nodes, aliases that
 * expand too far. The parser never logs (its messages quote the source, which can be a credential) and the check for
 * repeated keys is one pass with a set per mapping (the parser's own check is quadratic in the number of keys).
 */
export function readYamlDocuments(text: string): unknown[] | undefined {
  if (text.length > MAX_YAML_CHARS || anchorsAndAliases(text) > MAX_YAML_ANCHORS_AND_ALIASES) {
    return undefined;
  }
  try {
    const parsed = parseAllDocuments(text, {
      schema: 'core',
      strict: true,
      uniqueKeys: false,
      logLevel: 'silent',
      prettyErrors: false,
    });
    const documents = Array.isArray(parsed) ? parsed : [];
    const counter = { nodes: 0 };
    const out: unknown[] = [];
    for (const document of documents) {
      if (document.errors.length > 0 || document.warnings.length > 0) {
        return undefined;
      }
      if (!plainAndBounded(document, counter)) {
        return undefined;
      }
      out.push(document.toJS({ maxAliasCount: 100 }));
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * What a text that is not one clean document becomes (see `maskTextFailClosed`): no rule can tell its names from
 * its values, so none of it is shown.
 */
export { UNREADABLE_DOCUMENT };

/** `vmess://` carries its whole configuration, id included, in one base64 text; `ss://` can too. The payload is secret. */
const OPAQUE_LINK = /\b(vmess:\/\/|ssr?:\/\/)([A-Za-z0-9+/=_-]{12,})/giu;
const PEM_PRIVATE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;
/** A whole PEM block of base64 lines (no header lines): its body cannot hold a `-`, so the match is linear. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]{1,40}-----[A-Za-z0-9+/=\s]*-----END [A-Z0-9 ]{1,40}-----/gu;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@?#"'<>]+)@/giu;
const URL_PARAM = /([?&;])([A-Za-z0-9_.-]{1,40})=([^&#\s"'<>]*)/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/gu;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;

class Masker {
  count = 0;
  private readonly key: Uint8Array | string | undefined;
  private readonly extra: ReadonlySet<string>;
  private readonly people: boolean;
  private readonly scrubDecodedYaml: MaskOptions['scrubDecodedYaml'];

  constructor(options: MaskOptions) {
    this.key = options.fingerprintKey;
    this.extra = new Set((options.extraSecretKeys ?? []).map(norm));
    this.people = options.people !== 'off';
    this.scrubDecodedYaml = options.scrubDecodedYaml;
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

  private visits = 0;
  private repeatVisits = 0;
  private repeatDepth = 0;
  private readonly seen = new WeakMap<object, ContainerMode>();
  /** The objects on the way from the top to the value being read: one met again is a cycle (a YAML alias of itself). */
  private readonly path: object[] = [];

  /** Counts one visit; past the budget the call fails closed (see `maskSecrets`). */
  private visit(): void {
    this.visits += 1;
    if (this.visits > MAX_VISITS) {
      throw new UnsafeMaskStructure();
    }
    if (this.repeatDepth > 0) {
      this.visitRepeated();
    }
  }

  private visitRepeated(): void {
    this.repeatVisits += 1;
    if (this.repeatVisits > MAX_REPEAT_VISITS) {
      throw new UnsafeMaskStructure();
    }
  }

  /** Refuses aliases that can expose a value masked in another context; a cycle is masked rather than followed. */
  private inside<R>(value: object, mode: ContainerMode, read: () => R): R | string {
    const previous = this.seen.get(value);
    if (previous !== undefined && previous !== mode) {
      throw new UnsafeMaskStructure();
    }
    // A stack, not a set: the path is at most `MAX_DEPTH` long.
    if (this.path.includes(value)) {
      return this.mask(null);
    }
    if (previous === undefined) {
      this.seen.set(value, mode);
    } else {
      this.visitRepeated();
      this.repeatDepth += 1;
    }
    this.path.push(value);
    try {
      return read();
    } finally {
      this.path.pop();
      if (previous !== undefined) {
        this.repeatDepth -= 1;
      }
    }
  }

  private peopleMode(key: string | undefined): 'people' | 'ordinary' {
    return this.people && key !== undefined && PEOPLE_KEYS.has(norm(key)) ? 'people' : 'ordinary';
  }

  /** Replaces every scalar inside a value that is secret as a whole; the shape (how many items) stays visible. */
  private maskAll(value: unknown, depth: number): unknown {
    this.visit();
    if (depth > MAX_DEPTH) {
      return this.mask(null);
    }
    if (Array.isArray(value)) {
      return this.inside(value, 'all', () => value.map((item) => this.maskAll(item, depth + 1)));
    }
    if (value !== null && typeof value === 'object') {
      return this.inside(value, 'all', () =>
        this.named(
          Object.entries(value).map(([key, item]) => [key, this.maskAll(item, depth + 1)] as const),
        ),
      );
    }
    if (value === null || value === undefined || value === '') {
      return value;
    }
    return this.mask(value);
  }

  /** The shape-only rules, also used on already-read documents and mapping names. */
  text(input: string): string {
    let out = input;
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
   * A YAML document carried as base64 (a subscription template's `encodedTemplateYaml`): an opaque text to every other
   * rule, so it is decoded, read, masked like any document and encoded again, with its comments dropped. What cannot be
   * read that way is masked as a whole: it fails closed.
   */
  private encodedYaml(value: string, depth: number): string {
    if (value.trim() === '') {
      return value;
    }
    if (value.length > MAX_ENCODED_YAML_CHARS || depth > MAX_DEPTH) {
      return this.mask(value);
    }
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const before = this.count;
      const text = this.scrubYaml(decoded);
      const documents = readYamlDocuments(text);
      const [parsed] = documents ?? [];
      if (documents?.length !== 1 || parsed === null || typeof parsed !== 'object') {
        return this.mask(value);
      }
      const masked = this.walk(parsed, depth + 1, undefined, undefined);
      // The names of a mapping are not values to the walk: the value rules run over the written text as well.
      const written = this.scrubYaml(this.text(stringifyYaml(masked, { lineWidth: 0 })));
      if (this.count === before && !text.includes('#')) {
        // Nothing in it is a secret and it has no comment, which is not read and could hold one: the original stays.
        return value;
      }
      return Buffer.from(written, 'utf8').toString('base64');
    } catch (error) {
      if (error instanceof UnsafeMaskStructure) {
        throw error;
      }
      return this.mask(value);
    }
  }

  private scrubYaml(text: string): string {
    const scrubbed = this.scrubDecodedYaml?.(text);
    this.count += scrubbed?.count ?? 0;
    return scrubbed?.text ?? text;
  }

  /**
   * The rule for a text that is not one clean YAML or JSON document (a parse error or warning, a repeated key, over the
   * limits of size or aliases, an env file, a page): no rule can tell its names from its values, so it is masked as a
   * whole. Only a trivial text is shown with the value rules: one line without a `: ` or `=` separator (an error
   * sentence, a number, `ok`, a bare link).
   */
  failClosed(input: string): string {
    if (isTrivialText(input)) {
      return this.text(input);
    }
    return this.unreadable();
  }

  private unreadable(): string {
    this.count += 1;
    return UNREADABLE_DOCUMENT;
  }

  /**
   * A string value. A trivial one (one line, no `name: value` or `name=value` in it) gets the value rules. Any other is
   * a document in a string (`config: |` with YAML in it, a JSON text) and gets the rule of a text answer: read as one
   * clean document, masked by its names and written again when something in it was masked (kept, with the value rules,
   * when nothing was); not readable that way, it is masked whole. Depth and work count towards the same limits.
   */
  stringValue(value: string, depth = 0): string {
    // A PEM block is a known shape on several lines (a private key is masked by the value rules, a certificate kept):
    // a text that is trivial apart from its PEM blocks keeps the value rules.
    if (isTrivialText(value) || isTrivialText(value.replace(PEM_BLOCK, ' '))) {
      return this.text(value);
    }
    if (depth > MAX_DEPTH) {
      return this.unreadable();
    }
    const documents = readYamlDocuments(value);
    const [document] = documents ?? [];
    if (documents?.length !== 1 || document === null || typeof document !== 'object') {
      return this.unreadable();
    }
    const before = this.count;
    const masked = this.walk(document, depth + 1, undefined, undefined);
    if (this.count === before && !value.includes('#')) {
      return this.text(value);
    }
    const start = value.trimStart();
    const written = startsFlowDocument(start)
      ? JSON.stringify(masked)
      : stringifyYaml(masked, { lineWidth: 0 });
    return this.text(written);
  }

  /**
   * The entries of an object with their names read by the value rules too (a name can be a URL with credentials). Two
   * names that become one after masking keep both entries: the later ones get `#1`, `#2`, ... after the name.
   */
  private named(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
    const used = new Set<string>();
    // The next suffix to try for each masked name, so that many names that mask alike cost one step each.
    const next = new Map<string, number>();
    const out: [string, unknown][] = [];
    for (const [key, value] of entries) {
      this.visit();
      const masked = this.text(key);
      let name = masked;
      if (used.has(name)) {
        let index = next.get(masked) ?? 1;
        // A suffix can be taken by a name of the object itself (`x#1`): skip it, once.
        while (used.has(`${masked}#${String(index)}`)) {
          this.visit();
          index += 1;
        }
        name = `${masked}#${String(index)}`;
        next.set(masked, index + 1);
      }
      used.add(name);
      out.push([name, value]);
    }
    // `fromEntries` defines own properties: a name such as `__proto__` stays a name.
    return Object.fromEntries(out);
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
    this.visit();
    if (depth > MAX_DEPTH) {
      return this.mask(null);
    }
    if (typeof value === 'string') {
      return this.stringValue(value, depth);
    }
    if (Array.isArray(value)) {
      return this.inside(value, this.peopleMode(key), () =>
        value.map((item) => this.walk(item, depth + 1, undefined, key)),
      );
    }
    if (value !== null && typeof value === 'object') {
      const mode = this.peopleMode(arrayKey);
      return this.inside(value, mode, () =>
        this.object(value as Record<string, unknown>, depth, mode === 'people'),
      );
    }
    return value;
  }

  /**
   * A collection under a secret plural name (`accessTokens`): every scalar in it, at any depth, is masked (a list of
   * lists, a dictionary of tokens), except the metadata of a record: in an object that is an item of the collection
   * (or a value of a dictionary of such objects), a boolean and a plain value under a name of `COLLECTION_METADATA`
   * (`name`, `expiresAt`, ...) stay readable.
   */
  private collection(value: unknown, depth: number): unknown {
    this.visit();
    if (depth > MAX_DEPTH) {
      return this.mask(null);
    }
    const item = (entry: unknown): unknown =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? this.record(entry as Record<string, unknown>, depth + 1)
        : this.collection(entry, depth + 1);
    if (Array.isArray(value)) {
      return this.inside(value, 'collection', () => value.map(item));
    }
    if (value !== null && typeof value === 'object') {
      return this.inside(value, 'collection', () =>
        this.named(Object.entries(value).map(([key, entry]) => [key, item(entry)] as const)),
      );
    }
    return this.maskAll(value, depth);
  }

  /** One record of a collection of secrets: its metadata stays, everything else is masked whole. */
  private record(source: Readonly<Record<string, unknown>>, depth: number): unknown {
    this.visit();
    return this.inside(source, 'record', () =>
      this.named(
        Object.entries(source).map(([key, entry]): [string, unknown] => {
          // The names the caller's profile hides (the console's profile for people hides `uuid`) are hidden here too:
          // the metadata list never makes a value readable that the profile hides.
          if (this.extra.has(norm(key))) {
            return [key, this.maskAll(entry, depth + 1)];
          }
          if (typeof entry === 'boolean' || entry === null) {
            return [key, entry];
          }
          if (
            COLLECTION_METADATA.has(norm(key)) &&
            (typeof entry === 'string' || typeof entry === 'number')
          ) {
            return [key, typeof entry === 'string' ? this.stringValue(entry, depth + 1) : entry];
          }
          return [key, this.maskAll(entry, depth + 1)];
        }),
      ),
    );
  }

  private object(
    source: Readonly<Record<string, unknown>>,
    depth: number,
    inPeople: boolean,
  ): Record<string, unknown> {
    // `{ "name": "Authorization", "value": "..." }` and `{ "key": "x-api-key", "value": "..." }` pairs, in any case and
    // order of their properties: the value is secret when ANY of the naming properties names a secret.
    const hasValue = Object.keys(source).some((candidate) => norm(candidate) === 'value');
    const sensitivePair =
      hasValue &&
      Object.entries(source).some(
        ([candidate, given]) =>
          NAME_KEYS.has(norm(candidate)) &&
          typeof given === 'string' &&
          (this.secretName(given) || isSecretCollectionName(given)),
      );
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
      if (ENCODED_YAML.test(n) && typeof item === 'string') {
        return [name, this.encodedYaml(item, depth)];
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
      if (sensitivePair && n === 'value') {
        return [name, this.maskAll(item, depth + 1)];
      }
      if (isSecretCollectionName(name)) {
        return [name, this.collection(item, depth + 1)];
      }
      return [name, this.walk(item, depth + 1, name, undefined)];
    });
    return this.named(entries);
  }
}

/** Masks every secret in a JSON-like value. The input is not changed; the result shares nothing with it. */
export function maskSecrets<T>(value: T, options: MaskOptions = {}): Masked<T> {
  const masker = new Masker(options);
  try {
    const masked = masker.walk(value, 0, undefined, undefined) as T;
    return { value: masked, count: masker.count };
  } catch (error) {
    if (error instanceof UnsafeMaskStructure) {
      // An alias changes masking context or the structure takes too much work: nothing of it is shown.
      return { value: MASK as T, count: masker.count + 1 };
    }
    throw error;
  }
}

/** Masks the credentials and secret parameters in a URL or any text that holds one (a node's proxy URL). */
export function maskText(value: string, options: MaskOptions = {}): Masked<string> {
  const masker = new Masker(options);
  try {
    const masked = startsFlowDocument(value.trimStart())
      ? masker.stringValue(value)
      : masker.text(value);
    return { value: masked, count: masker.count };
  } catch (error) {
    if (error instanceof UnsafeMaskStructure) {
      return { value: MASK, count: masker.count + 1 };
    }
    throw error;
  }
}

/**
 * Masks a text that is not one clean YAML or JSON document (a repeated key, a syntax error, too large, an env or INI
 * file, a page): fails closed. It becomes `UNREADABLE_DOCUMENT`, unless it is a trivial text (one line without `:` or
 * `=`), which gets the value rules of `maskText`.
 */
export function maskTextFailClosed(value: string, options: MaskOptions = {}): Masked<string> {
  const masker = new Masker(options);
  try {
    const masked = masker.failClosed(value);
    return { value: masked, count: masker.count };
  } catch (error) {
    if (error instanceof UnsafeMaskStructure) {
      return { value: MASK, count: masker.count + 1 };
    }
    throw error;
  }
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
