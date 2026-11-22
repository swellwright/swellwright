import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { AUTH_KEY_BYTES } from './auth/secret-box.js';
import type { PluginRoot } from './plugins/discovery.js';
import type { KdfParams } from './vault/kdf.js';

/** An empty variable (`SW_X=`) means "not set", as in most env files. */
const unsetIfEmpty = (v: unknown): unknown => (v === '' ? undefined : v);
const optionalUrl = z.preprocess(unsetIfEmpty, z.url().optional());
const optionalString = z.preprocess(unsetIfEmpty, z.string().optional());
/** A text the build recorded about itself: trimmed, cut to a sane length, empty means "not set". */
const buildNote = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== 'string' || v.trim() === '') {
      return undefined;
    }
    return v.trim().slice(0, max);
  }, z.string().optional());

/** `owner/name` of a GitHub repository: the owner is up to 39 letters, digits and hyphens (not at the ends). */
const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;
/** Only a hash is put into a URL. */
const COMMIT_HASH = /^[0-9a-f]{7,64}$/iu;
export const DEFAULT_REPOSITORY = 'swellwright/swellwright';
export const DEFAULT_UPDATE_API_BASE = 'https://api.github.com';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where the update check asks. https only; plain http is for a stand-in server on the same machine (tests).
 * No credentials, query or fragment: the base is only a place to append `/repos/...` to.
 */
function checkUpdateApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid configuration: SW_UPDATE_API_BASE is not a URL.');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(
      'Invalid configuration: SW_UPDATE_API_BASE must be an https URL (http only for localhost).',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Invalid configuration: SW_UPDATE_API_BASE has no credentials, query or fragment.',
    );
  }
  return value.replace(/\/+$/u, '');
}

const EnvSchema = z.object({
  SW_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  SW_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  SW_DATABASE_URL: optionalUrl,
  SW_VALKEY_URL: optionalUrl,
  /** Check every response against its contract. Defaults to on outside production. */
  SW_VALIDATE_RESPONSES: z.stringbool().optional(),
  SW_LOG_LEVEL: z.enum(['normal', 'silent']).default('normal'),
  SW_VERSION: z.string().min(1).optional(),
  SW_COMMIT: z.string().min(1).optional(),
  /** What the image build recorded about itself, shown in the console's "Build info" (build arguments, ADR 0019). */
  SW_BUILD_TIME: buildNote(64),
  SW_BUILD_NUMBER: buildNote(64),
  SW_GIT_BRANCH: buildNote(255),
  SW_GIT_COMMIT: buildNote(64),
  /** Ask GitHub for the newest release and the star count (once a day). `off` sends nothing, ever. */
  SW_UPDATE_CHECK: z.preprocess(unsetIfEmpty, z.stringbool().default(true)),
  /** The GitHub repository the project lives in, `owner/name`. Forks and mirrors set their own. */
  SW_REPOSITORY: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(REPOSITORY, 'must be owner/name of a GitHub repository')
      .default(DEFAULT_REPOSITORY),
  ),
  /** The GitHub API. For tests only: a stand-in server on the same machine. */
  SW_UPDATE_API_BASE: z.preprocess(unsetIfEmpty, z.string().default(DEFAULT_UPDATE_API_BASE)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Base64 of 32 random bytes. Seals the TOTP secrets in the database (ADR 0014). */
  SW_AUTH_KEY: optionalString,
  /** Optional fixed setup token; without it a random one is printed to the log on first run. */
  SW_SETUP_TOKEN: z.preprocess(unsetIfEmpty, z.string().min(16).max(128).optional()),
  /** The session cookie gets the Secure attribute. Defaults to on in production. */
  SW_COOKIE_SECURE: z.stringbool().optional(),
  /** Comma-separated origins allowed to send state-changing requests. Default: the request's own host. */
  SW_ALLOWED_ORIGINS: optionalString,
  SW_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  SW_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  SW_LOCKOUT_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  SW_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  /** How long a session counts as freshly verified after the second factor (ADR 0017). */
  SW_STEP_UP_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  /** The directory with the built console. When set, the API serves it at `/` (one image, ADR 0019). */
  SW_WEB_DIR: optionalString,
  /**
   * Which proxies in front of the API may say who the client is (`X-Forwarded-For`): a number of hops, or a
   * comma-separated list of addresses, CIDR ranges and the names `loopback`, `linklocal`, `uniquelocal`.
   * Not set: nobody is trusted and the address of the connection is the client.
   */
  SW_TRUSTED_PROXIES: optionalString,
  /** Argon2id cost of the vault passphrase (ADR 0018). Raising it only affects vaults set up afterwards. */
  SW_VAULT_KDF_MEMORY_MIB: z.coerce.number().int().min(64).max(4096).default(256),
  SW_VAULT_KDF_PASSES: z.coerce.number().int().min(1).max(10).default(3),
  /** Plugins that ship with Swellwright (trust `official`), one directory per plugin (ADR 0021). */
  SW_PLUGINS_OFFICIAL_DIR: optionalString,
  /** Plugins of this instance (trust `local`): the administrator's own responsibility (ADR 0008). */
  SW_PLUGINS_LOCAL_DIR: optionalString,
  /** Plugins by others (trust `community`): only as sidecar containers or declarative drivers (ADR 0031). */
  SW_PLUGINS_COMMUNITY_DIR: optionalString,
  /** Where a sidecar reaches Swellwright from its network (ADR 0031). */
  SW_PLUGIN_CORE_URL: z.preprocess(unsetIfEmpty, z.url().default('http://swellwright:3000')),
  /** How the core reaches a sidecar: `{id}` is the plugin id and `{port}` the port of its manifest. */
  SW_PLUGIN_SIDECAR_URL: z.preprocess(
    unsetIfEmpty,
    z.string().default('http://plugin-{id}:{port}'),
  ),
  /** The compose network the sidecars live on, and the compose service of Swellwright that joins it. */
  SW_PLUGIN_NETWORK: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,40}$/u)
    .default('plugins'),
  SW_PLUGIN_CORE_SERVICE: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,40}$/u)
    .default('swellwright'),
  /** The heap limit of a plugin's process, in MiB (ADR 0028). */
  SW_PLUGIN_MEMORY_MIB: z.coerce.number().int().min(32).max(1024).default(128),
  /** How long one call to a plugin may take before its process is ended, in seconds. */
  SW_PLUGIN_CALL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
  /** How long a plugin's process may sit idle before it is stopped, in minutes. */
  SW_PLUGIN_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  /**
   * Which addresses Swellwright may open an SSH connection to (ADR 0037, docs/en/design/05-security.md section 7).
   * Loopback is the host Swellwright itself runs on and is refused by default; private ranges and host names are
   * allowed, because fleets live there. Link-local and cloud metadata addresses are never allowed.
   */
  SW_SSH_ALLOW_LOOPBACK: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
  SW_SSH_ALLOW_PRIVATE: z.preprocess(unsetIfEmpty, z.stringbool().default(true)),
  SW_SSH_ALLOW_HOSTNAMES: z.preprocess(unsetIfEmpty, z.stringbool().default(true)),
  /** TCP connect, key exchange and login together, in seconds. */
  SW_SSH_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  /** One command on a server (the facts script is the longest), in seconds. The quick probes use at most 20. */
  SW_SSH_COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  /** How many scans, checks and refreshes one user may start per minute. */
  SW_SSH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
  /** Scripts and commands on servers (ADR 0038): how many servers of one run are worked on at the same time. */
  SW_COMMAND_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  /** How much of each output stream of each server is kept, in KiB; the rest is cut and the target says so. */
  SW_COMMAND_OUTPUT_LIMIT_KIB: z.coerce.number().int().min(16).max(10_240).default(1024),
  /** How often a running script is looked at, in milliseconds (it slows down by itself while nothing new arrives). */
  SW_COMMAND_POLL_MS: z.coerce.number().int().min(20).max(10_000).default(1000),
  /** How long a running server may stay out of reach before its result is given up as lost, in minutes. */
  SW_COMMAND_LOST_AFTER_MINUTES: z.coerce.number().min(0.02).max(1440).default(30),
  /** How many runs one user may start per minute. */
  SW_COMMAND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(10),
  /**
   * The catalogue of built-in artifacts (ADR 0039): a directory with one sub-directory per artifact. The default is
   * the `artifacts` directory of the repository, which is where the container image puts it too.
   */
  SW_ARTIFACTS_DIR: optionalString,
  /** The biggest file an artifact may be, in bytes; a bigger one is broken. A push holds the file in memory. */
  SW_ARTIFACT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024)
    .default(64 * 1024 * 1024),
  /** How many pushes, checks and removals of artifacts one user may start per minute. */
  SW_ARTIFACT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(10),
  /**
   * The Remnawave panel (ADR 0041). The panel's address is validated like an SSH target: loopback is the host
   * Swellwright itself runs on and is refused by default, private ranges and host names are allowed, link-local and
   * cloud metadata addresses never are. Plain http only for a loopback or private address, and only when allowed.
   */
  SW_PANEL_ALLOW_HTTP: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
  SW_PANEL_ALLOW_LOOPBACK: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
  SW_PANEL_ALLOW_PRIVATE: z.preprocess(unsetIfEmpty, z.stringbool().default(true)),
  SW_PANEL_ALLOW_HOSTNAMES: z.preprocess(unsetIfEmpty, z.stringbool().default(true)),
  /** Turns the verification of the panel's TLS certificate off for every panel. Never needed with a CA of its own. */
  SW_PANEL_ALLOW_INSECURE_TLS: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
  /** One request to the panel, in seconds (the connection itself has `SW_PANEL_CONNECT_TIMEOUT_SECONDS`). */
  SW_PANEL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  SW_PANEL_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  /** The largest answer taken from the panel, in MiB; a bigger one is refused as a change of the contract. */
  SW_PANEL_MAX_RESPONSE_MIB: z.coerce.number().int().min(1).max(256).default(16),
  /** How long an answer is kept in the memory of this server before the panel is asked again, in seconds. */
  SW_PANEL_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(15),
  /** How often a connected panel is checked in the background (version, token, what can be read), in minutes. 0: never. */
  SW_PANEL_CHECK_INTERVAL_MINUTES: z.coerce
    .number()
    .min(0)
    .max(1440)
    .refine((minutes) => minutes === 0 || minutes >= 0.02, 'must be 0 (off) or at least 0.02')
    .default(5),
  /** How many times one user may ask the panel again (`refresh=true`) per minute. */
  SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(12),
  /** How many connection tests and connects one user may start per minute. */
  SW_PANEL_TEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(10),
  /**
   * The checks of the panel (ADR 0044). The reconciliation looks names up in DNS: how long one name may take, how many
   * different names one run may look up, how many lookups run at once, how long an answer is kept, which servers to ask
   * (empty: the resolver of this machine), and how often a person may start a reconciliation per minute.
   */
  SW_CHECKS_DNS_TIMEOUT_SECONDS: z.coerce.number().min(0.2).max(30).default(3),
  SW_CHECKS_DNS_MAX_NAMES: z.coerce.number().int().min(1).max(2000).default(200),
  SW_CHECKS_DNS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  SW_CHECKS_DNS_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  SW_CHECKS_DNS_SERVERS: optionalString,
  SW_CHECKS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(12),
  /** Snapshots of the panel (ADR 0043): how many are kept at least (the newest of each of the last 14 days is kept as well). */
  SW_PANEL_SNAPSHOT_KEEP: z.coerce.number().int().min(1).max(1000).default(50),
  /** How often the background job takes a snapshot while a panel is connected and the vault is open, in hours. 0: never. */
  SW_PANEL_SNAPSHOT_INTERVAL_HOURS: z.coerce
    .number()
    .min(0)
    .max(720)
    .refine((hours) => hours === 0 || hours >= 0.01, 'must be 0 (off) or at least 0.01')
    .default(24),
  /** The most one snapshot may hold before compression, in MiB; a panel that needs more is refused with 413. */
  SW_PANEL_SNAPSHOT_MAX_MIB: z.coerce.number().int().min(1).max(256).default(32),
});

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string | undefined;
  readonly valkeyUrl: string | undefined;
  readonly validateResponses: boolean;
  readonly silent: boolean;
  readonly version: string;
  readonly commit: string | undefined;
  /** What the image build recorded; each is null when the build did not say. */
  readonly build: { readonly time: string | null; readonly number: string | null };
  readonly git: {
    readonly branch: string | null;
    readonly commit: string | null;
    /** The page of the revision on GitHub: set only when the revision looks like a commit hash. */
    readonly commitUrl: string | null;
  };
  /** The GitHub repository, `owner/name`. */
  readonly repository: string;
  /** The page of the repository on GitHub. */
  readonly repositoryUrl: string;
  /** The check for a newer release (the console's version button) and where it asks. */
  readonly updateCheck: { readonly enabled: boolean; readonly apiBase: string };
  readonly production: boolean;
  readonly authKey: Buffer;
  /** True when no key was configured and a random one was made for this process (development only). */
  readonly authKeyEphemeral: boolean;
  readonly setupToken: string | undefined;
  readonly cookieSecure: boolean;
  readonly allowedOrigins: readonly string[];
  readonly sessionIdleMs: number;
  readonly sessionMaxMs: number;
  readonly lockoutAttempts: number;
  readonly lockoutMs: number;
  /** How long a session stays elevated after sign-in or a step-up. */
  readonly stepUpMs: number;
  /** The built console to serve, or undefined when a reverse proxy serves it. */
  readonly webDir: string | undefined;
  /** What Express is told about trusted proxies: a hop count, a list, or false (nobody). */
  readonly trustProxy: number | string[] | false;
  /** The cost with which a new vault passphrase is hardened. */
  readonly vaultKdf: KdfParams;
  /** Where plugins are looked for, the more trusted first. Empty: no plugins. */
  readonly pluginRoots: readonly PluginRoot[];
  /** How sidecar containers are reached and generated (ADR 0031). */
  readonly pluginSidecar: {
    readonly coreUrl: string;
    readonly urlTemplate: string;
    readonly network: string;
    readonly coreService: string;
  };
  /** What every plugin process is held to (ADR 0028). */
  readonly pluginLimits: {
    readonly memoryMiB: number;
    readonly callTimeoutMs: number;
    readonly idleMs: number;
  };
  /** Servers over SSH (ADR 0037). */
  readonly ssh: {
    /** The outbound address policy; the connection itself does not apply it, the API does before it connects. */
    readonly policy: {
      readonly allowLoopback: boolean;
      readonly allowPrivate: boolean;
      readonly allowHostnames: boolean;
    };
    readonly connectTimeoutMs: number;
    readonly commandTimeoutMs: number;
    readonly rateLimitPerMinute: number;
  };
  /** Scripts and commands on servers (ADR 0038). */
  readonly commands: {
    readonly concurrency: number;
    /** Per stream and per server, in bytes. */
    readonly outputLimitBytes: number;
    readonly pollMs: number;
    readonly lostAfterMs: number;
    readonly rateLimitPerMinute: number;
  };
  /** The artifact catalogue and how it is distributed (ADR 0039). */
  readonly artifacts: {
    readonly directory: string;
    readonly maxBytes: number;
    readonly rateLimitPerMinute: number;
  };
  /** The connection to a Remnawave panel (ADR 0041). */
  readonly panel: {
    /** The outbound address policy: applied to the address in the URL and to every address a name resolves to. */
    readonly policy: {
      readonly allowLoopback: boolean;
      readonly allowPrivate: boolean;
      readonly allowHostnames: boolean;
    };
    readonly allowHttp: boolean;
    readonly allowInsecureTls: boolean;
    readonly timeoutMs: number;
    readonly connectTimeoutMs: number;
    readonly maxResponseBytes: number;
    readonly cacheTtlMs: number;
    /** 0: no background check. */
    readonly checkIntervalMs: number;
    readonly refreshRateLimitPerMinute: number;
    readonly testRateLimitPerMinute: number;
    /** Snapshots (ADR 0043): how many are kept at least, the interval of the job (0: off) and the size cap. */
    readonly snapshotKeep: number;
    readonly snapshotIntervalMs: number;
    readonly snapshotMaxBytes: number;
  };
  /** The checks of the panel: DNS for the reconciliation (ADR 0044). */
  readonly checks: {
    readonly dnsTimeoutMs: number;
    readonly dnsMaxNames: number;
    readonly dnsConcurrency: number;
    readonly dnsCacheMs: number;
    /** Addresses of the DNS servers to ask; empty: the system resolver. */
    readonly dnsServers: readonly string[];
    readonly rateLimitPerMinute: number;
  };
}

/** The DNS servers of `SW_CHECKS_DNS_SERVERS`: a comma-separated list of IP addresses (with an optional port), or nothing. */
function dnsServersOf(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  const servers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const server of servers) {
    // An address as it is, or `1.2.3.4:53`, or `[2001:db8::1]:53`.
    const host =
      isIP(server) !== 0
        ? server
        : server.startsWith('[')
          ? server.slice(1, Math.max(1, server.indexOf(']')))
          : server.replace(/:\d+$/u, '');
    if (isIP(host) === 0) {
      throw new Error(
        `Invalid configuration: SW_CHECKS_DNS_SERVERS holds "${server}", which is not an IP address.`,
      );
    }
  }
  return servers;
}

/** What comes out of the template must be an http(s) URL: a typo is refused at start. */
function checkSidecarTemplate(template: string): string {
  const sample = template.replaceAll('{id}', 'example').replaceAll('{port}', '8080');
  if (!/^https?:\/\//u.test(sample)) {
    throw new Error(
      'Invalid configuration: SW_PLUGIN_SIDECAR_URL is an http(s) URL with {id} and {port}.',
    );
  }
  try {
    new URL(sample);
  } catch {
    throw new Error('Invalid configuration: SW_PLUGIN_SIDECAR_URL is not a URL.');
  }
  return template;
}

function decodeAuthKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== AUTH_KEY_BYTES) {
    throw new Error(
      `Invalid configuration: SW_AUTH_KEY must be ${String(AUTH_KEY_BYTES)} random bytes in base64 (try: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))").`,
    );
  }
  return key;
}

/** `2` is two hops; anything else is a list Express understands. A typo must not silently trust everyone. */
function parseTrustedProxies(value: string | undefined): number | string[] | false {
  if (value === undefined) {
    return false;
  }
  const text = value.trim();
  if (/^\d+$/u.test(text)) {
    const hops = Number(text);
    if (hops < 1 || hops > 10) {
      throw new Error('Invalid configuration: SW_TRUSTED_PROXIES as a number must be 1 to 10.');
    }
    return hops;
  }
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const named = new Set(['loopback', 'linklocal', 'uniquelocal']);
  for (const entry of entries) {
    const address = entry.split('/')[0] ?? '';
    if (
      !named.has(entry) &&
      !z.ipv4().safeParse(address).success &&
      !z.ipv6().safeParse(address).success
    ) {
      throw new Error(
        `Invalid configuration: SW_TRUSTED_PROXIES entries must be addresses, CIDR ranges, loopback, linklocal or uniquelocal, got "${entry}".`,
      );
    }
  }
  if (entries.length === 0) {
    throw new Error('Invalid configuration: SW_TRUSTED_PROXIES is empty.');
  }
  return entries;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  packageVersion: string,
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  // The revision comes from its own variable; the older `SW_COMMIT` (the image label) stands in when it is
  // missing, unless it holds the image's "unknown" placeholder.
  const gitCommit =
    e.SW_GIT_COMMIT ?? (e.SW_COMMIT && e.SW_COMMIT !== 'unknown' ? e.SW_COMMIT : null);
  if (production && e.SW_DATABASE_URL && !e.SW_AUTH_KEY) {
    throw new Error('Invalid configuration: SW_AUTH_KEY is required in production.');
  }
  const origins = (e.SW_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  for (const origin of origins) {
    if (!z.url().safeParse(origin).success || new URL(origin).origin !== origin) {
      throw new Error(
        `Invalid configuration: SW_ALLOWED_ORIGINS entries must be origins like https://console.example.com, got "${origin}".`,
      );
    }
  }
  return {
    host: e.SW_HTTP_HOST,
    port: e.SW_HTTP_PORT,
    databaseUrl: e.SW_DATABASE_URL,
    valkeyUrl: e.SW_VALKEY_URL,
    validateResponses: e.SW_VALIDATE_RESPONSES ?? !production,
    silent: e.SW_LOG_LEVEL === 'silent',
    version: e.SW_VERSION ?? packageVersion,
    commit: e.SW_COMMIT,
    build: { time: e.SW_BUILD_TIME ?? null, number: e.SW_BUILD_NUMBER ?? null },
    git: {
      branch: e.SW_GIT_BRANCH ?? null,
      commit: gitCommit,
      commitUrl:
        gitCommit !== null && COMMIT_HASH.test(gitCommit)
          ? `https://github.com/${e.SW_REPOSITORY}/commit/${gitCommit}`
          : null,
    },
    repository: e.SW_REPOSITORY,
    repositoryUrl: `https://github.com/${e.SW_REPOSITORY}`,
    updateCheck: { enabled: e.SW_UPDATE_CHECK, apiBase: checkUpdateApiBase(e.SW_UPDATE_API_BASE) },
    production,
    authKey: e.SW_AUTH_KEY ? decodeAuthKey(e.SW_AUTH_KEY) : randomBytes(AUTH_KEY_BYTES),
    authKeyEphemeral: !e.SW_AUTH_KEY,
    setupToken: e.SW_SETUP_TOKEN,
    cookieSecure: e.SW_COOKIE_SECURE ?? production,
    allowedOrigins: origins,
    sessionIdleMs: e.SW_SESSION_IDLE_MINUTES * 60_000,
    sessionMaxMs: e.SW_SESSION_MAX_HOURS * 3_600_000,
    lockoutAttempts: e.SW_LOCKOUT_ATTEMPTS,
    lockoutMs: e.SW_LOCKOUT_MINUTES * 60_000,
    stepUpMs: e.SW_STEP_UP_MINUTES * 60_000,
    webDir: e.SW_WEB_DIR,
    trustProxy: parseTrustedProxies(e.SW_TRUSTED_PROXIES),
    vaultKdf: {
      memoryKib: e.SW_VAULT_KDF_MEMORY_MIB * 1024,
      passes: e.SW_VAULT_KDF_PASSES,
      parallelism: 1,
    },
    pluginRoots: [
      ...(e.SW_PLUGINS_OFFICIAL_DIR
        ? [{ directory: resolve(e.SW_PLUGINS_OFFICIAL_DIR), trust: 'official' as const }]
        : []),
      ...(e.SW_PLUGINS_LOCAL_DIR
        ? [{ directory: resolve(e.SW_PLUGINS_LOCAL_DIR), trust: 'local' as const }]
        : []),
      ...(e.SW_PLUGINS_COMMUNITY_DIR
        ? [{ directory: resolve(e.SW_PLUGINS_COMMUNITY_DIR), trust: 'community' as const }]
        : []),
    ],
    pluginSidecar: {
      coreUrl: e.SW_PLUGIN_CORE_URL.replace(/\/$/u, ''),
      urlTemplate: checkSidecarTemplate(e.SW_PLUGIN_SIDECAR_URL),
      network: e.SW_PLUGIN_NETWORK,
      coreService: e.SW_PLUGIN_CORE_SERVICE,
    },
    pluginLimits: {
      memoryMiB: e.SW_PLUGIN_MEMORY_MIB,
      callTimeoutMs: e.SW_PLUGIN_CALL_TIMEOUT_SECONDS * 1000,
      idleMs: e.SW_PLUGIN_IDLE_MINUTES * 60_000,
    },
    ssh: {
      policy: {
        allowLoopback: e.SW_SSH_ALLOW_LOOPBACK,
        allowPrivate: e.SW_SSH_ALLOW_PRIVATE,
        allowHostnames: e.SW_SSH_ALLOW_HOSTNAMES,
      },
      connectTimeoutMs: e.SW_SSH_CONNECT_TIMEOUT_SECONDS * 1000,
      commandTimeoutMs: e.SW_SSH_COMMAND_TIMEOUT_SECONDS * 1000,
      rateLimitPerMinute: e.SW_SSH_RATE_LIMIT_PER_MINUTE,
    },
    commands: {
      concurrency: e.SW_COMMAND_CONCURRENCY,
      outputLimitBytes: e.SW_COMMAND_OUTPUT_LIMIT_KIB * 1024,
      pollMs: e.SW_COMMAND_POLL_MS,
      lostAfterMs: e.SW_COMMAND_LOST_AFTER_MINUTES * 60_000,
      rateLimitPerMinute: e.SW_COMMAND_RATE_LIMIT_PER_MINUTE,
    },
    artifacts: {
      // apps/api/{src,dist}/config.js: three levels up is the root of the repository, and of the image (/app).
      directory: resolve(
        e.SW_ARTIFACTS_DIR ?? fileURLToPath(new URL('../../../artifacts', import.meta.url)),
      ),
      maxBytes: e.SW_ARTIFACT_MAX_BYTES,
      rateLimitPerMinute: e.SW_ARTIFACT_RATE_LIMIT_PER_MINUTE,
    },
    panel: {
      policy: {
        allowLoopback: e.SW_PANEL_ALLOW_LOOPBACK,
        allowPrivate: e.SW_PANEL_ALLOW_PRIVATE,
        allowHostnames: e.SW_PANEL_ALLOW_HOSTNAMES,
      },
      allowHttp: e.SW_PANEL_ALLOW_HTTP,
      allowInsecureTls: e.SW_PANEL_ALLOW_INSECURE_TLS,
      timeoutMs: e.SW_PANEL_TIMEOUT_SECONDS * 1000,
      connectTimeoutMs: e.SW_PANEL_CONNECT_TIMEOUT_SECONDS * 1000,
      maxResponseBytes: e.SW_PANEL_MAX_RESPONSE_MIB * 1024 * 1024,
      cacheTtlMs: e.SW_PANEL_CACHE_TTL_SECONDS * 1000,
      checkIntervalMs: Math.round(e.SW_PANEL_CHECK_INTERVAL_MINUTES * 60_000),
      refreshRateLimitPerMinute: e.SW_PANEL_REFRESH_RATE_LIMIT_PER_MINUTE,
      testRateLimitPerMinute: e.SW_PANEL_TEST_RATE_LIMIT_PER_MINUTE,
      snapshotKeep: e.SW_PANEL_SNAPSHOT_KEEP,
      snapshotIntervalMs: Math.round(e.SW_PANEL_SNAPSHOT_INTERVAL_HOURS * 3_600_000),
      snapshotMaxBytes: e.SW_PANEL_SNAPSHOT_MAX_MIB * 1024 * 1024,
    },
    checks: {
      dnsTimeoutMs: Math.round(e.SW_CHECKS_DNS_TIMEOUT_SECONDS * 1000),
      dnsMaxNames: e.SW_CHECKS_DNS_MAX_NAMES,
      dnsConcurrency: e.SW_CHECKS_DNS_CONCURRENCY,
      dnsCacheMs: e.SW_CHECKS_DNS_CACHE_SECONDS * 1000,
      dnsServers: dnsServersOf(e.SW_CHECKS_DNS_SERVERS),
      rateLimitPerMinute: e.SW_CHECKS_RATE_LIMIT_PER_MINUTE,
    },
  };
}
