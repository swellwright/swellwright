import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SECRET_TYPES, type SecretType } from '@swellwright/contracts';
import { type Database } from '@swellwright/db';
import {
  type ConfigSchemaFile,
  type ConfigValues,
  PLUGIN_LIMITS,
  secretFields,
  validateConfig,
} from '@swellwright/plugin-api';

import { AuditService } from '../audit/audit.service.js';
import { requireDatabase } from '../auth/context.js';
import { CodedHttpException } from '../http.js';
import { DATABASE } from '../tokens.js';
import { VaultService } from '../vault/vault.service.js';

/** Why the core would not do what a plugin asked, in words the plugin author can act on. */
export class PluginBrokerError extends Error {
  constructor(
    message: string,
    /** The stable code of the API error behind it, when there is one (`secret_expired`). */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PluginBrokerError';
  }
}

/** What the broker needs to know about a plugin: who it is, what it declared, what was approved. */
export interface BrokerContext {
  readonly id: string;
  readonly schema: ConfigSchemaFile | undefined;
  /** The kinds of secret the administrator approved, from the stored approval. */
  readonly secretKinds: readonly string[];
}

/** A secret kind of a manifest (`dns-oauth`) is the vault's type (`dns_oauth`). */
export function secretTypeOf(kind: string): SecretType | undefined {
  const type = kind.replaceAll('-', '_');
  return (SECRET_TYPES as readonly string[]).includes(type) ? (type as SecretType) : undefined;
}

/** A secret used by a plugin is recorded once per window per secret, however often it is asked for. */
const USE_NOTE_WINDOW_MS = 10 * 60_000;

/**
 * What the core hands to a plugin besides the network (ADR 0029): its settings, the secrets bound to them, and
 * its own storage. The plugin runs without a way to reach any of these itself; it asks, and the core answers
 * if the administrator approved it. Used by the plugin host and by the interpreter of declarative drivers.
 */
@Injectable()
export class PluginBroker {
  private readonly used = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** The stored settings with the schema's defaults, secret fields as the ids that are bound. */
  async stored(context: BrokerContext): Promise<{
    values: ConfigValues;
    problems: { field: string; message: string }[];
    configured: boolean;
  }> {
    if (context.schema === undefined) {
      return { values: {}, problems: [], configured: false };
    }
    const row = await this.db.pluginConfig.findUnique({ where: { pluginId: context.id } });
    let input: Record<string, unknown> = {};
    if (row !== null) {
      try {
        input = JSON.parse(row.settings) as Record<string, unknown>;
      } catch {
        input = {};
      }
    }
    const { values, problems } = validateConfig(context.schema, input);
    return { values, problems, configured: row !== null };
  }

  /**
   * The settings a plugin may see: everything but the secret fields. A plugin whose required settings are not
   * filled in does not run (the administrator is told which).
   */
  async settings(context: BrokerContext): Promise<ConfigValues> {
    const { values, problems } = await this.stored(context);
    if (problems.length > 0) {
      const list = problems.map((p) => `${p.field} ${p.message}`).join('; ');
      throw new PluginBrokerError(`The plugin is not configured: ${list}.`);
    }
    const hidden = new Set(
      context.schema === undefined ? [] : secretFields(context.schema).map((f) => f.field),
    );
    return Object.fromEntries(Object.entries(values).filter(([name]) => !hidden.has(name)));
  }

  /** The value of the secret bound to a settings field, if the plugin may have it and the vault is open. */
  async secret(context: BrokerContext, field: string, auditDelivery = false): Promise<string> {
    const declared =
      context.schema === undefined
        ? undefined
        : secretFields(context.schema).find((f) => f.field === field);
    if (declared === undefined) {
      throw new PluginBrokerError(`"${field}" is not a setting that holds a secret.`);
    }
    if (!context.secretKinds.includes(declared.kind)) {
      throw new PluginBrokerError(
        `This plugin was not approved for secrets of the kind "${declared.kind}".`,
      );
    }
    const type = secretTypeOf(declared.kind);
    if (type === undefined) {
      throw new PluginBrokerError(`"${declared.kind}" is not a kind of secret this version has.`);
    }
    const { values } = await this.stored(context);
    const bound = values[field];
    if (typeof bound !== 'string') {
      throw new PluginBrokerError(`No secret is chosen for the setting "${field}".`);
    }
    let value: string;
    try {
      value = await this.vault.readForPlugin(bound, type, { kind: 'plugin', id: context.id });
    } catch (error) {
      if (!(
        error instanceof CodedHttpException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      )) {
        throw error;
      }
      const code = error instanceof CodedHttpException ? error.apiCode : undefined;
      const text = error.message;
      // A plugin sees only the text: an expired secret starts it with the stable code, so that it can tell (ADR 0042).
      throw new PluginBrokerError(
        code === 'secret_expired' ? `secret_expired: ${text}` : text,
        code,
      );
    }
    if (auditDelivery) {
      await this.audit.record({
        action: 'plugin.secret.used',
        outcome: 'success',
        actor: null,
        object: { type: 'plugin', id: context.id },
        details: { field, secret: bound },
        meta: { ip: undefined, requestId: undefined },
      });
    } else {
      this.noteUse(context.id, field, bound);
    }
    return value;
  }

  private noteUse(pluginId: string, field: string, secretId: string): void {
    const key = `${pluginId}:${secretId}`;
    const now = Date.now();
    const last = this.used.get(key);
    if (last !== undefined && now - last < USE_NOTE_WINDOW_MS) {
      return;
    }
    this.used.set(key, now);
    void this.audit.note({
      action: 'plugin.secret.used',
      outcome: 'success',
      actor: null,
      object: { type: 'plugin', id: pluginId },
      details: { field, secret: secretId },
      meta: { ip: undefined, requestId: undefined },
    });
  }

  // The plugin's own storage.

  private checkKey(key: unknown): string {
    if (typeof key !== 'string' || key.length === 0 || key.length > PLUGIN_LIMITS.storageKeyChars) {
      throw new PluginBrokerError(
        `A storage key is text of 1 to ${String(PLUGIN_LIMITS.storageKeyChars)} characters.`,
      );
    }
    return key;
  }

  async storageGet(pluginId: string, key: unknown): Promise<unknown> {
    const row = await this.db.pluginStorageItem.findUnique({
      where: { pluginId_key: { pluginId, key: this.checkKey(key) } },
    });
    return row === null ? null : (JSON.parse(row.value) as unknown);
  }

  async storageSet(pluginId: string, key: unknown, value: unknown): Promise<void> {
    const name = this.checkKey(key);
    const text = JSON.stringify(value === undefined ? null : value);
    if (Buffer.byteLength(text) > PLUGIN_LIMITS.storageValueBytes) {
      throw new PluginBrokerError(
        `A stored value is at most ${String(PLUGIN_LIMITS.storageValueBytes / 1024)} KiB.`,
      );
    }
    await this.db.$transaction(async (tx) => {
      // One writer per plugin at a time, so the limits below cannot be beaten by two requests at once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plugin-storage:${pluginId}`}))`;
      const rows = await tx.pluginStorageItem.findMany({
        where: { pluginId },
        select: { key: true, value: true },
      });
      const others = rows.filter((r) => r.key !== name);
      const bytes = others.reduce((sum, r) => sum + Buffer.byteLength(r.value), 0);
      if (others.length >= PLUGIN_LIMITS.storageKeys && rows.length === others.length) {
        throw new PluginBrokerError(
          `The storage holds at most ${String(PLUGIN_LIMITS.storageKeys)} keys.`,
        );
      }
      if (bytes + Buffer.byteLength(text) > PLUGIN_LIMITS.storageBytes) {
        throw new PluginBrokerError(
          `The storage holds at most ${String(PLUGIN_LIMITS.storageBytes / 1024 / 1024)} MiB.`,
        );
      }
      await tx.pluginStorageItem.upsert({
        where: { pluginId_key: { pluginId, key: name } },
        create: { pluginId, key: name, value: text },
        update: { value: text },
      });
    });
  }

  async storageDelete(pluginId: string, key: unknown): Promise<void> {
    await this.db.pluginStorageItem.deleteMany({
      where: { pluginId, key: this.checkKey(key) },
    });
  }

  async storageKeys(pluginId: string): Promise<string[]> {
    const rows = await this.db.pluginStorageItem.findMany({
      where: { pluginId },
      select: { key: true },
      orderBy: { key: 'asc' },
    });
    return rows.map((r) => r.key);
  }
}
