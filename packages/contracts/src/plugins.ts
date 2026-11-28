import { z } from 'zod';

/**
 * Where a plugin directory comes from (ADR 0021, 0031): the monorepo's plugins, a directory of this instance, or a
 * directory of plugins by others. A community plugin never runs code in a process of the core's: only as a sidecar
 * container or as a declarative driver.
 */
export const PLUGIN_TRUSTS = ['official', 'local', 'community'] as const;
export const PluginTrustSchema = z.enum(PLUGIN_TRUSTS).meta({ id: 'PluginTrust' });
export type PluginTrust = z.infer<typeof PluginTrustSchema>;

/** What discovery says about the files of a plugin, whatever the administrator did with it. */
export const PLUGIN_DISCOVERY_STATES = ['available', 'incompatible', 'invalid'] as const;
export const PluginDiscoveryStateSchema = z
  .enum(PLUGIN_DISCOVERY_STATES)
  .meta({ id: 'PluginDiscoveryState' });
export type PluginDiscoveryState = z.infer<typeof PluginDiscoveryStateSchema>;

/**
 * Where a plugin stands.
 * - `not_enabled`: usable, never approved.
 * - `enabled`: approved, and the files and the manifest are what was approved.
 * - `disabled`: approved before and turned off since; the files are still what was approved.
 * - `changed`: approved before, but the files differ now; it does not run until approved again.
 * - `unavailable`: its files are invalid or for other versions of Swellwright; it cannot be enabled.
 * - `missing`: approved before, and gone from the disk.
 */
export const PLUGIN_STATUSES = [
  'not_enabled',
  'enabled',
  'disabled',
  'changed',
  'unavailable',
  'missing',
] as const;
export const PluginStatusSchema = z.enum(PLUGIN_STATUSES).meta({ id: 'PluginStatus' });
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

/** What a plugin asks for, as it is shown to the administrator who enables it. Everything else is denied. */
export const PluginPermissionsViewSchema = z
  .object({
    network: z
      .array(z.string())
      .describe('Hosts it may call, as host:port, only through the core.'),
    secrets: z.array(z.string()).describe('Kinds of secret it may be handed, for one call.'),
    panel: z.array(z.string()).describe('Scopes of the panel API it may use.'),
    ssh: z.boolean().describe('Whether it may run commands on servers.'),
  })
  .meta({ id: 'PluginPermissions' });
export type PluginPermissionsView = z.infer<typeof PluginPermissionsViewSchema>;

const ListChangeSchema = z.object({ added: z.array(z.string()), removed: z.array(z.string()) });

/** What changed between what was approved and what the files ask for now. */
export const PluginPermissionChangeSchema = z
  .object({
    network: ListChangeSchema,
    secrets: ListChangeSchema,
    panel: ListChangeSchema,
    ssh: z.enum(['granted', 'revoked', 'unchanged']),
    widens: z.boolean().describe('It may do more than what was approved.'),
  })
  .meta({ id: 'PluginPermissionChange' });
export type PluginPermissionChange = z.infer<typeof PluginPermissionChangeSchema>;

export const PluginProvidedSchema = z
  .object({
    kind: z.string().describe('The extension kind, for example `DnsProvider`.'),
    mode: z.enum(['code', 'declarative']).describe('Runs its own code, or is described in data.'),
  })
  .meta({ id: 'PluginProvided' });

/** Whether a plugin has a process, and what it is doing (ADR 0028). Only an enabled plugin ever has one. */
export const PLUGIN_RUNTIME_STATES = ['stopped', 'running', 'failed'] as const;
export const PluginRuntimeSchema = z
  .object({
    state: z.enum(PLUGIN_RUNTIME_STATES),
    startedAt: z.iso.datetime().nullable(),
    calls: z.number().int().describe('Calls made since the process started.'),
    lastError: z.string().nullable().describe('A diagnostic from the core, or null.'),
    modules: z
      .array(z.object({ kind: z.string(), methods: z.array(z.string()) }))
      .describe('What the process loaded: each extension kind and the methods it offers.'),
  })
  .meta({ id: 'PluginRuntime' });
export type PluginRuntime = z.infer<typeof PluginRuntimeSchema>;

export const PluginApprovalSchema = z
  .object({
    version: z.string(),
    trust: PluginTrustSchema,
    digest: z.string(),
    permissions: PluginPermissionsViewSchema,
    approvedAt: z.iso.datetime(),
    approvedBy: z.string().describe('The user name at the time.'),
  })
  .meta({ id: 'PluginApproval', description: 'What an administrator approved, and when.' });
export type PluginApproval = z.infer<typeof PluginApprovalSchema>;

export const PluginViewSchema = z
  .object({
    id: z.string().describe('The plugin id; for a directory that is not a plugin, its name.'),
    folder: z.string().nullable().describe('The directory name; null when it is gone.'),
    trust: PluginTrustSchema.nullable(),
    discovery: PluginDiscoveryStateSchema.nullable().describe('Null when the plugin is gone.'),
    status: PluginStatusSchema,
    problems: z.array(z.string()).describe('Why it is invalid or incompatible.'),
    name: z.string().nullable(),
    version: z.string().nullable(),
    description: z.string().nullable(),
    license: z.string().nullable(),
    provides: z.array(PluginProvidedSchema),
    permissions: PluginPermissionsViewSchema.nullable().describe('What its files ask for now.'),
    digest: z
      .string()
      .nullable()
      .describe('SHA-256 over every file of the plugin; approval is tied to it.'),
    signed: z
      .boolean()
      .describe('The manifest carries a signature. It is not verified yet, so it proves nothing.'),
    hasSettings: z.boolean().describe('It brings a settings page of its own.'),
    hasConfig: z.boolean().describe('It has settings of its own to fill in (a `config.schema`).'),
    sidecar: z
      .object({
        image: z.string(),
        port: z.number().int(),
        memoryMiB: z.number().int(),
        cpus: z.number(),
      })
      .nullable()
      .describe('How its container is run, when its code runs as a sidecar (ADR 0031).'),
    approval: PluginApprovalSchema.nullable(),
    runtime: PluginRuntimeSchema,
    change: PluginPermissionChangeSchema.nullable().describe(
      'For a changed plugin: what its permissions differ by from the approved ones.',
    ),
  })
  .meta({ id: 'PluginView' });
export type PluginView = z.infer<typeof PluginViewSchema>;

export const PluginListSchema = z
  .object({
    plugins: z.array(PluginViewSchema),
    directories: z
      .object({ official: z.boolean(), local: z.boolean(), community: z.boolean() })
      .describe('Which plugin directories are configured.'),
  })
  .meta({ id: 'PluginList' });
export type PluginList = z.infer<typeof PluginListSchema>;

const ConfigValueSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);

/** One setting of a plugin, as the console draws it (ADR 0029). */
export const PluginConfigFieldSchema = z
  .object({
    name: z.string(),
    type: z.enum(['string', 'integer', 'number', 'boolean']),
    title: z.string().nullable(),
    description: z.string().nullable(),
    required: z.boolean(),
    default: ConfigValueSchema,
    minLength: z.number().int().nullable(),
    maxLength: z.number().int().nullable(),
    minimum: z.number().nullable(),
    maximum: z.number().nullable(),
    choices: z.array(z.string()).nullable().describe('A closed list of values, if there is one.'),
    secretKind: z
      .string()
      .nullable()
      .describe(
        'Set: the field holds the id of a vault secret of this kind (for example `dns-oauth`).',
      ),
  })
  .meta({ id: 'PluginConfigField' });
export type PluginConfigField = z.infer<typeof PluginConfigFieldSchema>;

export const PluginConfigViewSchema = z
  .object({
    fields: z.array(PluginConfigFieldSchema),
    values: z
      .record(z.string(), ConfigValueSchema)
      .describe(
        'What is set now, defaults applied. A secret field holds the id of a secret, or null.',
      ),
    problems: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .describe(
        'What is wrong with the stored settings for the plugin as it is now (a field it added).',
      ),
    updatedAt: z.iso.datetime().nullable(),
    updatedBy: z.string().nullable(),
  })
  .meta({ id: 'PluginConfigView' });
export type PluginConfigView = z.infer<typeof PluginConfigViewSchema>;

export const UpdatePluginConfigRequestSchema = z
  .object({ values: z.record(z.string(), ConfigValueSchema) })
  .meta({ id: 'UpdatePluginConfigRequest' });
export type UpdatePluginConfigRequest = z.infer<typeof UpdatePluginConfigRequestSchema>;

/** What the administrator applies to run a plugin's container: a Docker Compose fragment (ADR 0031). */
export const PluginSidecarFragmentSchema = z
  .object({
    service: z.string().describe('The name of the compose service of the sidecar.'),
    compose: z
      .string()
      .describe(
        "The compose file to add to the stack. It holds the plugin's token: keep it like a secret.",
      ),
    coreUrl: z.string().describe('Where the sidecar reaches Swellwright from its network.'),
  })
  .meta({ id: 'PluginSidecarFragment' });
export type PluginSidecarFragment = z.infer<typeof PluginSidecarFragmentSchema>;

/**
 * What a sidecar asks of the core, over HTTP with its token. The same three things a plugin process asks over
 * its channel (ADR 0028, 0029): the network, a secret bound to a setting, its storage.
 */
export const PluginGatewayRequestSchema = z
  .discriminatedUnion('op', [
    z.object({
      op: z.literal('fetch'),
      url: z.string().max(4096),
      init: z
        .object({
          method: z.string().max(10).optional(),
          headers: z.record(z.string().max(100), z.string().max(8192)).optional(),
          body: z.string().max(2_000_000).optional(),
        })
        .optional(),
    }),
    z.object({ op: z.literal('secret'), field: z.string().max(64) }),
    z.object({
      op: z.literal('storage'),
      action: z.enum(['get', 'set', 'delete', 'keys']),
      key: z.string().max(200).optional(),
      value: z.unknown().optional(),
    }),
  ])
  .meta({ id: 'PluginGatewayRequest' });
export type PluginGatewayRequest = z.infer<typeof PluginGatewayRequestSchema>;

export const PluginGatewayReplySchema = z
  .object({
    ok: z.boolean(),
    value: z.unknown().optional(),
    message: z.string().optional().describe('Why the core refused, when `ok` is false.'),
  })
  .meta({ id: 'PluginGatewayReply' });
export type PluginGatewayReply = z.infer<typeof PluginGatewayReplySchema>;

export const PluginIdParamsSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
});

/** The digest is what the administrator was shown; if the files changed since, the approval is refused. */
export const EnablePluginRequestSchema = z
  .object({
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .describe(
        'The digest of the plugin as shown; the plugin is enabled only if it is still this.',
      ),
  })
  .meta({ id: 'EnablePluginRequest' });
export type EnablePluginRequest = z.infer<typeof EnablePluginRequestSchema>;
