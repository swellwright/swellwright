import { z } from 'zod';

import {
  ArtifactListSchema,
  ArtifactNameParamsSchema,
  ArtifactPushResultSchema,
  ArtifactVerificationSchema,
  ArtifactVersionParamsSchema,
  ArtifactVersionViewSchema,
  ArtifactViewSchema,
  PushArtifactRequestSchema,
  ServerArtifactListSchema,
  ServerArtifactParamsSchema,
  ServerArtifactVersionParamsSchema,
  VerifyArtifactQuerySchema,
} from './artifacts.js';
import {
  AuditCheckpointSchema,
  AuditCheckpointVerificationSchema,
  AuditExportQuerySchema,
  AuditExportSchema,
  AuditPageSchema,
  AuditQuerySchema,
  ChainVerificationSchema,
  VerifyAuditCheckpointRequestSchema,
} from './audit.js';
import {
  AcceptInvitationRequestSchema,
  ChangePasswordRequestSchema,
  ElevationSchema,
  LoginRequestSchema,
  PendingSessionSchema,
  SessionInfoSchema,
  SetupOwnerRequestSchema,
  SetupStatusSchema,
  TotpCodeRequestSchema,
  TotpConfirmedSchema,
  TotpEnrollmentSchema,
  UpdatePreferencesRequestSchema,
  UserSummarySchema,
} from './auth.js';
import {
  CommandOutputPageSchema,
  CommandOutputQuerySchema,
  CommandRunIdParamsSchema,
  CommandRunListQuerySchema,
  CommandRunListSchema,
  CommandRunViewSchema,
  CommandTargetParamsSchema,
  CreateCommandRunRequestSchema,
  CreateScriptRequestSchema,
  ScriptIdParamsSchema,
  ScriptListSchema,
  ScriptViewSchema,
  UpdateScriptRequestSchema,
} from './commands.js';
import { ApiErrorSchema } from './errors.js';
import {
  ConnectPanelRequestSchema,
  ConnectPanelWithTokenRequestSchema,
  PanelApiTokenListSchema,
  PanelConfigProfileAnswerSchema,
  PanelConfigProfileListSchema,
  PanelConnectionViewSchema,
  PanelExternalSquadListSchema,
  PanelHostListSchema,
  PanelInfraAnswerSchema,
  PanelInternalSquadListSchema,
  PanelNodeListSchema,
  PanelNodePluginListSchema,
  PanelOverviewSchema,
  PanelProfileParamsSchema,
  PanelReadQuerySchema,
  PanelSnippetListSchema,
  PanelSubscriptionSettingsAnswerSchema,
  PanelSubscriptionTemplateListSchema,
  PanelTestResultSchema,
} from './panel.js';
import {
  EnablePluginRequestSchema,
  PluginConfigViewSchema,
  PluginGatewayReplySchema,
  PluginGatewayRequestSchema,
  PluginIdParamsSchema,
  PluginListSchema,
  PluginSidecarFragmentSchema,
  PluginViewSchema,
  UpdatePluginConfigRequestSchema,
} from './plugins.js';
import { type Permission, RoleCatalogSchema } from './roles.js';
import {
  AcceptHostKeyRequestSchema,
  AccessParamsSchema,
  AccessVerificationSchema,
  AddAccessRequestSchema,
  CreateServerRequestSchema,
  HostKeyAcceptedSchema,
  HostKeyParamsSchema,
  HostKeyScanSchema,
  PinHostKeyRequestSchema,
  ServerAccessSchema,
  ServerFactsRecordSchema,
  ServerHostKeySchema,
  ServerIdParamsSchema,
  ServerListQuerySchema,
  ServerListSchema,
  ServerViewSchema,
  UpdateAccessRequestSchema,
  UpdateServerRequestSchema,
} from './servers.js';
import {
  SessionIdParamsSchema,
  SessionListQuerySchema,
  SessionListSchema,
  SessionsRevokedSchema,
} from './sessions.js';
import {
  HealthResponseSchema,
  ReadyResponseSchema,
  UpdatesResponseSchema,
  VersionResponseSchema,
} from './system.js';
import {
  CreatedTokenSchema,
  CreateTokenRequestSchema,
  TokenIdParamsSchema,
  TokenListQuerySchema,
  TokenListSchema,
} from './tokens.js';
import {
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  UserIdParamsSchema,
  UserInvitationSchema,
  UserListQuerySchema,
  UserListSchema,
  UserViewSchema,
} from './users.js';
import {
  ChangeVaultPassphraseRequestSchema,
  ConfirmPassphraseRequestSchema,
  CreateSecretRequestSchema,
  InitializeVaultRequestSchema,
  RevealedSecretSchema,
  SecretIdParamsSchema,
  SecretListSchema,
  SecretViewSchema,
  UnsealVaultRequestSchema,
  UpdateSecretRequestSchema,
  VaultInitializedSchema,
  VaultRotatedSchema,
  VaultStatusSchema,
} from './vault.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Who may call a route.
 * - `none`: anyone (probes, the API description, the sign-in entry points).
 * - `pending`: a session whose password was accepted and whose second step is still open.
 * - `session`: a fully signed-in session.
 * - `token`: a Swellwright API token (`Authorization: Bearer`), nothing else.
 * - `any`: a signed-in session or an API token. Never a route that needs a step-up: a token has no second factor.
 */
export type RouteAuth = 'none' | 'pending' | 'session' | 'token' | 'any';

export interface ResponseDef {
  readonly description: string;
  readonly schema: z.ZodType;
  /** The response has no body (for example 204). */
  readonly empty?: boolean;
  /**
   * The body is a file, streamed as it is: not JSON, not checked against `schema`. The headers say what else the
   * answer carries (name and description).
   */
  readonly binary?: { readonly headers: Readonly<Record<string, string>> };
}

export interface RouteDef {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Relative to the API base path (`/api/v1`), OpenAPI style: `/runs/{id}`. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description?: string;
  readonly auth: RouteAuth;
  /**
   * What the caller's role must allow (ADR 0015). Required for a signed-in route, except the few that every
   * signed-in user may call (`ROUTES_OPEN_TO_ANY_SESSION`).
   */
  readonly permission?: Permission;
  /**
   * The session must have been freshly verified with the second factor (ADR 0017); otherwise 403 with the
   * code `step_up_required`. Required for routes that hold a permission in `STEP_UP_PERMISSIONS`.
   */
  readonly stepUp?: true;
  readonly request?: {
    readonly params?: z.ZodObject<Record<string, z.ZodType>>;
    readonly query?: z.ZodObject<Record<string, z.ZodType>>;
    readonly body?: z.ZodType;
  };
  /** Successful and expected non-successful responses by HTTP status. */
  readonly responses: Readonly<Record<number, ResponseDef>>;
}

/** Keeps the literal types of a definition so handlers can be typed from it. */
export const defineRoute = <const T extends RouteDef>(route: T): T => route;

const ERROR = { description: 'Error envelope.', schema: ApiErrorSchema } as const;

export const healthRoute = defineRoute({
  operationId: 'getHealth',
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: 'Liveness probe',
  description: 'Answers while the process serves requests. It does not check dependencies.',
  auth: 'none',
  responses: { 200: { description: 'The process is alive.', schema: HealthResponseSchema } },
});

export const readyRoute = defineRoute({
  operationId: 'getReady',
  method: 'get',
  path: '/ready',
  tags: ['system'],
  summary: 'Readiness probe',
  description:
    'Checks every configured dependency. Answers 503 with the same body shape when one is down.',
  auth: 'none',
  responses: {
    200: { description: 'Every configured dependency answers.', schema: ReadyResponseSchema },
    503: { description: 'At least one dependency is down.', schema: ReadyResponseSchema },
  },
});

export const versionRoute = defineRoute({
  operationId: 'getVersion',
  method: 'get',
  path: '/version',
  tags: ['system'],
  summary: 'Build and API version',
  description:
    'The version of the running build and what the build recorded about itself: when and by which CI run it was made and the branch and revision it came from (`SW_BUILD_TIME`, `SW_BUILD_NUMBER`, `SW_GIT_BRANCH`, `SW_GIT_COMMIT`, set as build arguments of the image). What the build did not record is null. `git.commitUrl` is the page of the revision on GitHub, known when the revision is a hash.',
  auth: 'none',
  responses: { 200: { description: 'Version information.', schema: VersionResponseSchema } },
});

export const updatesRoute = defineRoute({
  operationId: 'getUpdates',
  method: 'get',
  path: '/updates',
  tags: ['system'],
  summary: 'The newest release and the project page',
  description:
    'For the version button and the project link of the console. The server asks GitHub for the latest release and the star count at most once a day and answers from its memory; the browser never calls GitHub. The request sends nothing that identifies the installation, the user or the browser. After a failed attempt the old answer is kept and the next attempt comes in an hour. The first call after the start does not wait more than a moment, so it may answer with nulls. `SW_UPDATE_CHECK=off` switches the check off: `enabled` is false and nothing is ever sent. Nothing is recorded in the audit log.',
  auth: 'any',
  responses: { 200: { description: 'What is known.', schema: UpdatesResponseSchema } },
});

export const openApiRoute = defineRoute({
  operationId: 'getOpenApi',
  method: 'get',
  path: '/openapi.json',
  tags: ['system'],
  summary: 'This API description',
  description: 'The OpenAPI 3.1 document generated from the route registry.',
  auth: 'none',
  responses: {
    200: { description: 'The OpenAPI document.', schema: z.record(z.string(), z.unknown()) },
  },
});

export const getSetupStatusRoute = defineRoute({
  operationId: 'getSetupStatus',
  method: 'get',
  path: '/setup/status',
  tags: ['setup'],
  summary: 'Whether the instance owner exists',
  description: 'Lets the console choose between the first-run setup and the sign-in page.',
  auth: 'none',
  responses: { 200: { description: 'Setup state.', schema: SetupStatusSchema } },
});

export const createOwnerRoute = defineRoute({
  operationId: 'createOwner',
  method: 'post',
  path: '/setup/owner',
  tags: ['setup'],
  summary: 'Create the instance owner',
  description:
    'Works once, with the setup token the server printed to its log at start. Starts a session that still needs the authenticator to be set up (`/auth/totp/enrollment`).',
  auth: 'none',
  request: { body: SetupOwnerRequestSchema },
  responses: {
    200: { description: 'The owner was created.', schema: PendingSessionSchema },
  },
});

export const loginRoute = defineRoute({
  operationId: 'login',
  method: 'post',
  path: '/auth/login',
  tags: ['auth'],
  summary: 'Sign in with a password',
  description:
    'The first of two steps. On success a session cookie is set that is not yet usable for anything except finishing the sign-in. Wrong credentials and unknown users answer the same 401; repeated failures lock the account for a while (429).',
  auth: 'none',
  request: { body: LoginRequestSchema },
  responses: { 200: { description: 'The password was accepted.', schema: PendingSessionSchema } },
});

export const totpRoute = defineRoute({
  operationId: 'verifyTotp',
  method: 'post',
  path: '/auth/totp',
  tags: ['auth'],
  summary: 'Finish signing in with an authenticator code or a recovery code',
  description:
    'A recovery code works once. The session cookie is replaced by a new one when the sign-in completes.',
  auth: 'pending',
  request: { body: TotpCodeRequestSchema },
  responses: { 200: { description: 'Signed in.', schema: SessionInfoSchema } },
});

export const totpEnrollmentRoute = defineRoute({
  operationId: 'startTotpEnrollment',
  method: 'post',
  path: '/auth/totp/enrollment',
  tags: ['auth'],
  summary: 'Get the authenticator secret',
  description:
    'Only before the authenticator was confirmed. Repeated calls return the same secret until it is confirmed.',
  auth: 'pending',
  responses: {
    200: { description: 'The secret to add to an authenticator.', schema: TotpEnrollmentSchema },
  },
});

export const totpConfirmRoute = defineRoute({
  operationId: 'confirmTotpEnrollment',
  method: 'post',
  path: '/auth/totp/confirm',
  tags: ['auth'],
  summary: 'Confirm the authenticator and finish signing in',
  description: 'Returns the recovery codes. They are shown once and only their hashes are kept.',
  auth: 'pending',
  request: { body: TotpCodeRequestSchema },
  responses: { 200: { description: 'Signed in.', schema: TotpConfirmedSchema } },
});

export const logoutRoute = defineRoute({
  operationId: 'logout',
  method: 'post',
  path: '/auth/logout',
  tags: ['auth'],
  summary: 'Sign out',
  description: 'Ends the current session if there is one. Always answers 204.',
  auth: 'none',
  responses: {
    204: { description: 'The session is gone.', schema: z.undefined(), empty: true },
  },
});

export const meRoute = defineRoute({
  operationId: 'getMe',
  method: 'get',
  path: '/auth/me',
  tags: ['auth'],
  summary: 'The signed-in user',
  auth: 'any',
  responses: { 200: { description: 'The current session.', schema: SessionInfoSchema } },
});

export const stepUpRoute = defineRoute({
  operationId: 'stepUp',
  method: 'post',
  path: '/auth/step-up',
  tags: ['auth'],
  summary: 'Prove the second factor again to elevate the session',
  description:
    'Takes a code from the authenticator or a recovery code. For a short time afterwards the session may call the routes marked `x-sw-step-up`; they answer 403 `step_up_required` before that. A wrong code counts towards the lockout like a wrong code at sign-in. Signing in elevates the session already.',
  auth: 'session',
  request: { body: TotpCodeRequestSchema },
  responses: { 200: { description: 'The session is elevated.', schema: ElevationSchema } },
});

export const acceptInvitationRoute = defineRoute({
  operationId: 'acceptInvitation',
  method: 'post',
  path: '/auth/invitations/accept',
  tags: ['auth'],
  summary: 'Choose a password with an invitation token',
  description:
    'For a new user or one whose credentials were reset. The token is used up. Starts a session that still needs the authenticator to be set up (`/auth/totp/enrollment`). An unknown, used or expired token answers 401.',
  auth: 'none',
  request: { body: AcceptInvitationRequestSchema },
  responses: { 200: { description: 'The password was set.', schema: PendingSessionSchema } },
});

export const changePasswordRoute = defineRoute({
  operationId: 'changePassword',
  method: 'post',
  path: '/auth/password',
  tags: ['auth'],
  summary: 'Change your own password',
  description:
    'Needs the current password and an elevated session. Ends your other sessions and keeps this one. A wrong current password counts towards the lockout.',
  auth: 'session',
  stepUp: true,
  request: { body: ChangePasswordRequestSchema },
  responses: {
    204: { description: 'The password was changed.', schema: z.undefined(), empty: true },
  },
});

export const listUsersRoute = defineRoute({
  operationId: 'listUsers',
  method: 'get',
  path: '/users',
  tags: ['users'],
  summary: 'List the users',
  auth: 'any',
  permission: 'users:read',
  request: { query: UserListQuerySchema },
  responses: { 200: { description: 'One page of users.', schema: UserListSchema } },
});

export const createUserRoute = defineRoute({
  operationId: 'createUser',
  method: 'post',
  path: '/users',
  tags: ['users'],
  summary: 'Invite a user',
  description:
    'Creates the account without a password and returns an invitation. The token is shown once. A taken login name or e-mail address answers 409.',
  auth: 'session',
  permission: 'users:write',
  stepUp: true,
  request: { body: CreateUserRequestSchema },
  responses: { 201: { description: 'The user and the invitation.', schema: UserInvitationSchema } },
});

export const updateUserRoute = defineRoute({
  operationId: 'updateUser',
  method: 'patch',
  path: '/users/{id}',
  tags: ['users'],
  summary: 'Change a user',
  description:
    'Role, status, display name and e-mail address. Refused with 409 when it would leave the instance without an active owner, or when you change your own role or status. Disabling a user ends their sessions.',
  auth: 'session',
  permission: 'users:write',
  stepUp: true,
  request: { params: UserIdParamsSchema, body: UpdateUserRequestSchema },
  responses: { 200: { description: 'The user after the change.', schema: UserViewSchema } },
});

export const deleteUserRoute = defineRoute({
  operationId: 'deleteUser',
  method: 'delete',
  path: '/users/{id}',
  tags: ['users'],
  summary: 'Delete a disabled user',
  description:
    'Removes the account with its password, authenticator, recovery codes, sessions, tokens and open invitation. Cannot be undone. Only a disabled account can be deleted (409 otherwise), and never your own (409). What the account did stays in the audit log under the name it had.',
  auth: 'session',
  permission: 'users:write',
  stepUp: true,
  request: { params: UserIdParamsSchema },
  responses: { 204: { description: 'The user is gone.', schema: z.undefined(), empty: true } },
});

export const updatePreferencesRoute = defineRoute({
  operationId: 'updatePreferences',
  method: 'patch',
  path: '/auth/preferences',
  tags: ['auth'],
  summary: 'Change your own preferences',
  description:
    'The language the console uses for you after you sign in, on any browser. `null` goes back to following the browser.',
  auth: 'session',
  request: { body: UpdatePreferencesRequestSchema },
  responses: { 200: { description: 'You, after the change.', schema: UserSummarySchema } },
});

export const resetCredentialsRoute = defineRoute({
  operationId: 'resetCredentials',
  method: 'post',
  path: '/users/{id}/reset-credentials',
  tags: ['users'],
  summary: 'Reset the password and the authenticator of a user',
  description:
    'Deletes the password, the authenticator and the recovery codes, ends every session of the user at once, and returns a new invitation. The user cannot sign in until it is accepted. Refused with 409 when you reset your own account (change your password instead).',
  auth: 'session',
  permission: 'users:write',
  stepUp: true,
  request: { params: UserIdParamsSchema },
  responses: {
    200: { description: 'The user and a new invitation.', schema: UserInvitationSchema },
  },
});

export const vaultStatusRoute = defineRoute({
  operationId: 'getVaultStatus',
  method: 'get',
  path: '/vault/status',
  tags: ['vault'],
  summary: 'Whether the vault exists and is open',
  description: 'Also the number of secrets. Works while the vault is sealed.',
  auth: 'any',
  permission: 'vault:read',
  responses: { 200: { description: 'The status.', schema: VaultStatusSchema } },
});

export const initializeVaultRoute = defineRoute({
  operationId: 'initializeVault',
  method: 'post',
  path: '/vault/initialize',
  tags: ['vault'],
  summary: 'Set the vault up',
  description:
    'Once. Makes the key, wraps it under the passphrase and under a recovery key, and leaves the vault open. The recovery key is in the answer and nowhere else: it is the only way back in when the passphrase is lost. Answers 409 when a vault exists.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { body: InitializeVaultRequestSchema },
  responses: {
    201: { description: 'The vault and its recovery key.', schema: VaultInitializedSchema },
  },
});

export const unsealVaultRoute = defineRoute({
  operationId: 'unsealVault',
  method: 'post',
  path: '/vault/unseal',
  tags: ['vault'],
  summary: 'Open the vault with the passphrase or the recovery key',
  description:
    'A wrong passphrase or key answers 401 and is recorded; ten failures in fifteen minutes answer 429 for everyone.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { body: UnsealVaultRequestSchema },
  responses: { 200: { description: 'The vault is open.', schema: VaultStatusSchema } },
});

export const sealVaultRoute = defineRoute({
  operationId: 'sealVault',
  method: 'post',
  path: '/vault/seal',
  tags: ['vault'],
  summary: 'Close the vault',
  description:
    'Wipes the key from memory. Nothing that needs a secret works until it is opened again.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  responses: { 200: { description: 'The vault is sealed.', schema: VaultStatusSchema } },
});

export const listSecretsRoute = defineRoute({
  operationId: 'listSecrets',
  method: 'get',
  path: '/secrets',
  tags: ['vault'],
  summary: 'List the secrets, without their values',
  description: 'Works while the vault is sealed: names, types and dates are not secret. `expired` and `expiresInDays` are worked out by the server clock.',
  auth: 'any',
  permission: 'vault:read',
  responses: { 200: { description: 'The secrets.', schema: SecretListSchema } },
});

export const createSecretRoute = defineRoute({
  operationId: 'createSecret',
  method: 'post',
  path: '/secrets',
  tags: ['vault'],
  summary: 'Store a secret',
  description:
    'The vault must be open (423 `vault_sealed` otherwise). The value is encrypted with a key of its own and is write-only from now on. A taken name answers 409.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { body: CreateSecretRequestSchema },
  responses: { 201: { description: 'The secret, without its value.', schema: SecretViewSchema } },
});

export const updateSecretRoute = defineRoute({
  operationId: 'updateSecret',
  method: 'patch',
  path: '/secrets/{id}',
  tags: ['vault'],
  summary: 'Rename a secret, change its details or replace its value',
  description:
    'A new `value` needs the vault open and moves the version forward; the old value is not kept. Renaming and the details work while sealed. Setting a later `expiresAt` renews an expired secret; setting `null` removes the expiry.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { params: SecretIdParamsSchema, body: UpdateSecretRequestSchema },
  responses: { 200: { description: 'The secret after the change.', schema: SecretViewSchema } },
});

export const deleteSecretRoute = defineRoute({
  operationId: 'deleteSecret',
  method: 'delete',
  path: '/secrets/{id}',
  tags: ['vault'],
  summary: 'Delete a secret',
  description:
    'Works while the vault is sealed. Cannot be undone. A secret that a server uses for its login or for sudo cannot be deleted: 409, naming the servers.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { params: SecretIdParamsSchema },
  responses: { 204: { description: 'The secret is gone.', schema: z.undefined(), empty: true } },
});

export const revealSecretRoute = defineRoute({
  operationId: 'revealSecret',
  method: 'post',
  path: '/secrets/{id}/reveal',
  tags: ['vault'],
  summary: 'Show the value of a secret',
  description:
    'The only way a value leaves the vault. Needs the vault open, the reveal permission and a fresh second factor, and is recorded before the value is sent. An expired secret can still be revealed (to read it and rotate it); the answer says `expired: true`.',
  auth: 'session',
  permission: 'vault:reveal',
  stepUp: true,
  request: { params: SecretIdParamsSchema },
  responses: { 200: { description: 'The value.', schema: RevealedSecretSchema } },
});

export const changeVaultPassphraseRoute = defineRoute({
  operationId: 'changeVaultPassphrase',
  method: 'post',
  path: '/vault/passphrase',
  tags: ['vault'],
  summary: 'Change the passphrase of the vault',
  description:
    'Needs the current passphrase. The key that encrypts the secrets does not change, only the way the passphrase wraps it: nothing is re-encrypted, the recovery key stays valid, and the new passphrase is hardened with the current cost settings. Works while the vault is sealed. A wrong current passphrase answers 401 and counts towards the unseal limit.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { body: ChangeVaultPassphraseRequestSchema },
  responses: { 200: { description: 'The vault.', schema: VaultStatusSchema } },
});

export const rotateRecoveryKeyRoute = defineRoute({
  operationId: 'rotateRecoveryKey',
  method: 'post',
  path: '/vault/recovery-key/rotate',
  tags: ['vault'],
  summary: 'Issue a new recovery key',
  description:
    'Needs the passphrase. The old recovery key stops working at once; the new one is in the answer and nowhere else, so keep it away from this server. Nothing is re-encrypted.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { body: ConfirmPassphraseRequestSchema },
  responses: { 200: { description: 'The new recovery key.', schema: VaultInitializedSchema } },
});

export const rotateKekRoute = defineRoute({
  operationId: 'rotateKek',
  method: 'post',
  path: '/vault/rotate-kek',
  tags: ['vault'],
  summary: 'Replace the key that wraps every data key',
  description:
    'Needs the vault open and the passphrase. A new key-encryption key wraps every data key (the values are not re-encrypted), the key version moves forward, and a new recovery key is issued because the old one opened the old key. All or nothing: a failure leaves the vault as it was.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  request: { body: ConfirmPassphraseRequestSchema },
  responses: {
    200: { description: 'The new recovery key and the vault.', schema: VaultInitializedSchema },
  },
});

export const rotateDataKeysRoute = defineRoute({
  operationId: 'rotateDataKeys',
  method: 'post',
  path: '/vault/rotate-data-keys',
  tags: ['vault'],
  summary: 'Encrypt every secret under a fresh data key',
  description:
    'Needs the vault open. Every current value is decrypted in memory and encrypted again under a new data key wrapped by the current key. Versions and values do not change. All or nothing.',
  auth: 'session',
  permission: 'vault:manage',
  stepUp: true,
  responses: {
    200: { description: 'How many secrets were re-encrypted.', schema: VaultRotatedSchema },
  },
});

export const rolesRoute = defineRoute({
  operationId: 'getRoles',
  method: 'get',
  path: '/roles',
  tags: ['roles'],
  summary: 'The roles and the permission catalogue',
  description:
    'The built-in roles with the permissions each holds, and every permission with its meaning.',
  auth: 'any',
  permission: 'roles:read',
  responses: { 200: { description: 'The catalogue.', schema: RoleCatalogSchema } },
});

export const listAuditRoute = defineRoute({
  operationId: 'listAudit',
  method: 'get',
  path: '/audit',
  tags: ['audit'],
  summary: 'Read the audit log',
  description:
    'Newest first. Page back with `cursor`, or by page number with `offset`; `total` counts what the filters match. Filters combine.',
  auth: 'any',
  permission: 'audit:read',
  request: { query: AuditQuerySchema },
  responses: { 200: { description: 'One page of events.', schema: AuditPageSchema } },
});

export const verifyAuditChainRoute = defineRoute({
  operationId: 'verifyAuditChain',
  method: 'post',
  path: '/audit/verify-chain',
  tags: ['audit'],
  summary: 'Verify the integrity of the audit chain',
  description:
    'Reads the whole log and checks the numbering, every link and every hash. The run is itself recorded. A broken chain is a normal answer (`ok: false`), not an error.',
  auth: 'any',
  permission: 'audit:verify',
  responses: { 200: { description: 'The result.', schema: ChainVerificationSchema } },
});

export const listMySessionsRoute = defineRoute({
  operationId: 'listMySessions',
  method: 'get',
  path: '/auth/sessions',
  tags: ['sessions'],
  summary: 'The signed-in sessions of your account',
  description: 'Every active session of the caller, the current one marked.',
  auth: 'session',
  responses: { 200: { description: 'Your sessions.', schema: SessionListSchema } },
});

export const revokeMySessionRoute = defineRoute({
  operationId: 'revokeMySession',
  method: 'delete',
  path: '/auth/sessions/{id}',
  tags: ['sessions'],
  summary: 'End one of your sessions',
  description:
    'Ends another session of your own account at once. The session you are using cannot be ended here (409): sign out instead. A session that is not yours is reported as not found.',
  auth: 'session',
  request: { params: SessionIdParamsSchema },
  responses: { 204: { description: 'The session is gone.', schema: z.undefined(), empty: true } },
});

export const revokeOtherSessionsRoute = defineRoute({
  operationId: 'revokeOtherSessions',
  method: 'post',
  path: '/auth/sessions/revoke-others',
  tags: ['sessions'],
  summary: 'End all your other sessions',
  description: 'Keeps the session you are using and ends every other session of your account.',
  auth: 'session',
  responses: { 200: { description: 'How many were ended.', schema: SessionsRevokedSchema } },
});

export const listSessionsRoute = defineRoute({
  operationId: 'listSessions',
  method: 'get',
  path: '/sessions',
  tags: ['sessions'],
  summary: 'The signed-in sessions of every user',
  description: 'Active sessions, most recently used first. Filter by user with `userId`.',
  auth: 'any',
  permission: 'sessions:read',
  request: { query: SessionListQuerySchema },
  responses: { 200: { description: 'The sessions.', schema: SessionListSchema } },
});

export const revokeSessionRoute = defineRoute({
  operationId: 'revokeSession',
  method: 'delete',
  path: '/sessions/{id}',
  tags: ['sessions'],
  summary: 'End a session of any user',
  description:
    'Ends the session at once and records it. The session you are using cannot be ended here (409).',
  auth: 'session',
  permission: 'sessions:revoke',
  stepUp: true,
  request: { params: SessionIdParamsSchema },
  responses: { 204: { description: 'The session is gone.', schema: z.undefined(), empty: true } },
});

export const revokeUserSessionsRoute = defineRoute({
  operationId: 'revokeUserSessions',
  method: 'post',
  path: '/users/{id}/sessions/revoke',
  tags: ['sessions'],
  summary: 'End every session of a user',
  description:
    'Ends all sessions of the user at once, for example after a suspected theft of a cookie. Refused with 409 for your own account (use "end all other sessions").',
  auth: 'session',
  permission: 'sessions:revoke',
  stepUp: true,
  request: { params: UserIdParamsSchema },
  responses: { 200: { description: 'How many were ended.', schema: SessionsRevokedSchema } },
});

export const exportAuditRoute = defineRoute({
  operationId: 'exportAudit',
  method: 'get',
  path: '/audit/export',
  tags: ['audit'],
  summary: 'Export the audit log for checking outside the database',
  description:
    'Pages of events, oldest first, with every field their hashes cover, so that a copy can be verified without this server (`node dist/admin.js audit-verify <file>`). Each page is recorded. Needs a fresh second factor: a copy of the whole log is a lot to hand over.',
  auth: 'session',
  permission: 'audit:export',
  stepUp: true,
  request: { query: AuditExportQuerySchema },
  responses: { 200: { description: 'One page of the export.', schema: AuditExportSchema } },
});

export const createAuditCheckpointRoute = defineRoute({
  operationId: 'createAuditCheckpoint',
  method: 'post',
  path: '/audit/checkpoints',
  tags: ['audit'],
  summary: 'Note the head of the audit chain in a form that cannot be made up in the database',
  description:
    'Returns the last event with a signature made with a key that is not in the database. Keep the text somewhere else (a ticket, a vault of your own, a cron job). Later, a check against it proves that nothing up to that event was changed, and that no tail was cut off.',
  auth: 'any',
  permission: 'audit:verify',
  responses: { 200: { description: 'The checkpoint.', schema: AuditCheckpointSchema } },
});

export const verifyAuditCheckpointRoute = defineRoute({
  operationId: 'verifyAuditCheckpoint',
  method: 'post',
  path: '/audit/checkpoints/verify',
  tags: ['audit'],
  summary: 'Check the log against a checkpoint',
  description:
    'Checks the signature, finds the event, compares its hash and checks the chain up to it. A failed check is a normal answer (`ok: false` with the reason). The check is recorded.',
  auth: 'any',
  permission: 'audit:verify',
  request: { body: VerifyAuditCheckpointRequestSchema },
  responses: {
    200: { description: 'The result.', schema: AuditCheckpointVerificationSchema },
  },
});

export const listMyTokensRoute = defineRoute({
  operationId: 'listMyTokens',
  method: 'get',
  path: '/auth/tokens',
  tags: ['tokens'],
  summary: 'Your API tokens',
  description:
    'The tokens issued in your name, active, expired and revoked ones, never their values.',
  auth: 'session',
  responses: { 200: { description: 'Your tokens.', schema: TokenListSchema } },
});

export const revokeMyTokenRoute = defineRoute({
  operationId: 'revokeMyToken',
  method: 'delete',
  path: '/auth/tokens/{id}',
  tags: ['tokens'],
  summary: 'Revoke one of your tokens',
  description:
    'Stops the token at once. Revoking a token that is already revoked succeeds. A token of someone else is reported as not found.',
  auth: 'session',
  request: { params: TokenIdParamsSchema },
  responses: { 204: { description: 'The token is revoked.', schema: z.undefined(), empty: true } },
});

export const createTokenRoute = defineRoute({
  operationId: 'createToken',
  method: 'post',
  path: '/tokens',
  tags: ['tokens'],
  summary: 'Create an API token in your own name',
  description:
    'The token carries a subset of your permissions (never one that needs a fresh second factor), expires after at most a year, and may be limited to addresses. The value is in the answer and nowhere else: it is not stored and cannot be shown again.',
  auth: 'session',
  permission: 'tokens:create',
  stepUp: true,
  request: { body: CreateTokenRequestSchema },
  responses: { 201: { description: 'The token and its record.', schema: CreatedTokenSchema } },
});

export const listTokensRoute = defineRoute({
  operationId: 'listTokens',
  method: 'get',
  path: '/tokens',
  tags: ['tokens'],
  summary: 'The API tokens of every user',
  description: 'Newest first. Filter by user with `userId`. Never the values.',
  auth: 'any',
  permission: 'tokens:read',
  request: { query: TokenListQuerySchema },
  responses: { 200: { description: 'The tokens.', schema: TokenListSchema } },
});

export const revokeTokenRoute = defineRoute({
  operationId: 'revokeToken',
  method: 'delete',
  path: '/tokens/{id}',
  tags: ['tokens'],
  summary: 'Revoke the token of any user',
  description: 'Stops the token at once and records it.',
  auth: 'session',
  permission: 'tokens:revoke',
  stepUp: true,
  request: { params: TokenIdParamsSchema },
  responses: { 204: { description: 'The token is revoked.', schema: z.undefined(), empty: true } },
});

export const listPluginsRoute = defineRoute({
  operationId: 'listPlugins',
  method: 'get',
  path: '/plugins',
  tags: ['plugins'],
  summary: 'The plugins of this instance',
  description:
    'Reads the plugin directories on every call and says, for each plugin, what its files declare, what it asks for, and whether an administrator approved exactly that. A plugin that was enabled and whose files changed, went missing or became invalid is switched off here and the change is recorded.',
  auth: 'any',
  permission: 'plugins:read',
  responses: { 200: { description: 'The plugins.', schema: PluginListSchema } },
});

export const enablePluginRoute = defineRoute({
  operationId: 'enablePlugin',
  method: 'post',
  path: '/plugins/{id}/enable',
  tags: ['plugins'],
  summary: 'Enable a plugin and approve what it asks for',
  description:
    'Approves the plugin as it is now: the digest of its files and the permissions of its manifest. The digest in the request is what the administrator was shown; if the files differ now the answer is 409 and nothing is enabled. Only a plugin that is usable can be enabled (not invalid, not for other versions of Swellwright).',
  auth: 'session',
  permission: 'plugins:manage',
  stepUp: true,
  request: { params: PluginIdParamsSchema, body: EnablePluginRequestSchema },
  responses: { 200: { description: 'The plugin, now enabled.', schema: PluginViewSchema } },
});

export const disablePluginRoute = defineRoute({
  operationId: 'disablePlugin',
  method: 'post',
  path: '/plugins/{id}/disable',
  tags: ['plugins'],
  summary: 'Disable a plugin',
  description:
    'Switches the plugin off at once. The approval stays on record; enabling again needs a new approval of what the files are then. Disabling a plugin that is not enabled succeeds and changes nothing.',
  auth: 'session',
  permission: 'plugins:manage',
  stepUp: true,
  request: { params: PluginIdParamsSchema },
  responses: { 200: { description: 'The plugin, now disabled.', schema: PluginViewSchema } },
});

export const checkPluginRoute = defineRoute({
  operationId: 'checkPlugin',
  method: 'post',
  path: '/plugins/{id}/check',
  tags: ['plugins'],
  summary: 'Load an enabled plugin in its restricted process',
  description:
    'Starts the plugin in a process of its own (no network, no child processes, only its own directory readable, a heap limit) and loads its modules; the answer says what loaded and which methods each module offers, or why it did not. The files are verified against the approval first: a plugin that is not what was approved is switched off instead. The process stays up until it is idle for a while, switched off, or changed.',
  auth: 'session',
  permission: 'plugins:manage',
  stepUp: true,
  request: { params: PluginIdParamsSchema },
  responses: { 200: { description: 'The plugin and its runtime.', schema: PluginViewSchema } },
});

export const getPluginConfigRoute = defineRoute({
  operationId: 'getPluginConfig',
  method: 'get',
  path: '/plugins/{id}/config',
  tags: ['plugins'],
  summary: 'The settings of a plugin',
  description:
    'The form the plugin declares (its `config.schema`) and what is set now. A secret field holds the id of a vault secret, never the secret.',
  auth: 'any',
  permission: 'plugins:read',
  request: { params: PluginIdParamsSchema },
  responses: { 200: { description: 'The settings.', schema: PluginConfigViewSchema } },
});

export const updatePluginConfigRoute = defineRoute({
  operationId: 'updatePluginConfig',
  method: 'put',
  path: '/plugins/{id}/config',
  tags: ['plugins'],
  summary: 'Change the settings of a plugin',
  description:
    'Replaces the settings. Every value is checked against what the plugin declares, a field it does not declare is refused, and a secret field must name an existing vault secret of the right kind. Which fields changed is recorded, never the values.',
  auth: 'session',
  permission: 'plugins:manage',
  stepUp: true,
  request: { params: PluginIdParamsSchema, body: UpdatePluginConfigRequestSchema },
  responses: { 200: { description: 'The settings as stored.', schema: PluginConfigViewSchema } },
});

export const getPluginSidecarRoute = defineRoute({
  operationId: 'getPluginSidecar',
  method: 'get',
  path: '/plugins/{id}/sidecar',
  tags: ['plugins'],
  summary: 'The compose fragment that runs the container of a plugin',
  description:
    'For a plugin whose code runs as a sidecar container: a Docker Compose file that adds the container to the stack on an internal network with no way out, read-only, without privileges, with the memory and cpu the manifest names and the image pinned by digest. It holds the token with which the sidecar proves itself to the core, derived from the plugin and its digest: keep it like a secret. Swellwright never starts a container itself.',
  auth: 'session',
  permission: 'plugins:manage',
  stepUp: true,
  request: { params: PluginIdParamsSchema },
  responses: { 200: { description: 'The fragment.', schema: PluginSidecarFragmentSchema } },
});

export const pluginGatewayRoute = defineRoute({
  operationId: 'pluginGateway',
  method: 'post',
  path: '/plugins/{id}/gateway',
  tags: ['plugin-gateway'],
  summary: 'What a sidecar asks of the core',
  description:
    "Called by a plugin's container, not by people: it proves itself with `Authorization: Bearer <token>`, the token of the compose fragment. The core does what the plugin was approved for and nothing else: requests to the approved hosts, the secret bound to a setting, the plugin's own storage. The answer is always 200 with `ok`; a refusal says why. A wrong token, a plugin that is not enabled or whose files changed answer 401.",
  auth: 'none',
  request: { params: PluginIdParamsSchema, body: PluginGatewayRequestSchema },
  responses: {
    200: { description: 'The result or the refusal.', schema: PluginGatewayReplySchema },
  },
});

export const listServersRoute = defineRoute({
  operationId: 'listServers',
  method: 'get',
  path: '/servers',
  tags: ['servers'],
  summary: 'List the servers',
  description:
    'The inventory, ordered by name, each server with how many host keys are pinned, how many access entries it has and a summary of its facts. The filters combine.',
  auth: 'any',
  permission: 'servers:read',
  request: { query: ServerListQuerySchema },
  responses: { 200: { description: 'The servers.', schema: ServerListSchema } },
});

export const createServerRoute = defineRoute({
  operationId: 'createServer',
  method: 'post',
  path: '/servers',
  tags: ['servers'],
  summary: 'Add a server',
  description: 'A taken name answers 409. The server starts as a draft unless a state is given.',
  auth: 'any',
  permission: 'servers:write',
  request: { body: CreateServerRequestSchema },
  responses: { 201: { description: 'The server.', schema: ServerViewSchema } },
});

export const getServerRoute = defineRoute({
  operationId: 'getServer',
  method: 'get',
  path: '/servers/{id}',
  tags: ['servers'],
  summary: 'One server in full',
  description:
    'With its pinned host keys, its access entries (the names of the secrets, never their values) and its facts.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ServerIdParamsSchema },
  responses: { 200: { description: 'The server.', schema: ServerViewSchema } },
});

export const updateServerRoute = defineRoute({
  operationId: 'updateServer',
  method: 'patch',
  path: '/servers/{id}',
  tags: ['servers'],
  summary: 'Change a server',
  description:
    'Any field, including the state: the five states may follow one another freely, and the audit record keeps the old and the new one. A taken name answers 409.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema, body: UpdateServerRequestSchema },
  responses: { 200: { description: 'The server after the change.', schema: ServerViewSchema } },
});

export const deleteServerRoute = defineRoute({
  operationId: 'deleteServer',
  method: 'delete',
  path: '/servers/{id}',
  tags: ['servers'],
  summary: 'Delete a server',
  description:
    'Only a draft or a retired server; any other state answers 409. Its host keys, access entries and facts go with it; the vault secrets stay.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema },
  responses: { 204: { description: 'The server is gone.', schema: z.undefined(), empty: true } },
});

export const pinHostKeyRoute = defineRoute({
  operationId: 'pinHostKey',
  method: 'post',
  path: '/servers/{id}/host-keys',
  tags: ['servers'],
  summary: 'Pin a host key by hand',
  description:
    'Pins a fingerprint the person checked (for example from the provider console). Idempotent: pinning the same fingerprint again changes nothing and answers 200 with the key that is there; a new key answers 201.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema, body: PinHostKeyRequestSchema },
  responses: {
    200: { description: 'That fingerprint was already pinned.', schema: ServerHostKeySchema },
    201: { description: 'The key is pinned.', schema: ServerHostKeySchema },
  },
});

export const revokeHostKeyRoute = defineRoute({
  operationId: 'revokeHostKey',
  method: 'delete',
  path: '/servers/{id}/host-keys/{keyId}',
  tags: ['servers'],
  summary: 'Revoke a pinned host key',
  description:
    'For a server that was reinstalled: the old key must stop being trusted. Nothing connects to a server whose keys are all revoked until a new one is pinned.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: HostKeyParamsSchema },
  responses: { 204: { description: 'The key is revoked.', schema: z.undefined(), empty: true } },
});

export const addAccessRoute = defineRoute({
  operationId: 'addServerAccess',
  method: 'post',
  path: '/servers/{id}/access',
  tags: ['servers'],
  summary: 'Add a way to log in',
  description:
    'The entry names vault secrets and holds no value. A password entry needs a secret of kind `ssh_password`, a key entry one of kind `ssh_key`, and the sudo secret one of kind `ssh_password`; anything else answers 400, as does a secret that does not exist. A server has at most five entries (409 beyond that). A secret in use cannot be deleted from the vault.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema, body: AddAccessRequestSchema },
  responses: { 201: { description: 'The entry.', schema: ServerAccessSchema } },
});

export const updateAccessRoute = defineRoute({
  operationId: 'updateServerAccess',
  method: 'patch',
  path: '/servers/{id}/access/{accessId}',
  tags: ['servers'],
  summary: 'Change a way to log in',
  description: 'The same rules as when adding: the result must be consistent.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: AccessParamsSchema, body: UpdateAccessRequestSchema },
  responses: { 200: { description: 'The entry after the change.', schema: ServerAccessSchema } },
});

export const removeAccessRoute = defineRoute({
  operationId: 'removeServerAccess',
  method: 'delete',
  path: '/servers/{id}/access/{accessId}',
  tags: ['servers'],
  summary: 'Remove a way to log in',
  description: 'The secrets it named stay in the vault.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: AccessParamsSchema },
  responses: { 204: { description: 'The entry is gone.', schema: z.undefined(), empty: true } },
});

const SSH_ERRORS =
  'Errors: 404 (no such server or entry), 409 `host_key_not_pinned` (nothing is pinned yet), `host_key_mismatch` (the server shows another key than the pinned one: `details` has `expected` and `actual`), `address_not_allowed` (the outbound policy refuses the address), `secret_expired` (a secret the access entry names has expired: nothing was sent with it; `details` has `secretId` and `secretName`; renew its expiry or replace the secret), 423 `vault_sealed`, 429 `rate_limited`.';

export const scanHostKeyRoute = defineRoute({
  operationId: 'scanHostKey',
  method: 'post',
  path: '/servers/{id}/host-keys/scan',
  tags: ['servers'],
  summary: 'Read the host key the server shows',
  description: `Connects to the server and reads its SSH host key without sending any credential, then compares it with the pinned ones. Nothing is stored (only an audit note): the person checks the fingerprint against another source and then calls \`accept\`. \`differs\` means keys are pinned and this one is not among them: expected after the operating system was reinstalled, a sign of somebody in the middle otherwise. It sends no credential, but it makes the API open a connection to the server, so it needs the same role (\`servers:write\`) as the other SSH operations; a role that may only read never causes a connection. Errors: 404, 409 \`address_not_allowed\`, 429 \`rate_limited\`, 502 \`ssh_connect_failed\`, 504 \`ssh_timeout\`.`,
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema },
  responses: { 200: { description: 'The key the server shows.', schema: HostKeyScanSchema } },
});

export const acceptHostKeyRoute = defineRoute({
  operationId: 'acceptHostKey',
  method: 'post',
  path: '/servers/{id}/host-keys/accept',
  tags: ['servers'],
  summary: 'Pin the host key the person confirmed',
  description:
    'Reads the key again and pins it only when it is exactly the fingerprint the person confirmed (otherwise 409 `host_key_mismatch`, nothing stored), with the source `scan`. Pinning a key that is pinned already changes nothing and answers 200. When other keys are pinned, a different key needs `replace: true`, which revokes them in the same step (the operating system was reinstalled); without it: 409 `host_key_replace_required`. Both the pin and the revocations are audit records. Other errors: 404, 409 `address_not_allowed`, 429, 502 `ssh_connect_failed`, 504 `ssh_timeout`.',
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema, body: AcceptHostKeyRequestSchema },
  responses: {
    200: { description: 'That key was pinned already.', schema: HostKeyAcceptedSchema },
    201: { description: 'The key is pinned.', schema: HostKeyAcceptedSchema },
  },
});

export const verifyAccessRoute = defineRoute({
  operationId: 'verifyServerAccess',
  method: 'post',
  path: '/servers/{id}/access/{accessId}/verify',
  tags: ['servers'],
  summary: 'Try an access entry',
  description: `Logs in with that entry (the host key must be pinned and is checked before any credential is sent) and runs read-only probes: \`id -un\`, \`id -u\` and a sudo check (with the stored sudo secret on standard input when there is one, otherwise \`sudo -n\`). A login that does not work is a result: 200 with \`ok: false\` and the code and message. The time and the outcome are kept on the entry. ${SSH_ERRORS}`,
  auth: 'any',
  permission: 'servers:write',
  request: { params: AccessParamsSchema },
  responses: { 200: { description: 'The result of the check.', schema: AccessVerificationSchema } },
});

export const refreshFactsRoute = defineRoute({
  operationId: 'refreshServerFacts',
  method: 'post',
  path: '/servers/{id}/facts/refresh',
  tags: ['servers'],
  summary: 'Collect the facts of a server',
  description: `Runs a fixed, read-only script over SSH (as root, or through sudo when the login is not root and sudo works, or as the login), parses its output strictly and stores the result; a malformed part becomes a warning and the rest is kept. Access entries are tried by priority until one logs in. One refresh per server runs at a time: a second request joins it. ${SSH_ERRORS} Also 409 \`no_access_entry\`, 502 \`ssh_connect_failed\`, \`ssh_auth_failed\`, \`ssh_key_invalid\`, \`ssh_failed\`, \`facts_unreadable\`, 504 \`ssh_timeout\`.`,
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerIdParamsSchema },
  responses: { 200: { description: 'The new facts.', schema: ServerFactsRecordSchema } },
});

export const getFactsRoute = defineRoute({
  operationId: 'getServerFacts',
  method: 'get',
  path: '/servers/{id}/facts',
  tags: ['servers'],
  summary: 'The facts collected last',
  description:
    'What the last refresh found, with when, what collected it and the hash of the script. 404 until facts were collected. Reading never connects to the server.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ServerIdParamsSchema },
  responses: { 200: { description: 'The facts.', schema: ServerFactsRecordSchema } },
});

const RUN_ERRORS =
  'Errors: 400 `validation_failed` (the body, or a parameter value that does not fit its definition: `details` names it), 404 (no such script or server), 409 `confirmation_required` (the level of the run is not `read` and `confirmedLevel` is missing or different; `details.level` says which), 429 `rate_limited`. A server that cannot be used (no pinned host key, no access entry) is not an error of the request: its target is `skipped` with the reason, and the others run.';

export const listScriptsRoute = defineRoute({
  operationId: 'listScripts',
  method: 'get',
  path: '/scripts',
  tags: ['commands'],
  summary: 'The script library',
  description:
    'The built-in diagnostics and the scripts of this instance, with their parameters and danger level. The text of a script is in `GET /scripts/{id}`.',
  auth: 'any',
  permission: 'servers:read',
  responses: { 200: { description: 'The scripts.', schema: ScriptListSchema } },
});

export const getScriptRoute = defineRoute({
  operationId: 'getScript',
  method: 'get',
  path: '/scripts/{id}',
  tags: ['commands'],
  summary: 'One script with its text',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ScriptIdParamsSchema },
  responses: { 200: { description: 'The script.', schema: ScriptViewSchema } },
});

export const createScriptRoute = defineRoute({
  operationId: 'createScript',
  method: 'post',
  path: '/scripts',
  tags: ['commands'],
  summary: 'Add a script to the library',
  description:
    'A script is code that will run on servers, usually as root, so writing one needs the permission to run commands (`servers:exec`) and a fresh authenticator code, not only the permission to read servers. A taken name answers 409. The parameters are checked as a whole: duplicate names, a default outside its range or pattern, a pattern that is not a regular expression all answer 400.',
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { body: CreateScriptRequestSchema },
  responses: { 201: { description: 'The script.', schema: ScriptViewSchema } },
});

export const updateScriptRoute = defineRoute({
  operationId: 'updateScript',
  method: 'patch',
  path: '/scripts/{id}',
  tags: ['commands'],
  summary: 'Change a script',
  description:
    'Changing the text raises the version. Runs that happened before keep the text they ran. A built-in script cannot be changed: 409.',
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { params: ScriptIdParamsSchema, body: UpdateScriptRequestSchema },
  responses: { 200: { description: 'The script after the change.', schema: ScriptViewSchema } },
});

export const deleteScriptRoute = defineRoute({
  operationId: 'deleteScript',
  method: 'delete',
  path: '/scripts/{id}',
  tags: ['commands'],
  summary: 'Delete a script',
  description:
    'The history keeps what every run executed, so deleting a script loses nothing of it. A built-in script cannot be deleted: 409.',
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { params: ScriptIdParamsSchema },
  responses: { 204: { description: 'The script is gone.', schema: z.undefined(), empty: true } },
});

export const createCommandRunRoute = defineRoute({
  operationId: 'createCommandRun',
  method: 'post',
  path: '/command-runs',
  tags: ['commands'],
  summary: 'Run a script or a command on several servers',
  description: `Queues a run and returns at once; the servers are worked on in the background, at most \`SW_COMMAND_CONCURRENCY\` at a time, each as a target of its own with its own state, exit status and output: one server failing never fails another. The script runs on the server as a detached step, so it survives a dropped connection and a restart of this API. Values of parameters reach it only as environment variables. The host key must be pinned and the address policy applies. A run whose level is not \`read\` must be confirmed (\`confirmedLevel\`); the engine's approvals come in a later phase. Output can hold secrets: whoever may read servers may read it. ${RUN_ERRORS}`,
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { body: CreateCommandRunRequestSchema },
  responses: { 201: { description: 'The run as it was queued.', schema: CommandRunViewSchema } },
});

export const listCommandRunsRoute = defineRoute({
  operationId: 'listCommandRuns',
  method: 'get',
  path: '/command-runs',
  tags: ['commands'],
  summary: 'The history of runs',
  description:
    'Newest first, with the number of servers in each state. Needs only `servers:read`: the history shows who ran what where, and the output of a run may contain whatever the script printed.',
  auth: 'any',
  permission: 'servers:read',
  request: { query: CommandRunListQuerySchema },
  responses: { 200: { description: 'One page of runs.', schema: CommandRunListSchema } },
});

export const getCommandRunRoute = defineRoute({
  operationId: 'getCommandRun',
  method: 'get',
  path: '/command-runs/{id}',
  tags: ['commands'],
  summary: 'One run with its servers',
  description:
    'The exact text that ran, the parameters, and every target with its state, exit status, error and the end of its output (`tail`). Poll it while the run is `pending` or `running`; the rest of the output is paged through `.../targets/{targetId}/output`.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: CommandRunIdParamsSchema },
  responses: { 200: { description: 'The run.', schema: CommandRunViewSchema } },
});

export const getCommandOutputRoute = defineRoute({
  operationId: 'getCommandOutput',
  method: 'get',
  path: '/command-runs/{id}/targets/{targetId}/output',
  tags: ['commands'],
  summary: 'A page of the output of one server',
  description:
    'Reads what Swellwright kept of one stream, by byte offset. Start at 0 and continue with `nextOffset` until `eof`; while the run is going, `eof` only means "up to now". At most 256 KiB a page, ended between two UTF-8 characters.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: CommandTargetParamsSchema, query: CommandOutputQuerySchema },
  responses: { 200: { description: 'The page.', schema: CommandOutputPageSchema } },
});

export const cancelCommandRunRoute = defineRoute({
  operationId: 'cancelCommandRun',
  method: 'post',
  path: '/command-runs/{id}/cancel',
  tags: ['commands'],
  summary: 'Stop a run',
  description:
    'Servers that have not started are cancelled at once; on those that run, the script gets TERM and then KILL. Asking twice is harmless (the second answer is the same run). A run that has ended answers 409.',
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { params: CommandRunIdParamsSchema },
  responses: { 200: { description: 'The run after the request.', schema: CommandRunViewSchema } },
});

export const listArtifactsRoute = defineRoute({
  operationId: 'listArtifacts',
  method: 'get',
  path: '/artifacts',
  tags: ['artifacts'],
  summary: 'The catalogue of artifacts',
  description:
    'The files Swellwright ships to servers (the node installer, later the node engine): each with its versions, the SHA-256 and size its manifest declares, its steps and parameters, and whether the file on disk still is what the manifest says (`ok`) or not (`broken`, with the reason). A broken artifact is listed so that it can be seen, and is neither downloaded nor pushed. The files are checked when the server starts and again whenever one is used.',
  auth: 'any',
  permission: 'servers:read',
  responses: { 200: { description: 'The artifacts.', schema: ArtifactListSchema } },
});

export const getArtifactRoute = defineRoute({
  operationId: 'getArtifact',
  method: 'get',
  path: '/artifacts/{name}',
  tags: ['artifacts'],
  summary: 'One artifact with all its versions',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ArtifactNameParamsSchema },
  responses: { 200: { description: 'The artifact.', schema: ArtifactViewSchema } },
});

export const getArtifactVersionRoute = defineRoute({
  operationId: 'getArtifactVersion',
  method: 'get',
  path: '/artifacts/{name}/versions/{version}',
  tags: ['artifacts'],
  summary: 'One version of an artifact',
  description:
    'With its manifest. A version that is broken answers 200 with `state: broken` and the reason.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ArtifactVersionParamsSchema },
  responses: { 200: { description: 'The version.', schema: ArtifactVersionViewSchema } },
});

const DOWNLOAD_HEADERS = {
  'Content-Disposition': 'An attachment with the file name from the manifest.',
  'X-Content-SHA256': 'The SHA-256 of the bytes that follow, as the manifest declares it.',
} as const;

export const downloadArtifactRoute = defineRoute({
  operationId: 'downloadArtifact',
  method: 'get',
  path: '/artifacts/{name}/content',
  tags: ['artifacts'],
  summary: 'Download the latest intact version of an artifact',
  description:
    'The file, streamed. `X-Content-SHA256` carries the hash the manifest declares, so that the receiver can check what it got. A broken artifact, and one with no intact version, answers 409 `artifact_broken`: it is never served.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ArtifactNameParamsSchema },
  responses: {
    200: { description: 'The file.', schema: z.unknown(), binary: { headers: DOWNLOAD_HEADERS } },
  },
});

export const downloadArtifactVersionRoute = defineRoute({
  operationId: 'downloadArtifactVersion',
  method: 'get',
  path: '/artifacts/{name}/versions/{version}/content',
  tags: ['artifacts'],
  summary: 'Download one version of an artifact',
  description: 'As the latest version, for a version that is named.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ArtifactVersionParamsSchema },
  responses: {
    200: { description: 'The file.', schema: z.unknown(), binary: { headers: DOWNLOAD_HEADERS } },
  },
});

export const listServerArtifactsRoute = defineRoute({
  operationId: 'listServerArtifacts',
  method: 'get',
  path: '/servers/{id}/artifacts',
  tags: ['servers'],
  summary: 'The artifacts pushed to a server',
  description:
    'What Swellwright put on the server, with the result of the last check of each copy. Reading never connects to the server.',
  auth: 'any',
  permission: 'servers:read',
  request: { params: ServerIdParamsSchema },
  responses: { 200: { description: 'The copies.', schema: ServerArtifactListSchema } },
});

export const pushArtifactRoute = defineRoute({
  operationId: 'pushServerArtifact',
  method: 'post',
  path: '/servers/{id}/artifacts',
  tags: ['servers'],
  summary: 'Push an artifact to a server',
  description: `Reads the file of the catalogue and hashes it (a file that is not what its manifest says is never sent), uploads it over SFTP to \`<dir>/<name>/<version>/<file>\` under a temporary name, hashes what arrived on the server and renames it into place only when it matches, sets the mode (a script 0755, a data file 0644, never writable by others) and hashes it once more in its place. A failure leaves no partial file. \`destination: user\` (the default) is \`~/.swellwright/artifacts\` of the login, private to it; \`destination: system\` is \`/var/lib/swellwright/artifacts\`, root-owned, written through sudo. When the same file is already there nothing is uploaded and the answer is 200 \`unchanged\`; a new or replaced copy answers 201 \`pushed\`. One push per server runs at a time. Access entries are tried by priority until one logs in. Needs \`servers:exec\` and a fresh second factor: what is pushed is meant to be run on the server. ${SSH_ERRORS} Also 409 \`artifact_broken\`, \`artifact_busy\` (another push or removal is running on this server), \`artifact_destination_conflict\` (this version is on the server at the other destination: remove it first), \`sudo_unavailable\` (destination \`system\` needs root or a working sudo), \`no_access_entry\`, 502 \`artifact_hash_mismatch\` (the copy on the server does not hash to the catalogue's value: nothing is left there; \`details\` has \`expected\`, \`actual\`, \`stage\`), \`ssh_connect_failed\`, \`ssh_auth_failed\`, \`ssh_key_invalid\`, \`ssh_failed\`, 504 \`ssh_timeout\`.`,
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { params: ServerIdParamsSchema, body: PushArtifactRequestSchema },
  responses: {
    200: { description: 'The same file was already there.', schema: ArtifactPushResultSchema },
    201: { description: 'The file was uploaded and checked.', schema: ArtifactPushResultSchema },
  },
});

export const verifyServerArtifactRoute = defineRoute({
  operationId: 'verifyServerArtifact',
  method: 'post',
  path: '/servers/{id}/artifacts/{name}/verify',
  tags: ['servers'],
  summary: 'Check the copies of an artifact on a server',
  description: `Hashes each copy on the server (\`sha256sum\`) and compares it with the catalogue: \`ok\`, \`differs\` (somebody or something changed the file) or \`missing\`. A copy of a version the catalogue no longer has is compared with what was pushed. The time and the result are kept and shown. A copy that differs or is missing is a result (200 with \`ok: false\`), not an error. Nothing is repaired: push again to replace it. ${SSH_ERRORS} 404 when no copy of that artifact is on the server.`,
  auth: 'any',
  permission: 'servers:write',
  request: { params: ServerArtifactParamsSchema, query: VerifyArtifactQuerySchema },
  responses: {
    200: { description: 'The result of the check.', schema: ArtifactVerificationSchema },
  },
});

export const removeServerArtifactRoute = defineRoute({
  operationId: 'removeServerArtifact',
  method: 'delete',
  path: '/servers/{id}/artifacts/{name}/{version}',
  tags: ['servers'],
  summary: 'Remove an artifact from a server',
  description: `Deletes the copy on the server (and the directories left empty) and forgets it. Needs \`servers:exec\` and a fresh second factor. Nothing is removed that Swellwright did not put there: the path comes from the record of the push and is checked against the layout before anything is deleted. A copy that is already gone is not an error. ${SSH_ERRORS} Also 409 \`artifact_busy\`, \`sudo_unavailable\`.`,
  auth: 'session',
  permission: 'servers:exec',
  stepUp: true,
  request: { params: ServerArtifactVersionParamsSchema },
  responses: { 204: { description: 'The copy is gone.', schema: z.undefined(), empty: true } },
});

const PANEL_ERRORS =
  'The panel can be refused or slow, and each of those has a code: 409 `panel_not_connected` (nothing is connected), 409 `panel_unsupported_version`, 502 `panel_unauthorized` (the panel rejected the token), 502 `panel_forbidden` (the token has no scope for this), 502 `panel_unreachable`, 502 `panel_contract_changed` (the panel answered in a shape this release does not know; the message names the endpoint and the field), 504 `panel_timeout`, 429 `panel_rate_limited` (the panel asked to slow down; `Retry-After` is set). 423 `vault_sealed` while the vault that holds the token is sealed.';

export const getPanelConnectionRoute = defineRoute({
  operationId: 'getPanelConnection',
  method: 'get',
  path: '/panel/connection',
  tags: ['panel'],
  summary: 'The connection to the Remnawave panel',
  description:
    'Where the panel is, which vault secret holds its token (never the token), the state found by the last check, the version and whether this release supports it, what the token can read, when the token expires and what went wrong last. Answers 200 with state `unconfigured` when no panel is connected. Reading does not call the panel.',
  auth: 'any',
  permission: 'panel:read',
  responses: { 200: { description: 'The connection.', schema: PanelConnectionViewSchema } },
});

export const connectPanelRoute = defineRoute({
  operationId: 'connectPanel',
  method: 'put',
  path: '/panel/connection',
  tags: ['panel'],
  summary: 'Connect to a panel with a token from the vault',
  description: `Validates the address (https; the same address policy as for servers: loopback, link-local and metadata addresses are refused), asks the panel for its version and health with the token, reads each resource once to find what the token can read, and only then saves the connection (one row; a second call replaces it). Nothing is stored when the panel refuses. The token secret cannot be deleted from the vault while a connection uses it. Recorded as \`panel.connected\`. ${PANEL_ERRORS} 409 \`address_not_allowed\`.`,
  auth: 'session',
  permission: 'panel:write',
  request: { body: ConnectPanelRequestSchema },
  responses: { 200: { description: 'The saved connection.', schema: PanelConnectionViewSchema } },
});

export const connectPanelWithTokenRoute = defineRoute({
  operationId: 'connectPanelWithToken',
  method: 'put',
  path: '/panel/connection/with-token',
  tags: ['panel'],
  summary: 'Connect to a panel with a token that is not in the vault yet',
  description: `The wizard path: the token is tried against the panel first, and only when the panel accepts it is the token sealed into the vault (kind \`panel_token\`, the name you give) and the connection saved, in one transaction. Needs \`panel:write\` and \`vault:manage\`, and a fresh second factor, as every route that writes a secret does. Recorded as \`secret.created\` and \`panel.connected\`. ${PANEL_ERRORS} 409 \`address_not_allowed\`, and 409 when the secret name is taken.`,
  auth: 'session',
  permission: 'panel:write',
  stepUp: true,
  request: { body: ConnectPanelWithTokenRequestSchema },
  responses: { 200: { description: 'The saved connection.', schema: PanelConnectionViewSchema } },
});

export const testPanelRoute = defineRoute({
  operationId: 'testPanel',
  method: 'post',
  path: '/panel/connection/test',
  tags: ['panel'],
  summary: 'Test the connection',
  description:
    'Asks the panel again (version, health, every resource once) and saves what it finds as the state of the connection. A panel that does not answer or refuses the token is a result (200 with `ok: false` and the state), not an error. Recorded as `panel.tested` with the outcome. Rate limited per user.',
  auth: 'session',
  permission: 'panel:write',
  responses: { 200: { description: 'The result of the test.', schema: PanelTestResultSchema } },
});

export const disconnectPanelRoute = defineRoute({
  operationId: 'disconnectPanel',
  method: 'delete',
  path: '/panel/connection',
  tags: ['panel'],
  summary: 'Disconnect from the panel',
  description:
    'Forgets the connection and the short-lived memory of what was read. The token stays in the vault: delete the secret separately. Nothing is changed on the panel. Recorded as `panel.disconnected`. 404 when nothing is connected.',
  auth: 'session',
  permission: 'panel:write',
  responses: { 204: { description: 'Disconnected.', schema: z.undefined(), empty: true } },
});

export const getPanelOverviewRoute = defineRoute({
  operationId: 'getPanelOverview',
  method: 'get',
  path: '/panel/overview',
  tags: ['panel'],
  summary: 'The panel at a glance',
  description: `Version, health, how many nodes, hosts, config profiles, squads, templates, snippets and node plugins there are, how many nodes are online, the users as counts (no personal data), and the days left of the connected token with a warning from 14 days before. A count the token may not read is null. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The overview.', schema: PanelOverviewSchema } },
});

export const listPanelNodesRoute = defineRoute({
  operationId: 'listPanelNodes',
  method: 'get',
  path: '/panel/nodes',
  tags: ['panel'],
  summary: 'The nodes of the panel',
  description: `Normalised: state, address, port, country, versions of the node and of Xray, the profile and its active inbounds, tags, provider, traffic and consumption fields, flags. Read from a memory of this server that lives 15 seconds (\`SW_PANEL_CACHE_TTL_SECONDS\`); \`refresh=true\` asks the panel again and is rate limited per user. Read only: nothing is sent to the panel but GET requests. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The nodes.', schema: PanelNodeListSchema } },
});

export const listPanelHostsRoute = defineRoute({
  operationId: 'listPanelHosts',
  method: 'get',
  path: '/panel/hosts',
  tags: ['panel'],
  summary: 'The hosts of the panel',
  description: `Every field the panel shows for a host. Opaque parts (mux, sockopt, XHTTP extra parameters, final mask, the subscription mappers) are JSON with every secret masked. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The hosts.', schema: PanelHostListSchema } },
});

export const listPanelConfigProfilesRoute = defineRoute({
  operationId: 'listPanelConfigProfiles',
  method: 'get',
  path: '/panel/config-profiles',
  tags: ['panel'],
  summary: 'The config profiles of the panel',
  description: `Name, tags, inbounds (tag, protocol, network, security, port) and the nodes that run the profile. The Xray configuration itself is not in the list: read one profile for it. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The profiles.', schema: PanelConfigProfileListSchema } },
});

export const getPanelConfigProfileRoute = defineRoute({
  operationId: 'getPanelConfigProfile',
  method: 'get',
  path: '/panel/config-profiles/{uuid}',
  tags: ['panel'],
  summary: 'One config profile with its configuration',
  description: `The Xray configuration as JSON with every secret masked (REALITY private keys and short ids, passwords, client ids, credentials in URLs, PEM private keys): a mask looks like \`[masked:1a2b3c4d]\`, where the eight characters are a keyed fingerprint of the value, so a rotated key shows as a change and the value cannot be guessed from it. No route returns an unmasked value. 404 when the panel has no such profile. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { params: PanelProfileParamsSchema, query: PanelReadQuerySchema },
  responses: { 200: { description: 'The profile.', schema: PanelConfigProfileAnswerSchema } },
});

export const getPanelComputedConfigRoute = defineRoute({
  operationId: 'getPanelComputedConfig',
  method: 'get',
  path: '/panel/config-profiles/{uuid}/computed-config',
  tags: ['panel'],
  summary: 'The computed configuration of a config profile',
  description: `The configuration as the panel computes it for its nodes, masked like the profile. Not cached: it is read when asked. 404 when the panel has no such profile. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { params: PanelProfileParamsSchema },
  responses: {
    200: { description: 'The computed profile.', schema: PanelConfigProfileAnswerSchema },
  },
});

export const listPanelInternalSquadsRoute = defineRoute({
  operationId: 'listPanelInternalSquads',
  method: 'get',
  path: '/panel/internal-squads',
  tags: ['panel'],
  summary: 'The internal squads of the panel',
  description: `Name, tags, members count (a number, no user), inbounds. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The squads.', schema: PanelInternalSquadListSchema } },
});

export const listPanelExternalSquadsRoute = defineRoute({
  operationId: 'listPanelExternalSquads',
  method: 'get',
  path: '/panel/external-squads',
  tags: ['panel'],
  summary: 'The external squads of the panel',
  description: `Templates, subscription settings, host overrides, response headers (values that carry credentials are masked), HWID settings, custom remarks. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The squads.', schema: PanelExternalSquadListSchema } },
});

export const listPanelSubscriptionTemplatesRoute = defineRoute({
  operationId: 'listPanelSubscriptionTemplates',
  method: 'get',
  path: '/panel/subscription-templates',
  tags: ['panel'],
  summary: 'The subscription templates of the panel',
  description: `Type, name, tags and the template body (JSON, or YAML decoded and masked). A template for a local proxy often carries its credentials; they are masked. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: {
    200: { description: 'The templates.', schema: PanelSubscriptionTemplateListSchema },
  },
});

export const getPanelSubscriptionSettingsRoute = defineRoute({
  operationId: 'getPanelSubscriptionSettings',
  method: 'get',
  path: '/panel/subscription-settings',
  tags: ['panel'],
  summary: 'The subscription settings of the panel',
  description: `Custom remarks and response headers, the response rules, HWID settings. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: {
    200: { description: 'The settings.', schema: PanelSubscriptionSettingsAnswerSchema },
  },
});

export const listPanelSnippetsRoute = defineRoute({
  operationId: 'listPanelSnippets',
  method: 'get',
  path: '/panel/snippets',
  tags: ['panel'],
  summary: 'The snippets of the panel',
  description: `Named JSON fragments the panel templates reuse, masked. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The snippets.', schema: PanelSnippetListSchema } },
});

export const listPanelNodePluginsRoute = defineRoute({
  operationId: 'listPanelNodePlugins',
  method: 'get',
  path: '/panel/node-plugins',
  tags: ['panel'],
  summary: 'The node plugins of the panel',
  description: `Name, tags and the plugin configuration as masked JSON. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The plugins.', schema: PanelNodePluginListSchema } },
});

export const getPanelInfraRoute = defineRoute({
  operationId: 'getPanelInfra',
  method: 'get',
  path: '/panel/infra',
  tags: ['panel'],
  summary: 'Infrastructure providers and billing nodes',
  description: `Providers with their totals, billing nodes with their next billing date, the nodes that are not in billing yet, and the totals. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The billing data.', schema: PanelInfraAnswerSchema } },
});

export const listPanelApiTokensRoute = defineRoute({
  operationId: 'listPanelApiTokens',
  method: 'get',
  path: '/panel/api-tokens',
  tags: ['panel'],
  summary: 'The API tokens of the panel',
  description: `Names, scopes and expiry, never the token values. The panel lets only an administrator session list its API tokens, not an API token: with a token the panel answers 403, which is reported as 502 \`panel_forbidden\`, and the capability \`apiTokens\` of the connection is \`denied\`. ${PANEL_ERRORS}`,
  auth: 'any',
  permission: 'panel:read',
  request: { query: PanelReadQuerySchema },
  responses: { 200: { description: 'The tokens.', schema: PanelApiTokenListSchema } },
});

/** Routes any signed-in user may call without a permission. Everything else under `session` names one. */
export const ROUTES_OPEN_TO_ANY_SESSION: readonly string[] = [
  'getMe',
  'getUpdates',
  'changePassword',
  'stepUp',
  'listMySessions',
  'revokeMySession',
  'revokeOtherSessions',
  'listMyTokens',
  'revokeMyToken',
  'updatePreferences',
];

/** Every route of the public API. The server binds its handlers to these definitions. */
export const routes = [
  healthRoute,
  readyRoute,
  versionRoute,
  updatesRoute,
  openApiRoute,
  getSetupStatusRoute,
  createOwnerRoute,
  loginRoute,
  totpRoute,
  totpEnrollmentRoute,
  totpConfirmRoute,
  logoutRoute,
  meRoute,
  stepUpRoute,
  acceptInvitationRoute,
  changePasswordRoute,
  listUsersRoute,
  createUserRoute,
  updateUserRoute,
  deleteUserRoute,
  updatePreferencesRoute,
  resetCredentialsRoute,
  vaultStatusRoute,
  initializeVaultRoute,
  unsealVaultRoute,
  sealVaultRoute,
  listSecretsRoute,
  createSecretRoute,
  updateSecretRoute,
  deleteSecretRoute,
  revealSecretRoute,
  changeVaultPassphraseRoute,
  rotateRecoveryKeyRoute,
  rotateKekRoute,
  rotateDataKeysRoute,
  rolesRoute,
  listAuditRoute,
  verifyAuditChainRoute,
  exportAuditRoute,
  createAuditCheckpointRoute,
  verifyAuditCheckpointRoute,
  listMySessionsRoute,
  revokeMySessionRoute,
  revokeOtherSessionsRoute,
  listSessionsRoute,
  revokeSessionRoute,
  revokeUserSessionsRoute,
  listMyTokensRoute,
  revokeMyTokenRoute,
  createTokenRoute,
  listTokensRoute,
  revokeTokenRoute,
  listPluginsRoute,
  enablePluginRoute,
  disablePluginRoute,
  checkPluginRoute,
  getPluginConfigRoute,
  updatePluginConfigRoute,
  getPluginSidecarRoute,
  pluginGatewayRoute,
  listServersRoute,
  createServerRoute,
  getServerRoute,
  updateServerRoute,
  deleteServerRoute,
  pinHostKeyRoute,
  revokeHostKeyRoute,
  addAccessRoute,
  updateAccessRoute,
  removeAccessRoute,
  scanHostKeyRoute,
  acceptHostKeyRoute,
  verifyAccessRoute,
  refreshFactsRoute,
  getFactsRoute,
  listScriptsRoute,
  getScriptRoute,
  createScriptRoute,
  updateScriptRoute,
  deleteScriptRoute,
  createCommandRunRoute,
  listCommandRunsRoute,
  getCommandRunRoute,
  getCommandOutputRoute,
  cancelCommandRunRoute,
  listArtifactsRoute,
  getArtifactRoute,
  getArtifactVersionRoute,
  downloadArtifactRoute,
  downloadArtifactVersionRoute,
  listServerArtifactsRoute,
  pushArtifactRoute,
  verifyServerArtifactRoute,
  removeServerArtifactRoute,
  getPanelConnectionRoute,
  connectPanelRoute,
  connectPanelWithTokenRoute,
  testPanelRoute,
  disconnectPanelRoute,
  getPanelOverviewRoute,
  listPanelNodesRoute,
  listPanelHostsRoute,
  listPanelConfigProfilesRoute,
  getPanelConfigProfileRoute,
  getPanelComputedConfigRoute,
  listPanelInternalSquadsRoute,
  listPanelExternalSquadsRoute,
  listPanelSubscriptionTemplatesRoute,
  getPanelSubscriptionSettingsRoute,
  listPanelSnippetsRoute,
  listPanelNodePluginsRoute,
  getPanelInfraRoute,
  listPanelApiTokensRoute,
] as const;

/** Errors every route may return, documented once. */
export const commonErrors = { default: ERROR } as const;
