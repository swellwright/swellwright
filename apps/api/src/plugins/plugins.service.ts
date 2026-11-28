import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type PluginConfigField,
  type PluginConfigView,
  type PluginList,
  type PluginPermissionChange,
  type PluginPermissionsView,
  type PluginStatus,
  type PluginView,
} from '@swellwright/contracts';
import { type Database, type PluginApproval } from '@swellwright/db';
import {
  type ConfigSchemaFile,
  permissionDiff,
  type PluginPermissions,
  secretFields,
  validateConfig,
  widensPermissions,
} from '@swellwright/plugin-api';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { type AppConfig } from '../config.js';
import { secretTypeOf } from './broker.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { type Actor } from '../users/users.service.js';
import { type DiscoveredPlugin, discoverPlugin, discoverPlugins } from './discovery.js';
import type { RuntimeSnapshot } from './host/process.js';
import { PluginRuntime } from './runtime.js';

/** An arbitrary constant: one transaction at a time may enable, disable or switch off a plugin. */
const PLUGINS_LOCK_KEY = 7_761_238;
const UNVERIFIABLE_LIMIT = 3;
const UNVERIFIABLE_STRIKE_MS = 1000;

/** Why a plugin that was enabled was switched off without anyone asking. */
export type SwitchOffReason = 'missing' | 'unavailable' | 'changed';

/** The permissions in one canonical form, so the text that is stored and compared is always the same. */
export function canonicalPermissions(permissions: PluginPermissions): PluginPermissionsView {
  return {
    network: [...permissions.network].sort(),
    secrets: [...permissions.secrets].sort(),
    panel: [...permissions.panel].sort(),
    ssh: permissions.ssh,
  };
}

function parseApproved(text: string): PluginPermissionsView {
  const value = JSON.parse(text) as PluginPermissionsView;
  return canonicalPermissions(value);
}

/** The usable plugin for an id, or failing that any plugin whose manifest names it (to tell why it is not usable). */
function indexById(found: readonly DiscoveredPlugin[]): Map<string, DiscoveredPlugin> {
  const index = new Map<string, DiscoveredPlugin>();
  for (const plugin of found) {
    const id = plugin.manifest?.id ?? (plugin.transient === true ? plugin.folder : undefined);
    if (id === undefined) {
      continue;
    }
    const known = index.get(id);
    if (
      known === undefined ||
      (known.state === 'invalid' &&
        (plugin.state !== 'invalid' || (known.transient !== true && plugin.transient === true)))
    ) {
      index.set(id, plugin);
    }
  }
  return index;
}

/** One approval as opposed to any other: the same files approved again, with other permissions, is another one. */
function revisionOf(record: PluginApproval): string {
  return `${record.approvedAt.toISOString()}\0${record.digest}\0${record.permissions}`;
}

function whyNotRunning(
  record: PluginApproval,
  plugin: DiscoveredPlugin | undefined,
): SwitchOffReason | undefined {
  if (plugin === undefined) {
    return 'missing';
  }
  if (plugin.state !== 'available') {
    return 'unavailable';
  }
  return plugin.digest === record.digest && plugin.trust === record.trust ? undefined : 'changed';
}

function statusOf(
  plugin: DiscoveredPlugin | undefined,
  record: PluginApproval | undefined,
): PluginStatus {
  if (plugin === undefined) {
    return 'missing';
  }
  if (plugin.state !== 'available') {
    return 'unavailable';
  }
  if (record === undefined) {
    return 'not_enabled';
  }
  if (record.digest !== plugin.digest || record.trust !== plugin.trust) {
    return 'changed';
  }
  return record.enabled ? 'enabled' : 'disabled';
}

function changeOf(
  approved: PluginPermissionsView,
  now: PluginPermissionsView,
): PluginPermissionChange {
  const diff = permissionDiff(approved, now);
  const list = (change: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }) => ({
    added: [...change.added],
    removed: [...change.removed],
  });
  return {
    network: list(diff.network),
    secrets: list(diff.secrets),
    panel: list(diff.panel),
    ssh: diff.ssh,
    widens: widensPermissions(diff),
  };
}

function runtimeOf(snapshot: RuntimeSnapshot): PluginView['runtime'] {
  return {
    state: snapshot.state,
    startedAt: snapshot.startedAt?.toISOString() ?? null,
    calls: snapshot.calls,
    lastError: snapshot.lastError,
    modules: snapshot.modules.map((m) => ({ kind: m.kind, methods: [...m.methods] })),
  };
}

export function viewOf(
  plugin: DiscoveredPlugin | undefined,
  record: PluginApproval | undefined,
  runtime: RuntimeSnapshot,
): PluginView {
  const manifest = plugin?.manifest;
  const status = statusOf(plugin, record);
  const permissions = manifest ? canonicalPermissions(manifest.permissions) : null;
  const approved = record ? parseApproved(record.permissions) : null;
  return {
    id: manifest?.id ?? plugin?.folder ?? record?.pluginId ?? '',
    folder: plugin?.folder ?? null,
    trust: plugin?.trust ?? null,
    discovery: plugin?.state ?? null,
    status,
    problems: [...(plugin?.problems ?? [])],
    name: manifest?.name ?? null,
    version: manifest?.version ?? null,
    description: manifest?.description ?? null,
    license: manifest?.license ?? null,
    provides: (manifest?.provides ?? []).map((p) => ({
      kind: p.kind,
      mode: p.driver === undefined ? 'code' : 'declarative',
    })),
    permissions,
    digest: plugin?.digest ?? null,
    signed: manifest?.signature !== undefined,
    hasSettings: manifest?.ui !== undefined,
    hasConfig: manifest?.config !== undefined,
    sidecar:
      manifest?.sidecar === undefined
        ? null
        : {
            image: manifest.sidecar.image,
            port: manifest.sidecar.port,
            memoryMiB: manifest.sidecar.memoryMiB,
            cpus: manifest.sidecar.cpus,
          },
    approval: record
      ? {
          version: record.version,
          trust:
            record.trust === 'official' || record.trust === 'community' ? record.trust : 'local',
          digest: record.digest,
          permissions:
            approved ?? canonicalPermissions({ network: [], secrets: [], panel: [], ssh: false }),
          approvedAt: record.approvedAt.toISOString(),
          approvedBy: record.approvedBy,
        }
      : null,
    runtime: runtimeOf(status === 'enabled' ? runtime : { ...runtime, state: 'stopped' }),
    change:
      status === 'changed' && permissions !== null && approved !== null
        ? changeOf(approved, permissions)
        : null,
  };
}

/**
 * Which plugins this instance has and which of them an administrator approved (ADR 0027). Discovery describes
 * the files (ADR 0021); this adds the decision, tied to the digest of the files, so a plugin whose files change
 * after approval is switched off and must be approved again. Nothing here runs a plugin.
 */
@Injectable()
export class PluginsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Plugins');
  private readonly unverifiable = new Map<
    string,
    { approvedAt: number; strikes: number; lastStrike: number }
  >();

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'pluginRoots' | 'version'>,
    @Inject(PluginRuntime) private readonly runtime: PluginRuntime,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** A plugin that changed while Swellwright was off must not come back switched on. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.database) {
      return;
    }
    try {
      await this.reconcile(await this.discover());
    } catch (error) {
      this.logger.warn(
        `could not check the enabled plugins at start: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** A plugin as discovery sees it now, by id. */
  async find(id: string): Promise<DiscoveredPlugin | undefined> {
    return indexById(await this.discover()).get(id);
  }

  private discover(): Promise<DiscoveredPlugin[]> {
    return discoverPlugins(this.config.pluginRoots, this.config.version);
  }

  /** Switches off every enabled plugin that is gone, unusable, or no longer what was approved. */
  private async reconcile(found: readonly DiscoveredPlugin[]): Promise<void> {
    const byId = indexById(found);
    const enabled = await this.db.pluginApproval.findMany({ where: { enabled: true } });
    for (const record of enabled) {
      const current = byId.get(record.pluginId);
      const unavailable =
        current?.trust !== record.trust
          ? found.find(
              (plugin) =>
                plugin.folder === record.pluginId &&
                plugin.trust === record.trust &&
                plugin.transient === true,
            )
          : undefined;
      const plugin = unavailable ?? current;
      if (plugin?.transient === true && plugin.trust === record.trust) {
        await this.noteUnverifiable(record, plugin);
        continue;
      }
      this.unverifiable.delete(record.pluginId);
      const reason = whyNotRunning(record, plugin);
      if (reason !== undefined) {
        await this.switchOff(record, reason);
      }
    }
  }

  private async noteUnverifiable(record: PluginApproval, plugin: DiscoveredPlugin): Promise<void> {
    const id = record.pluginId;
    const approvedAt = record.approvedAt.getTime();
    const observed = this.unverifiable.get(id);
    const previous = observed?.approvedAt === approvedAt ? observed : undefined;
    const strikes = previous?.strikes ?? 0;
    if (strikes >= UNVERIFIABLE_LIMIT) {
      return;
    }
    const now = Date.now();
    if (
      plugin.hardLink !== true &&
      previous !== undefined &&
      now - previous.lastStrike < UNVERIFIABLE_STRIKE_MS
    ) {
      return;
    }
    const next = plugin.hardLink === true ? UNVERIFIABLE_LIMIT : strikes + 1;
    this.unverifiable.set(id, { approvedAt, strikes: next, lastStrike: now });
    if (next >= UNVERIFIABLE_LIMIT) {
      this.runtime.requestStop(id);
      await this.audit.note({
        action: 'plugin.unverifiable',
        outcome: 'failure',
        actor: null,
        object: { type: 'plugin', id },
        details: { reason: plugin.hardLink === true ? 'hard_link' : 'file_verification_failed' },
        meta: { ip: undefined, requestId: undefined },
      });
    }
  }

  private async switchOff(record: PluginApproval, reason: SwitchOffReason): Promise<void> {
    const { pluginId, approvedAt } = record;
    const stopped = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLUGINS_LOCK_KEY})`;
      const changed = await tx.pluginApproval.updateMany({
        where: { pluginId, enabled: true, approvedAt },
        data: { enabled: false },
      });
      if (changed.count === 0) {
        return false;
      }
      await this.audit.record(
        {
          action: 'plugin.disabled',
          outcome: 'success',
          actor: null,
          object: { type: 'plugin', id: pluginId },
          details: { reason, version: record.version },
          meta: { ip: undefined, requestId: undefined },
        },
        tx,
      );
      return true;
    });
    if (stopped) {
      this.runtime.requestStop(pluginId);
    }
  }

  /**
   * The plugin as it may run now: enabled, approved, and with files that are what was approved. A plugin that
   * was enabled and is not any more is switched off here, so the host never runs what nobody approved.
   */
  async runnable(id: string): Promise<
    | {
        readonly kind: 'ok';
        readonly plugin: DiscoveredPlugin;
        /** What was approved, from the stored approval. */
        readonly network: readonly string[];
        readonly secretKinds: readonly string[];
        /** Which approval this is: a process started under another one is not used for this one. */
        readonly revision: string;
        readonly approvedAt: Date;
      }
    | { readonly kind: 'unknown' }
    | { readonly kind: 'not_enabled'; readonly why: string }
  > {
    const unavailable: DiscoveredPlugin[] = [];
    const discovered = await discoverPlugin(
      this.config.pluginRoots,
      this.config.version,
      id,
      (candidate) => {
        unavailable.push(candidate);
      },
    );
    const record = await this.db.pluginApproval.findUnique({ where: { pluginId: id } });
    // File checks can be slow. Only then read the current approval and resolve its trust tier.
    const plugin =
      discovered?.trust === record?.trust
        ? discovered
        : (unavailable.find((candidate) => candidate.trust === record?.trust) ?? discovered);
    if (record === null) {
      this.unverifiable.delete(id);
      return plugin === undefined
        ? { kind: 'unknown' }
        : { kind: 'not_enabled', why: 'it was never enabled' };
    }
    if (!record.enabled) {
      this.unverifiable.delete(id);
      return { kind: 'not_enabled', why: 'it is disabled' };
    }
    if (plugin?.transient === true && plugin.trust === record.trust) {
      await this.noteUnverifiable(record, plugin);
      return {
        kind: 'not_enabled',
        why:
          plugin.hardLink === true
            ? 'a plugin file must have exactly one hard link; install an independent copy'
            : 'its files could not be verified; try again',
      };
    }
    this.unverifiable.delete(id);
    const reason = whyNotRunning(record, plugin);
    if (reason !== undefined || plugin === undefined) {
      await this.switchOff(record, reason ?? 'missing');
      return {
        kind: 'not_enabled',
        why: `its files are not what was approved (${reason ?? 'missing'}); it was switched off`,
      };
    }
    const approved = parseApproved(record.permissions);
    return {
      kind: 'ok',
      plugin,
      network: approved.network,
      secretKinds: approved.secrets,
      revision: revisionOf(record),
      approvedAt: record.approvedAt,
    };
  }

  /**
   * The digest a plugin was approved with, when it is enabled: what the token of its sidecar is made from. One read
   * of the approval and nothing of the files, so that a request at the gateway with a wrong token costs no discovery.
   */
  async enabledApproval(id: string): Promise<{ digest: string; approvedAt: Date } | undefined> {
    const record = await this.db.pluginApproval.findUnique({
      where: { pluginId: id },
      select: { enabled: true, digest: true, approvedAt: true },
    });
    return record?.enabled === true ? record : undefined;
  }

  async list(): Promise<PluginList> {
    const found = await this.discover();
    await this.reconcile(found);
    const records = new Map(
      (await this.db.pluginApproval.findMany()).map((record) => [record.pluginId, record]),
    );
    const byId = indexById(found);
    const plugins = found.map((plugin) =>
      viewOf(
        plugin,
        records.get(plugin.manifest?.id ?? (plugin.transient === true ? plugin.folder : '')),
        this.runtime.snapshotOf(
          plugin.manifest?.id ?? (plugin.transient === true ? plugin.folder : ''),
        ),
      ),
    );
    const shown = new Set(found.flatMap((p) => (p.manifest ? [p.manifest.id] : [])));
    for (const record of records.values()) {
      if (!shown.has(record.pluginId) && !byId.has(record.pluginId)) {
        plugins.push(viewOf(undefined, record, this.runtime.snapshotOf(record.pluginId)));
      }
    }
    const roots = this.config.pluginRoots;
    return {
      plugins,
      directories: {
        official: roots.some((r) => r.trust === 'official'),
        local: roots.some((r) => r.trust === 'local'),
        community: roots.some((r) => r.trust === 'community'),
      },
    };
  }

  async viewById(id: string): Promise<PluginView> {
    const { plugins } = await this.list();
    const view =
      plugins.find((p) => p.id === id && p.discovery !== 'invalid') ??
      plugins.find((p) => p.id === id);
    if (!view) {
      throw new NotFoundException('There is no such plugin.');
    }
    return view;
  }

  /**
   * Approves a plugin as it is now. The digest is what the administrator was shown; if the files differ the
   * approval is refused, so nobody approves code they have not seen.
   */
  async enable(
    actor: Actor,
    id: string,
    digest: string,
    meta: RequestMeta,
    canReveal: boolean,
  ): Promise<PluginView> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLUGINS_LOCK_KEY})`;
      const plugin = indexById(await this.discover()).get(id);
      if (plugin?.manifest === undefined) {
        throw new NotFoundException('There is no such plugin.');
      }
      if (plugin.state !== 'available' || plugin.digest === undefined) {
        throw new ConflictException(
          `This plugin cannot be enabled: ${plugin.problems[0] ?? 'it is not usable'}.`,
        );
      }
      if (plugin.digest !== digest) {
        throw new ConflictException(
          'The plugin changed since you looked at it. Review it again before enabling.',
        );
      }
      if (!canReveal && plugin.configSchema !== undefined) {
        const fields = secretFields(plugin.configSchema);
        if (fields.length > 0) {
          const row = await tx.pluginConfig.findUnique({ where: { pluginId: id } });
          let saved: unknown;
          try {
            saved = row === null ? undefined : JSON.parse(row.settings);
          } catch {
            saved = undefined;
          }
          if (
            typeof saved === 'object' &&
            saved !== null &&
            fields.some(({ field }) => {
              const value = (saved as Record<string, unknown>)[field];
              return Object.hasOwn(saved, field) && typeof value === 'string' && value !== '';
            })
          ) {
            throw new ForbiddenException(
              'Approving a plugin with a saved secret binding requires vault:reveal.',
            );
          }
        }
      }
      const permissions = canonicalPermissions(plugin.manifest.permissions);
      const previous = await tx.pluginApproval.findUnique({
        where: { pluginId: id },
        select: { approvedAt: true },
      });
      const data = {
        enabled: true,
        version: plugin.manifest.version,
        trust: plugin.trust,
        digest: plugin.digest,
        permissions: JSON.stringify(permissions),
        approvedAt: new Date(Math.max(Date.now(), (previous?.approvedAt.getTime() ?? 0) + 1)),
        approvedBy: actor?.name ?? 'unknown',
      };
      await tx.pluginApproval.upsert({
        where: { pluginId: id },
        create: { pluginId: id, ...data },
        update: data,
      });
      await this.audit.record(
        {
          action: 'plugin.enabled',
          outcome: 'success',
          actor,
          object: { type: 'plugin', id },
          details: {
            version: plugin.manifest.version,
            trust: plugin.trust,
            digest: plugin.digest,
            network: permissions.network.length,
            secrets: permissions.secrets.length,
            panel: permissions.panel.length,
            ssh: permissions.ssh,
          },
          meta,
        },
        tx,
      );
    });
    // A process that runs under an earlier approval of this plugin ends: it holds the permissions of that one.
    this.unverifiable.delete(id);
    this.runtime.requestStop(id);
    return this.viewById(id);
  }

  // The settings of a plugin (ADR 0029).

  private async withSchema(id: string): Promise<ConfigSchemaFile> {
    const plugin = indexById(await this.discover()).get(id);
    if (plugin === undefined) {
      throw new NotFoundException('There is no such plugin.');
    }
    if (plugin.configSchema === undefined) {
      throw new NotFoundException('This plugin has no settings.');
    }
    return plugin.configSchema;
  }

  private fieldsOf(schema: ConfigSchemaFile): PluginConfigField[] {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([name, field]) => {
      const text = field.type === 'string' ? field : undefined;
      return {
        name,
        type: field.type,
        title: field.title ?? null,
        description: field.description ?? null,
        required: required.has(name),
        default: 'default' in field ? (field.default ?? null) : null,
        minLength: text?.minLength ?? null,
        maxLength: text?.maxLength ?? null,
        minimum: 'minimum' in field ? (field.minimum ?? null) : null,
        maximum: 'maximum' in field ? (field.maximum ?? null) : null,
        choices: text?.enum ?? null,
        secretKind: text?.['x-sw-secret'] ?? null,
      };
    });
  }

  private async configView(id: string, schema: ConfigSchemaFile): Promise<PluginConfigView> {
    const row = await this.db.pluginConfig.findUnique({ where: { pluginId: id } });
    let stored: Record<string, unknown> = {};
    if (row !== null) {
      try {
        stored = JSON.parse(row.settings) as Record<string, unknown>;
      } catch {
        stored = {};
      }
    }
    const { values, problems } = validateConfig(schema, stored);
    return {
      fields: this.fieldsOf(schema),
      values,
      // Before anything is saved, what is missing is simply not filled in yet.
      problems: row === null ? [] : problems,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async getConfig(id: string): Promise<PluginConfigView> {
    return this.configView(id, await this.withSchema(id));
  }

  /** Replaces the settings after checking them against what the plugin declares, secret bindings included. */
  async updateConfig(
    actor: Actor,
    id: string,
    input: Readonly<Record<string, unknown>>,
    meta: RequestMeta,
    canBindSecret: boolean,
  ): Promise<PluginConfigView> {
    const schema = await this.withSchema(id);
    const { values, problems } = validateConfig(schema, input);
    const bindings = secretFields(schema);
    if (problems.length > 0) {
      throw new BadRequestException(
        problems
          .map((p) => `${p.field} ${p.message}`)
          .join('; ')
          .slice(0, 500),
      );
    }
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLUGINS_LOCK_KEY})`;
      const before = await tx.pluginConfig.findUnique({ where: { pluginId: id } });
      let old: Record<string, unknown> = {};
      try {
        old = before === null ? {} : (JSON.parse(before.settings) as Record<string, unknown>);
      } catch {
        old = {};
      }
      const assigned = bindings.flatMap(({ field }) => {
        const value = values[field];
        return typeof value === 'string' && value !== old[field] ? [{ field, id: value }] : [];
      });
      if (assigned.length > 0 && !canBindSecret) {
        throw new ForbiddenException('Binding a plugin secret requires vault:reveal.');
      }
      for (const { field, kind } of bindings) {
        const bound = values[field];
        if (typeof bound === 'string') {
          const secret = await tx.secret.findUnique({
            where: { id: bound },
            select: { type: true },
          });
          if (secret === null || secret.type !== secretTypeOf(kind)) {
            problems.push({ field, message: `must be a secret of the kind "${kind}" that exists` });
          }
        }
      }
      if (problems.length > 0) {
        throw new BadRequestException(
          problems
            .map(({ field, message }) => `${field} ${message}`)
            .join('; ')
            .slice(0, 500),
        );
      }
      const names = new Set([...Object.keys(old), ...Object.keys(values)]);
      const changed = [...names].filter(
        (n) => JSON.stringify(old[n]) !== JSON.stringify(values[n]),
      );
      await tx.pluginConfig.upsert({
        where: { pluginId: id },
        create: { pluginId: id, settings: canonical, updatedBy: actor?.name ?? 'unknown' },
        update: { settings: canonical, updatedBy: actor?.name ?? 'unknown' },
      });
      await this.audit.record(
        {
          action: 'plugin.config.updated',
          outcome: 'success',
          actor,
          object: { type: 'plugin', id },
          // Which settings changed, never what they are changed to.
          details: { fields: changed.sort().join(',').slice(0, 200), count: changed.length },
          meta,
        },
        tx,
      );
      for (const { field, id: secretId } of assigned) {
        await this.audit.record(
          {
            action: 'plugin.secret.bound',
            outcome: 'success',
            actor,
            object: { type: 'plugin', id },
            details: { field, secret: secretId },
            meta,
          },
          tx,
        );
      }
    });
    return this.configView(id, schema);
  }

  /** Switches a plugin off. The approval stays on record; one that is not enabled is left as it is. */
  async disable(actor: Actor, id: string, meta: RequestMeta): Promise<PluginView> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLUGINS_LOCK_KEY})`;
      const record = await tx.pluginApproval.findUnique({ where: { pluginId: id } });
      if (record === null) {
        if (indexById(await this.discover()).has(id)) {
          return;
        }
        throw new NotFoundException('There is no such plugin.');
      }
      if (!record.enabled) {
        return;
      }
      await tx.pluginApproval.update({ where: { pluginId: id }, data: { enabled: false } });
      await this.audit.record(
        {
          action: 'plugin.disabled',
          outcome: 'success',
          actor,
          object: { type: 'plugin', id },
          details: { reason: 'administrator', version: record.version },
          meta,
        },
        tx,
      );
    });
    this.unverifiable.delete(id);
    this.runtime.requestStop(id);
    return this.viewById(id);
  }
}
