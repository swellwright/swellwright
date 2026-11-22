import { z } from 'zod';

import { SERVER_STATES } from './servers.js';

/**
 * The dashboard (ADR 0047): one place that says what needs attention, built only from what this server already holds
 * (database rows and the memory of the checks, never a call to the panel or to a server). Two views: the attention
 * feed, a ranked list of items from every source the caller may read, and the health of the fleet, one row per server of
 * the inventory.
 */

// ---- The attention feed --------------------------------------------------------------------------------------------

export const ATTENTION_SEVERITIES = ['critical', 'warning', 'info'] as const;
export const AttentionSeveritySchema = z.enum(ATTENTION_SEVERITIES).meta({
  id: 'AttentionSeverity',
  description:
    '`critical`: something stopped working or an integrity check failed, act now. `warning`: look at it soon. `info`: good to know.',
});
export type AttentionSeverity = z.infer<typeof AttentionSeveritySchema>;

/** Where an item comes from. A caller sees the items of a source only when their role may read it. */
export const ATTENTION_SOURCES = [
  'vault',
  'panel',
  'conventions',
  'reconciliation',
  'snapshots',
  'baseline',
  'servers',
  'runs',
  'audit',
  'plugins',
  'updates',
] as const;
export const AttentionSourceSchema = z.enum(ATTENTION_SOURCES).meta({ id: 'AttentionSource' });
export type AttentionSource = z.infer<typeof AttentionSourceSchema>;

/** The permission that opens a source; `null` is a source nobody needs a permission for (public data). */
export const ATTENTION_SOURCE_PERMISSIONS = {
  vault: 'vault:read',
  panel: 'panel:read',
  conventions: 'panel:read',
  reconciliation: 'panel:read',
  snapshots: 'panel:read',
  baseline: 'servers:read',
  servers: 'servers:read',
  runs: 'servers:read',
  audit: 'audit:read',
  plugins: 'plugins:read',
  updates: null,
} as const satisfies Record<AttentionSource, string | null>;

/**
 * Every kind of item, in the order that ranks items of the same severity (the first is shown first). The console
 * keeps its texts under these names (`dashboard:attention.<kind>.title` and `.detail`).
 */
export const ATTENTION_KINDS = [
  'vault.secrets_expired',
  'panel.unauthorized',
  'panel.token_expired',
  'baseline.host_key_mismatch',
  'audit.chain_failed',
  'vault.sealed',
  'panel.unreachable',
  'panel.unsupported',
  'panel.degraded',
  'panel.token_expiring',
  'vault.secrets_expiring',
  'baseline.failing',
  'baseline.unreachable',
  'baseline.stale',
  'servers.not_ready',
  'runs.failed',
  'conventions.errors',
  'reconciliation.drift',
  'snapshots.stale',
  'plugins.switched_off',
  'vault.uninitialized',
  'panel.not_connected',
  'conventions.not_run',
  'conventions.warnings',
  'reconciliation.undecided',
  'snapshots.none',
  'snapshots.changed',
  'baseline.warnings',
  'baseline.never_checked',
  'servers.facts_stale',
  'audit.verify_overdue',
  'updates.available',
] as const;
export const AttentionKindSchema = z.enum(ATTENTION_KINDS).meta({ id: 'AttentionKind' });
export type AttentionKind = z.infer<typeof AttentionKindSchema>;

/** The places of the console an item can lead to. The console checks at build time that each is one of its routes. */
export const ATTENTION_LINKS = [
  '/dashboard/security/vault',
  '/dashboard/security/audit',
  '/dashboard/panel/connection',
  '/dashboard/panel/checks',
  '/dashboard/panel/snapshots',
  '/dashboard/fleet/servers',
  '/dashboard/fleet/baseline',
  '/dashboard/operations/runs',
  '/dashboard/settings/plugins',
] as const;
export const AttentionLinkSchema = z.enum(ATTENTION_LINKS).meta({ id: 'AttentionLink' });
export type AttentionLink = z.infer<typeof AttentionLinkSchema>;

const ParamValue = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);

export const AttentionItemSchema = z
  .object({
    id: z
      .string()
      .max(80)
      .describe(
        'Stable: the same condition has the same id on every call, so a console can remember that it was hidden.',
      ),
    fingerprint: z
      .string()
      .max(16)
      .describe(
        'Changes when the facts behind the item change (a count, a name, a state). A console that hid the item shows it again when this is not what it hid.',
      ),
    severity: AttentionSeveritySchema,
    kind: AttentionKindSchema,
    source: AttentionSourceSchema,
    title: z
      .string()
      .max(200)
      .describe(
        'English text. The console shows `dashboard:attention.<kind>.title` in the language of the user.',
      ),
    detail: z
      .string()
      .max(500)
      .describe(
        'English text. The console shows `dashboard:attention.<kind>.detail`; `params` fill its placeholders.',
      ),
    params: z
      .record(z.string().max(64), ParamValue)
      .describe(
        'Numbers, flags and short names (of a secret, a server, a plugin: what the caller may read anyway). Never a secret, an address or a person.',
      ),
    since: z.iso
      .datetime()
      .nullable()
      .describe(
        'When the condition began or was last seen, as the source records it; null when the source does not say.',
      ),
    link: AttentionLinkSchema.nullable().describe('The page of the console that deals with it.'),
  })
  .meta({ id: 'AttentionItem' });
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const AttentionSourceStateSchema = z
  .object({
    source: AttentionSourceSchema,
    state: z
      .enum(['ok', 'not_permitted', 'failed'])
      .describe(
        '`ok`: read, and its items (if any) are in the list. `not_permitted`: the role may not read it. `failed`: reading it failed, the others are still here.',
      ),
  })
  .meta({ id: 'AttentionSourceState' });
export type AttentionSourceState = z.infer<typeof AttentionSourceStateSchema>;

export const AttentionFeedSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    items: z
      .array(AttentionItemSchema)
      .describe('Most severe first, then by the order of the kinds, then oldest first.'),
    counts: z.object({
      critical: z.number().int().nonnegative(),
      warning: z.number().int().nonnegative(),
      info: z.number().int().nonnegative(),
    }),
    sources: z.array(AttentionSourceStateSchema),
  })
  .meta({
    id: 'AttentionFeed',
    description:
      "What needs attention, from the sources the caller may read. Built from this server's own records and memory; it never calls the panel or a server.",
  });
export type AttentionFeed = z.infer<typeof AttentionFeedSchema>;

// ---- The health of the fleet ---------------------------------------------------------------------------------------

export const FLEET_HEALTH_STATES = ['critical', 'warning', 'ok', 'unknown'] as const;
export const FleetHealthStateSchema = z.enum(FLEET_HEALTH_STATES).meta({
  id: 'FleetHealthState',
  description:
    'The worst thing known about the server: `critical` (a host key mismatch, an expired secret on every login, a failing check), `warning`, `ok`, or `unknown` (nothing checked yet).',
});
export type FleetHealthState = z.infer<typeof FleetHealthStateSchema>;

/** What is wrong or missing on a server, as flags a table can filter on. */
export const FLEET_FLAGS = [
  'no_host_key',
  'no_access',
  'access_expired',
  'access_failed',
  'facts_missing',
  'facts_stale',
  'baseline_failing',
  'baseline_warning',
  'baseline_unreachable',
  'baseline_stale',
  'baseline_never_checked',
  'host_key_mismatch',
  'node_offline',
  'check_running',
] as const;
export const FleetFlagSchema = z.enum(FLEET_FLAGS).meta({ id: 'FleetFlag' });
export type FleetFlag = z.infer<typeof FleetFlagSchema>;

export const FLEET_BASELINE_STATUSES = [
  'pass',
  'warn',
  'fail',
  'unreachable',
  'never',
  'unassigned',
] as const;

const Count = z.number().int().nonnegative();

export const FleetHealthRowSchema = z
  .object({
    server: z.object({
      id: z.uuid(),
      name: z.string(),
      state: z.enum(SERVER_STATES),
      country: z.string().nullable(),
      tags: z.array(z.string()),
    }),
    health: FleetHealthStateSchema,
    flags: z.array(FleetFlagSchema),
    facts: z
      .object({
        collectedAt: z.iso.datetime(),
        stale: z.boolean(),
        os: z.string().nullable(),
        kernel: z.string().nullable(),
      })
      .nullable()
      .describe('Null until facts are collected.'),
    baseline: z.object({
      status: z.enum(FLEET_BASELINE_STATUSES),
      name: z.string().nullable(),
      version: z.number().int().positive().nullable(),
      lastRunAt: z.iso.datetime().nullable().describe('When the newest finished run ended.'),
      counts: z
        .object({ pass: Count, warn: Count, fail: Count, error: Count, skipped: Count })
        .nullable()
        .describe('Of the newest finished run that observed the server; null when it could not.'),
      errorCode: z.string().nullable().describe('Why the newest run could not observe the server.'),
      trend: z.enum(['better', 'worse', 'same']).nullable(),
      running: z.boolean(),
    }),
    hostKey: z.object({
      pinned: z.boolean(),
      count: Count,
    }),
    access: z.object({
      entries: Count,
      usable: Count.describe('Entries whose secrets have not expired.'),
      expired: Count.describe('Entries with an expired secret.'),
      lastVerifiedAt: z.iso.datetime().nullable().describe('The newest time an entry was tried.'),
      lastVerifyOk: z
        .boolean()
        .nullable()
        .describe('What the newest try found; null when none was tried.'),
    }),
    panelNode: z
      .object({
        name: z.string(),
        state: z.enum(['online', 'offline', 'connecting', 'disabled']),
        asOf: z.iso.datetime().describe('When the reconciliation that matched it ran.'),
      })
      .nullable()
      .describe(
        'The node of the panel that the last reconciliation matched with this server. Null without it, or for a role that may not read the panel.',
      ),
  })
  .meta({ id: 'FleetHealthRow' });
export type FleetHealthRow = z.infer<typeof FleetHealthRowSchema>;

export const FLEET_HEALTH_PAGE_DEFAULT = 25;
export const FLEET_HEALTH_PAGE_MAX = 100;
export const FLEET_HEALTH_SORTS = ['health', 'name', 'lastCheck'] as const;

export const FleetHealthQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FLEET_HEALTH_PAGE_MAX)
    .optional()
    .describe(`Servers per page, ${String(FLEET_HEALTH_PAGE_DEFAULT)} by default.`),
  offset: z.coerce.number().int().min(0).optional().describe('Servers to skip.'),
  // Not the named schemas: a query parameter describes itself inline instead of pointing into the components.
  q: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('Servers whose name or a tag contains this text, ignoring case.'),
  state: z.enum(SERVER_STATES).optional(),
  tag: z.string().min(1).max(32).optional().describe('Only servers that carry this tag.'),
  health: z.enum(FLEET_HEALTH_STATES).optional(),
  flag: z.enum(FLEET_FLAGS).optional().describe('Only servers that have this flag.'),
  sort: z
    .enum(FLEET_HEALTH_SORTS)
    .optional()
    .describe(
      '`health` (default): the worst first, then by name. `name`. `lastCheck`: the longest without a finished check first (never checked on top).',
    ),
  order: z.enum(['asc', 'desc']).optional().describe('Reverses the sort.'),
});
export type FleetHealthQuery = z.infer<typeof FleetHealthQuerySchema>;

export const FleetHealthSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    rows: z.array(FleetHealthRowSchema),
    total: Count.describe('Servers that match the filters, whatever `limit` and `offset` say.'),
    totals: z
      .object({
        servers: Count,
        critical: Count,
        warning: Count,
        ok: Count,
        unknown: Count,
      })
      .describe('Over the whole inventory, not the filters: the strip above the table.'),
    panel: z.object({
      matched: z
        .boolean()
        .describe('A reconciliation has matched servers with nodes since this server started.'),
      asOf: z.iso.datetime().nullable(),
    }),
    settings: z.object({
      baselineStaleDays: Count,
      factsStaleDays: Count,
    }),
  })
  .meta({
    id: 'FleetHealth',
    description:
      'One row per server of the inventory, from stored data only: facts, the newest baseline check, the host key, the access entries and the node the last reconciliation matched.',
  });
export type FleetHealth = z.infer<typeof FleetHealthSchema>;
