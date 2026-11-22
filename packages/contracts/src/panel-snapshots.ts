import { z } from 'zod';

// Snapshots of a Remnawave panel and the diff between two of them (ADR 0043). A snapshot is what Swellwright knew about
// the panel's objects at one moment, in the normalised, masked form of ADR 0041: nothing in it is a secret, so
// nothing here can be one either. Two snapshots (or a snapshot and the live panel) are compared object by object and
// field by field; a secret that was rotated shows as "changed, masked", never as a value.

/** Where a snapshot came from. `before_change` and `imported` are reserved for later phases (the change flow, GitOps). */
export const PANEL_SNAPSHOT_KINDS = ['manual', 'scheduled', 'before_change', 'imported'] as const;
export const PanelSnapshotKindSchema = z.enum(PANEL_SNAPSHOT_KINDS).meta({
  id: 'PanelSnapshotKind',
  description:
    '`manual`: a person asked for it. `scheduled`: the background job took it. `before_change` and `imported` are reserved: the anchor of a later change, and an import from a file.',
});
export type PanelSnapshotKind = z.infer<typeof PanelSnapshotKindSchema>;

/** The kinds of panel object a snapshot holds, in the order the console shows them. */
export const PANEL_SNAPSHOT_OBJECT_KINDS = [
  'nodes',
  'hosts',
  'configProfiles',
  'internalSquads',
  'externalSquads',
  'subscriptionTemplates',
  'subscriptionSettings',
  'snippets',
  'nodePlugins',
  'infraProviders',
  'billingNodes',
] as const;
export const PanelSnapshotObjectKindSchema = z.enum(PANEL_SNAPSHOT_OBJECT_KINDS).meta({
  id: 'PanelSnapshotObjectKind',
  description:
    'A kind of panel object. `infraProviders` and `billingNodes` are the two halves of the panel billing data; the snapshot does not hold API tokens, users or anything about what runs right now.',
});
export type PanelSnapshotObjectKind = z.infer<typeof PanelSnapshotObjectKindSchema>;

export const PANEL_SNAPSHOT_COVERAGE_STATES = ['ok', 'denied', 'failed'] as const;
export const PanelSnapshotCoverageSchema = z.enum(PANEL_SNAPSHOT_COVERAGE_STATES).meta({
  id: 'PanelSnapshotCoverage',
  description:
    '`ok`: the kind is in the snapshot. `denied`: the token has no scope to read it. `failed`: the panel answered in a shape this release does not know, or the read failed in another way. A kind that is not `ok` is left out of the snapshot and of every comparison.',
});
export type PanelSnapshotCoverage = z.infer<typeof PanelSnapshotCoverageSchema>;

const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const Count = z.number().int().nonnegative();

const countsOfKinds = z.record(PanelSnapshotObjectKindSchema, Count);
const coverageOfKinds = z.record(PanelSnapshotObjectKindSchema, PanelSnapshotCoverageSchema);
const hashesOfKinds = z.partialRecord(PanelSnapshotObjectKindSchema, Hash);

export const PANEL_SNAPSHOT_LABEL_MAX = 100;
export const PANEL_SNAPSHOT_PAGE_DEFAULT = 25;
export const PANEL_SNAPSHOT_PAGE_MAX = 100;

export const PanelSnapshotSummarySchema = z
  .object({
    id: z.uuid(),
    label: z.string().nullable().describe('The name a person gave it; null when none was given.'),
    kind: PanelSnapshotKindSchema,
    createdAt: z.iso.datetime(),
    createdBy: z
      .object({ id: z.uuid(), name: z.string().describe('The login name at the time.') })
      .nullable()
      .describe('Null for a scheduled snapshot.'),
    panelUrl: z.string().describe('The panel it was taken from.'),
    panelVersion: z.string().nullable(),
    counts: countsOfKinds.describe(
      'How many objects of each kind it holds (0 for a kind that is not covered).',
    ),
    coverage: coverageOfKinds,
    complete: z.boolean().describe('True when every kind is `ok`.'),
    objectCount: Count,
    overallHash: Hash.describe(
      'SHA-256 over the (id, hash) pairs of every covered object: two snapshots with the same hash hold the same configuration.',
    ),
    kindHashes: hashesOfKinds.describe('The same per kind, for the covered kinds.'),
    rawBytes: Count.describe('The size of the content before compression.'),
    sizeBytes: Count.describe('The size of the content as it is stored (compressed).'),
    checkedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'When the panel was last compared with this snapshot (the background job, or a comparison with the live panel).',
      ),
    changesSince: Count.nullable().describe(
      'How many objects differed at `checkedAt`: 0 when the panel was found the same, null when it was never compared.',
    ),
  })
  .meta({
    id: 'PanelSnapshotSummary',
    description:
      'A snapshot without its content. The content is the masked, normalised configuration of every object; the secrets in it are replaced by keyed fingerprints (ADR 0041).',
  });
export type PanelSnapshotSummary = z.infer<typeof PanelSnapshotSummarySchema>;

export const PanelSnapshotSettingsSchema = z
  .object({
    intervalHours: z
      .number()
      .nonnegative()
      .describe('How often the background job takes a snapshot; 0 means it is off.'),
    keep: z.number().int().positive().describe('How many snapshots are kept at least.'),
    keepDailyDays: z
      .number()
      .int()
      .nonnegative()
      .describe('For this many days the newest snapshot of each day is kept whatever `keep` says.'),
    scheduling: z
      .boolean()
      .describe('True when the background job runs (the interval is on and a database is there).'),
  })
  .meta({ id: 'PanelSnapshotSettings' });
export type PanelSnapshotSettings = z.infer<typeof PanelSnapshotSettingsSchema>;

export const PanelSnapshotListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PANEL_SNAPSHOT_PAGE_MAX)
    .optional()
    .describe(`Snapshots per page, ${String(PANEL_SNAPSHOT_PAGE_DEFAULT)} by default.`),
  offset: z.coerce.number().int().min(0).optional().describe('How many to skip, newest first.'),
});
export type PanelSnapshotListQuery = z.infer<typeof PanelSnapshotListQuerySchema>;

export const PanelSnapshotListSchema = z
  .object({
    snapshots: z.array(PanelSnapshotSummarySchema),
    total: Count,
    settings: PanelSnapshotSettingsSchema,
  })
  .meta({ id: 'PanelSnapshotList' });
export type PanelSnapshotList = z.infer<typeof PanelSnapshotListSchema>;

export const CreatePanelSnapshotRequestSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(PANEL_SNAPSHOT_LABEL_MAX)
      .optional()
      .describe('A name for the snapshot ("before the key rotation"). Optional.'),
  })
  .meta({ id: 'CreatePanelSnapshotRequest' });
export type CreatePanelSnapshotRequest = z.infer<typeof CreatePanelSnapshotRequestSchema>;

export const PanelSnapshotParamsSchema = z.object({ id: z.uuid() });

export const PANEL_DIFF_AGAINST_LIVE = 'live';

export const PanelDiffQuerySchema = z.object({
  against: z
    .union([z.literal(PANEL_DIFF_AGAINST_LIVE), z.uuid()])
    .describe(
      'What to compare the snapshot with: `live` (the panel as it is now, read through the memory of this server) or the id of another snapshot of the same panel.',
    ),
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'With `against=live`: true asks the panel again instead of answering from memory. Rate limited per user, like every forced read.',
    ),
  includeUnchanged: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'true lists the objects that did not change as well; the summary counts them either way.',
    ),
});
export type PanelDiffQuery = z.infer<typeof PanelDiffQuerySchema>;

// ---------------------------------------------------------------------------------------------------------------
// The diff.

export const PANEL_DIFF_OBJECT_STATUSES = ['added', 'removed', 'changed', 'unchanged'] as const;
export const PanelDiffObjectStatusSchema = z.enum(PANEL_DIFF_OBJECT_STATUSES).meta({
  id: 'PanelDiffObjectStatus',
  description:
    'Seen from the first side to the second: `added` is in the second only, `removed` in the first only.',
});
export type PanelDiffObjectStatus = z.infer<typeof PanelDiffObjectStatusSchema>;

export const PanelFieldChangeSchema = z
  .object({
    path: z
      .string()
      .describe(
        'Where in the object, `config.inbounds[tag=MAIN].port`: keys with a dot, an array element of an object by its natural key (`[tag=...]`, `[uuid=...]`, `[name=...]`) and otherwise by position (`[2]`).',
      ),
    op: z.enum(['added', 'removed', 'changed']),
    before: z
      .unknown()
      .optional()
      .describe(
        'The value in the first side (JSON). Absent for `added`. A very large value is replaced by a text that says how large it was.',
      ),
    after: z.unknown().optional().describe('The value in the second side. Absent for `removed`.'),
    masked: z
      .boolean()
      .optional()
      .describe(
        'True when a value is, or holds, a masked secret. The two sides then differ in the keyed fingerprint (`[masked:1a2b3c4d]` against `[masked:5e6f7a8b]`): the secret was changed, and neither value can be read.',
      ),
    hidden: z
      .boolean()
      .optional()
      .describe(
        'True for a list of people (clients, users, accounts, peers): only how many items it holds is shown, never what is in them.',
      ),
    lines: z
      .object({ removed: Count, added: Count })
      .optional()
      .describe(
        'For a text of several lines (a YAML template): how many lines went and came; `before` and `after` hold those lines only.',
      ),
    valueTruncated: z
      .boolean()
      .optional()
      .describe('True when `before` or `after` was cut to the size limit.'),
  })
  .meta({ id: 'PanelFieldChange' });
export type PanelFieldChange = z.infer<typeof PanelFieldChangeSchema>;

export const PanelDiffObjectSchema = z
  .object({
    kind: PanelSnapshotObjectKindSchema,
    id: z.string().describe('The uuid of the object (the name for a snippet).'),
    name: z.string(),
    status: PanelDiffObjectStatusSchema,
    changes: z
      .array(PanelFieldChangeSchema)
      .describe(
        'For `changed`: what differs. For `added` and `removed`: empty, the whole object is the change.',
      ),
    changeCount: Count.describe('How many field changes there are, also when `changes` was cut.'),
    truncated: z.boolean().describe('True when `changes` holds fewer entries than `changeCount`.'),
    fromHash: Hash.nullable(),
    toHash: Hash.nullable(),
  })
  .meta({ id: 'PanelDiffObject' });
export type PanelDiffObject = z.infer<typeof PanelDiffObjectSchema>;

export const PanelDiffCountsSchema = z
  .object({ added: Count, removed: Count, changed: Count, unchanged: Count })
  .meta({ id: 'PanelDiffCounts' });
export type PanelDiffCounts = z.infer<typeof PanelDiffCountsSchema>;

export const PANEL_DIFF_NOTE_CODES = [
  'kind_not_covered',
  'mask_key_differs',
  'panel_version_differs',
  'noise_only',
  'objects_cut',
] as const;
export const PanelDiffNoteSchema = z
  .object({
    code: z.enum(PANEL_DIFF_NOTE_CODES),
    kinds: z.array(PanelSnapshotObjectKindSchema).optional(),
    count: Count.optional(),
  })
  .meta({
    id: 'PanelDiffNote',
    description:
      '`kind_not_covered`: a kind is missing on one side (the token cannot read it) and was not compared. `mask_key_differs`: the two sides were masked with different keys, so rotated secrets cannot be told apart and masked values were compared as equal. `panel_version_differs`: the panel was updated between the two. `noise_only`: `count` objects had a different hash but only in fields that are left out of a diff (timestamps). `objects_cut`: the list of objects was cut to the size limit; the counts are complete.',
  });
export type PanelDiffNote = z.infer<typeof PanelDiffNoteSchema>;

export const PanelDiffSideSchema = z
  .object({
    type: z.enum(['snapshot', 'live']),
    id: z.uuid().nullable().describe('The snapshot id; null for the live panel.'),
    label: z.string().nullable(),
    at: z.iso.datetime().describe('When the snapshot was taken, or the live panel was read.'),
    panelVersion: z.string().nullable(),
    overallHash: Hash,
  })
  .meta({ id: 'PanelDiffSide' });
export type PanelDiffSide = z.infer<typeof PanelDiffSideSchema>;

export const PanelDiffSchema = z
  .object({
    from: PanelDiffSideSchema,
    to: PanelDiffSideSchema,
    identical: z
      .boolean()
      .describe(
        'True when nothing differs in the kinds that were compared: "no differences" is a result, not an empty list.',
      ),
    summary: z.object({
      objects: PanelDiffCountsSchema,
      byKind: z.partialRecord(PanelSnapshotObjectKindSchema, PanelDiffCountsSchema),
      fieldChanges: Count.describe('How many field changes there are in all `changed` objects.'),
    }),
    objects: z.array(PanelDiffObjectSchema),
    notes: z.array(PanelDiffNoteSchema),
    labels: z
      .record(z.string(), z.string())
      .describe(
        'Names for the uuids that appear in the values of the changes (an inbound, a node, a squad), so that a change can be read without a second lookup.',
      ),
  })
  .meta({
    id: 'PanelDiff',
    description:
      'The differences between two snapshots, or between a snapshot and the live panel, seen from `from` to `to`. Runtime state (online, counters, versions of a node) is not compared; a masked secret is compared by its keyed fingerprint and never shown.',
  });
export type PanelDiff = z.infer<typeof PanelDiffSchema>;

/** The envelope of an exported snapshot: a file that Swellwright, or a person with a text editor, can read later. */
export const PANEL_SNAPSHOT_EXPORT_FORMAT = 'swellwright.panel-snapshot';
export const PANEL_SNAPSHOT_EXPORT_VERSION = 1;
