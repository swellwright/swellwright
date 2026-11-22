import { z } from 'zod';

import {
  ArtifactCatalogueStateSchema,
  ArtifactCheckSchema,
  ArtifactCheckStateSchema,
  ArtifactDestinationSchema,
  ArtifactInterpreterSchema,
  ArtifactListSchema,
  ArtifactManifestSchema,
  ArtifactParamSchema,
  ArtifactPushResultSchema,
  ArtifactStateSchema,
  ArtifactStepSchema,
  ArtifactVerificationSchema,
  ArtifactVersionViewSchema,
  ArtifactViewSchema,
  PushArtifactRequestSchema,
  ServerArtifactListSchema,
  ServerArtifactSchema,
} from './artifacts.js';
import {
  AuditActionSchema,
  AuditCheckpointSchema,
  AuditCheckpointVerificationSchema,
  AuditDetailsSchema,
  AuditEventSchema,
  AuditExportSchema,
  AuditOutcomeSchema,
  AuditPageSchema,
  ChainProblemSchema,
  ChainVerificationSchema,
  VerifyAuditCheckpointRequestSchema,
} from './audit.js';
import {
  CheckFixHintSchema,
  CheckObjectKindSchema,
  CheckObjectRefSchema,
  CheckSeveritySchema,
  ConventionFindingSchema,
  ConventionLastRunSchema,
  ConventionPackDocumentSchema,
  ConventionPackValidationSchema,
  ConventionPackVersionListSchema,
  ConventionPackVersionSchema,
  ConventionPackViewSchema,
  ConventionRuleCatalogSchema,
  ConventionRuleInfoSchema,
  ConventionRunSchema,
  ConventionSummarySchema,
  ImpactKindSchema,
  ImpactReportSchema,
  ImpactRequestSchema,
  ImpactTargetSchema,
  ImpactRuleIdSchema,
  ImpactSettingsSchema,
  JsonPatchOperationSchema,
  PackIssueSchema,
  PackRefSchema,
  PackRuleConfigSchema,
  PackScopeSchema,
  ReconciliationCheckInfoSchema,
  ReconciliationCheckSchema,
  ReconciliationReportSchema,
  ReconciliationRowSchema,
  ReconciliationSettingsSchema,
  ReconciliationStatusSchema,
  ReconciliationSummarySchema,
  RiskLevelSchema,
  RuleParamInfoSchema,
  SaveConventionPackRequestSchema,
  ValidateConventionPackRequestSchema,
} from './checks.js';
import {
  UpdatePreferencesRequestSchema,
  AcceptInvitationRequestSchema,
  AuthNextStepSchema,
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
  UserSummarySchema,
} from './auth.js';
import {
  BooleanParameterSchema,
  CommandOutputPageSchema,
  CommandOutputSchema,
  CommandRunCountsSchema,
  CommandRunListSchema,
  CommandRunModeSchema,
  CommandRunStateSchema,
  CommandRunSummarySchema,
  CommandRunViewSchema,
  CommandTargetStateSchema,
  CommandTargetViewSchema,
  CreateCommandRunRequestSchema,
  CreateScriptRequestSchema,
  DangerLevelSchema,
  EnumParameterSchema,
  IntegerParameterSchema,
  ParameterValuesSchema,
  RunSecretRequestSchema,
  RunSecretViewSchema,
  ScriptListSchema,
  ScriptParameterSchema,
  ScriptSummarySchema,
  ScriptViewSchema,
  SecretParameterSchema,
  StringParameterSchema,
  UpdateScriptRequestSchema,
} from './commands.js';
import { ApiErrorSchema, ErrorCodeSchema } from './errors.js';
import {
  ConnectPanelRequestSchema,
  ConnectPanelWithTokenRequestSchema,
  PanelApiTokenListSchema,
  PanelApiTokenViewSchema,
  PanelBillingNodeViewSchema,
  PanelCapabilitiesSchema,
  PanelCapabilityStateSchema,
  PanelConfigProfileAnswerSchema,
  PanelConfigProfileListSchema,
  PanelConfigProfileSummarySchema,
  PanelConfigProfileViewSchema,
  PanelConnectionStateSchema,
  PanelConnectionViewSchema,
  PanelExternalSquadListSchema,
  PanelExternalSquadViewSchema,
  PanelHostListSchema,
  PanelHostViewSchema,
  PanelInboundViewSchema,
  PanelInfraAnswerSchema,
  PanelInfraProviderViewSchema,
  PanelInfraViewSchema,
  PanelInternalSquadListSchema,
  PanelInternalSquadViewSchema,
  PanelLastErrorSchema,
  PanelNodeListSchema,
  PanelNodePluginListSchema,
  PanelNodePluginViewSchema,
  PanelNodeStateSchema,
  PanelNodeViewSchema,
  PanelOverviewSchema,
  PanelResourceSchema,
  PanelSnippetListSchema,
  PanelSnippetViewSchema,
  PanelSubscriptionSettingsAnswerSchema,
  PanelSubscriptionSettingsViewSchema,
  PanelSubscriptionTemplateListSchema,
  PanelSubscriptionTemplateViewSchema,
  PanelTestResultSchema,
  PanelTokenInfoSchema,
  PanelVersionSupportSchema,
  PanelWarningSchema,
} from './panel.js';
import {
  PanelConsoleAvailabilitySchema,
  PanelConsoleBlockedReasonSchema,
  PanelConsoleCatalogueSchema,
  PanelConsoleIssuesSchema,
  PanelConsoleOperationDetailSchema,
  PanelConsoleOperationSchema,
  PanelConsoleParamSchema,
  PanelConsoleRequestSchema,
  PanelConsoleResultSchema,
} from './panel-console.js';
import {
  CreatePanelSnapshotRequestSchema,
  PanelDiffCountsSchema,
  PanelDiffNoteSchema,
  PanelDiffObjectSchema,
  PanelDiffObjectStatusSchema,
  PanelDiffSchema,
  PanelDiffSideSchema,
  PanelFieldChangeSchema,
  PanelSnapshotCoverageSchema,
  PanelSnapshotKindSchema,
  PanelSnapshotListSchema,
  PanelSnapshotObjectKindSchema,
  PanelSnapshotSettingsSchema,
  PanelSnapshotSummarySchema,
} from './panel-snapshots.js';
import {
  EnablePluginRequestSchema,
  PluginApprovalSchema,
  PluginConfigFieldSchema,
  PluginConfigViewSchema,
  UpdatePluginConfigRequestSchema,
  PluginDiscoveryStateSchema,
  PluginGatewayReplySchema,
  PluginGatewayRequestSchema,
  PluginListSchema,
  PluginPermissionChangeSchema,
  PluginPermissionsViewSchema,
  PluginProvidedSchema,
  PluginRuntimeSchema,
  PluginSidecarFragmentSchema,
  PluginStatusSchema,
  PluginTrustSchema,
  PluginViewSchema,
} from './plugins.js';
import {
  PermissionSchema,
  PermissionSummarySchema,
  RoleCatalogSchema,
  RoleSummarySchema,
  UserRoleSchema,
} from './roles.js';
import {
  AcceptHostKeyRequestSchema,
  AccessMethodSchema,
  AccessVerificationSchema,
  AddAccessRequestSchema,
  CreateServerRequestSchema,
  HostKeyAcceptedSchema,
  HostKeyScanSchema,
  PinHostKeyRequestSchema,
  SecretRefSchema,
  ServerAccessSchema,
  ServerFactsRecordSchema,
  ServerFactsSchema,
  ServerFactsSummarySchema,
  ServerHostKeySchema,
  ServerListSchema,
  ServerStateSchema,
  ServerSummarySchema,
  ServerViewSchema,
  UpdateAccessRequestSchema,
  UpdateServerRequestSchema,
} from './servers.js';
import { type RouteDef, routes } from './routes.js';
import {
  CreateUserRequestSchema,
  InvitationSchema,
  UpdateUserRequestSchema,
  UserInvitationSchema,
  UserListSchema,
  UserStateSchema,
  UserStatusSchema,
  UserViewSchema,
} from './users.js';
import {
  CreateSecretRequestSchema,
  ChangeVaultPassphraseRequestSchema,
  ConfirmPassphraseRequestSchema,
  InitializeVaultRequestSchema,
  RevealedSecretSchema,
  SecretListSchema,
  SecretTypeSchema,
  SecretViewSchema,
  UnsealVaultRequestSchema,
  UpdateSecretRequestSchema,
  VaultInitializedSchema,
  VaultRotatedSchema,
  VaultStatusSchema,
} from './vault.js';
import { SessionListSchema, SessionSummarySchema, SessionsRevokedSchema } from './sessions.js';
import {
  CreatedTokenSchema,
  CreateTokenRequestSchema,
  TokenListSchema,
  TokenStateSchema,
  TokenViewSchema,
} from './tokens.js';
import {
  CheckResultSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
  UpdatesResponseSchema,
  VersionResponseSchema,
} from './system.js';

/** Version of the API description. Bump it with every contract change (oasdiff checks the rules). */
export const OPENAPI_INFO_VERSION = '0.28.0';

/** Named schemas that appear under `components.schemas`. Every response schema must be listed here. */
const COMPONENT_SCHEMAS: readonly z.ZodType[] = [
  ErrorCodeSchema,
  ApiErrorSchema,
  HealthResponseSchema,
  CheckResultSchema,
  ReadyResponseSchema,
  VersionResponseSchema,
  UpdatesResponseSchema,
  UserRoleSchema,
  UserSummarySchema,
  SetupStatusSchema,
  SetupOwnerRequestSchema,
  LoginRequestSchema,
  AuthNextStepSchema,
  PendingSessionSchema,
  TotpCodeRequestSchema,
  TotpEnrollmentSchema,
  SessionInfoSchema,
  UpdatePreferencesRequestSchema,
  TotpConfirmedSchema,
  PermissionSchema,
  PermissionSummarySchema,
  RoleSummarySchema,
  RoleCatalogSchema,
  AuditActionSchema,
  AuditOutcomeSchema,
  AuditDetailsSchema,
  AuditEventSchema,
  AuditPageSchema,
  ChainProblemSchema,
  ChainVerificationSchema,
  AuditExportSchema,
  AuditCheckpointSchema,
  VerifyAuditCheckpointRequestSchema,
  AuditCheckpointVerificationSchema,
  AcceptInvitationRequestSchema,
  ChangePasswordRequestSchema,
  ElevationSchema,
  UserStatusSchema,
  UserStateSchema,
  UserViewSchema,
  InvitationSchema,
  UserInvitationSchema,
  UserListSchema,
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  SecretTypeSchema,
  VaultStatusSchema,
  InitializeVaultRequestSchema,
  VaultInitializedSchema,
  UnsealVaultRequestSchema,
  ChangeVaultPassphraseRequestSchema,
  ConfirmPassphraseRequestSchema,
  VaultRotatedSchema,
  SecretViewSchema,
  SessionSummarySchema,
  SessionListSchema,
  SessionsRevokedSchema,
  TokenStateSchema,
  TokenViewSchema,
  TokenListSchema,
  CreateTokenRequestSchema,
  CreatedTokenSchema,
  PluginTrustSchema,
  PluginDiscoveryStateSchema,
  PluginStatusSchema,
  PluginPermissionsViewSchema,
  PluginPermissionChangeSchema,
  PluginProvidedSchema,
  PluginRuntimeSchema,
  PluginApprovalSchema,
  PluginViewSchema,
  PluginListSchema,
  EnablePluginRequestSchema,
  PluginConfigFieldSchema,
  PluginConfigViewSchema,
  UpdatePluginConfigRequestSchema,
  PluginSidecarFragmentSchema,
  PluginGatewayRequestSchema,
  PluginGatewayReplySchema,
  SecretListSchema,
  CreateSecretRequestSchema,
  UpdateSecretRequestSchema,
  RevealedSecretSchema,
  ServerStateSchema,
  AccessMethodSchema,
  ServerFactsSummarySchema,
  ServerFactsSchema,
  ServerFactsRecordSchema,
  ServerSummarySchema,
  ServerListSchema,
  ServerHostKeySchema,
  SecretRefSchema,
  ServerAccessSchema,
  ServerViewSchema,
  CreateServerRequestSchema,
  UpdateServerRequestSchema,
  PinHostKeyRequestSchema,
  AddAccessRequestSchema,
  UpdateAccessRequestSchema,
  HostKeyScanSchema,
  AcceptHostKeyRequestSchema,
  HostKeyAcceptedSchema,
  AccessVerificationSchema,
  DangerLevelSchema,
  StringParameterSchema,
  IntegerParameterSchema,
  EnumParameterSchema,
  BooleanParameterSchema,
  SecretParameterSchema,
  ScriptParameterSchema,
  ParameterValuesSchema,
  RunSecretRequestSchema,
  RunSecretViewSchema,
  ScriptSummarySchema,
  ScriptViewSchema,
  ScriptListSchema,
  CreateScriptRequestSchema,
  UpdateScriptRequestSchema,
  CommandRunStateSchema,
  CommandTargetStateSchema,
  CommandRunModeSchema,
  CommandOutputSchema,
  CommandTargetViewSchema,
  CommandRunCountsSchema,
  CommandRunSummarySchema,
  CommandRunViewSchema,
  CommandRunListSchema,
  CreateCommandRunRequestSchema,
  CommandOutputPageSchema,
  ArtifactInterpreterSchema,
  ArtifactStepSchema,
  ArtifactParamSchema,
  ArtifactManifestSchema,
  ArtifactStateSchema,
  ArtifactVersionViewSchema,
  ArtifactViewSchema,
  ArtifactListSchema,
  ArtifactDestinationSchema,
  ArtifactCheckStateSchema,
  ArtifactCatalogueStateSchema,
  ServerArtifactSchema,
  ServerArtifactListSchema,
  PushArtifactRequestSchema,
  ArtifactPushResultSchema,
  ArtifactCheckSchema,
  ArtifactVerificationSchema,
  PanelConnectionStateSchema,
  PanelResourceSchema,
  PanelCapabilityStateSchema,
  PanelCapabilitiesSchema,
  PanelVersionSupportSchema,
  PanelTokenInfoSchema,
  PanelWarningSchema,
  PanelLastErrorSchema,
  PanelConnectionViewSchema,
  ConnectPanelRequestSchema,
  ConnectPanelWithTokenRequestSchema,
  PanelTestResultSchema,
  PanelInboundViewSchema,
  PanelNodeStateSchema,
  PanelNodeViewSchema,
  PanelHostViewSchema,
  PanelConfigProfileSummarySchema,
  PanelConfigProfileViewSchema,
  PanelInternalSquadViewSchema,
  PanelExternalSquadViewSchema,
  PanelSubscriptionTemplateViewSchema,
  PanelSubscriptionSettingsViewSchema,
  PanelSnippetViewSchema,
  PanelNodePluginViewSchema,
  PanelInfraProviderViewSchema,
  PanelBillingNodeViewSchema,
  PanelInfraViewSchema,
  PanelApiTokenViewSchema,
  PanelNodeListSchema,
  PanelHostListSchema,
  PanelConfigProfileListSchema,
  PanelInternalSquadListSchema,
  PanelExternalSquadListSchema,
  PanelSubscriptionTemplateListSchema,
  PanelSnippetListSchema,
  PanelNodePluginListSchema,
  PanelInfraAnswerSchema,
  PanelApiTokenListSchema,
  PanelSubscriptionSettingsAnswerSchema,
  PanelConfigProfileAnswerSchema,
  PanelOverviewSchema,
  CheckSeveritySchema,
  CheckObjectKindSchema,
  CheckObjectRefSchema,
  CheckFixHintSchema,
  PackScopeSchema,
  PackRuleConfigSchema,
  ReconciliationCheckSchema,
  ReconciliationSettingsSchema,
  ImpactSettingsSchema,
  ConventionPackDocumentSchema,
  PackRefSchema,
  ConventionPackViewSchema,
  ConventionPackVersionSchema,
  ConventionPackVersionListSchema,
  SaveConventionPackRequestSchema,
  ValidateConventionPackRequestSchema,
  PackIssueSchema,
  ConventionPackValidationSchema,
  RuleParamInfoSchema,
  ConventionRuleInfoSchema,
  ReconciliationCheckInfoSchema,
  ConventionRuleCatalogSchema,
  ConventionFindingSchema,
  ConventionSummarySchema,
  ConventionRunSchema,
  ConventionLastRunSchema,
  ReconciliationStatusSchema,
  ReconciliationRowSchema,
  ReconciliationSummarySchema,
  ReconciliationReportSchema,
  ImpactKindSchema,
  JsonPatchOperationSchema,
  ImpactRequestSchema,
  ImpactTargetSchema,
  ImpactRuleIdSchema,
  RiskLevelSchema,
  ImpactReportSchema,
  PanelSnapshotKindSchema,
  PanelSnapshotObjectKindSchema,
  PanelSnapshotCoverageSchema,
  PanelSnapshotSummarySchema,
  PanelSnapshotSettingsSchema,
  PanelSnapshotListSchema,
  CreatePanelSnapshotRequestSchema,
  PanelDiffObjectStatusSchema,
  PanelFieldChangeSchema,
  PanelDiffObjectSchema,
  PanelDiffCountsSchema,
  PanelDiffNoteSchema,
  PanelDiffSideSchema,
  PanelDiffSchema,
  PanelConsoleAvailabilitySchema,
  PanelConsoleBlockedReasonSchema,
  PanelConsoleParamSchema,
  PanelConsoleOperationSchema,
  PanelConsoleOperationDetailSchema,
  PanelConsoleCatalogueSchema,
  PanelConsoleRequestSchema,
  PanelConsoleResultSchema,
  PanelConsoleIssuesSchema,
];

type Json = Record<string, unknown>;

function idOf(schema: z.ZodType): string | undefined {
  return z.globalRegistry.get(schema)?.id;
}

function componentRegistry(): z.core.$ZodRegistry<{ id: string }> {
  const registry = z.registry<{ id: string }>();
  for (const schema of COMPONENT_SCHEMAS) {
    const id = idOf(schema);
    if (!id) {
      throw new Error('Every component schema needs meta({ id }).');
    }
    registry.add(schema, { id });
  }
  return registry;
}

function schemaRef(schema: z.ZodType): Json {
  const id = idOf(schema);
  if (id && COMPONENT_SCHEMAS.includes(schema)) {
    return { $ref: `#/components/schemas/${id}` };
  }
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  });
}

function parameters(route: RouteDef): Json[] {
  const out: Json[] = [];
  for (const [where, shape] of [
    ['path', route.request?.params],
    ['query', route.request?.query],
  ] as const) {
    if (!shape) {
      continue;
    }
    for (const [name, field] of Object.entries(shape.shape)) {
      out.push({
        name,
        in: where,
        required: where === 'path' ? true : !field.safeParse(undefined).success,
        schema: schemaRef(field),
      });
    }
  }
  return out;
}

function operation(route: RouteDef): Json {
  const responses: Json = {};
  for (const [status, def] of Object.entries(route.responses)) {
    if (def.binary) {
      responses[status] = {
        description: def.description,
        headers: Object.fromEntries(
          Object.entries(def.binary.headers).map(([name, description]) => [
            name,
            { description, schema: { type: 'string' } },
          ]),
        ),
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      };
      continue;
    }
    responses[status] = def.empty
      ? { description: def.description }
      : {
          description: def.description,
          content: { 'application/json': { schema: schemaRef(def.schema) } },
        };
  }
  responses['default'] = {
    description: 'Error envelope.',
    content: { 'application/json': { schema: schemaRef(ApiErrorSchema) } },
  };
  const op: Json = {
    operationId: route.operationId,
    tags: [...route.tags],
    summary: route.summary,
    responses,
  };
  if (route.description) {
    op['description'] = route.description;
  }
  const params = parameters(route);
  if (params.length > 0) {
    op['parameters'] = params;
  }
  if (route.request?.body) {
    op['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: schemaRef(route.request.body) } },
    };
  }
  op['security'] =
    route.auth === 'none'
      ? []
      : route.auth === 'token'
        ? [{ bearer: [] }]
        : route.auth === 'any'
          ? [{ session: [] }, { bearer: [] }]
          : [{ session: [] }];
  if (route.permission) {
    // Not part of OpenAPI: tells a reader and a generated client which role may call the operation.
    op['x-sw-permission'] = route.permission;
  }
  if (route.stepUp) {
    // Not part of OpenAPI: the session must have been elevated with POST /auth/step-up, or the answer is 403
    // with the error code `step_up_required`.
    op['x-sw-step-up'] = true;
  }
  return op;
}

/** Builds the OpenAPI 3.1 document from the route registry and the Zod schemas. No decorators involved. */
export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method]: operation(route) };
  }
  const { schemas } = z.toJSONSchema(componentRegistry(), {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  for (const schema of Object.values(schemas)) {
    // Zod adds a per-schema $schema and an $id with a fragment; the document already declares the dialect.
    delete schema['$schema'];
    delete schema['$id'];
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Swellwright API',
      version: OPENAPI_INFO_VERSION,
      description: 'Deploy and operate Remnawave fleets. Unofficial community project.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'system', description: 'Probes, version and the API description.' },
      { name: 'setup', description: 'First-run setup of a new instance.' },
      { name: 'auth', description: 'Sign-in with a password and an authenticator, sessions.' },
      { name: 'users', description: 'Users, their roles, invitations and credential resets.' },
      {
        name: 'vault',
        description:
          'The secrets vault: sealed on start, opened with a passphrase, values write-only.',
      },
      { name: 'roles', description: 'Built-in roles and the permission catalogue.' },
      { name: 'audit', description: 'The append-only audit log and its integrity check.' },
      { name: 'sessions', description: 'Signed-in browser sessions and how to end them.' },
      { name: 'tokens', description: 'API tokens for the CLI and integrations.' },
      {
        name: 'servers',
        description:
          'The inventory of servers: addresses, pinned SSH host keys (read from the server and confirmed by a person), access entries that name vault secrets and can be tried, facts collected over SSH, and the artifacts pushed to each server.',
      },
      {
        name: 'artifacts',
        description:
          'The catalogue of built-in artifacts: versioned files whose SHA-256 is checked before they are served or sent to a server.',
      },
      {
        name: 'commands',
        description:
          'The script library and runs of a script or a command on several servers at once, with the output of each server (ADR 0038). Writing scripts and starting or stopping runs need `servers:exec` and a fresh authenticator code; reading the history needs `servers:read`.',
      },
      {
        name: 'panel',
        description:
          "The connection to a Remnawave panel and read-only views of its objects (ADR 0041): nodes, hosts, config profiles, squads, templates, snippets, node plugins and billing. Secrets in what the panel returns are masked before they leave this server. Snapshots of the panel and the diff between two of them (ADR 0043) are kept masked as well. The API console (ADR 0046) lists every operation of the panel's API and sends the reads among them, never anything else, with every answer masked.",
      },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sw_session',
          description:
            'Set by the sign-in routes. Routes marked as needing a session accept a signed-in one; the second sign-in step accepts one whose password was accepted.',
        },
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API token (`swt_...`) created in the console. It carries a subset of the permissions of its owner, expires, and is refused on every route that needs a fresh second factor.',
        },
      },
    },
  };
}
