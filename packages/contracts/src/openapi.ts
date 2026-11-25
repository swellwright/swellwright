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
  ReconciliationLastSchema,
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
import {
  BaselineCategorySchema,
  BaselineSeveritySchema,
  ExpectationSchema,
  ObserveSchema,
  BaselineCheckSchema,
  BaselineDocumentSchema,
  CheckStatusSchema,
  ObservationStatusSchema,
  CheckRunStateSchema,
  CheckTriggerSchema,
  ObservedValueSchema,
  CheckResultViewSchema,
  CheckCountsSchema,
  CheckRunSummarySchema,
  CheckRunViewSchema,
  CheckRunListSchema,
  DriftChangeSchema,
  DriftItemSchema,
  DriftCountsSchema,
  CheckRunDiffSchema,
  BaselineVersionInfoSchema,
  BaselineAssignmentsSchema,
  BaselineSummarySchema,
  BaselineListSchema,
  BaselineViewSchema,
  CreateBaselineRequestSchema,
  UpdateBaselineRequestSchema,
  ValidateBaselineRequestSchema,
  BaselineIssueSchema,
  ValidateBaselineResultSchema,
  SetBaselineAssignmentsRequestSchema,
  ObservationCatalogueSchema,
  StartServerBaselineRunRequestSchema,
  StartBaselineRunsRequestSchema,
  StartBaselineRunsResultSchema,
  BaselineFleetItemSchema,
  BaselineFleetSchema,
} from './baselines.js';
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
import {
  AttentionFeedSchema,
  AttentionItemSchema,
  AttentionKindSchema,
  AttentionLinkSchema,
  AttentionSeveritySchema,
  AttentionSourceSchema,
  AttentionSourceStateSchema,
  FleetFlagSchema,
  FleetHealthRowSchema,
  FleetHealthSchema,
  FleetHealthStateSchema,
} from './dashboard.js';
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
export const OPENAPI_INFO_VERSION = '0.32.0';

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
  ReconciliationLastSchema,
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
  BaselineCategorySchema,
  BaselineSeveritySchema,
  ExpectationSchema,
  ObserveSchema,
  BaselineCheckSchema,
  BaselineDocumentSchema,
  CheckStatusSchema,
  ObservationStatusSchema,
  CheckRunStateSchema,
  CheckTriggerSchema,
  ObservedValueSchema,
  CheckResultViewSchema,
  CheckCountsSchema,
  CheckRunSummarySchema,
  CheckRunViewSchema,
  CheckRunListSchema,
  DriftChangeSchema,
  DriftItemSchema,
  DriftCountsSchema,
  CheckRunDiffSchema,
  BaselineVersionInfoSchema,
  BaselineAssignmentsSchema,
  BaselineSummarySchema,
  BaselineListSchema,
  BaselineViewSchema,
  CreateBaselineRequestSchema,
  UpdateBaselineRequestSchema,
  ValidateBaselineRequestSchema,
  BaselineIssueSchema,
  ValidateBaselineResultSchema,
  SetBaselineAssignmentsRequestSchema,
  ObservationCatalogueSchema,
  StartServerBaselineRunRequestSchema,
  StartBaselineRunsRequestSchema,
  StartBaselineRunsResultSchema,
  BaselineFleetItemSchema,
  BaselineFleetSchema,
  PanelConsoleAvailabilitySchema,
  PanelConsoleBlockedReasonSchema,
  PanelConsoleParamSchema,
  PanelConsoleOperationSchema,
  PanelConsoleOperationDetailSchema,
  PanelConsoleCatalogueSchema,
  PanelConsoleRequestSchema,
  AttentionSeveritySchema,
  AttentionSourceSchema,
  AttentionKindSchema,
  AttentionLinkSchema,
  AttentionItemSchema,
  AttentionSourceStateSchema,
  AttentionFeedSchema,
  FleetHealthStateSchema,
  FleetFlagSchema,
  FleetHealthRowSchema,
  FleetHealthSchema,
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

/**
 * A schema as a request reads it (`input`: a field with a default may be left out) or as a response writes it
 * (`output`: the default is filled in, so the field is always there).
 */
type Io = 'input' | 'output';

function schemaRef(schema: z.ZodType, io: Io = 'output'): Json {
  const id = idOf(schema);
  if (id && COMPONENT_SCHEMAS.includes(schema)) {
    return { $ref: `#/components/schemas/${id}` };
  }
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  });
}

function renderComponents(io: Io): Record<string, Json> {
  const { schemas } = z.toJSONSchema(componentRegistry(), {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  for (const schema of Object.values(schemas)) {
    // Zod adds a per-schema $schema and an $id with a fragment; the document already declares the dialect.
    delete schema['$schema'];
    delete schema['$id'];
  }
  return schemas;
}

function refsIn(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      refsIn(item, out);
    }
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === '$ref' && typeof value === 'string') {
        out.add(value.slice('#/components/schemas/'.length));
      } else {
        refsIn(value, out);
      }
    }
  }
  return out;
}

/** Every component a set of roots reaches, the roots included, following `$ref` through `schemas`. */
function reach(roots: Iterable<string>, schemas: Record<string, Json>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    queue.push(...refsIn(schemas[name], new Set()));
  }
  return seen;
}

/** Every `required` list in a schema, by its place in the tree. */
function requiredLists(
  node: unknown,
  path = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (Array.isArray(node)) {
    node.forEach((item, index) => requiredLists(item, `${path}/${String(index)}`, out));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === 'required' && Array.isArray(value)) {
        out.set(path, JSON.stringify([...(value as string[])].sort()));
      } else {
        requiredLists(value, `${path}/${key}`, out);
      }
    }
  }
  return out;
}

/**
 * The component schemas. A component that only requests use is described as a request reads it, so a field with a
 * default is optional there; one that responses use is described as it is written. A component both use must require
 * the same fields either way (no defaults), or the document could not say both: the build fails and names it.
 */
function components(): Record<string, Json> {
  const output = renderComponents('output');
  const input = renderComponents('input');
  const requestRoots = new Set<string>();
  const responseRoots = new Set<string>(['ApiError']);
  for (const route of routes as readonly RouteDef[]) {
    const body = route.request?.body;
    if (body) {
      refsIn(schemaRef(body, 'input'), requestRoots);
    }
    for (const shape of [route.request?.params, route.request?.query]) {
      for (const field of Object.values(shape?.shape ?? {})) {
        refsIn(schemaRef(field), responseRoots);
      }
    }
    for (const def of Object.values(route.responses)) {
      if (!def.binary && !def.empty) {
        refsIn(schemaRef(def.schema), responseRoots);
      }
    }
  }
  const forRequests = reach(requestRoots, input);
  const forResponses = reach(responseRoots, output);
  const schemas: Record<string, Json> = {};
  for (const [name, written] of Object.entries(output)) {
    const read = input[name];
    if (forRequests.has(name) && !forResponses.has(name)) {
      schemas[name] = read ?? written;
      continue;
    }
    if (
      forRequests.has(name) &&
      JSON.stringify([...requiredLists(read)]) !== JSON.stringify([...requiredLists(written)])
    ) {
      throw new Error(
        `The component ${name} is used by requests and responses but requires different fields in each.`,
      );
    }
    schemas[name] = written;
  }
  return schemas;
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
        content: {
          [def.binary.contentType ?? 'application/octet-stream']: {
            schema: { type: 'string', format: 'binary' },
          },
        },
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
      content: { 'application/json': { schema: schemaRef(route.request.body, 'input') } },
    };
  }
  op['security'] =
    route.handlerAuth === 'sidecar'
      ? [{ sidecar: [] }]
      : route.auth === 'none'
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
  const schemas = components();
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
        name: 'baselines',
        description:
          'Baseline checks of servers over SSH (ADR 0045): documents that say what a healthy server looks like, the closed catalogue of read-only observations they use, runs that compare a server with its baseline, the drift between two runs and the state of the fleet. Starting a run needs `servers:exec` and a fresh authenticator code; editing a baseline needs `servers:write` and one; reading needs `servers:read`. A run changes nothing on a server.',
      },
      {
        name: 'dashboard',
        description:
          'The dashboard (ADR 0047): what needs attention and the health of the fleet, built only from the records and the memory of this server. Nothing here calls the panel or a server.',
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
        sidecar: {
          type: 'http',
          scheme: 'bearer',
          description:
            "The token of a plugin's sidecar container, from its compose fragment (`GET /plugins/{id}/sidecar`). Accepted only by that plugin's gateway, never by any other route; it is not an API token.",
        },
      },
    },
  };
}
