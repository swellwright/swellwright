import { z } from 'zod';

/**
 * The `config.schema` file of a plugin (ADR 0029): a small subset of JSON Schema, enough to build a form and to
 * check what is entered, and nothing that could make the core evaluate anything (no patterns: a regular
 * expression from a plugin run against what an administrator types could hang the core). A field is a string (optionally
 * a closed list of choices), an integer, a number, a boolean, or a reference to a secret of the vault.
 */

const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,39}$/u;
export const MAX_CONFIG_FIELDS = 32;
export const MAX_CONFIG_STRING = 4096;

const Meta = {
  title: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
};

/** A kind of secret: lower-case words joined by `-`, as in the manifest's `permissions.secrets`. */
const SecretKind = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

const StringField = z.strictObject({
  type: z.literal('string'),
  ...Meta,
  default: z.string().max(MAX_CONFIG_STRING).optional(),
  minLength: z.number().int().min(0).max(MAX_CONFIG_STRING).optional(),
  maxLength: z.number().int().min(1).max(MAX_CONFIG_STRING).optional(),
  enum: z.array(z.string().max(200)).min(1).max(64).optional(),
  /** This field holds the id of a vault secret of this kind; the value is never kept in the settings. */
  'x-sw-secret': SecretKind.optional(),
});

const IntegerField = z.strictObject({
  type: z.literal('integer'),
  ...Meta,
  default: z.number().int().optional(),
  minimum: z.number().int().optional(),
  maximum: z.number().int().optional(),
});

const NumberField = z.strictObject({
  type: z.literal('number'),
  ...Meta,
  default: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

const BooleanField = z.strictObject({
  type: z.literal('boolean'),
  ...Meta,
  default: z.boolean().optional(),
});

export const ConfigFieldSchema = z.discriminatedUnion('type', [
  StringField,
  IntegerField,
  NumberField,
  BooleanField,
]);
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

export const ConfigSchemaFileSchema = z
  .strictObject({
    type: z.literal('object'),
    properties: z.record(z.string(), ConfigFieldSchema),
    required: z.array(z.string()).max(MAX_CONFIG_FIELDS).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .superRefine((schema, ctx) => {
    const names = Object.keys(schema.properties);
    if (names.length > MAX_CONFIG_FIELDS) {
      ctx.addIssue({ code: 'custom', message: `at most ${String(MAX_CONFIG_FIELDS)} fields` });
    }
    for (const name of names) {
      if (!FIELD_NAME.test(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['properties', name],
          message: 'a field name starts with a lower-case letter and has letters and digits only',
        });
      }
      const field = schema.properties[name];
      if (field?.type === 'string') {
        if (field['x-sw-secret'] !== undefined) {
          const extras = ['default', 'minLength', 'maxLength', 'enum'] as const;
          for (const key of extras) {
            if (field[key] !== undefined) {
              ctx.addIssue({
                code: 'custom',
                path: ['properties', name, key],
                message: 'a secret field has no default, length or choices',
              });
            }
          }
        }
      }
    }
    for (const name of schema.required ?? []) {
      if (!names.includes(name)) {
        ctx.addIssue({ code: 'custom', path: ['required'], message: `"${name}" is not a field` });
      }
    }
  });
export type ConfigSchemaFile = z.infer<typeof ConfigSchemaFileSchema>;

export type ConfigValue = string | number | boolean | null;
export type ConfigValues = Record<string, ConfigValue>;

export interface ConfigProblem {
  readonly field: string;
  readonly message: string;
}

/** The kinds of secret a schema refers to, with the fields that use them. */
export function secretFields(schema: ConfigSchemaFile): { field: string; kind: string }[] {
  return Object.entries(schema.properties).flatMap(([field, definition]) =>
    definition.type === 'string' && definition['x-sw-secret'] !== undefined
      ? [{ field, kind: definition['x-sw-secret'] }]
      : [],
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Checks values entered for a schema and fills in defaults. A secret field holds the id of a vault secret or
 * `null`. Fields the schema does not name are refused, so a typo is an error and not a setting that does nothing.
 * The values that come back have exactly the fields of the schema that have a value.
 */
export function validateConfig(
  schema: ConfigSchemaFile,
  input: Readonly<Record<string, unknown>>,
): { values: ConfigValues; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const values: ConfigValues = {};
  const required = new Set(schema.required ?? []);
  for (const name of Object.keys(input)) {
    // Own properties only: `constructor` or `toString` are not settings because every object has them.
    if (!Object.hasOwn(schema.properties, name)) {
      problems.push({ field: name, message: 'is not a setting of this plugin' });
    }
  }
  for (const [name, definition] of Object.entries(schema.properties)) {
    const given = Object.hasOwn(input, name) ? input[name] : undefined;
    const has = given !== undefined && given !== null && given !== '';
    const value = has ? given : 'default' in definition ? definition.default : undefined;
    if (value === undefined || value === '') {
      if (required.has(name)) {
        problems.push({ field: name, message: 'is required' });
      } else if (definition.type === 'string' && definition['x-sw-secret'] !== undefined) {
        values[name] = null;
      }
      continue;
    }
    const problem = checkValue(definition, value);
    if (problem !== undefined) {
      problems.push({ field: name, message: problem });
    } else {
      values[name] = value as ConfigValue;
    }
  }
  return { values, problems };
}

function checkValue(definition: ConfigField, value: unknown): string | undefined {
  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'must be a number';
      }
      if (definition.type === 'integer' && !Number.isInteger(value)) {
        return 'must be a whole number';
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        return `must be at least ${String(definition.minimum)}`;
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        return `must be at most ${String(definition.maximum)}`;
      }
      return undefined;
    }
    case 'string': {
      if (typeof value !== 'string') {
        return 'must be text';
      }
      if (definition['x-sw-secret'] !== undefined) {
        return UUID.test(value) ? undefined : 'must be the id of a secret';
      }
      if (definition.minLength !== undefined && value.length < definition.minLength) {
        return `must be at least ${String(definition.minLength)} characters`;
      }
      if (value.length > (definition.maxLength ?? MAX_CONFIG_STRING)) {
        return `must be at most ${String(definition.maxLength ?? MAX_CONFIG_STRING)} characters`;
      }
      if (definition.enum !== undefined && !definition.enum.includes(value)) {
        return `must be one of: ${definition.enum.join(', ')}`;
      }
      return undefined;
    }
  }
}
