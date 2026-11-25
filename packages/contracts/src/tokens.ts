import { z } from 'zod';

import { PERMISSIONS, type Permission, PermissionSchema, STEP_UP_PERMISSIONS } from './roles.js';

/**
 * What a token may carry: every permission except those that need a fresh second factor. A token has no
 * second factor to give, so it could never use them (ADR 0017); refusing them at creation says so early.
 */
export const TOKEN_GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !STEP_UP_PERMISSIONS.includes(permission),
);

export const TOKEN_PREFIX = 'swt_';
/** `swt_` and 43 characters: 256 random bits in base64url. */
export const TOKEN_PATTERN = /^swt_[A-Za-z0-9_-]{43}$/u;
export const TOKEN_MAX_DAYS = 365;
export const TOKEN_DEFAULT_DAYS = 90;
/** Tokens a user may hold at once (active ones). */
export const TOKEN_MAX_ACTIVE = 20;

export const TOKEN_STATES = ['active', 'expired', 'revoked'] as const;
export const TokenStateSchema = z.enum(TOKEN_STATES).meta({ id: 'TokenState' });
export type TokenState = z.infer<typeof TokenStateSchema>;

const CidrSchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

export const TokenViewSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    username: z.string(),
    name: z.string(),
    prefix: z.string().describe('The first characters of the token, to recognise it in a list.'),
    permissions: z.array(PermissionSchema),
    ipAllowlist: z
      .array(z.string())
      .describe('Addresses or ranges it may be used from; empty: anywhere.'),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    lastUsedIp: z.string().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    state: TokenStateSchema,
  })
  .meta({ id: 'TokenView' });
export type TokenView = z.infer<typeof TokenViewSchema>;

export const TokenListSchema = z
  .object({ tokens: z.array(TokenViewSchema) })
  .meta({ id: 'TokenList' });
export type TokenList = z.infer<typeof TokenListSchema>;

export const CreateTokenRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    permissions: z
      .array(PermissionSchema)
      .min(1)
      .max(PERMISSIONS.length)
      .refine((list) => new Set(list).size === list.length, {
        message: 'List each permission once.',
      })
      .refine((list) => list.every((p) => TOKEN_GRANTABLE_PERMISSIONS.includes(p)), {
        message: 'A token cannot carry a permission that needs a fresh second factor.',
      }),
    expiresInDays: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(TOKEN_DEFAULT_DAYS),
    ipAllowlist: z
      .array(CidrSchema)
      .max(16)
      .default([])
      .describe(
        'Addresses or ranges the token may be used from; empty: anywhere. An address is compared only with ranges of its own family: `::/0` admits every IPv6 address and no IPv4 one, so allowing both takes `0.0.0.0/0` and `::/0`. An IPv4 address that arrives mapped into IPv6 (`::ffff:a.b.c.d`) counts as IPv4.',
      ),
  })
  .meta({ id: 'CreateTokenRequest' });
/** What a client sends: expiry and the address list may be left out. */
export type CreateTokenInput = z.input<typeof CreateTokenRequestSchema>;
/** What the server works with: the defaults are filled in. */
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

export const CreatedTokenSchema = z
  .object({
    token: z
      .string()
      .describe(
        'The token. Shown once, never again; only its hash is kept. Send it as `Authorization: Bearer <token>`.',
      ),
    view: TokenViewSchema,
  })
  .meta({ id: 'CreatedToken' });
export type CreatedToken = z.infer<typeof CreatedTokenSchema>;

export const TokenIdParamsSchema = z.object({ id: z.uuid() });

export const TokenListQuerySchema = z.object({
  userId: z.uuid().optional().describe('Only the tokens of this user.'),
});
export type TokenListQuery = z.infer<typeof TokenListQuerySchema>;
