import {
  type AcceptHostKeyRequest,
  type AcceptInvitationRequest,
  type AccessVerification,
  AccessVerificationSchema,
  type ArtifactList,
  ArtifactListSchema,
  type ArtifactPushResult,
  ArtifactPushResultSchema,
  type ArtifactVerification,
  ArtifactVerificationSchema,
  type PushArtifactRequest,
  type ServerArtifactList,
  ServerArtifactListSchema,
  type AuditCheckpoint,
  AuditCheckpointSchema,
  type AuditCheckpointVerification,
  AuditCheckpointVerificationSchema,
  type AuditExport,
  type AuditExportQuery,
  AuditExportSchema,
  type AuditPage,
  AuditPageSchema,
  type AuditQuery,
  ApiErrorSchema,
  type ChainVerification,
  ChainVerificationSchema,
  type ChangePasswordRequest,
  type CreateUserRequest,
  type Elevation,
  ElevationSchema,
  type ErrorCode,
  type HealthResponse,
  HealthResponseSchema,
  type LoginRequest,
  type ConnectPanelRequest,
  type ConnectPanelWithTokenRequest,
  type PanelConfigProfileAnswer,
  PanelConfigProfileAnswerSchema,
  type PanelConsoleCatalogue,
  PanelConsoleCatalogueSchema,
  type PanelConsoleOperationDetail,
  PanelConsoleOperationDetailSchema,
  type PanelConsoleRequest,
  type PanelConsoleResult,
  PanelConsoleResultSchema,
  type PanelConfigProfileList,
  PanelConfigProfileListSchema,
  type PanelConnectionView,
  PanelConnectionViewSchema,
  type PanelExternalSquadList,
  PanelExternalSquadListSchema,
  type PanelHostList,
  PanelHostListSchema,
  type PanelInfraAnswer,
  PanelInfraAnswerSchema,
  type PanelInternalSquadList,
  PanelInternalSquadListSchema,
  type PanelNodeList,
  PanelNodeListSchema,
  type PanelNodePluginList,
  PanelNodePluginListSchema,
  type PanelOverview,
  PanelOverviewSchema,
  type PanelDiff,
  PanelDiffSchema,
  type PanelSnapshotList,
  PanelSnapshotListSchema,
  type PanelSnapshotListQuery,
  type PanelSnapshotSummary,
  PanelSnapshotSummarySchema,
  type PanelSnippetList,
  PanelSnippetListSchema,
  type PanelSubscriptionSettingsAnswer,
  PanelSubscriptionSettingsAnswerSchema,
  type PanelSubscriptionTemplateList,
  PanelSubscriptionTemplateListSchema,
  type PanelTestResult,
  PanelTestResultSchema,
  type PendingSession,
  PendingSessionSchema,
  type PluginConfigView,
  PluginConfigViewSchema,
  type PluginList,
  PluginListSchema,
  type PluginSidecarFragment,
  PluginSidecarFragmentSchema,
  type PluginView,
  PluginViewSchema,
  type AddAccessRequest,
  type CommandOutputPage,
  CommandOutputPageSchema,
  type CommandOutputQuery,
  type CommandRunList,
  CommandRunListSchema,
  type CommandRunListQuery,
  type CommandRunView,
  CommandRunViewSchema,
  type CreateCommandRunRequest,
  type CreateScriptRequest,
  type CreateServerRequest,
  type HostKeyAccepted,
  HostKeyAcceptedSchema,
  type HostKeyScan,
  HostKeyScanSchema,
  type PinHostKeyRequest,
  type ReadyResponse,
  ReadyResponseSchema,
  type ScriptList,
  ScriptListSchema,
  type ScriptView,
  ScriptViewSchema,
  type UpdateScriptRequest,
  type ServerAccess,
  ServerAccessSchema,
  type ServerFactsRecord,
  ServerFactsRecordSchema,
  type ServerHostKey,
  ServerHostKeySchema,
  type ServerList,
  type ServerListQuery,
  ServerListSchema,
  type ServerView,
  ServerViewSchema,
  type UpdateAccessRequest,
  type UpdateServerRequest,
  type UpdatesResponse,
  UpdatesResponseSchema,
  type RoleCatalog,
  RoleCatalogSchema,
  type SessionInfo,
  SessionInfoSchema,
  type SessionList,
  type SessionListQuery,
  SessionListSchema,
  type SessionsRevoked,
  SessionsRevokedSchema,
  type SetupOwnerRequest,
  type SetupStatus,
  SetupStatusSchema,
  type TotpConfirmed,
  TotpConfirmedSchema,
  type TotpEnrollment,
  TotpEnrollmentSchema,
  type CreatedToken,
  CreatedTokenSchema,
  type CreateTokenInput,
  type ChangeVaultPassphraseRequest,
  type ConfirmPassphraseRequest,
  type CreateSecretRequest,
  type InitializeVaultRequest,
  type RevealedSecret,
  RevealedSecretSchema,
  type SecretList,
  SecretListSchema,
  type SecretView,
  SecretViewSchema,
  type TokenList,
  type TokenListQuery,
  TokenListSchema,
  type UnsealVaultRequest,
  type UpdateSecretRequest,
  type UpdatePluginConfigRequest,
  type UpdatePreferencesRequest,
  type UpdateUserRequest,
  type UserInvitation,
  UserInvitationSchema,
  type UserList,
  type UserListQuery,
  UserListSchema,
  type UserSummary,
  UserSummarySchema,
  type UserView,
  UserViewSchema,
  type VaultInitialized,
  VaultInitializedSchema,
  type VaultStatus,
  VaultStatusSchema,
  type VaultRotated,
  VaultRotatedSchema,
  type VersionResponse,
  VersionResponseSchema,
} from '@swellwright/contracts';

import { reportApiReachable, reportApiUnreachable } from './shell/connection-status.js';

const BASE = '/api/v1';

export class ApiUnreachableError extends Error {
  constructor() {
    super('The API did not answer.');
  }
}

/** The person was asked to confirm with a code (step-up) and closed the dialog instead. */
export class StepUpCancelledError extends Error {
  constructor() {
    super('The confirmation was cancelled.');
  }
}

/** The API answered with the documented error envelope. Branch on `code`, never on the message. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'unknown',
    message: string,
    readonly retryAfterSeconds: number | undefined,
    /** Structured details some errors carry (the two fingerprints of a host key that changed). */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Reads a JSON body and checks it against the contract, so a drifting server fails loudly. */
async function getJson<T>(path: string, schema: { parse: (data: unknown) => T }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  } catch {
    reportApiUnreachable();
    throw new ApiUnreachableError();
  }
  // A body that is not JSON (a proxy error page, an empty 502) means the API is not behind this address.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    reportApiUnreachable();
    throw new ApiUnreachableError();
  }
  reportApiReachable();
  // /ready answers 503 with the same body shape; any other mismatch fails the schema below.
  return schema.parse(body);
}

/**
 * A call that can fail with the error envelope. The session cookie travels by itself (same origin).
 * `schema` is undefined for a response without a body.
 */
export async function send<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  schema: { parse: (data: unknown) => T } | undefined,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    reportApiUnreachable();
    throw new ApiUnreachableError();
  }
  if (response.status === 204) {
    reportApiReachable();
    return undefined as T;
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    reportApiUnreachable();
    throw new ApiUnreachableError();
  }
  reportApiReachable();
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiUnreachableError();
    }
    const retry = Number(response.headers.get('retry-after'));
    throw new ApiRequestError(
      response.status,
      parsed.data.error.code,
      parsed.data.error.message,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
      parsed.data.error.details,
    );
  }
  if (!schema) {
    return undefined as T;
  }
  return schema.parse(json);
}

export interface SystemStatus {
  health: HealthResponse;
  ready: ReadyResponse;
  version: VersionResponse;
}

export async function loadSystemStatus(): Promise<SystemStatus> {
  const [health, ready, version] = await Promise.all([
    getJson('/health', HealthResponseSchema),
    getJson('/ready', ReadyResponseSchema),
    getJson('/version', VersionResponseSchema),
  ]);
  return { health, ready, version };
}

/** What this build is (the number, the build and the commit). Public, like the rest of the system documents. */
export const getVersion = (): Promise<VersionResponse> =>
  getJson('/version', VersionResponseSchema);

/** The newest release and the stars of the project, read from GitHub by the server (signed in). */
export const getUpdates = (): Promise<UpdatesResponse> =>
  send('GET', '/updates', undefined, UpdatesResponseSchema);

export const getSetupStatus = (): Promise<SetupStatus> =>
  send('GET', '/setup/status', undefined, SetupStatusSchema);

export const createOwner = (request: SetupOwnerRequest): Promise<PendingSession> =>
  send('POST', '/setup/owner', request, PendingSessionSchema);

export const login = (request: LoginRequest): Promise<PendingSession> =>
  send('POST', '/auth/login', request, PendingSessionSchema);

export const verifyTotp = (code: string): Promise<SessionInfo> =>
  send('POST', '/auth/totp', { code }, SessionInfoSchema);

export const startTotpEnrollment = (): Promise<TotpEnrollment> =>
  send('POST', '/auth/totp/enrollment', undefined, TotpEnrollmentSchema);

export const confirmTotpEnrollment = (code: string): Promise<TotpConfirmed> =>
  send('POST', '/auth/totp/confirm', { code }, TotpConfirmedSchema);

export const logout = (): Promise<void> => send('POST', '/auth/logout', undefined, undefined);

export const getVaultStatus = (): Promise<VaultStatus> =>
  send('GET', '/vault/status', undefined, VaultStatusSchema);

export const initializeVault = (request: InitializeVaultRequest): Promise<VaultInitialized> =>
  send('POST', '/vault/initialize', request, VaultInitializedSchema);

export const unsealVault = (request: UnsealVaultRequest): Promise<VaultStatus> =>
  send('POST', '/vault/unseal', request, VaultStatusSchema);

export const sealVault = (): Promise<VaultStatus> =>
  send('POST', '/vault/seal', undefined, VaultStatusSchema);

/** Works while the vault is sealed; a wrong current passphrase answers 401 (`unauthorized`). */
export const changeVaultPassphrase = (
  request: ChangeVaultPassphraseRequest,
): Promise<VaultStatus> => send('POST', '/vault/passphrase', request, VaultStatusSchema);

/** A new recovery key, shown once; the old one stops working at once. */
export const rotateRecoveryKey = (request: ConfirmPassphraseRequest): Promise<VaultInitialized> =>
  send('POST', '/vault/recovery-key/rotate', request, VaultInitializedSchema);

/** Needs the vault open (423 `vault_sealed` otherwise). Issues a new recovery key as well. */
export const rotateKek = (request: ConfirmPassphraseRequest): Promise<VaultInitialized> =>
  send('POST', '/vault/rotate-kek', request, VaultInitializedSchema);

/** Needs the vault open. Every secret is encrypted again under a fresh data key. */
export const rotateDataKeys = (): Promise<VaultRotated> =>
  send('POST', '/vault/rotate-data-keys', undefined, VaultRotatedSchema);

export const listSecrets = (): Promise<SecretList> =>
  send('GET', '/secrets', undefined, SecretListSchema);

export const createSecret = (request: CreateSecretRequest): Promise<SecretView> =>
  send('POST', '/secrets', request, SecretViewSchema);

export const updateSecret = (id: string, request: UpdateSecretRequest): Promise<SecretView> =>
  send('PATCH', `/secrets/${id}`, request, SecretViewSchema);

export const deleteSecret = (id: string): Promise<void> =>
  send('DELETE', `/secrets/${id}`, undefined, undefined);

export const revealSecret = (id: string): Promise<RevealedSecret> =>
  send('POST', `/secrets/${id}/reveal`, undefined, RevealedSecretSchema);

export const stepUp = (code: string): Promise<Elevation> =>
  send('POST', '/auth/step-up', { code }, ElevationSchema);

export const acceptInvitation = (request: AcceptInvitationRequest): Promise<PendingSession> =>
  send('POST', '/auth/invitations/accept', request, PendingSessionSchema);

export const changePassword = (request: ChangePasswordRequest): Promise<void> =>
  send('POST', '/auth/password', request, undefined);

export const listUsers = (query: UserListQuery): Promise<UserList> =>
  send('GET', `/users${queryString(query)}`, undefined, UserListSchema);

export const createUser = (request: CreateUserRequest): Promise<UserInvitation> =>
  send('POST', '/users', request, UserInvitationSchema);

export const updateUser = (id: string, request: UpdateUserRequest): Promise<UserView> =>
  send('PATCH', `/users/${id}`, request, UserViewSchema);

export const resetCredentials = (id: string): Promise<UserInvitation> =>
  send('POST', `/users/${id}/reset-credentials`, undefined, UserInvitationSchema);

/** Removes a disabled account for good (`users:write`, needs a fresh confirmation with a code). Its history stays in the audit log. */
export const deleteUser = (id: string): Promise<void> =>
  send('DELETE', `/users/${id}`, undefined, undefined);

/** Saves your language on the account so it follows you to other browsers; `null` follows the browser again. */
export const updatePreferences = (
  language: UpdatePreferencesRequest['language'],
): Promise<UserSummary> => send('PATCH', '/auth/preferences', { language }, UserSummarySchema);

export const getRoles = (): Promise<RoleCatalog> =>
  send('GET', '/roles', undefined, RoleCatalogSchema);

/** The signed-in sessions of your own account; `current` marks the one making the call. */
export const listMySessions = (): Promise<SessionList> =>
  send('GET', '/auth/sessions', undefined, SessionListSchema);

/** Ends another session of your own account. Ending the one in use is refused (409). */
export const revokeMySession = (id: string): Promise<void> =>
  send('DELETE', `/auth/sessions/${id}`, undefined, undefined);

/** Ends every session of your account except the one in use. */
export const revokeOtherSessions = (): Promise<SessionsRevoked> =>
  send('POST', '/auth/sessions/revoke-others', undefined, SessionsRevokedSchema);

/** The signed-in sessions of every user, or of one (`sessions:read`). */
export const listSessions = (query: SessionListQuery): Promise<SessionList> =>
  send('GET', `/sessions${queryString(query)}`, undefined, SessionListSchema);

/** Ends a session of any user (`sessions:revoke`, needs a fresh confirmation with a code). */
export const revokeSession = (id: string): Promise<void> =>
  send('DELETE', `/sessions/${id}`, undefined, undefined);

/** Ends every session of a user (`sessions:revoke`, needs a fresh confirmation with a code). */
export const revokeUserSessions = (id: string): Promise<SessionsRevoked> =>
  send('POST', `/users/${id}/sessions/revoke`, undefined, SessionsRevokedSchema);

/** Your own API tokens: active, expired and revoked ones, never their values. */
export const listMyTokens = (): Promise<TokenList> =>
  send('GET', '/auth/tokens', undefined, TokenListSchema);

/** Revokes one of your own tokens. Revoking one that is already revoked is not an error. */
export const revokeMyToken = (id: string): Promise<void> =>
  send('DELETE', `/auth/tokens/${id}`, undefined, undefined);

/** Creates a token in your name (`tokens:create`, needs a fresh confirmation with a code). The value comes back once. */
export const createToken = (request: CreateTokenInput): Promise<CreatedToken> =>
  send('POST', '/tokens', request, CreatedTokenSchema);

/** The API tokens of every user, or of one (`tokens:read`). */
export const listTokens = (query: TokenListQuery): Promise<TokenList> =>
  send('GET', `/tokens${queryString(query)}`, undefined, TokenListSchema);

/** Revokes a token of any user (`tokens:revoke`, needs a fresh confirmation with a code). */
export const revokeToken = (id: string): Promise<void> =>
  send('DELETE', `/tokens/${id}`, undefined, undefined);

/** `?a=1&b=2` from the values that are set, or nothing. */
function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const listAudit = (query: AuditQuery): Promise<AuditPage> =>
  send('GET', `/audit${queryString(query)}`, undefined, AuditPageSchema);

export const verifyAuditChain = (): Promise<ChainVerification> =>
  send('POST', '/audit/verify-chain', undefined, ChainVerificationSchema);

/** One page of the log for the export file, oldest first (`audit:export`, needs a fresh confirmation with a code). */
export const exportAudit = (query: AuditExportQuery): Promise<AuditExport> =>
  send('GET', `/audit/export${queryString(query)}`, undefined, AuditExportSchema);

/** The head of the chain as signed text, to be kept outside the database (`audit:verify`). */
export const createAuditCheckpoint = (): Promise<AuditCheckpoint> =>
  send('POST', '/audit/checkpoints', undefined, AuditCheckpointSchema);

/** Checks the log against a checkpoint noted earlier. A failed check is an answer (`ok: false`), not an error. */
export const verifyAuditCheckpoint = (checkpoint: string): Promise<AuditCheckpointVerification> =>
  send('POST', '/audit/checkpoints/verify', { checkpoint }, AuditCheckpointVerificationSchema);

/** The plugins found in the configured directories, and where each stands (`plugins:read`). */
export const listPlugins = (): Promise<PluginList> =>
  send('GET', '/plugins', undefined, PluginListSchema);

/**
 * Enables a plugin (`plugins:manage`, needs a fresh confirmation with a code). `digest` is the one the person was
 * shown: if the files differ now, the server refuses with 409 rather than approve something nobody looked at.
 */
export const enablePlugin = (id: string, digest: string): Promise<PluginView> =>
  send('POST', `/plugins/${id}/enable`, { digest }, PluginViewSchema);

/** Disables a plugin (`plugins:manage`, needs a fresh confirmation with a code). Its approval stays on record. */
export const disablePlugin = (id: string): Promise<PluginView> =>
  send('POST', `/plugins/${id}/disable`, undefined, PluginViewSchema);

/**
 * Starts an enabled plugin in its restricted process and loads its modules (`plugins:manage`, needs a fresh
 * confirmation with a code). A plugin that fails to load is an answer (`runtime.state` is `failed`), not an error.
 */
export const checkPlugin = (id: string): Promise<PluginView> =>
  send('POST', `/plugins/${id}/check`, undefined, PluginViewSchema);

/**
 * The settings a plugin declares and what is set now (`plugins:read`). A secret field holds the id of a vault
 * secret, never its value. 404 for a plugin that has no settings.
 */
export const getPluginConfig = (id: string): Promise<PluginConfigView> =>
  send('GET', `/plugins/${id}/config`, undefined, PluginConfigViewSchema);

/**
 * Replaces the settings of a plugin (`plugins:manage`, needs a fresh confirmation with a code). A value the server
 * does not accept is a 400 whose message names each field; nothing is stored then.
 */
export const updatePluginConfig = (
  id: string,
  values: UpdatePluginConfigRequest['values'],
): Promise<PluginConfigView> =>
  send('PUT', `/plugins/${id}/config`, { values }, PluginConfigViewSchema);

/**
 * The Docker Compose fragment that runs the container of a plugin whose code is a sidecar (`plugins:manage`, needs a
 * fresh confirmation with a code). It holds the token the container proves itself with: a secret. Swellwright never
 * starts the container; the administrator applies the file.
 */
export const getPluginSidecar = (id: string): Promise<PluginSidecarFragment> =>
  send('GET', `/plugins/${id}/sidecar`, undefined, PluginSidecarFragmentSchema);

/** The inventory (`servers:read`): every server with its counts and a summary of its facts. */
export const listServers = (query: ServerListQuery = {}): Promise<ServerList> =>
  send('GET', `/servers${queryString(query)}`, undefined, ServerListSchema);

/** One server in full: pinned host keys, access entries (secret names only) and facts. */
export const getServer = (id: string): Promise<ServerView> =>
  send('GET', `/servers/${id}`, undefined, ServerViewSchema);

export const createServer = (request: CreateServerRequest): Promise<ServerView> =>
  send('POST', '/servers', request, ServerViewSchema);

export const updateServer = (id: string, request: UpdateServerRequest): Promise<ServerView> =>
  send('PATCH', `/servers/${id}`, request, ServerViewSchema);

/** Only a draft or a retired server; any other state answers 409. */
export const deleteServer = (id: string): Promise<void> =>
  send('DELETE', `/servers/${id}`, undefined, undefined);

/** Pins a fingerprint a person checked. Pinning the same one again changes nothing. */
export const pinHostKey = (id: string, request: PinHostKeyRequest): Promise<ServerHostKey> =>
  send('POST', `/servers/${id}/host-keys`, request, ServerHostKeySchema);

export const revokeHostKey = (id: string, keyId: string): Promise<void> =>
  send('DELETE', `/servers/${id}/host-keys/${keyId}`, undefined, undefined);

/** Reads the host key the server shows, without a credential (`servers:write`). Nothing is stored. */
export const scanHostKey = (id: string): Promise<HostKeyScan> =>
  send('POST', `/servers/${id}/host-keys/scan`, undefined, HostKeyScanSchema);

/** Pins the key the person confirmed; the server is asked again and must show exactly that key. */
export const acceptHostKey = (
  id: string,
  request: AcceptHostKeyRequest,
): Promise<HostKeyAccepted> =>
  send('POST', `/servers/${id}/host-keys/accept`, request, HostKeyAcceptedSchema);

/** Logs in with one access entry and runs read-only probes. A login that does not work is a result. */
export const verifyServerAccess = (id: string, accessId: string): Promise<AccessVerification> =>
  send('POST', `/servers/${id}/access/${accessId}/verify`, undefined, AccessVerificationSchema);

/** Collects the facts of a server over SSH. */
export const refreshServerFacts = (id: string): Promise<ServerFactsRecord> =>
  send('POST', `/servers/${id}/facts/refresh`, undefined, ServerFactsRecordSchema);

export const addServerAccess = (id: string, request: AddAccessRequest): Promise<ServerAccess> =>
  send('POST', `/servers/${id}/access`, request, ServerAccessSchema);

export const updateServerAccess = (
  id: string,
  accessId: string,
  request: UpdateAccessRequest,
): Promise<ServerAccess> =>
  send('PATCH', `/servers/${id}/access/${accessId}`, request, ServerAccessSchema);

export const removeServerAccess = (id: string, accessId: string): Promise<void> =>
  send('DELETE', `/servers/${id}/access/${accessId}`, undefined, undefined);

/** The script library (`servers:read`): the built-in diagnostics and the scripts of this instance, without their text. */
export const listScripts = (): Promise<ScriptList> =>
  send('GET', '/scripts', undefined, ScriptListSchema);

export const getScript = (id: string): Promise<ScriptView> =>
  send('GET', `/scripts/${id}`, undefined, ScriptViewSchema);

/** Writing a script needs `servers:exec` and a fresh code (the caller wraps these in the step-up dialog). */
export const createScript = (request: CreateScriptRequest): Promise<ScriptView> =>
  send('POST', '/scripts', request, ScriptViewSchema);

export const updateScript = (id: string, request: UpdateScriptRequest): Promise<ScriptView> =>
  send('PATCH', `/scripts/${id}`, request, ScriptViewSchema);

export const deleteScript = (id: string): Promise<void> =>
  send('DELETE', `/scripts/${id}`, undefined, undefined);

/** Queues a run of a script or a command on one to fifty servers (`servers:exec`, needs a fresh code). */
export const createCommandRun = (request: CreateCommandRunRequest): Promise<CommandRunView> =>
  send('POST', '/command-runs', request, CommandRunViewSchema);

export const listCommandRuns = (query: CommandRunListQuery = {}): Promise<CommandRunList> =>
  send('GET', `/command-runs${queryString(query)}`, undefined, CommandRunListSchema);

/** A run with its servers and the end of the output of each. Poll it while the run is going. */
export const getCommandRun = (id: string): Promise<CommandRunView> =>
  send('GET', `/command-runs/${id}`, undefined, CommandRunViewSchema);

/** A page of what was kept of one stream of one server, by byte offset. */
export const getCommandOutput = (
  id: string,
  targetId: string,
  query: CommandOutputQuery,
): Promise<CommandOutputPage> =>
  send(
    'GET',
    `/command-runs/${id}/targets/${targetId}/output${queryString(query)}`,
    undefined,
    CommandOutputPageSchema,
  );

export const cancelCommandRun = (id: string): Promise<CommandRunView> =>
  send('POST', `/command-runs/${id}/cancel`, undefined, CommandRunViewSchema);
/** The catalogue of built-in artifacts (`servers:read`), each file checked against its manifest. */
export const listArtifacts = (): Promise<ArtifactList> =>
  send('GET', '/artifacts', undefined, ArtifactListSchema);

/** Where a file of the catalogue is downloaded from: the browser follows it, with the session cookie. */
export const artifactDownloadPath = (name: string, version: string): string =>
  `${BASE}/artifacts/${name}/versions/${version}/content`;

/** What was pushed to a server, with the last check of each copy. Never connects to the server. */
export const listServerArtifacts = (id: string): Promise<ServerArtifactList> =>
  send('GET', `/servers/${id}/artifacts`, undefined, ServerArtifactListSchema);

/** Uploads a file of the catalogue (`servers:write`); the answer says whether anything was uploaded. */
export const pushServerArtifact = (
  id: string,
  request: PushArtifactRequest,
): Promise<ArtifactPushResult> =>
  send('POST', `/servers/${id}/artifacts`, request, ArtifactPushResultSchema);

/** Hashes the copies of an artifact on the server and compares them with the catalogue. */
export const verifyServerArtifact = (
  id: string,
  name: string,
  version?: string,
): Promise<ArtifactVerification> =>
  send(
    'POST',
    `/servers/${id}/artifacts/${name}/verify${version === undefined ? '' : `?version=${version}`}`,
    undefined,
    ArtifactVerificationSchema,
  );

/** Deletes a copy from the server and forgets it. */
export const removeServerArtifact = (id: string, name: string, version: string): Promise<void> =>
  send('DELETE', `/servers/${id}/artifacts/${name}/${version}`, undefined, undefined);

/** `?refresh=true` when the person asked the panel again instead of the short memory of the server. */
const refreshQuery = (refresh: boolean): string => (refresh ? '?refresh=true' : '');

/** Where the connection to the Remnawave panel stands (`panel:read`). Never calls the panel and never carries the token. */
export const getPanelConnection = (): Promise<PanelConnectionView> =>
  send('GET', '/panel/connection', undefined, PanelConnectionViewSchema);

/** Connects with a token that is in the vault already (`panel:write`). The panel is asked first. */
export const connectPanel = (request: ConnectPanelRequest): Promise<PanelConnectionView> =>
  send('PUT', '/panel/connection', request, PanelConnectionViewSchema);

/**
 * Connects with a token that is not in the vault yet (`panel:write` and `vault:manage`, needs a fresh code): the
 * panel accepts it first, then it is sealed into the vault and the connection saved in one step.
 */
export const connectPanelWithToken = (
  request: ConnectPanelWithTokenRequest,
): Promise<PanelConnectionView> =>
  send('PUT', '/panel/connection/with-token', request, PanelConnectionViewSchema);

/** Asks the panel again and saves what it finds. A panel that does not answer is a result (`ok: false`), not an error. */
export const testPanel = (): Promise<PanelTestResult> =>
  send('POST', '/panel/connection/test', undefined, PanelTestResultSchema);

/** Forgets the connection. The token stays in the vault; nothing is changed on the panel. */
export const disconnectPanel = (): Promise<void> =>
  send('DELETE', '/panel/connection', undefined, undefined);

export const getPanelOverview = (refresh = false): Promise<PanelOverview> =>
  send('GET', `/panel/overview${refreshQuery(refresh)}`, undefined, PanelOverviewSchema);

export const listPanelNodes = (refresh = false): Promise<PanelNodeList> =>
  send('GET', `/panel/nodes${refreshQuery(refresh)}`, undefined, PanelNodeListSchema);

export const listPanelHosts = (refresh = false): Promise<PanelHostList> =>
  send('GET', `/panel/hosts${refreshQuery(refresh)}`, undefined, PanelHostListSchema);

export const listPanelConfigProfiles = (refresh = false): Promise<PanelConfigProfileList> =>
  send(
    'GET',
    `/panel/config-profiles${refreshQuery(refresh)}`,
    undefined,
    PanelConfigProfileListSchema,
  );

/** One profile with its Xray configuration, every secret in it masked. */
export const getPanelConfigProfile = (
  uuid: string,
  refresh = false,
): Promise<PanelConfigProfileAnswer> =>
  send(
    'GET',
    `/panel/config-profiles/${uuid}${refreshQuery(refresh)}`,
    undefined,
    PanelConfigProfileAnswerSchema,
  );

/** The configuration as the panel computes it for its nodes (masked too). Not kept in memory by the server. */
export const getPanelComputedConfig = (uuid: string): Promise<PanelConfigProfileAnswer> =>
  send(
    'GET',
    `/panel/config-profiles/${uuid}/computed-config`,
    undefined,
    PanelConfigProfileAnswerSchema,
  );

export const listPanelInternalSquads = (refresh = false): Promise<PanelInternalSquadList> =>
  send(
    'GET',
    `/panel/internal-squads${refreshQuery(refresh)}`,
    undefined,
    PanelInternalSquadListSchema,
  );

export const listPanelExternalSquads = (refresh = false): Promise<PanelExternalSquadList> =>
  send(
    'GET',
    `/panel/external-squads${refreshQuery(refresh)}`,
    undefined,
    PanelExternalSquadListSchema,
  );

export const listPanelSubscriptionTemplates = (
  refresh = false,
): Promise<PanelSubscriptionTemplateList> =>
  send(
    'GET',
    `/panel/subscription-templates${refreshQuery(refresh)}`,
    undefined,
    PanelSubscriptionTemplateListSchema,
  );

export const getPanelSubscriptionSettings = (
  refresh = false,
): Promise<PanelSubscriptionSettingsAnswer> =>
  send(
    'GET',
    `/panel/subscription-settings${refreshQuery(refresh)}`,
    undefined,
    PanelSubscriptionSettingsAnswerSchema,
  );

export const listPanelSnippets = (refresh = false): Promise<PanelSnippetList> =>
  send('GET', `/panel/snippets${refreshQuery(refresh)}`, undefined, PanelSnippetListSchema);

export const listPanelNodePlugins = (refresh = false): Promise<PanelNodePluginList> =>
  send('GET', `/panel/node-plugins${refreshQuery(refresh)}`, undefined, PanelNodePluginListSchema);

export const getPanelInfra = (refresh = false): Promise<PanelInfraAnswer> =>
  send('GET', `/panel/infra${refreshQuery(refresh)}`, undefined, PanelInfraAnswerSchema);

// ---- snapshots of the panel (ADR 0043) -------------------------------------------------------------------------------

/** Every operation of the panel's API, from the frozen description that ships with the server (`panel:read`). Asks nothing of the panel. */
export const listPanelConsoleOperations = (): Promise<PanelConsoleCatalogue> =>
  send('GET', '/panel/api-console/operations', undefined, PanelConsoleCatalogueSchema);

/** One operation with the schemas of its body and its answer (`panel:read`). */
export const getPanelConsoleOperation = (
  operationId: string,
): Promise<PanelConsoleOperationDetail> =>
  send(
    'GET',
    `/panel/api-console/operations/${encodeURIComponent(operationId)}`,
    undefined,
    PanelConsoleOperationDetailSchema,
  );

/** Sends one read to the connected panel and returns its answer, masked (`panel:console`; about people also needs a code). */
export const sendPanelConsoleRequest = (
  request: PanelConsoleRequest,
): Promise<PanelConsoleResult> =>
  send('POST', '/panel/api-console/requests', request, PanelConsoleResultSchema);

/** One page of the snapshots of the connected panel, newest first (`panel:read`). Never calls the panel. */
export const listPanelSnapshots = (
  query: PanelSnapshotListQuery = {},
): Promise<PanelSnapshotList> =>
  send('GET', `/panel/snapshots${queryString(query)}`, undefined, PanelSnapshotListSchema);

/** Reads the panel and keeps what it holds as a snapshot (`panel:write`). A forced read of the panel. */
export const createPanelSnapshot = (label?: string): Promise<PanelSnapshotSummary> =>
  send(
    'POST',
    '/panel/snapshots',
    label === undefined ? {} : { label },
    PanelSnapshotSummarySchema,
  );

/** Deletes a snapshot (`panel:write`, needs a fresh confirmation with a code). */
export const deletePanelSnapshot = (id: string): Promise<void> =>
  send('DELETE', `/panel/snapshots/${id}`, undefined, undefined);

/** What differs between a snapshot and the live panel (`'live'`) or another snapshot (its id). */
export const diffPanelSnapshot = (
  id: string,
  against: string,
  options: { refresh?: boolean; includeUnchanged?: boolean } = {},
): Promise<PanelDiff> =>
  send(
    'GET',
    `/panel/snapshots/${id}/diff${queryString({
      against,
      ...(options.refresh === true ? { refresh: 'true' } : {}),
      ...(options.includeUnchanged === true ? { includeUnchanged: 'true' } : {}),
    })}`,
    undefined,
    PanelDiffSchema,
  );

/** Where a snapshot is downloaded from as a JSON file: the browser follows it, with the session cookie. */
export const panelSnapshotExportPath = (id: string): string =>
  `${BASE}/panel/snapshots/${id}/export`;

/** The current session, or null when nobody is signed in. */
export async function getMe(): Promise<SessionInfo | null> {
  try {
    return await send('GET', '/auth/me', undefined, SessionInfoSchema);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      return null;
    }
    throw error;
  }
}
