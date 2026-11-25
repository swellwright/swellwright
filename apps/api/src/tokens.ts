export const CONFIG = Symbol('CONFIG');
/** The shared `Database` of the process, or `undefined` when no database URL is configured. */
export const DATABASE = Symbol('DATABASE');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const SECRET_BOX = Symbol('SECRET_BOX');
/** The Argon2id cost for a new vault passphrase. */
export const VAULT_KDF = Symbol('VAULT_KDF');
/** The core's door for plugin requests (ADR 0028); tests replace it. */
export const PLUGIN_NETWORK = Symbol('PLUGIN_NETWORK');
/**
 * The clock of the process, in milliseconds since the epoch: the update check and the expiry of secrets read it. Tests
 * move it instead of waiting (`AppOptions.clock`).
 */
export const CLOCK = Symbol('CLOCK');
/** The clock of the panel snapshots (their time, the job's interval, the retention by day), in milliseconds since the epoch. */
export const SNAPSHOT_CLOCK = Symbol('SNAPSHOT_CLOCK');
/** The clock of the baseline checks' schedule (when a server is due), in milliseconds since the epoch. */
export const CHECKS_CLOCK = Symbol('CHECKS_CLOCK');
/** The question the reconciliation asks of DNS (ADR 0044); tests replace it so that no real name is looked up. */
export const DNS_QUERY = Symbol('DNS_QUERY');
/** The store of the run engine over PostgreSQL, or `undefined` when no database is configured (ADR 0048). */
export const RUN_STORE = Symbol('RUN_STORE');
/** The steps and the workflows this build knows; empty until a workflow is decided and written. Tests put their own in. */
export const ENGINE_CATALOGUE = Symbol('ENGINE_CATALOGUE');
/** The ports the steps are given (`EnginePorts`), built once for the process from what the API already has. */
export const ENGINE_PORTS = Symbol('ENGINE_PORTS');
/** What a test may change about the loop of the engine (`EngineTuning`); the production values come from the configuration. */
export const ENGINE_TUNING = Symbol('ENGINE_TUNING');
