/**
 * What a plugin's module looks like from the inside (ADR 0028). A module named in `provides[].entry` exports
 * `methods`; the core calls them by name, in a process of their own that can touch only the plugin's directory:
 * no network, no child processes, no environment of the core. The one door out is `context.fetch`, which goes
 * through the core and reaches only the hosts the administrator approved.
 */

export interface PluginFetchInit {
  /** `GET` by default. */
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Text only; at most 1 MiB. */
  readonly body?: string;
}

export interface PluginFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * The plugin's own corner of storage (ADR 0029): keys of at most 128 characters, values that survive JSON, at most
 * 64 KiB each, at most 1000 keys and 4 MiB in all. It is the plugin's alone; no other plugin and no part of the
 * core reads it.
 */
export interface PluginStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * What a method is given. Its `secret`, `storage` and `fetch` work only while the call it was given to is under way:
 * the core does not answer a process outside a call, nor a request of a call that has ended (ADR 0050).
 */
export interface PluginContext {
  readonly pluginId: string;
  /**
   * What the administrator entered in the plugin's settings (its `config.schema`), defaults applied. Secret
   * fields are not here: ask for them with `secret`.
   */
  readonly config: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * The value of the vault secret bound to a settings field marked `x-sw-secret`. The core hands it over only if
   * the administrator approved that kind of secret for this plugin and the vault is unsealed. Do not keep it.
   */
  secret(field: string): Promise<string>;
  readonly storage: PluginStorage;
  /**
   * An HTTPS request through the core. Only `host:port` pairs listed in the manifest's `permissions.network`
   * are reachable, redirects are not followed, the answer is text of at most 4 MiB.
   */
  fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>;
}

export type PluginMethod = (params: unknown, context: PluginContext) => unknown;

export interface PluginModule {
  readonly methods: Readonly<Record<string, PluginMethod>>;
}

/** Gives a module its type: `export default definePlugin({ methods: { ... } })`. */
export const definePlugin = (module: PluginModule): PluginModule => module;

/** Limits that hold for every call, whatever the plugin says (ADR 0028). */
export const PLUGIN_LIMITS = {
  /** A request body a plugin may send through the core. */
  requestBytes: 1024 * 1024,
  /** A response the core hands back. */
  responseBytes: 4 * 1024 * 1024,
  /** Requests a plugin may have in flight through the core. */
  concurrentFetches: 4,
  /** Calls a plugin may have in flight. */
  concurrentCalls: 8,
  /** Requests to the core (network, secret, storage) a plugin process may have answered at once. */
  concurrentCoreRequests: 8,
  /** Requests to the core one call may make in all; the core answers a process only during a call. */
  coreRequestsPerCall: 256,
  storageKeyChars: 128,
  storageValueBytes: 64 * 1024,
  storageKeys: 1000,
  storageBytes: 4 * 1024 * 1024,
} as const;
