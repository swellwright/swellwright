import { z } from 'zod';

/** What a secret is for. A closed list (docs/en/design/02-data-model.md); a new kind comes with a migration. */
export const SECRET_TYPES = [
  'panel_token',
  'ssh_key',
  'ssh_password',
  'ssh_ca',
  'dns_oauth',
  'provider_token',
  'telegram',
  'generic',
] as const;
export const SecretTypeSchema = z.enum(SECRET_TYPES).meta({ id: 'SecretType' });
export type SecretType = z.infer<typeof SecretTypeSchema>;

/**
 * The kinds of secret that may be handed to a command run as a file (ADR 0042). Text that a script reads: a token, a
 * key of a node, a password. A private key (`ssh_key`) and a CA key (`ssh_ca`) are structured and far more powerful
 * than anything a script needs, so they are left out.
 */
export const RUN_SECRET_TYPES = [
  'generic',
  'panel_token',
  'provider_token',
  'telegram',
  'dns_oauth',
  'ssh_password',
] as const satisfies readonly (typeof SECRET_TYPES)[number][];
export type RunSecretType = (typeof RUN_SECRET_TYPES)[number];
export const isRunSecretType = (type: string): type is RunSecretType =>
  (RUN_SECRET_TYPES as readonly string[]).includes(type);

/** The console warns when a secret expires within this many days. */
export const SECRET_EXPIRY_WARN_DAYS = 14;

/** The `details` of a `secret_expired` error: which secret, and when it expired. Never the value. */
export const SecretExpiredDetailsSchema = z.object({
  secretId: z.uuid(),
  secretName: z.string(),
  expiresAt: z.iso.datetime(),
});
export type SecretExpiredDetails = z.infer<typeof SecretExpiredDetailsSchema>;

export const VAULT_STATES = ['uninitialized', 'sealed', 'unsealed'] as const;

export const VaultStatusSchema = z
  .object({
    state: z
      .enum(VAULT_STATES)
      .describe(
        '`uninitialized`: no vault yet. `sealed`: it exists and the key is not in memory. `unsealed`: it can be used.',
      ),
    secretCount: z.number().int().nonnegative(),
    kekVersion: z.number().int().positive().nullable(),
    createdAt: z.iso.datetime().nullable(),
    passphraseChangedAt: z.iso
      .datetime()
      .nullable()
      .describe('Null: never changed since the vault was set up.'),
    recoveryKeyRotatedAt: z.iso.datetime().nullable(),
    kekRotatedAt: z.iso.datetime().nullable(),
    dataKeysRotatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'VaultStatus' });
export type VaultStatus = z.infer<typeof VaultStatusSchema>;

/** A long passphrase beats a complicated one; the console shows a strength hint, the server enforces the length. */
export const VAULT_PASSPHRASE_MIN_LENGTH = 16;
export const VAULT_PASSPHRASE_MAX_LENGTH = 256;

export const InitializeVaultRequestSchema = z
  .object({
    passphrase: z.string().min(VAULT_PASSPHRASE_MIN_LENGTH).max(VAULT_PASSPHRASE_MAX_LENGTH),
  })
  .meta({ id: 'InitializeVaultRequest' });
export type InitializeVaultRequest = z.infer<typeof InitializeVaultRequestSchema>;

export const VaultInitializedSchema = z
  .object({
    status: VaultStatusSchema,
    recoveryKey: z
      .string()
      .describe(
        'Shown once, never stored. With it the vault can be opened when the passphrase is lost: keep it away from this server.',
      ),
  })
  .meta({ id: 'VaultInitialized' });
export type VaultInitialized = z.infer<typeof VaultInitializedSchema>;

export const UnsealVaultRequestSchema = z
  .object({
    passphrase: z.string().min(1).max(VAULT_PASSPHRASE_MAX_LENGTH).optional(),
    recoveryKey: z.string().min(1).max(128).optional(),
  })
  .refine((body) => (body.passphrase === undefined) !== (body.recoveryKey === undefined), {
    message: 'Give the passphrase or the recovery key, not both and not neither.',
  })
  .meta({ id: 'UnsealVaultRequest' });
export type UnsealVaultRequest = z.infer<typeof UnsealVaultRequestSchema>;

export const ChangeVaultPassphraseRequestSchema = z
  .object({
    currentPassphrase: z.string().min(1).max(VAULT_PASSPHRASE_MAX_LENGTH),
    newPassphrase: z.string().min(VAULT_PASSPHRASE_MIN_LENGTH).max(VAULT_PASSPHRASE_MAX_LENGTH),
  })
  .meta({ id: 'ChangeVaultPassphraseRequest' });
export type ChangeVaultPassphraseRequest = z.infer<typeof ChangeVaultPassphraseRequestSchema>;

/** Rotations that replace the key the recovery key opens ask for the passphrase again, as a second proof. */
export const ConfirmPassphraseRequestSchema = z
  .object({ passphrase: z.string().min(1).max(VAULT_PASSPHRASE_MAX_LENGTH) })
  .meta({ id: 'ConfirmPassphraseRequest' });
export type ConfirmPassphraseRequest = z.infer<typeof ConfirmPassphraseRequestSchema>;

export const VaultRotatedSchema = z
  .object({
    status: VaultStatusSchema,
    rotated: z.number().int().nonnegative().describe('How many secrets were re-encrypted.'),
  })
  .meta({ id: 'VaultRotated' });
export type VaultRotated = z.infer<typeof VaultRotatedSchema>;

export const SecretViewSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    type: SecretTypeSchema,
    description: z.string().nullable(),
    version: z
      .number()
      .int()
      .positive()
      .describe('Moves forward every time the value is replaced.'),
    expiresAt: z.iso.datetime().nullable(),
    expired: z
      .boolean()
      .describe(
        'The expiry has passed (`expiresAt` is now or earlier, by the server clock). An expired secret is not handed to anything that uses it: a server login, a plugin, a run (409 `secret_expired`). It can still be revealed, renewed or replaced.',
      ),
    expiresInDays: z
      .number()
      .int()
      .nullable()
      .describe(
        'Whole days until the expiry, rounded up; 0 or less once it has passed. Null when the secret has no expiry.',
      ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    valueChangedAt: z.iso.datetime(),
  })
  .meta({ id: 'SecretView', description: 'A secret without its value. Values are write-only.' });
export type SecretView = z.infer<typeof SecretViewSchema>;

export const SecretListSchema = z
  .object({ secrets: z.array(SecretViewSchema).describe('Ordered by name.') })
  .meta({ id: 'SecretList' });
export type SecretList = z.infer<typeof SecretListSchema>;

export const SECRET_VALUE_MAX_LENGTH = 32768;

const SecretName = z.string().trim().min(1).max(100);
const SecretValue = z.string().min(1).max(SECRET_VALUE_MAX_LENGTH);
const SecretDescription = z.string().trim().min(1).max(500);

export const CreateSecretRequestSchema = z
  .object({
    name: SecretName,
    type: SecretTypeSchema,
    value: SecretValue,
    description: SecretDescription.optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'CreateSecretRequest' });
export type CreateSecretRequest = z.infer<typeof CreateSecretRequestSchema>;

export const UpdateSecretRequestSchema = z
  .object({
    name: SecretName.optional(),
    description: SecretDescription.nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    value: SecretValue.optional().describe(
      'A new value. Needs the vault open; the version moves forward.',
    ),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one field.' })
  .meta({
    id: 'UpdateSecretRequest',
    description:
      'Fields that are absent stay as they are; `null` clears the description or the expiry.',
  });
export type UpdateSecretRequest = z.infer<typeof UpdateSecretRequestSchema>;

export const SecretIdParamsSchema = z.object({ id: z.uuid() });

export const RevealedSecretSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    type: SecretTypeSchema,
    version: z.number().int().positive(),
    expired: z
      .boolean()
      .describe(
        'The secret has expired. A person may still read it, to rotate it; nothing else is given it.',
      ),
    value: z.string().describe('The secret. Not kept anywhere by the console after it is hidden.'),
  })
  .meta({ id: 'RevealedSecret' });
export type RevealedSecret = z.infer<typeof RevealedSecretSchema>;
