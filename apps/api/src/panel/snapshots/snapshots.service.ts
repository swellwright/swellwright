import { Inject, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import {
  PANEL_DIFF_AGAINST_LIVE,
  PANEL_SNAPSHOT_EXPORT_FORMAT,
  PANEL_SNAPSHOT_EXPORT_VERSION,
  PANEL_SNAPSHOT_OBJECT_KINDS,
  PANEL_SNAPSHOT_PAGE_DEFAULT,
  type CreatePanelSnapshotRequest,
  type PanelDiff,
  type PanelDiffNote,
  type PanelDiffQuery,
  type PanelDiffSide,
  type PanelSnapshotCoverage,
  type PanelSnapshotKind,
  type PanelSnapshotList,
  type PanelSnapshotListQuery,
  type PanelSnapshotObjectKind,
  type PanelSnapshotSettings,
  type PanelSnapshotSummary,
} from '@swellwright/contracts';
import { type Database, type PanelSnapshot, Prisma } from '@swellwright/db';
import {
  buildSnapshotContent,
  countsOf,
  diffSnapshotContents,
  kindHashesOf,
  objectCountOf,
  overallHashOf,
  type PanelState,
  type SnapshotContent,
} from '@swellwright/remnawave';

import { AuditService } from '../../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../../auth/context.js';
import { type AppConfig } from '../../config.js';
import { CodedHttpException, VaultSealedException } from '../../http.js';
import { CONFIG, DATABASE, SNAPSHOT_CLOCK } from '../../tokens.js';
import type { Actor } from '../../vault/vault.service.js';
import { PanelReaderService } from '../panel-reader.service.js';
import { PanelService } from '../panel.service.js';
import { decodeContent, encodeContent, SNAPSHOT_ENCODING } from './snapshot-storage.js';

/** For this many days the newest snapshot of each (UTC) day is kept, whatever the count says. */
export const KEEP_DAILY_DAYS = 14;
const DAY_MS = 86_400_000;

/** The seam of the background job: no person, no request. */
const BACKGROUND_META: Pick<RequestMeta, 'ip' | 'requestId'> = {
  ip: undefined,
  requestId: undefined,
};

/** What a run of the background job did. */
export type SnapshotRun =
  'off' | 'unconfigured' | 'not_due' | 'sealed' | 'unchanged' | 'created' | 'failed';

/** The audit details of a snapshot: the counts per kind in snake case (details are flat), never an object. */
const COUNT_FIELDS: Record<PanelSnapshotObjectKind, string> = {
  nodes: 'nodes',
  hosts: 'hosts',
  configProfiles: 'config_profiles',
  internalSquads: 'internal_squads',
  externalSquads: 'external_squads',
  subscriptionTemplates: 'subscription_templates',
  subscriptionSettings: 'subscription_settings',
  snippets: 'snippets',
  nodePlugins: 'node_plugins',
  infraProviders: 'infra_providers',
  billingNodes: 'billing_nodes',
};

const asRecord = <T>(value: unknown): Record<string, T> =>
  value !== null && typeof value === 'object' ? (value as Record<string, T>) : {};

export function toSummary(row: PanelSnapshot): PanelSnapshotSummary {
  const counts = asRecord<number>(row.counts);
  const coverage = asRecord<PanelSnapshotCoverage>(row.coverage);
  const kindHashes = asRecord<string>(row.kindHashes);
  const fullCounts = {} as Record<PanelSnapshotObjectKind, number>;
  const fullCoverage = {} as Record<PanelSnapshotObjectKind, PanelSnapshotCoverage>;
  for (const kind of PANEL_SNAPSHOT_OBJECT_KINDS) {
    fullCounts[kind] = counts[kind] ?? 0;
    fullCoverage[kind] = coverage[kind] ?? 'failed';
  }
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    createdBy:
      row.createdById === null ? null : { id: row.createdById, name: row.createdByName ?? '' },
    panelUrl: row.panelUrl,
    panelVersion: row.panelVersion,
    counts: fullCounts,
    coverage: fullCoverage,
    complete: PANEL_SNAPSHOT_OBJECT_KINDS.every((kind) => fullCoverage[kind] === 'ok'),
    objectCount: row.objectCount,
    overallHash: row.overallHash,
    kindHashes: Object.fromEntries(
      PANEL_SNAPSHOT_OBJECT_KINDS.flatMap((kind) => {
        const hash = kindHashes[kind];
        return hash === undefined ? [] : [[kind, hash]];
      }),
    ),
    rawBytes: row.rawBytes,
    sizeBytes: row.sizeBytes,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    changesSince: row.changesSince,
  };
}

/** What was prepared from one read of the panel: the content, its hashes, and what the row will say about it. */
interface Prepared {
  readonly content: SnapshotContent;
  readonly state: PanelState;
  readonly overallHash: string;
}

/**
 * Snapshots of the panel (ADR 0043): taking one (by a person or the background job), reading them back, comparing two
 * or one with the panel as it is now, exporting and deleting them, and the retention that keeps their number down. A
 * snapshot is the masked, normalised configuration of every object the token may read; nothing in it is a secret.
 * Taking and deleting are recorded in the audit chain in the same transaction.
 */
@Injectable()
export class PanelSnapshotsService {
  private readonly logger = new Logger('PanelSnapshots');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PanelService) private readonly panel: PanelService,
    @Inject(PanelReaderService) private readonly reader: PanelReaderService,
    @Inject(SNAPSHOT_CLOCK) private readonly clock: () => number,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  settings(): PanelSnapshotSettings {
    const intervalMs = this.config.panel.snapshotIntervalMs;
    return {
      intervalHours: intervalMs / 3_600_000,
      keep: this.config.panel.snapshotKeep,
      keepDailyDays: KEEP_DAILY_DAYS,
      scheduling: intervalMs > 0 && this.database !== undefined,
    };
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  /** The snapshots of the connected panel, or all of them while nothing is connected (the history is kept). */
  async list(query: PanelSnapshotListQuery): Promise<PanelSnapshotList> {
    const connection = await this.panel.row();
    const where: Prisma.PanelSnapshotWhereInput = connection
      ? { panelUrl: connection.baseUrl }
      : {};
    const [rows, total] = await Promise.all([
      this.db.panelSnapshot.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.offset ?? 0,
        take: query.limit ?? PANEL_SNAPSHOT_PAGE_DEFAULT,
      }),
      this.db.panelSnapshot.count({ where }),
    ]);
    return { snapshots: rows.map(toSummary), total, settings: this.settings() };
  }

  private async requireRow(id: string): Promise<PanelSnapshot> {
    const row = await this.db.panelSnapshot.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('There is no such snapshot.');
    }
    return row;
  }

  async get(id: string): Promise<PanelSnapshotSummary> {
    return toSummary(await this.requireRow(id));
  }

  private async loadContent(id: string): Promise<SnapshotContent> {
    const stored = await this.db.panelSnapshotContent.findUnique({ where: { snapshotId: id } });
    if (!stored) {
      throw new CodedHttpException(
        409,
        'snapshot_corrupt',
        'The content of this snapshot is missing. Delete it and take another one.',
      );
    }
    return decodeContent(stored, this.config.panel.snapshotMaxBytes);
  }

  // ---- taking ------------------------------------------------------------------------------------------------------

  private prepare(state: PanelState, maskKeyId: string): Prepared {
    if (PANEL_SNAPSHOT_OBJECT_KINDS.every((kind) => state.coverage[kind] !== 'ok')) {
      throw new CodedHttpException(
        502,
        'panel_forbidden',
        'The token of the connection cannot read any kind of object of the panel, so there is nothing to take a snapshot of. Give it a scope to read, or use a token with more.',
      );
    }
    const content = buildSnapshotContent(state, maskKeyId);
    return { content, state, overallHash: overallHashOf(content) };
  }

  /** Stores a prepared snapshot and records it, in one transaction. */
  private async store(input: {
    readonly prepared: Prepared;
    readonly connection: { readonly id: string; readonly baseUrl: string };
    readonly kind: PanelSnapshotKind;
    readonly label: string | null;
    readonly actor: Actor | null;
    readonly meta: Pick<RequestMeta, 'ip' | 'requestId'>;
  }): Promise<PanelSnapshot> {
    const { prepared, connection, kind, label, actor, meta } = input;
    const { content, state } = prepared;
    const encoded = await encodeContent(content, this.config.panel.snapshotMaxBytes);
    const counts = countsOf(content);
    const objectCount = objectCountOf(content);
    const complete = PANEL_SNAPSHOT_OBJECT_KINDS.every((k) => state.coverage[k] === 'ok');
    const details: Record<string, string | number | boolean | null> = {
      kind,
      label,
      panel_version: state.version.version.slice(0, 64),
      object_count: objectCount,
      overall_hash: prepared.overallHash,
      complete,
      raw_bytes: encoded.rawBytes,
      size_bytes: encoded.data.length,
    };
    for (const k of PANEL_SNAPSHOT_OBJECT_KINDS) {
      details[COUNT_FIELDS[k]] = counts[k];
    }
    const createdAt = new Date(this.clock());
    return this.db.$transaction(async (tx) => {
      const row = await tx.panelSnapshot.create({
        data: {
          connectionId: connection.id,
          panelUrl: connection.baseUrl,
          label,
          kind,
          createdAt,
          createdById: actor?.id ?? null,
          createdByName: actor?.name ?? null,
          panelVersion: state.version.version.slice(0, 64),
          counts,
          coverage: state.coverage,
          objectCount,
          overallHash: prepared.overallHash,
          kindHashes: kindHashesOf(content),
          maskKeyId: content.maskKeyId,
          rawBytes: encoded.rawBytes,
          sizeBytes: encoded.data.length,
          // Taken now, so the panel is the same as the snapshot: nothing has changed since.
          checkedAt: createdAt,
          changesSince: 0,
          content: {
            create: {
              encoding: SNAPSHOT_ENCODING,
              data: new Uint8Array(encoded.data),
              sha256: encoded.sha256,
            },
          },
        },
      });
      await this.audit.record(
        {
          action: 'panel.snapshot.created',
          outcome: 'success',
          actor,
          object: { type: 'panel_snapshot', id: row.id },
          details,
          meta,
        },
        tx,
      );
      return row;
    });
  }

  /** A snapshot a person asked for: read from the panel itself, counted as one forced read of that person. */
  async create(
    actor: Actor,
    request: CreatePanelSnapshotRequest,
    meta: RequestMeta,
  ): Promise<PanelSnapshotSummary> {
    const stamp = await this.reader.stamp();
    const read = await this.reader.state(actor, true);
    const prepared = this.prepare(read.value, stamp.maskKeyId);
    const row = await this.store({
      prepared,
      connection: stamp.connection,
      kind: 'manual',
      label: request.label ?? null,
      actor,
      meta,
    });
    await this.prune(stamp.connection.baseUrl);
    return toSummary(row);
  }

  // ---- the background job ------------------------------------------------------------------------------------------

  /**
   * One round of the job: when the last snapshot (or the last time the panel was found the same as it) is older than the
   * interval, the panel is read; a panel that is the same as the latest snapshot only records that ("checked, no
   * change"), a changed one is stored as a new snapshot. Skipped while nothing is connected or the vault is sealed.
   * Never throws.
   */
  async runDue(): Promise<SnapshotRun> {
    const intervalMs = this.config.panel.snapshotIntervalMs;
    if (intervalMs <= 0 || !this.database) {
      return 'off';
    }
    try {
      const connection = await this.panel.row();
      if (!connection || connection.state === 'unsupported') {
        return 'unconfigured';
      }
      const latest = await this.db.panelSnapshot.findFirst({
        where: { panelUrl: connection.baseUrl },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const now = this.clock();
      if (latest) {
        const last = Math.max(latest.createdAt.getTime(), latest.checkedAt?.getTime() ?? 0);
        if (now - last < intervalMs) {
          return 'not_due';
        }
      }
      let read: Awaited<ReturnType<PanelReaderService['state']>>;
      try {
        read = await this.reader.state(null, true);
      } catch (error) {
        if (error instanceof VaultSealedException) {
          return 'sealed';
        }
        throw error;
      }
      const stamp = await this.reader.stamp();
      const prepared = this.prepare(read.value, stamp.maskKeyId);
      if (latest?.overallHash === prepared.overallHash) {
        await this.db.panelSnapshot.updateMany({
          where: { id: latest.id },
          data: { checkedAt: new Date(this.clock()), changesSince: 0 },
        });
        return 'unchanged';
      }
      await this.store({
        prepared,
        connection: stamp.connection,
        kind: 'scheduled',
        label: null,
        actor: null,
        meta: BACKGROUND_META,
      });
      await this.prune(stamp.connection.baseUrl);
      return 'created';
    } catch (error) {
      this.logger.warn(
        `the scheduled snapshot of the panel failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return 'failed';
    }
  }

  // ---- retention ---------------------------------------------------------------------------------------------------

  /**
   * Removes the snapshots of a panel beyond the policy: the newest `SW_PANEL_SNAPSHOT_KEEP` stay, and so does the
   * newest of each of the last 14 days, and a snapshot that is the anchor of a change (`before_change`) is never
   * removed here. Each removal is recorded. Returns how many were removed.
   */
  async prune(panelUrl: string): Promise<number> {
    const rows = await this.db.panelSnapshot.findMany({
      where: { panelUrl },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, kind: true, createdAt: true, overallHash: true, objectCount: true },
    });
    const keep = new Set<string>(
      rows.slice(0, this.config.panel.snapshotKeep).map((row) => row.id),
    );
    const now = this.clock();
    const days = new Set<string>();
    for (const row of rows) {
      if (row.kind === 'before_change') {
        keep.add(row.id);
      }
      const age = now - row.createdAt.getTime();
      const day = row.createdAt.toISOString().slice(0, 10);
      if (age < KEEP_DAILY_DAYS * DAY_MS && !days.has(day)) {
        days.add(day);
        keep.add(row.id);
      }
    }
    let removed = 0;
    for (const row of rows) {
      if (keep.has(row.id)) {
        continue;
      }
      const gone = await this.db.$transaction(async (tx) => {
        const result = await tx.panelSnapshot.deleteMany({ where: { id: row.id } });
        if (result.count === 1) {
          await this.audit.record(
            {
              action: 'panel.snapshot.deleted',
              outcome: 'success',
              actor: null,
              object: { type: 'panel_snapshot', id: row.id },
              details: {
                reason: 'retention',
                kind: row.kind,
                object_count: row.objectCount,
                overall_hash: row.overallHash,
              },
              meta: BACKGROUND_META,
            },
            tx,
          );
        }
        return result.count;
      });
      removed += gone;
    }
    return removed;
  }

  // ---- deleting ----------------------------------------------------------------------------------------------------

  async delete(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const row = await tx.panelSnapshot.findUnique({ where: { id } });
      if (!row) {
        throw new NotFoundException('There is no such snapshot.');
      }
      await tx.panelSnapshot.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'panel.snapshot.deleted',
          outcome: 'success',
          actor,
          object: { type: 'panel_snapshot', id },
          details: {
            reason: 'user',
            kind: row.kind,
            object_count: row.objectCount,
            overall_hash: row.overallHash,
          },
          meta,
        },
        tx,
      );
    });
  }

  // ---- comparing ---------------------------------------------------------------------------------------------------

  private sideOf(row: PanelSnapshot): PanelDiffSide {
    return {
      type: 'snapshot',
      id: row.id,
      label: row.label,
      at: row.createdAt.toISOString(),
      panelVersion: row.panelVersion,
      overallHash: row.overallHash,
    };
  }

  private otherPanel(): CodedHttpException {
    return new CodedHttpException(
      409,
      'snapshot_other_panel',
      'These snapshots are of different panels, and a snapshot of a panel cannot be compared with another panel.',
    );
  }

  /**
   * What differs between a snapshot and the live panel or another snapshot, seen from the snapshot to the other. A
   * comparison with the live panel is also kept on the snapshot as "checked, N objects differ" for the overview.
   */
  async diff(actor: Actor, id: string, query: PanelDiffQuery): Promise<PanelDiff> {
    const from = await this.requireRow(id);
    let toContent: SnapshotContent;
    let to: PanelDiffSide;
    const live = query.against === PANEL_DIFF_AGAINST_LIVE;
    if (live) {
      const stamp = await this.reader.stamp();
      if (stamp.connection.baseUrl !== from.panelUrl) {
        throw this.otherPanel();
      }
      const read = await this.reader.state(actor, query.refresh === 'true');
      const prepared = this.prepare(read.value, stamp.maskKeyId);
      toContent = prepared.content;
      to = {
        type: 'live',
        id: null,
        label: null,
        at: read.fetchedAt,
        panelVersion: read.value.version.version,
        overallHash: prepared.overallHash,
      };
    } else {
      const other = await this.requireRow(query.against);
      if (other.panelUrl !== from.panelUrl) {
        throw this.otherPanel();
      }
      toContent = await this.loadContent(other.id);
      to = this.sideOf(other);
    }
    const fromContent = await this.loadContent(from.id);
    const outcome = diffSnapshotContents(fromContent, toContent, {
      includeUnchanged: query.includeUnchanged === 'true',
    });
    const notes: PanelDiffNote[] = [...outcome.notes];
    const sideVersions = [from.panelVersion, to.panelVersion];
    if (sideVersions[0] && sideVersions[1] && sideVersions[0] !== sideVersions[1]) {
      notes.push({ code: 'panel_version_differs' });
    }
    if (live) {
      const { added, removed, changed } = outcome.summary.objects;
      await this.db.panelSnapshot.updateMany({
        where: { id: from.id },
        data: { checkedAt: new Date(this.clock()), changesSince: added + removed + changed },
      });
    }
    return { from: this.sideOf(from), to, ...outcome, notes };
  }

  // ---- exporting ---------------------------------------------------------------------------------------------------

  /** The snapshot as a file: the summary and, per kind, every object with its hash and masked configuration. */
  async export(id: string): Promise<StreamableFile> {
    const row = await this.requireRow(id);
    const content = await this.loadContent(id);
    const body = JSON.stringify(
      {
        format: PANEL_SNAPSHOT_EXPORT_FORMAT,
        version: PANEL_SNAPSHOT_EXPORT_VERSION,
        masked: true,
        snapshot: toSummary(row),
        maskKeyId: content.maskKeyId,
        kinds: content.kinds,
      },
      null,
      2,
    );
    const day = row.createdAt.toISOString().slice(0, 10);
    const buffer = Buffer.from(`${body}\n`, 'utf8');
    return new StreamableFile(buffer, {
      type: 'application/json',
      disposition: `attachment; filename="swellwright-panel-snapshot-${day}-${row.id.slice(0, 8)}.json"`,
      length: buffer.length,
    });
  }
}
