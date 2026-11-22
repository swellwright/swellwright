import { z } from 'zod';

import { PanelResourceSchema } from './panel.js';

// The three checks of phase 3 that think about what the panel holds (ADR 0044): the convention linter, the
// reconciliation of hosts with nodes and with the server inventory, and the impact calculator (a dry run). All three
// are read-only: they read what the panel reported (masked, ADR 0041), compute, and answer. Nothing here writes to the
// panel; a `fix` is a hint of what a later, approved write would change.

/** The format marker of a convention pack document. A new, incompatible format gets a new marker. */
export const CONVENTION_PACK_FORMAT = 'swellwright.conventions/v1' as const;

/** The most a pack document, a pack as text, a rule's parameters and a result may hold. */
export const CONVENTION_PACK_LIMITS = {
  /** The pack as typed (YAML or JSON), in characters. */
  textChars: 262_144,
  rules: 200,
  tagsPerScope: 50,
  tagChars: 64,
  patternChars: 256,
  /** A regular expression is matched against at most this many characters of a value; a longer value does not match. */
  matchedChars: 512,
  findings: 5000,
  rows: 5000,
} as const;

export const CHECK_SEVERITIES = ['error', 'warning', 'info'] as const;
export const CheckSeveritySchema = z.enum(CHECK_SEVERITIES).meta({ id: 'CheckSeverity' });
export type CheckSeverity = z.infer<typeof CheckSeveritySchema>;

export const CHECK_OBJECT_KINDS = [
  'panel',
  'host',
  'node',
  'configProfile',
  'inbound',
  'internalSquad',
  'externalSquad',
  'subscriptionTemplate',
  'snippet',
  'nodePlugin',
  'server',
] as const;
export const CheckObjectKindSchema = z
  .enum(CHECK_OBJECT_KINDS)
  .meta({ id: 'CheckObjectKind', description: 'The kind of object a finding or a row is about.' });
export type CheckObjectKind = z.infer<typeof CheckObjectKindSchema>;

export const CheckObjectRefSchema = z
  .object({
    kind: CheckObjectKindSchema,
    uuid: z.string().max(64).nullable().describe('Null for the panel itself.'),
    name: z.string().max(300),
  })
  .meta({ id: 'CheckObjectRef' });
export type CheckObjectRef = z.infer<typeof CheckObjectRefSchema>;

/** A value in a message or a hint: nothing nested, nothing that can hold a secret (the views are masked already). */
const ParamValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
export const CheckParamsSchema = z.record(z.string().max(64), ParamValue);
export type CheckParams = z.infer<typeof CheckParamsSchema>;

const FixValue = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(500)).max(100),
]);

export const CheckFixHintSchema = z
  .object({
    op: z.enum(['replace', 'add', 'remove']),
    path: z
      .string()
      .max(300)
      .describe(
        'A JSON Pointer (RFC 6901) into the editable form of the object, the one the panel API takes, for example `/address`.',
      ),
    from: FixValue.describe('What it is now; null when there is nothing (add).'),
    to: FixValue.describe('What it would become; null when it would go (remove).'),
    note: z.string().max(300).optional(),
  })
  .meta({
    id: 'CheckFixHint',
    description:
      'What a later write would change to resolve the finding. Informational: this release never writes to the panel.',
  });
export type CheckFixHint = z.infer<typeof CheckFixHintSchema>;

// ---------------------------------------------------------------------------------------------------------------
// The convention pack: rules as data.

const Tag = z.string().min(1).max(CONVENTION_PACK_LIMITS.tagChars);

export const PackScopeSchema = z
  .strictObject({
    tags: z
      .array(Tag)
      .max(CONVENTION_PACK_LIMITS.tagsPerScope)
      .optional()
      .describe('Only objects that carry at least one of these tags.'),
    excludeTags: z
      .array(Tag)
      .max(CONVENTION_PACK_LIMITS.tagsPerScope)
      .optional()
      .describe(
        'Not the objects that carry any of these tags (for example a tag for test objects).',
      ),
    match: z
      .string()
      .max(CONVENTION_PACK_LIMITS.patternChars)
      .optional()
      .describe(
        'Only objects whose name (the remark of a host) matches this pattern entirely. The pattern language is the safe subset described in `docs/en/conventions.md`.',
      ),
    exclude: z
      .string()
      .max(CONVENTION_PACK_LIMITS.patternChars)
      .optional()
      .describe(
        'Not the objects whose name matches this pattern entirely (for example a marker of test objects).',
      ),
  })
  .meta({
    id: 'PackScope',
    description:
      'Which objects a rule applies to. A rule that has its own scope uses only that; otherwise the scope of the pack applies. Nothing set: every object.',
  });
export type PackScope = z.infer<typeof PackScopeSchema>;

export const PackRuleConfigSchema = z
  .strictObject({
    enabled: z.boolean().optional().describe('`false` switches the rule off.'),
    severity: CheckSeveritySchema.optional().describe(
      'Replaces the severity of every finding of the rule.',
    ),
    params: z
      .record(z.string().max(64), z.unknown())
      .optional()
      .describe(
        'The parameters of this rule; each rule says which it takes (`GET /panel/checks/rules`).',
      ),
    scope: PackScopeSchema.optional(),
    note: z
      .string()
      .max(300)
      .optional()
      .describe('Why this rule is set this way. Shown with the rule.'),
  })
  .meta({ id: 'PackRuleConfig' });
export type PackRuleConfig = z.infer<typeof PackRuleConfigSchema>;

export const HOST_ADDRESS_EXPECTATIONS = ['node', 'node-ip', 'node-address', 'none'] as const;
export const HOST_SNI_EXPECTATIONS = ['none', 'node-address'] as const;
export const HOST_PORT_EXPECTATIONS = ['none', 'inbound'] as const;
export const INVENTORY_MATCH_METHODS = ['address', 'dns', 'hostname'] as const;

/** The checks reconciliation makes, by the id a pack can switch off. */
export const RECONCILIATION_CHECKS = [
  'host.address',
  'host.sni',
  'host.port',
  'host.node',
  'host.duplicate',
  'node.dns',
  'node.disabled-resolving',
  'node.duplicate',
  'node.server',
  'server.node',
  'server.duplicate',
] as const;
export const ReconciliationCheckSchema = z
  .enum(RECONCILIATION_CHECKS)
  .meta({ id: 'ReconciliationCheck' });
export type ReconciliationCheck = z.infer<typeof ReconciliationCheckSchema>;

export const ReconciliationSettingsSchema = z
  .strictObject({
    hostAddress: z
      .enum(HOST_ADDRESS_EXPECTATIONS)
      .optional()
      .describe(
        'What the `address` of a host must be, compared with the node that serves it. `node` (default): the address of the node or an IP it resolves to, as a name or as an IP. `node-ip`: an IP of the node. `node-address`: exactly the address the panel has for the node. `none`: not checked.',
      ),
    hostSni: z
      .enum(HOST_SNI_EXPECTATIONS)
      .optional()
      .describe(
        'What the `sni` of a host must be. `none` (default): not checked. `node-address`: the address of the node, when that is a name.',
      ),
    hostPort: z
      .enum(HOST_PORT_EXPECTATIONS)
      .optional()
      .describe(
        'What the `port` of a host must be. `none` (default): not checked (a front end often listens on another port than the inbound). `inbound`: the port of its inbound.',
      ),
    dns: z
      .strictObject({
        enabled: z
          .boolean()
          .optional()
          .describe('`false`: no name is looked up; checks that need a lookup say "unknown".'),
        maxTtlSeconds: z
          .number()
          .int()
          .min(0)
          .max(86_400)
          .optional()
          .describe('A record with a longer time to live is reported with a hint (default 3600).'),
      })
      .optional(),
    inventory: z
      .strictObject({
        matchBy: z
          .array(z.enum(INVENTORY_MATCH_METHODS))
          .min(1)
          .max(3)
          .optional()
          .describe('How a node is matched with a server of the inventory (default: all three).'),
        reportUnmanaged: z
          .boolean()
          .optional()
          .describe(
            'A node of the panel that no server of the inventory matches is `missing` (default true).',
          ),
        reportExtra: z
          .boolean()
          .optional()
          .describe(
            'A server of the inventory that no node matches is `extra` (default true). Retired servers are never reported.',
          ),
      })
      .optional(),
    checks: z
      .partialRecord(ReconciliationCheckSchema, z.strictObject({ enabled: z.boolean().optional() }))
      .optional()
      .describe('Switches single checks off (`enabled: false`).'),
    scope: PackScopeSchema.optional().describe(
      'Hosts, nodes and servers that reconciliation leaves out.',
    ),
  })
  .meta({ id: 'ReconciliationSettings' });
export type ReconciliationSettings = z.infer<typeof ReconciliationSettingsSchema>;

export const ImpactSettingsSchema = z
  .strictObject({
    highRiskRestartNodes: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('A change that restarts at least this many nodes is high risk (default 3).'),
    highRiskRestartShare: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'A change that restarts at least this share of the running nodes is high risk (default 0.5).',
      ),
  })
  .meta({ id: 'ImpactSettings' });
export type ImpactSettings = z.infer<typeof ImpactSettingsSchema>;

export const ConventionPackDocumentSchema = z
  .strictObject({
    format: z.literal(CONVENTION_PACK_FORMAT),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).optional(),
    scope: PackScopeSchema.optional().describe('The scope of every rule that has none of its own.'),
    rules: z
      .record(z.string().min(1).max(64), PackRuleConfigSchema)
      .refine((rules) => Object.keys(rules).length <= CONVENTION_PACK_LIMITS.rules, {
        message: `A pack configures at most ${String(CONVENTION_PACK_LIMITS.rules)} rules.`,
      })
      .optional()
      .describe('Settings by rule id. A rule that is not named keeps its defaults.'),
    reconciliation: ReconciliationSettingsSchema.optional(),
    impact: ImpactSettingsSchema.optional(),
  })
  .meta({
    id: 'ConventionPackDocument',
    description:
      'A set of conventions as data: which rules run, how severe they are, their parameters, whom they apply to, and what reconciliation and the impact calculator expect. Unknown keys are refused, so a typo does not pass as a setting.',
  });
export type ConventionPackDocument = z.infer<typeof ConventionPackDocumentSchema>;

export const PackRefSchema = z
  .object({
    source: z.enum(['built-in', 'custom']),
    version: z.number().int().positive().nullable().describe('Null for the built-in pack.'),
    name: z.string(),
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .describe('SHA-256 of the canonical JSON of the document.'),
  })
  .meta({ id: 'PackRef' });
export type PackRef = z.infer<typeof PackRefSchema>;

export const ConventionPackViewSchema = z
  .object({
    pack: PackRefSchema,
    description: z.string().nullable(),
    comment: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
    createdBy: z.string().nullable().describe('The login of the user who saved it.'),
    active: z.boolean().describe('Whether this version is the one in use.'),
    document: ConventionPackDocumentSchema,
    yaml: z.string().describe('The pack as the user wrote it, or a rendering of the built-in one.'),
  })
  .meta({ id: 'ConventionPackView' });
export type ConventionPackView = z.infer<typeof ConventionPackViewSchema>;

export const ConventionPackVersionSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string(),
    hash: z.string(),
    active: z.boolean(),
    comment: z.string().nullable(),
    createdAt: z.iso.datetime(),
    createdBy: z.string().nullable(),
  })
  .meta({ id: 'ConventionPackVersion' });
export type ConventionPackVersion = z.infer<typeof ConventionPackVersionSchema>;

export const ConventionPackVersionListSchema = z
  .object({ versions: z.array(ConventionPackVersionSchema).describe('Newest first.') })
  .meta({ id: 'ConventionPackVersionList' });
export type ConventionPackVersionList = z.infer<typeof ConventionPackVersionListSchema>;

export const ConventionPackQuerySchema = z.object({
  version: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('A version from the history; the active pack when not given.'),
});

const PackSource = {
  yaml: z
    .string()
    .max(CONVENTION_PACK_LIMITS.textChars)
    .optional()
    .describe('The pack as YAML (JSON is YAML too). Kept as written, with its comments.'),
  document: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The pack as a JSON object, instead of `yaml`.'),
};
const exactlyOneSource = (value: { yaml?: string | undefined; document?: unknown }): boolean =>
  (value.yaml === undefined) !== (value.document === undefined);

export const ValidateConventionPackRequestSchema = z
  .object(PackSource)
  .refine(exactlyOneSource, {
    message: 'Give either `yaml` or `document`, not both and not neither.',
  })
  .meta({ id: 'ValidateConventionPackRequest' });
export type ValidateConventionPackRequest = z.infer<typeof ValidateConventionPackRequestSchema>;

export const SaveConventionPackRequestSchema = z
  .object({
    ...PackSource,
    comment: z.string().trim().max(500).optional().describe('Why it changes. Kept in the history.'),
    expectedVersion: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        'The version the editor started from; `null` for "no pack was saved yet". When the active pack is another one, the answer is 409 and nothing is saved.',
      ),
  })
  .refine(exactlyOneSource, {
    message: 'Give either `yaml` or `document`, not both and not neither.',
  })
  .meta({ id: 'SaveConventionPackRequest' });
export type SaveConventionPackRequest = z.infer<typeof SaveConventionPackRequestSchema>;

export const PackIssueSchema = z
  .object({
    severity: z.enum(['error', 'warning']),
    path: z
      .string()
      .max(300)
      .describe('Where, as a path into the document: `rules.host.remark-pattern.params.pattern`.'),
    message: z.string().max(500),
    line: z.number().int().positive().nullable().describe('For a YAML syntax error.'),
    column: z.number().int().positive().nullable(),
  })
  .meta({ id: 'PackIssue' });
export type PackIssue = z.infer<typeof PackIssueSchema>;

export const ConventionPackValidationSchema = z
  .object({
    valid: z
      .boolean()
      .describe('True when there is no error (warnings do not make a pack invalid).'),
    issues: z.array(PackIssueSchema),
    name: z.string().nullable(),
    rules: z.number().int().nonnegative().describe('How many rules the pack configures.'),
    hash: z.string().nullable(),
  })
  .meta({ id: 'ConventionPackValidation' });
export type ConventionPackValidation = z.infer<typeof ConventionPackValidationSchema>;

// ---------------------------------------------------------------------------------------------------------------
// The rule catalogue.

export const RULE_PARAM_TYPES = [
  'string',
  'number',
  'boolean',
  'enum',
  'pattern',
  'string-list',
  'ranges',
] as const;

export const RuleParamInfoSchema = z
  .object({
    name: z.string(),
    type: z.enum(RULE_PARAM_TYPES),
    description: z.string(),
    default: z
      .unknown()
      .describe('The value used when the pack does not set it (null: the rule needs it).'),
    values: z.array(z.string()).nullable().describe('For an enumeration, the allowed values.'),
  })
  .meta({ id: 'RuleParamInfo' });
export type RuleParamInfo = z.infer<typeof RuleParamInfoSchema>;

export const ConventionRuleInfoSchema = z
  .object({
    id: z.string(),
    kind: CheckObjectKindSchema.describe('The kind of object the rule reports on.'),
    title: z.string(),
    description: z.string(),
    defaultSeverity: CheckSeveritySchema,
    needs: z.array(PanelResourceSchema).describe('What must be readable for the rule to run.'),
    codes: z.array(z.string()).describe('The kinds of finding the rule makes.'),
    params: z.array(RuleParamInfoSchema),
    effective: z.object({
      enabled: z.boolean(),
      severity: CheckSeveritySchema,
      params: z.record(z.string(), z.unknown()),
      scope: PackScopeSchema.nullable().describe(
        "The scope in force (the rule's own, or the pack's); null: every object.",
      ),
      active: z
        .boolean()
        .describe(
          'Whether the rule runs. False when switched off or when a parameter it needs is not set.',
        ),
      inactive: z.enum(['disabled', 'needs_params']).nullable(),
      note: z.string().nullable(),
    }),
  })
  .meta({ id: 'ConventionRuleInfo' });
export type ConventionRuleInfo = z.infer<typeof ConventionRuleInfoSchema>;

export const ReconciliationCheckInfoSchema = z
  .object({
    id: ReconciliationCheckSchema,
    title: z.string(),
    description: z.string(),
    enabled: z.boolean(),
  })
  .meta({ id: 'ReconciliationCheckInfo' });

export const ConventionRuleCatalogSchema = z
  .object({
    pack: PackRefSchema,
    rules: z.array(ConventionRuleInfoSchema),
    reconciliationChecks: z.array(ReconciliationCheckInfoSchema),
  })
  .meta({ id: 'ConventionRuleCatalog' });
export type ConventionRuleCatalog = z.infer<typeof ConventionRuleCatalogSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Findings and runs.

export const ConventionFindingSchema = z
  .object({
    id: z
      .string()
      .max(400)
      .describe(
        'Stable between runs for the same rule, kind of finding, object and field: compare runs by it.',
      ),
    ruleId: z.string(),
    code: z.string().describe('The kind of finding within the rule.'),
    severity: CheckSeveritySchema,
    object: CheckObjectRefSchema,
    related: z.array(CheckObjectRefSchema).max(20),
    message: z
      .string()
      .max(1000)
      .describe('English text. The console shows `messageKey` in the language of the user.'),
    messageKey: z
      .string()
      .max(200)
      .describe(
        'A key of the `checks` namespace of the console texts; `params` fill its placeholders.',
      ),
    params: CheckParamsSchema,
    fields: z.array(z.string().max(300)).max(20).describe('JSON Pointers of the fields involved.'),
    fix: CheckFixHintSchema.nullable(),
  })
  .meta({ id: 'ConventionFinding' });
export type ConventionFinding = z.infer<typeof ConventionFindingSchema>;

export const ConventionSummarySchema = z
  .object({
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    objects: z.number().int().nonnegative().describe('How many objects have at least one finding.'),
    byRule: z.record(z.string(), z.number().int().nonnegative()),
  })
  .meta({ id: 'ConventionSummary' });
export type ConventionSummary = z.infer<typeof ConventionSummarySchema>;

export const ConventionRunSchema = z
  .object({
    pack: PackRefSchema,
    ranAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime().describe('When the panel was last asked for what the run saw.'),
    cached: z
      .boolean()
      .describe('True when every kind of object came from the memory of this server.'),
    summary: ConventionSummarySchema,
    findings: z
      .array(ConventionFindingSchema)
      .describe('Most severe first, then by kind and name.'),
    truncated: z
      .boolean()
      .describe(
        `More findings than ${String(CONVENTION_PACK_LIMITS.findings)}: the rest are counted in \`summary\` but not listed.`,
      ),
    skipped: z.array(
      z.object({
        ruleId: z.string(),
        missing: z.array(PanelResourceSchema).describe('Kinds of object the token could not read.'),
      }),
    ),
    failed: z
      .array(z.object({ ruleId: z.string(), message: z.string().max(300) }))
      .describe('Rules that raised an error; the others ran.'),
    checked: z.object({
      nodes: z.number().int().nonnegative(),
      hosts: z.number().int().nonnegative(),
      configProfiles: z.number().int().nonnegative(),
      internalSquads: z.number().int().nonnegative(),
      externalSquads: z.number().int().nonnegative(),
      subscriptionTemplates: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'ConventionRun' });
export type ConventionRun = z.infer<typeof ConventionRunSchema>;

export const ConventionLastRunSchema = z
  .object({
    ranAt: z.iso
      .datetime()
      .nullable()
      .describe('Null when no run was made since the server started.'),
    pack: PackRefSchema.nullable(),
    summary: ConventionSummarySchema.nullable(),
  })
  .meta({
    id: 'ConventionLastRun',
    description:
      'What the last run found, from the memory of this server. Does not run anything and does not ask the panel.',
  });
export type ConventionLastRun = z.infer<typeof ConventionLastRunSchema>;

export const ChecksQuerySchema = z.object({
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'true: ask the panel again instead of using the memory of this server. Rate limited per user.',
    ),
});

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation.

export const RECONCILIATION_STATUSES = ['ok', 'drift', 'missing', 'extra', 'unknown'] as const;
export const ReconciliationStatusSchema = z.enum(RECONCILIATION_STATUSES).meta({
  id: 'ReconciliationStatus',
  description:
    '`ok`: as expected. `drift`: the two sides disagree. `missing`: the other side has no counterpart (a node the inventory does not know, a name without a record). `extra`: the inventory holds something the panel does not. `unknown`: it could not be decided (a name did not resolve in time, nothing serves the inbound).',
});
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const ReconciliationRowSchema = z
  .object({
    id: z.string().max(400),
    check: ReconciliationCheckSchema,
    status: ReconciliationStatusSchema,
    subject: CheckObjectRefSchema,
    counterpart: CheckObjectRefSchema.nullable().describe(
      'The node or server it was compared with.',
    ),
    related: z.array(CheckObjectRefSchema).max(20),
    expected: z.string().max(1000).nullable(),
    actual: z.string().max(1000).nullable(),
    reason: z
      .string()
      .max(1000)
      .describe('English text; the console shows `reasonKey` in the language of the user.'),
    reasonKey: z.string().max(200),
    params: CheckParamsSchema,
    fix: CheckFixHintSchema.nullable(),
    ttlSeconds: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('For a name that was looked up: its time to live.'),
  })
  .meta({ id: 'ReconciliationRow' });
export type ReconciliationRow = z.infer<typeof ReconciliationRowSchema>;

export const ReconciliationSummarySchema = z
  .object({
    ok: z.number().int().nonnegative(),
    drift: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    extra: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    byCheck: z
      .record(z.string(), z.number().int().nonnegative())
      .describe('Rows that are not `ok`, by check.'),
  })
  .meta({ id: 'ReconciliationSummary' });
export type ReconciliationSummary = z.infer<typeof ReconciliationSummarySchema>;

export const ReconciliationReportSchema = z
  .object({
    pack: PackRefSchema,
    ranAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime(),
    summary: ReconciliationSummarySchema,
    rows: z.array(ReconciliationRowSchema),
    truncated: z.boolean(),
    dns: z.object({
      enabled: z.boolean(),
      names: z.number().int().nonnegative().describe('Different names that had to be looked up.'),
      resolved: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative().describe('Not found, timed out or refused.'),
      skipped: z
        .number()
        .int()
        .nonnegative()
        .describe('Left out because of the cap on names per run.'),
      capped: z.boolean(),
      cached: z
        .number()
        .int()
        .nonnegative()
        .describe('Answers that came from the short memory of this server.'),
      durationMs: z.number().int().nonnegative(),
    }),
    inventory: z.object({
      available: z.boolean(),
      reason: z.enum(['no_permission']).nullable().describe('Why the inventory was not compared.'),
      servers: z.number().int().nonnegative(),
    }),
    settings: z.object({
      hostAddress: z.enum(HOST_ADDRESS_EXPECTATIONS),
      hostSni: z.enum(HOST_SNI_EXPECTATIONS),
      hostPort: z.enum(HOST_PORT_EXPECTATIONS),
      dnsEnabled: z.boolean(),
      maxTtlSeconds: z.number().int().nonnegative(),
      matchBy: z.array(z.enum(INVENTORY_MATCH_METHODS)),
    }),
  })
  .meta({
    id: 'ReconciliationReport',
    description:
      'What hosts, nodes and servers say about each other. "Check only": nothing is changed, and the fix hints are information.',
  });
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

// ---------------------------------------------------------------------------------------------------------------
// The impact calculator.

export const IMPACT_KINDS = [
  'configProfile',
  'internalSquad',
  'host',
  'node',
  'subscriptionTemplate',
] as const;
export const ImpactKindSchema = z.enum(IMPACT_KINDS).meta({ id: 'ImpactKind' });
export type ImpactKind = z.infer<typeof ImpactKindSchema>;

const PatchPath = z.string().max(512);
export const JsonPatchOperationSchema = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('add'), path: PatchPath, value: z.unknown() }),
    z.object({ op: z.literal('replace'), path: PatchPath, value: z.unknown() }),
    z.object({ op: z.literal('test'), path: PatchPath, value: z.unknown() }),
    z.object({ op: z.literal('remove'), path: PatchPath }),
    z.object({ op: z.literal('move'), from: PatchPath, path: PatchPath }),
    z.object({ op: z.literal('copy'), from: PatchPath, path: PatchPath }),
  ])
  .meta({ id: 'JsonPatchOperation', description: 'One operation of RFC 6902.' });
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;

export const ImpactRequestSchema = z
  .object({
    kind: ImpactKindSchema,
    uuid: z.uuid().describe('The object the change is for.'),
    change: z
      .union([z.array(JsonPatchOperationSchema).min(1).max(500), z.record(z.string(), z.unknown())])
      .describe(
        'Either a partial object as the panel API would take it for an update (the fields given replace the current ones; the others stay), or a JSON Patch (RFC 6902, an array) applied to the editable form of the object. The editable forms are listed in the description of the operation. A masked value (`[masked:...]`) in a configuration means "unchanged"; any other value where the current one is masked counts as a change of a secret.',
      ),
  })
  .meta({ id: 'ImpactRequest' });
export type ImpactRequest = z.infer<typeof ImpactRequestSchema>;

export const ImpactTargetQuerySchema = z.object({ kind: ImpactKindSchema, uuid: z.uuid() });
export type ImpactTargetQuery = z.infer<typeof ImpactTargetQuerySchema>;

export const ImpactTargetSchema = z
  .object({
    target: CheckObjectRefSchema,
    editable: z
      .record(z.string(), z.unknown())
      .describe(
        'The editable form of the object, as `POST /panel/impact` takes a change for it, with every secret masked.',
      ),
    masked: z
      .boolean()
      .describe(
        'True when the form holds masked values: they stand for secrets that a dry run cannot change.',
      ),
  })
  .meta({
    id: 'ImpactTarget',
    description:
      'The object a change is for, in the form a change is written against: the starting point of an editor.',
  });
export type ImpactTarget = z.infer<typeof ImpactTargetSchema>;

export const IMPACT_RULE_IDS = [
  'profile.config-edit',
  'profile.name-only',
  'squad.inbounds-changed',
  'squad.members-changed',
  'squad.metadata-only',
  'node.profile-move',
  'node.active-inbounds-changed',
  'node.disable',
  'node.enable',
  'node.connection-changed',
  'node.metadata-only',
  'host.edit',
  'template.edit',
] as const;
export const ImpactRuleIdSchema = z.enum(IMPACT_RULE_IDS).meta({ id: 'ImpactRuleId' });
export type ImpactRuleId = z.infer<typeof ImpactRuleIdSchema>;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS).meta({ id: 'RiskLevel' });
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

const Count = z.number().int().nonnegative();

export const ImpactMessageSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(1000).describe('English text.'),
  messageKey: z.string().max(200),
  params: CheckParamsSchema,
});
export type ImpactMessage = z.infer<typeof ImpactMessageSchema>;

export const ImpactReportSchema = z
  .object({
    rulesVersion: z
      .string()
      .describe(
        'The version of the impact rule table (`3.4`: the observed behaviour of Remnawave 3.4.x).',
      ),
    panelVersion: z.string().nullable(),
    target: CheckObjectRefSchema,
    changed: z.boolean().describe('False when the proposed change leaves the object as it is.'),
    changes: z
      .array(z.object({ op: z.enum(['add', 'remove', 'replace']), path: z.string().max(300) }))
      .max(200)
      .describe(
        'Paths of the editable form that differ (values are not repeated: they may hold secrets).',
      ),
    inbounds: z
      .object({
        added: z.array(z.string()),
        removed: z.array(z.string()),
        changed: z.array(z.string()),
        renamed: z.array(z.object({ from: z.string(), to: z.string() })),
      })
      .nullable()
      .describe(
        'For a configuration or an inbound list: which inbounds (by tag) the change adds, removes, changes or renames.',
      ),
    restarts: z
      .array(
        z.object({
          node: CheckObjectRefSchema,
          rule: ImpactRuleIdSchema,
          action: z
            .enum(['restart', 'stop', 'start'])
            .describe(
              'What happens to the node: Xray restarts, the node stops (it is disabled), or it starts (it is enabled).',
            ),
          state: z.string(),
          usersOnline: Count.nullable(),
        }),
      )
      .describe('Nodes on which Xray restarts or that stop or start, and the rule that says so.'),
    skipped: z
      .array(z.object({ node: CheckObjectRefSchema, reason: z.enum(['disabled']) }))
      .describe('Nodes of the same profile that the change does not restart.'),
    rules: z.array(
      z.object({
        id: ImpactRuleIdSchema,
        title: z.string(),
        basis: z
          .enum(['observed', 'documented', 'assumed'])
          .describe(
            'Where the rule comes from: measured on a panel, the design of Remnawave 3.4.x, or an assumption to confirm.',
          ),
        effect: z.enum(['restart', 'stop', 'start', 'none']),
        messageKey: z.string(),
      }),
    ),
    dangling: z.array(
      z.object({
        from: CheckObjectRefSchema,
        inbound: z.object({ uuid: z.string().nullable(), tag: z.string() }),
        reason: z.enum(['removed', 'renamed', 'unlisted']),
      }),
    ),
    unserved: z
      .array(
        z.object({
          host: CheckObjectRefSchema,
          reason: z.enum(['inbound_removed', 'node_moved', 'node_disabled', 'no_node']),
        }),
      )
      .describe('Hosts that would be left with no node that serves their inbound.'),
    affected: z.object({
      internalSquads: z.array(CheckObjectRefSchema),
      externalSquads: z.array(CheckObjectRefSchema),
      templates: z.array(CheckObjectRefSchema),
      hosts: z.array(CheckObjectRefSchema),
    }),
    users: z.object({
      onlineOnRestartedNodes: Count.nullable().describe(
        'Users connected now to the nodes that restart (their count as the panel reports it); null when unknown.',
      ),
      squadMembersUpTo: Count.nullable().describe(
        'An upper bound of the users who may use these nodes: the member counts of the internal squads that reach them, added up (a user in two squads counts twice).',
      ),
    }),
    risk: z.object({
      level: RiskLevelSchema,
      reasons: z.array(ImpactMessageSchema.extend({ level: RiskLevelSchema })),
    }),
    saferWay: ImpactMessageSchema.nullable().describe(
      'A way to do it that disturbs less, when there is one.',
    ),
    findings: z.object({
      introduced: z
        .array(ConventionFindingSchema)
        .describe('Convention findings the change would cause.'),
      fixed: z
        .array(ConventionFindingSchema)
        .describe('Convention findings the change would resolve.'),
      unchanged: Count,
    }),
    notes: z.array(ImpactMessageSchema),
  })
  .meta({
    id: 'ImpactReport',
    description:
      'The result of a dry run: what a change would do, computed from what the panel reported. Nothing was sent to the panel.',
  });
export type ImpactReport = z.infer<typeof ImpactReportSchema>;
