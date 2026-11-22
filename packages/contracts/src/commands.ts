import { z } from 'zod';

import { ServerNameSchema } from './servers.js';
import { RUN_SECRET_TYPES } from './vault.js';

/**
 * How much a script can change on a server. It is stored on the script and shown wherever the script is chosen. The
 * approvals of the engine (phase 4) will hang on it; until then a run of a script that is not `read` needs the person
 * to confirm the level in so many words (ADR 0038).
 */
export const DANGER_LEVELS = ['read', 'change', 'destructive'] as const;
export const DangerLevelSchema = z.enum(DANGER_LEVELS).meta({
  id: 'DangerLevel',
  description:
    '`read` only looks (the built-in diagnostics). `change` modifies something that can be put back. `destructive` removes or overwrites something that cannot.',
});
export type DangerLevel = z.infer<typeof DangerLevelSchema>;

/** Letters, digits, space, dot, dash and underscore; 1 to 64 characters, like a server name. */
export const ScriptNameSchema = ServerNameSchema;

export const MAX_SCRIPT_BODY_BYTES = 256 * 1024;
export const MAX_INLINE_COMMAND_BYTES = 64 * 1024;
export const MAX_SCRIPT_PARAMETERS = 20;
export const MAX_RUN_SERVERS = 50;
export const DEFAULT_RUN_TIMEOUT_SECONDS = 300;
export const MAX_RUN_TIMEOUT_SECONDS = 3600;

/**
 * A vault secret can be handed to a run (ADR 0042): the runner writes it to a file for the length of the run and the
 * script reads it through `<NAME>_FILE`. The name is a shell variable name in capitals; two prefixes are Swellwright's.
 */
export const RUN_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const MAX_RUN_SECRETS = 8;
/** Names that belong to Swellwright's own variables (`SW_PARAM_*`, `SWELLWRIGHT_STEP_DIR`, ...). */
export const RESERVED_RUN_SECRET_PREFIXES = ['SW_', 'SWELLWRIGHT_'] as const;
export const isRunSecretNameAllowed = (name: string): boolean =>
  RUN_SECRET_NAME_PATTERN.test(name) &&
  !RESERVED_RUN_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));

/** What the output shows where the value of a secret was: the value never reaches the stored output. */
export const runSecretMarker = (name: string): string => `[secret ${name}]`;

// A value that reaches a script is plain text: a NUL cannot cross the shell and a script text with one is not a script.
const noNul = (value: string): boolean => !value.includes('\u0000');
const encoder = new TextEncoder();
/** The size of a text in bytes, as UTF-8. (No `Buffer`: the console uses this file too.) */
export const utf8Length = (text: string): number => encoder.encode(text).length;

/** Lower-case snake case; the script finds it as `$SW_PARAM_<NAME>`. */
export const PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const ParameterName = z.string().regex(PARAMETER_NAME_PATTERN, {
  message: 'Use 1 to 32 lower-case letters, digits or underscores, starting with a letter.',
});

/** What a value of an enum parameter may look like: it is quoted anyway, this keeps the lists readable. */
const ENUM_OPTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/u;

export const MAX_STRING_PARAMETER_LENGTH = 1000;

const ParameterCommon = {
  name: ParameterName,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300).optional(),
  required: z.boolean(),
};

export const StringParameterSchema = z
  .object({
    ...ParameterCommon,
    type: z.literal('string'),
    pattern: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'A regular expression (JavaScript syntax) the whole value must match. Without one any text up to `maxLength` is accepted: it reaches the script quoted, never as shell code.',
      ),
    maxLength: z.number().int().min(1).max(MAX_STRING_PARAMETER_LENGTH),
    default: z.string().max(MAX_STRING_PARAMETER_LENGTH).refine(noNul).optional(),
  })
  .meta({ id: 'StringParameter' });
export const IntegerParameterSchema = z
  .object({
    ...ParameterCommon,
    type: z.literal('integer'),
    min: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    max: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    default: z.number().int().optional(),
  })
  .meta({ id: 'IntegerParameter' });
export const EnumParameterSchema = z
  .object({
    ...ParameterCommon,
    type: z.literal('enum'),
    options: z.array(z.string().regex(ENUM_OPTION_PATTERN)).min(1).max(50),
    default: z.string().optional(),
  })
  .meta({ id: 'EnumParameter' });
export const BooleanParameterSchema = z
  .object({
    ...ParameterCommon,
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  })
  .meta({ id: 'BooleanParameter' });

export const SecretParameterSchema = z
  .object({
    ...ParameterCommon,
    type: z.literal('secret'),
    secretTypes: z
      .array(z.enum(RUN_SECRET_TYPES))
      .min(1)
      .max(RUN_SECRET_TYPES.length)
      .describe(
        'The kinds of vault secret that may be chosen for it. The person picks a secret of the vault, never types a value.',
      ),
  })
  .meta({ id: 'SecretParameter' });

export const ScriptParameterSchema = z
  .discriminatedUnion('type', [
    StringParameterSchema,
    IntegerParameterSchema,
    EnumParameterSchema,
    BooleanParameterSchema,
    SecretParameterSchema,
  ])
  .meta({
    id: 'ScriptParameter',
    description:
      'A typed parameter of a script. Its value reaches the script as the environment variable `SW_PARAM_<NAME>` (booleans as `1` or `0`), never inside the script text. A `secret` parameter is different: the value of the run is the id of a vault secret, and the script finds the secret in a file named by `<NAME>_FILE` (the parameter name in capitals), never in the environment, the script text or the stored run.',
  });
export type ScriptParameter = z.infer<typeof ScriptParameterSchema>;

export type ParameterValue = string | number | boolean;
export type ParameterValues = Record<string, ParameterValue>;
export const ParameterValuesSchema = z
  .record(
    ParameterName,
    z.union([z.string().max(MAX_STRING_PARAMETER_LENGTH), z.number(), z.boolean()]),
  )
  .meta({
    id: 'ParameterValues',
    description: 'Values by parameter name: text, whole numbers and booleans.',
  });

/** The environment variable a parameter arrives in. */
export function parameterEnvName(name: string): string {
  return `SW_PARAM_${name.toUpperCase()}`;
}

/** The expression that decides whether a string value is allowed: the whole value must match, `u` flag. */
export function compileParameterPattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return undefined;
  }
}

export interface ParameterIssue {
  /** Where the problem is: the parameter name, or `null` for the list as a whole. */
  readonly name: string | null;
  readonly message: string;
}

/** What is wrong with the definition of a script's parameters (pure: no input from a run). */
export function parameterDefinitionIssues(
  parameters: readonly ScriptParameter[],
): ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  if (parameters.length > MAX_SCRIPT_PARAMETERS) {
    issues.push({
      name: null,
      message: `A script has at most ${String(MAX_SCRIPT_PARAMETERS)} parameters.`,
    });
  }
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const { name } = parameter;
    if (seen.has(name)) {
      issues.push({ name, message: 'Two parameters have this name.' });
    }
    seen.add(name);
    if (parameter.type === 'string') {
      const matcher =
        parameter.pattern === undefined ? undefined : compileParameterPattern(parameter.pattern);
      if (parameter.pattern !== undefined && matcher === undefined) {
        issues.push({ name, message: 'The pattern is not a valid regular expression.' });
      }
      if (parameter.default !== undefined) {
        if (parameter.default.length > parameter.maxLength) {
          issues.push({ name, message: 'The default is longer than the maximum length.' });
        } else if (matcher !== undefined && !matcher.test(parameter.default)) {
          issues.push({ name, message: 'The default does not match the pattern.' });
        }
      }
    } else if (parameter.type === 'integer') {
      if (parameter.min > parameter.max) {
        issues.push({ name, message: 'The minimum is greater than the maximum.' });
      } else if (
        parameter.default !== undefined &&
        (parameter.default < parameter.min || parameter.default > parameter.max)
      ) {
        issues.push({ name, message: 'The default is outside the range.' });
      }
    } else if (parameter.type === 'enum') {
      if (new Set(parameter.options).size !== parameter.options.length) {
        issues.push({ name, message: 'An option is listed twice.' });
      }
      if (parameter.default !== undefined && !parameter.options.includes(parameter.default)) {
        issues.push({ name, message: 'The default is not one of the options.' });
      }
    } else if (parameter.type === 'secret') {
      if (new Set(parameter.secretTypes).size !== parameter.secretTypes.length) {
        issues.push({ name, message: 'A kind of secret is listed twice.' });
      }
      if (!isRunSecretNameAllowed(name.toUpperCase())) {
        issues.push({
          name,
          message:
            'A secret parameter becomes a variable in capitals: its name must not start with sw_ or swellwright_.',
        });
      }
    }
  }
  return issues;
}

export const ScriptParametersSchema = z
  .array(ScriptParameterSchema)
  .max(MAX_SCRIPT_PARAMETERS)
  .superRefine((parameters, ctx) => {
    for (const issue of parameterDefinitionIssues(parameters)) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.name === null ? [] : [parameters.findIndex((p) => p.name === issue.name)],
      });
    }
  });

export type ParameterCheck =
  | {
      readonly ok: true;
      readonly values: ParameterValues;
      readonly env: Record<string, string>;
      /** The `secret` parameters that were given: parameter name to the id of the vault secret. Never in `values` or `env`. */
      readonly secrets: Record<string, string>;
    }
  | { readonly ok: false; readonly issues: readonly ParameterIssue[] };

/** The name a secret parameter has as a secret of the run: the parameter name in capitals (`node_key` is `NODE_KEY`). */
export const parameterSecretName = (name: string): string => name.toUpperCase();

/**
 * Checks the values a person gave against the definitions and works out what the script will see. Used by the server
 * (it is the check that counts) and by the console's form. Unknown names are refused; a missing optional value takes the
 * default, and one without a default is simply not set. The result never contains anything the definitions did not allow.
 */
export function checkParameterValues(
  parameters: readonly ScriptParameter[],
  given: Readonly<Record<string, unknown>>,
): ParameterCheck {
  const issues: ParameterIssue[] = [];
  const values: ParameterValues = {};
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const known = new Set(parameters.map((p) => p.name));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) {
      issues.push({ name, message: 'This script has no such parameter.' });
    }
  }
  for (const parameter of parameters) {
    const { name } = parameter;
    const raw = Object.hasOwn(given, name) ? given[name] : undefined;
    // A secret has no default: a secret is chosen by a person, never filled in for them.
    const fallback = parameter.type === 'secret' ? undefined : parameter.default;
    const value = raw === undefined || raw === null || raw === '' ? fallback : raw;
    if (value === undefined) {
      if (parameter.required) {
        issues.push({ name, message: 'A value is required.' });
      }
      continue;
    }
    switch (parameter.type) {
      case 'string': {
        if (typeof value !== 'string') {
          issues.push({ name, message: 'Text is expected.' });
        } else if (!noNul(value)) {
          issues.push({ name, message: 'The value must not contain a NUL character.' });
        } else if (value.length > parameter.maxLength) {
          issues.push({ name, message: `At most ${String(parameter.maxLength)} characters.` });
        } else if (
          parameter.pattern !== undefined &&
          !(compileParameterPattern(parameter.pattern)?.test(value) ?? false)
        ) {
          issues.push({ name, message: 'The value does not have the expected form.' });
        } else {
          values[name] = value;
          env[parameterEnvName(name)] = value;
        }
        break;
      }
      case 'integer': {
        const number =
          typeof value === 'number'
            ? value
            : typeof value === 'string' && /^-?[0-9]{1,10}$/u.test(value)
              ? Number(value)
              : Number.NaN;
        if (!Number.isInteger(number)) {
          issues.push({ name, message: 'A whole number is expected.' });
        } else if (number < parameter.min || number > parameter.max) {
          issues.push({
            name,
            message: `A number from ${String(parameter.min)} to ${String(parameter.max)}.`,
          });
        } else {
          values[name] = number;
          env[parameterEnvName(name)] = String(number);
        }
        break;
      }
      case 'enum': {
        if (typeof value !== 'string' || !parameter.options.includes(value)) {
          issues.push({ name, message: 'Choose one of the listed options.' });
        } else {
          values[name] = value;
          env[parameterEnvName(name)] = value;
        }
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          issues.push({ name, message: 'Yes or no is expected.' });
        } else {
          values[name] = value;
          env[parameterEnvName(name)] = value ? '1' : '0';
        }
        break;
      }
      case 'secret': {
        // The value is the id of a secret of the vault: the server checks that it exists and is of a kind the
        // parameter allows. It is not a value that reaches the script, so it is neither in `values` nor in `env`.
        if (typeof value !== 'string' || !z.uuid().safeParse(value).success) {
          issues.push({ name, message: 'Choose a secret of the vault.' });
        } else {
          secrets[name] = value;
        }
        break;
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, values, env, secrets };
}

/** The Script as the list shows it: no text. */
export const ScriptSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    dangerLevel: DangerLevelSchema,
    sudo: z.boolean().describe('Runs as root: through sudo with the stored sudo secret.'),
    parameters: z.array(ScriptParameterSchema),
    builtin: z
      .boolean()
      .describe('Ships with Swellwright. Read only: it cannot be changed or deleted.'),
    version: z.number().int().positive().describe('Raised by one with every change of the text.'),
    bodySha256: z.string().describe('SHA-256 of the text, in hex.'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ScriptSummary' });
export type ScriptSummary = z.infer<typeof ScriptSummarySchema>;

export const ScriptViewSchema = z
  .object({ ...ScriptSummarySchema.shape, body: z.string() })
  .meta({ id: 'ScriptView' });
export type ScriptView = z.infer<typeof ScriptViewSchema>;

export const ScriptListSchema = z
  .object({
    scripts: z.array(ScriptSummarySchema).describe('Built-in scripts first, then by name.'),
  })
  .meta({ id: 'ScriptList' });
export type ScriptList = z.infer<typeof ScriptListSchema>;

export const ScriptIdParamsSchema = z.object({ id: z.uuid() });

const ScriptBody = z
  .string()
  .min(1)
  .refine((text) => utf8Length(text) <= MAX_SCRIPT_BODY_BYTES, {
    message: `At most ${String(MAX_SCRIPT_BODY_BYTES / 1024)} KiB.`,
  })
  .refine(noNul, { message: 'The text must not contain a NUL character.' })
  .describe('POSIX sh, run as `sh script.sh`. Line endings are made LF when it is saved.');

const ScriptDescription = z.string().trim().min(1).max(500);

export const CreateScriptRequestSchema = z
  .object({
    name: ScriptNameSchema,
    description: ScriptDescription,
    dangerLevel: DangerLevelSchema,
    sudo: z.boolean(),
    parameters: ScriptParametersSchema,
    body: ScriptBody,
  })
  .meta({ id: 'CreateScriptRequest' });
export type CreateScriptRequest = z.infer<typeof CreateScriptRequestSchema>;

export const UpdateScriptRequestSchema = z
  .object({
    name: ScriptNameSchema.optional(),
    description: ScriptDescription.optional(),
    dangerLevel: DangerLevelSchema.optional(),
    sudo: z.boolean().optional(),
    parameters: ScriptParametersSchema.optional(),
    body: ScriptBody.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one field.' })
  .meta({
    id: 'UpdateScriptRequest',
    description:
      'Fields that are absent stay as they are. Changing the text raises the version; runs that happened before keep the text they ran.',
  });
export type UpdateScriptRequest = z.infer<typeof UpdateScriptRequestSchema>;

// ---- command runs ---------------------------------------------------------------------------------------------

export const COMMAND_RUN_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'partial',
] as const;
export const CommandRunStateSchema = z.enum(COMMAND_RUN_STATES).meta({
  id: 'CommandRunState',
  description:
    '`pending`: queued. `running`: at least one server is not finished. When all are: `succeeded` (every server succeeded), `failed` (none did), `partial` (some did), `cancelled` (a person stopped the run).',
});
export type CommandRunState = z.infer<typeof CommandRunStateSchema>;

export const COMMAND_TARGET_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'lost',
  'cancelled',
  'skipped',
] as const;
export const CommandTargetStateSchema = z.enum(COMMAND_TARGET_STATES).meta({
  id: 'CommandTargetState',
  description:
    '`pending`: waiting for a free slot. `running`: the script runs on the server. `succeeded`: it exited with status 0. `failed`: it exited with another status, timed out, or the server could not be used (see `errorCode`). `lost`: contact was lost for good, or the record of the run vanished from the server, so the result is unknown. `cancelled`: stopped by a person. `skipped`: never tried because the server cannot be used (no pinned host key, no access entry).',
});
export type CommandTargetState = z.infer<typeof CommandTargetStateSchema>;

export const FINISHED_TARGET_STATES: readonly CommandTargetState[] = [
  'succeeded',
  'failed',
  'lost',
  'cancelled',
  'skipped',
];
export const FINISHED_RUN_STATES: readonly CommandRunState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'partial',
];

/** How much of each stream the target view carries; the rest is paged through the output route. */
export const OUTPUT_TAIL_BYTES = 16 * 1024;
export const OUTPUT_PAGE_DEFAULT = 64 * 1024;
export const OUTPUT_PAGE_MAX = 256 * 1024;

export const CommandOutputSchema = z
  .object({
    storedBytes: z
      .number()
      .int()
      .nonnegative()
      .describe('How many bytes Swellwright keeps of this stream.'),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'How many bytes the script wrote. More than `storedBytes` when the output was cut at the limit.',
      ),
    truncated: z.boolean().describe('The output went over the limit: the end is not kept.'),
    tail: z
      .string()
      .describe('The last bytes that are kept, as text (invalid UTF-8 shows as U+FFFD).'),
    tailOffset: z
      .number()
      .int()
      .nonnegative()
      .describe('Where `tail` starts in the kept output; 0 when the whole output is in `tail`.'),
  })
  .meta({ id: 'CommandOutput' });
export type CommandOutput = z.infer<typeof CommandOutputSchema>;

export const CommandTargetViewSchema = z
  .object({
    id: z.uuid(),
    serverId: z.uuid().nullable().describe('Null when the server was deleted since.'),
    serverName: z.string().describe('The name the server had when the run was made.'),
    state: CommandTargetStateSchema,
    exitCode: z
      .number()
      .int()
      .nullable()
      .describe('The exit status of the script, when it ended by itself.'),
    errorCode: z
      .string()
      .nullable()
      .describe(
        'Why a server did not succeed, besides a non-zero exit: an API error code such as `ssh_auth_failed` or `host_key_mismatch`, or `timeout`, `server_deleted`, `step_lost`, `unreachable`, `cancelled_unreachable`.',
      ),
    errorMessage: z.string().nullable(),
    waiting: z
      .string()
      .nullable()
      .describe(
        'Set while Swellwright cannot reach a running server for now (`vault_sealed`, `ssh_connect_failed`, ...): it keeps trying and the script is not affected.',
      ),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    stdout: CommandOutputSchema,
    stderr: CommandOutputSchema,
  })
  .meta({ id: 'CommandTargetView' });
export type CommandTargetView = z.infer<typeof CommandTargetViewSchema>;

export const CommandRunCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .meta({ id: 'CommandRunCounts' });
export type CommandRunCounts = z.infer<typeof CommandRunCountsSchema>;

export const COMMAND_RUN_MODES = ['script', 'inline'] as const;
export const CommandRunModeSchema = z.enum(COMMAND_RUN_MODES).meta({ id: 'CommandRunMode' });
export type CommandRunMode = z.infer<typeof CommandRunModeSchema>;

export const CommandRunSummarySchema = z
  .object({
    id: z.uuid(),
    mode: CommandRunModeSchema,
    state: CommandRunStateSchema,
    label: z
      .string()
      .describe(
        'The name of the script, or the first line of an inline command (cut at 80 characters).',
      ),
    scriptId: z
      .uuid()
      .nullable()
      .describe('Null for an inline command, or when the script was deleted since.'),
    dangerLevel: DangerLevelSchema,
    sudo: z.boolean(),
    timeoutSeconds: z.number().int(),
    createdBy: z.string().describe('The login name at the time.'),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    cancelRequestedAt: z.iso.datetime().nullable(),
    counts: CommandRunCountsSchema,
  })
  .meta({ id: 'CommandRunSummary' });
export type CommandRunSummary = z.infer<typeof CommandRunSummarySchema>;

export const RunSecretViewSchema = z
  .object({
    name: z
      .string()
      .describe('The name the script knows it by: the file is named by `<NAME>_FILE`.'),
    secretId: z.uuid().nullable().describe('Null after the secret was deleted.'),
    secretName: z
      .string()
      .describe('What the secret was called in the vault when the run was made.'),
  })
  .meta({
    id: 'RunSecretView',
    description:
      'A vault secret that was handed to the run as a file. Only the name and the secret are kept, never a value.',
  });
export type RunSecretView = z.infer<typeof RunSecretViewSchema>;

export const CommandRunViewSchema = z
  .object({
    ...CommandRunSummarySchema.shape,
    body: z
      .string()
      .describe(
        'The exact text that ran: the script as it was when the run was made, or the inline command. Never changes.',
      ),
    bodySha256: z.string(),
    scriptName: z.string().nullable(),
    scriptVersion: z.number().int().nullable(),
    parameters: ParameterValuesSchema,
    confirmedLevel: DangerLevelSchema.nullable().describe(
      'The level the person confirmed when the run was started; null for a `read` run.',
    ),
    secrets: z
      .array(RunSecretViewSchema)
      .describe(
        'The vault secrets handed to the run, by name. Where the output holds one of their values, it shows `[secret NAME]` instead.',
      ),
    targets: z.array(CommandTargetViewSchema).describe('In the order the servers were chosen.'),
  })
  .meta({ id: 'CommandRunView' });
export type CommandRunView = z.infer<typeof CommandRunViewSchema>;

export const CommandRunListSchema = z
  .object({
    runs: z.array(CommandRunSummarySchema).describe('Newest first.'),
    total: z.number().int().nonnegative(),
  })
  .meta({ id: 'CommandRunList' });
export type CommandRunList = z.infer<typeof CommandRunListSchema>;

export const CommandRunListQuerySchema = z.object({
  // Not the named schemas: a query parameter describes itself inline instead of pointing into the components.
  state: z.enum(COMMAND_RUN_STATES).optional(),
  serverId: z.uuid().optional().describe('Only runs that had this server among their targets.'),
  limit: z.coerce.number().int().min(1).max(200).optional().describe('50 by default.'),
  offset: z.coerce.number().int().min(0).optional(),
});
export type CommandRunListQuery = z.infer<typeof CommandRunListQuerySchema>;

export const CommandRunIdParamsSchema = z.object({ id: z.uuid() });
export const CommandTargetParamsSchema = z.object({ id: z.uuid(), targetId: z.uuid() });

export const RunSecretRequestSchema = z
  .object({
    name: z.string().regex(RUN_SECRET_NAME_PATTERN, {
      message: 'Use 1 to 64 capital letters, digits or underscores, starting with a letter.',
    }),
    secretId: z.uuid(),
  })
  .meta({ id: 'RunSecretRequest' });
export type RunSecretRequest = z.infer<typeof RunSecretRequestSchema>;

const RunCommon = {
  secrets: z
    .array(RunSecretRequestSchema)
    .max(MAX_RUN_SECRETS)
    .refine((list) => new Set(list.map((entry) => entry.name)).size === list.length, {
      message: 'A name is used twice.',
    })
    .refine((list) => list.every((entry) => isRunSecretNameAllowed(entry.name)), {
      message: 'A name must not start with SW_ or SWELLWRIGHT_.',
    })
    .optional()
    .describe(
      `Vault secrets for the script, up to ${String(MAX_RUN_SECRETS)}, by the name the script knows them by. Each is written to a file on the server (mode 0600) for the length of the run and removed afterwards; the script reads it through the variable \`<NAME>_FILE\`. Needs \`vault:reveal\` as well as \`servers:exec\`: a script can print what it reads. A secret that has expired is refused (409 \`secret_expired\`), and so is the vault being sealed (423).`,
    ),
  serverIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_RUN_SERVERS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'A server is listed twice.' })
    .describe(`One to ${String(MAX_RUN_SERVERS)} servers; each becomes a target of its own.`),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_RUN_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Per server, from the moment the script starts there; ${String(DEFAULT_RUN_TIMEOUT_SECONDS)} by default. When it passes, the script is stopped and the server counts as failed.`,
    ),
  confirmedLevel: DangerLevelSchema.optional().describe(
    'Required when the level of the run is not `read`, and it must be that level: the person confirmed it.',
  ),
};

export const CreateCommandRunRequestSchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('script'),
      ...RunCommon,
      scriptId: z.uuid(),
      parameters: ParameterValuesSchema.optional(),
    }),
    z.object({
      mode: z.literal('inline'),
      ...RunCommon,
      command: z
        .string()
        .min(1)
        .refine((text) => utf8Length(text) <= MAX_INLINE_COMMAND_BYTES, {
          message: `At most ${String(MAX_INLINE_COMMAND_BYTES / 1024)} KiB.`,
        })
        .refine(noNul, { message: 'The command must not contain a NUL character.' })
        .describe(
          'POSIX sh. It is kept with the run, so do not put a secret in it: hand a vault secret to the run with `secrets` and read it from `$NAME_FILE`.',
        ),
      sudo: z.boolean().optional().describe('Run as root through sudo. False by default.'),
      dangerLevel: DangerLevelSchema.optional().describe(
        'What the person says the command does. Swellwright cannot know; `change` by default, so that it asks for a confirmation.',
      ),
    }),
  ])
  .meta({
    id: 'CreateCommandRunRequest',
    description:
      'Run a stored script (`mode: script`, with its parameters) or a command typed in (`mode: inline`) on one to fifty servers at once.',
  });
export type CreateCommandRunRequest = z.infer<typeof CreateCommandRunRequestSchema>;

export const CommandOutputQuerySchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  offset: z.coerce.number().int().min(0).optional().describe('Bytes to skip; 0 by default.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(OUTPUT_PAGE_MAX)
    .optional()
    .describe(`At most this many bytes; ${String(OUTPUT_PAGE_DEFAULT)} by default.`),
});
export type CommandOutputQuery = z.infer<typeof CommandOutputQuerySchema>;

export const CommandOutputPageSchema = z
  .object({
    stream: z.enum(['stdout', 'stderr']),
    offset: z.number().int().nonnegative(),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Where the next page starts. It never lies inside a UTF-8 character: a page is shortened to end between two.',
      ),
    text: z.string(),
    storedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    eof: z
      .boolean()
      .describe(
        '`nextOffset` has reached the end of what is kept (more may still arrive while the script runs).',
      ),
  })
  .meta({ id: 'CommandOutputPage' });
export type CommandOutputPage = z.infer<typeof CommandOutputPageSchema>;

/** The first line of a command, cut: what the lists call an inline run. */
export function commandLabel(command: string): string {
  const first = command.split('\n').find((line) => line.trim().length > 0) ?? command;
  const clean = first.trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}
