import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type ChangeVaultPassphraseRequest,
  type ConfirmPassphraseRequest,
  type CreateSecretRequest,
  type RevealedSecret,
  type SecretList,
  type SecretType,
  type SecretView,
  type UnsealVaultRequest,
  type UpdateSecretRequest,
  type VaultInitialized,
  type VaultRotated,
  type VaultStatus,
  RUN_SECRET_TYPES,
} from '@swellwright/contracts';
import { type Database, Prisma, type Secret, type VaultMeta } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { WindowLimiter } from '../auth/rate-limit.js';
import { RateLimitedException, SecretExpiredException, VaultSealedException } from '../http.js';
import { CLOCK, DATABASE, VAULT_KDF } from '../tokens.js';
import { expiryView, isExpired } from './expiry.js';
import { deriveKey, KDF_SALT_BYTES, type KdfParams } from './kdf.js';
import {
  decryptSecret,
  encryptSecret,
  formatRecoveryKey,
  newKek,
  newRecoveryKey,
  parseRecoveryKey,
  rewrapDek,
  unwrapKekWithPassphraseKey,
  unwrapKekWithRecoveryKey,
  wrapKekUnderPassphraseKey,
  wrapKekUnderRecoveryKey,
} from './keys.js';
import { Serial } from './serial.js';

/** An arbitrary constant: one transaction at a time may set the vault up. */
const VAULT_LOCK_KEY = 7_761_237;
/**
 * An arbitrary constant: making a run that is handed secrets, replacing a value and deleting a secret take turns, so a
 * value cannot be replaced between the moment a run is queued with it and the moment it is looked at again (ADR 0042).
 */
export const SECRET_USE_LOCK_KEY = 7_761_242;
/** Rotations run one at a time with the database too, in case a second process ever shares the vault. */
const ROTATION_TX = { timeout: 60_000, maxWait: 10_000 } as const;
/** Ten failed tries in fifteen minutes block every further try (a success does not count). */
const UNSEAL_ATTEMPTS = 10;
const UNSEAL_WINDOW_MS = 15 * 60_000;

/** A refused use of an expired secret is recorded once per secret in this window, however often it is tried. */
const REFUSAL_NOTE_WINDOW_MS = 10 * 60_000;

/** Who did it. The vault has no server command: every caller is a signed-in user. */
export interface Actor {
  readonly id: string;
  readonly name: string;
}

/**
 * Whatever takes a secret's value to use it (ADR 0042): a server login, a plugin, a command run. The kind and the id
 * are what the audit record of a refusal says; a value is never given without one.
 */
export interface SecretConsumer {
  readonly kind: 'server_access' | 'plugin' | 'panel' | 'command_run';
  readonly id: string;
}

export interface UseOptions {
  /**
   * A use that began before the expiry may go on: following a script that is already running on a server must not stop
   * because the credential of the connection expired meanwhile. Only the runner, for a target whose step has started.
   */
  readonly allowExpired?: boolean;
}

/** What a consumer needs to take a value: which secret, of which kinds, and the words of the two ordinary failures. */
interface UseRequest {
  readonly id: string;
  readonly types: readonly SecretType[];
  readonly consumer: SecretConsumer;
  readonly options: UseOptions | undefined;
  /** The version of the value the caller means, when it knows one: another version is refused before it is decrypted. */
  readonly version?: number;
  readonly missing: string;
  readonly wrongKind: (row: Secret) => string;
}

/** What a run was handed: the name the script knows it by, the secret, and the value for as long as the caller needs it. */
export interface RunSecretValue {
  readonly name: string;
  readonly secretId: string;
  readonly secretName: string;
  readonly version: number;
  readonly value: string;
}

/** What `readForRun` is asked for: the secret, and the version of it that the run was queued with, if it is known. */
export interface RunSecretRequest {
  readonly name: string;
  readonly secretId: string;
  readonly version?: number;
}

/** The value of a secret that was taken for a consumer, with the row it came from. */
export interface TakenSecret {
  readonly value: string;
  readonly row: Secret;
}

export function toSecretView(row: Secret, nowMs: number): SecretView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    version: row.version,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    ...expiryView(row.expiresAt, nowMs),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    valueChangedAt: row.valueChangedAt.toISOString(),
  };
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * The secrets vault (ADR 0018). The key-encryption key lives only in this process's memory, and only while the
 * vault is open; the database holds it wrapped twice and every value encrypted under a data key of its own.
 */
@Injectable()
export class VaultService implements OnApplicationShutdown {
  private readonly logger = new Logger('Vault');
  private readonly attempts = new WindowLimiter(UNSEAL_ATTEMPTS, UNSEAL_WINDOW_MS);
  private kek: Buffer | null = null;
  private readonly serial = new Serial();
  /** When a refused use of each secret was last recorded. */
  private readonly refusals = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(VAULT_KDF) private readonly kdf: KdfParams,
    @Inject(CLOCK) private readonly now: () => number,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  onApplicationShutdown(): void {
    this.wipe();
  }

  private wipe(): void {
    this.kek?.fill(0);
    this.kek = null;
  }

  /** Throws the sealed answer (423) when the key is not in memory; for a caller that must not start before it is. */
  requireOpen(): void {
    this.openKey();
  }

  /** The key, or the answer a caller gets when there is none: no vault yet (409) or a sealed one (423). */
  private openKey(): Buffer {
    if (!this.kek) {
      throw new VaultSealedException();
    }
    return this.kek;
  }

  async status(): Promise<VaultStatus> {
    const [meta, secretCount] = await Promise.all([
      this.db.vaultMeta.findUnique({ where: { id: 1 } }),
      this.db.secret.count(),
    ]);
    return {
      state: !meta ? 'uninitialized' : this.kek ? 'unsealed' : 'sealed',
      secretCount,
      kekVersion: meta?.kekVersion ?? null,
      createdAt: meta?.createdAt.toISOString() ?? null,
      passphraseChangedAt: meta?.passphraseChangedAt?.toISOString() ?? null,
      recoveryKeyRotatedAt: meta?.recoveryKeyRotatedAt?.toISOString() ?? null,
      kekRotatedAt: meta?.kekRotatedAt?.toISOString() ?? null,
      dataKeysRotatedAt: meta?.dataKeysRotatedAt?.toISOString() ?? null,
    };
  }

  /** Sets the vault up once and leaves it open. The recovery key is returned here and never stored. */
  initialize(actor: Actor, passphrase: string, meta: RequestMeta): Promise<VaultInitialized> {
    return this.serial.run(() => this.initializeNow(actor, passphrase, meta));
  }

  private async initializeNow(
    actor: Actor,
    passphrase: string,
    meta: RequestMeta,
  ): Promise<VaultInitialized> {
    const kek = newKek();
    const recoveryKey = newRecoveryKey();
    const salt = randomBytes(KDF_SALT_BYTES);
    const passphraseKey = await deriveKey(passphrase, salt, this.kdf);
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_LOCK_KEY})`;
        if ((await tx.vaultMeta.count()) > 0) {
          throw new ConflictException('The vault is already set up.');
        }
        await tx.vaultMeta.create({
          data: {
            id: 1,
            kdfSalt: new Uint8Array(salt),
            kdfMemoryKib: this.kdf.memoryKib,
            kdfPasses: this.kdf.passes,
            kdfParallelism: this.kdf.parallelism,
            passphraseWrappedKek: new Uint8Array(wrapKekUnderPassphraseKey(kek, passphraseKey)),
            recoveryWrappedKek: new Uint8Array(wrapKekUnderRecoveryKey(kek, recoveryKey)),
            createdById: actor.id,
          },
        });
        await this.audit.record(
          {
            action: 'vault.initialized',
            outcome: 'success',
            actor,
            details: { kek_version: 1 },
            meta,
          },
          tx,
        );
      });
    } catch (error) {
      kek.fill(0);
      throw error;
    } finally {
      passphraseKey.fill(0);
    }
    this.wipe();
    this.kek = kek;
    const formatted = formatRecoveryKey(recoveryKey);
    recoveryKey.fill(0);
    return { status: await this.status(), recoveryKey: formatted };
  }

  /** Opens the vault with the passphrase or the recovery key. Failures are recorded and rate-limited. */
  unseal(actor: Actor, request: UnsealVaultRequest, meta: RequestMeta): Promise<VaultStatus> {
    return this.serial.run(() => this.unsealNow(actor, request, meta));
  }

  private async unsealNow(
    actor: Actor,
    request: UnsealVaultRequest,
    meta: RequestMeta,
  ): Promise<VaultStatus> {
    if (this.attempts.blocked('vault')) {
      throw new RateLimitedException(Math.ceil(UNSEAL_WINDOW_MS / 1000));
    }
    const stored = await this.db.vaultMeta.findUnique({ where: { id: 1 } });
    if (!stored) {
      throw new ConflictException('There is no vault yet.');
    }
    const method = request.passphrase === undefined ? 'recovery_key' : 'passphrase';
    let kek: Buffer | null;
    if (request.passphrase !== undefined) {
      const key = await deriveKey(request.passphrase, Buffer.from(stored.kdfSalt), {
        memoryKib: stored.kdfMemoryKib,
        passes: stored.kdfPasses,
        parallelism: stored.kdfParallelism,
      });
      kek = unwrapKekWithPassphraseKey(stored.passphraseWrappedKek, key);
      key.fill(0);
    } else {
      const key = parseRecoveryKey(request.recoveryKey ?? '');
      kek = key ? unwrapKekWithRecoveryKey(stored.recoveryWrappedKek, key) : null;
      key?.fill(0);
    }
    if (!kek) {
      this.attempts.hit('vault');
      await this.audit.note({
        action: 'vault.unseal.failed',
        outcome: 'failure',
        actor,
        details: { method },
        meta,
      });
      throw new UnauthorizedException('Invalid passphrase or recovery key.');
    }
    try {
      await this.audit.record({
        action: 'vault.unsealed',
        outcome: 'success',
        actor,
        details: { method },
        meta,
      });
    } catch (error) {
      kek.fill(0);
      throw error;
    }
    this.wipe();
    this.kek = kek;
    return this.status();
  }

  seal(actor: Actor, meta: RequestMeta): Promise<VaultStatus> {
    return this.serial.run(() => this.sealNow(actor, meta));
  }

  private async sealNow(actor: Actor, meta: RequestMeta): Promise<VaultStatus> {
    if (!(await this.db.vaultMeta.findUnique({ where: { id: 1 } }))) {
      throw new ConflictException('There is no vault yet.');
    }
    this.wipe();
    await this.audit.record({ action: 'vault.sealed', outcome: 'success', actor, meta });
    return this.status();
  }

  async list(): Promise<SecretList> {
    const rows = await this.db.secret.findMany({ orderBy: { name: 'asc' } });
    const now = this.now();
    return { secrets: rows.map((row) => toSecretView(row, now)) };
  }

  /** Needs the vault open. The value is encrypted before it reaches the database and is not returned again. */
  create(actor: Actor, request: CreateSecretRequest, meta: RequestMeta): Promise<SecretView> {
    return this.serial.run(() => this.createNow(actor, request, meta));
  }

  /**
   * Creates a secret and lets the caller do more in the same transaction: the connection to a panel that was just
   * tried with this token is saved together with it, so there is never a token without its connection or the other
   * way round (ADR 0041). If `inside` throws, the secret is not created.
   */
  createWithin(
    actor: Actor,
    request: CreateSecretRequest,
    meta: RequestMeta,
    inside: (tx: Prisma.TransactionClient, secret: SecretView) => Promise<void>,
  ): Promise<SecretView> {
    return this.serial.run(() => this.createNow(actor, request, meta, inside));
  }

  private async createNow(
    actor: Actor,
    request: CreateSecretRequest,
    meta: RequestMeta,
    inside?: (tx: Prisma.TransactionClient, secret: SecretView) => Promise<void>,
  ): Promise<SecretView> {
    const kek = this.openKey();
    const id = randomUUID();
    const blobs = encryptSecret(kek, { id, version: 1, type: request.type }, request.value);
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.secret.create({
          data: {
            id,
            name: request.name,
            type: request.type,
            ciphertext: new Uint8Array(blobs.ciphertext),
            wrappedDek: new Uint8Array(blobs.wrappedDek),
            createdById: actor.id,
            ...(request.description === undefined ? {} : { description: request.description }),
            ...(request.expiresAt === undefined ? {} : { expiresAt: new Date(request.expiresAt) }),
          },
        });
        await this.audit.record(
          {
            action: 'secret.created',
            outcome: 'success',
            actor,
            object: { type: 'secret', id },
            details: { secret_type: request.type, version: 1 },
            meta,
          },
          tx,
        );
        if (inside) {
          await inside(tx, toSecretView(created, this.now()));
        }
        return created;
      });
      return toSecretView(row, this.now());
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A secret with that name exists already.');
      }
      throw error;
    }
  }

  /** Renames, changes the details or replaces the value (a new version under a new data key). */
  update(
    actor: Actor,
    id: string,
    body: UpdateSecretRequest,
    meta: RequestMeta,
  ): Promise<SecretView> {
    return this.serial.run(() => this.updateNow(actor, id, body, meta));
  }

  private async updateNow(
    actor: Actor,
    id: string,
    body: UpdateSecretRequest,
    meta: RequestMeta,
  ): Promise<SecretView> {
    const kek = body.value === undefined ? null : this.openKey();
    try {
      const row = await this.db.$transaction(async (tx) => {
        if (body.value !== undefined) {
          await this.refuseWhileHandedToRun(tx, id, 'replaced');
        }
        const current = await tx.secret.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException('There is no such secret.');
        }
        const data: Prisma.SecretUpdateInput = {};
        const changed: string[] = [];
        if (body.name !== undefined && body.name !== current.name) {
          data.name = body.name;
          changed.push('name');
        }
        if (body.description !== undefined && body.description !== current.description) {
          data.description = body.description;
          changed.push('description');
        }
        if (body.expiresAt !== undefined) {
          const expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);
          if (expiresAt?.getTime() !== current.expiresAt?.getTime()) {
            data.expiresAt = expiresAt;
            changed.push('expires_at');
          }
        }
        let version = current.version;
        if (body.value !== undefined && kek) {
          version = current.version + 1;
          const blobs = encryptSecret(kek, { id, version, type: current.type }, body.value);
          data.version = version;
          data.ciphertext = new Uint8Array(blobs.ciphertext);
          data.wrappedDek = new Uint8Array(blobs.wrappedDek);
          data.valueChangedAt = new Date();
          changed.push('value');
        }
        if (changed.length === 0) {
          return current;
        }
        // The version is part of what the blobs are bound to: a second writer must not slip in between.
        const written = await tx.secret.updateMany({
          where: { id, version: current.version },
          data,
        });
        if (written.count !== 1) {
          throw new ConflictException('The secret was changed meanwhile. Try again.');
        }
        await this.audit.record(
          {
            action: 'secret.updated',
            outcome: 'success',
            actor,
            object: { type: 'secret', id },
            details: { changed: changed.join(','), version },
            meta,
          },
          tx,
        );
        return tx.secret.findUniqueOrThrow({ where: { id } });
      });
      return toSecretView(row, this.now());
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A secret with that name exists already.');
      }
      throw error;
    }
  }

  /**
   * A secret that a server's access entry names (as the login or as the sudo password) cannot be deleted: the
   * database refuses it too (a restricting foreign key), this check says which servers use it (ADR 0034).
   */
  private async refuseWhileInUse(
    tx: Pick<Prisma.TransactionClient, 'serverAccess' | 'panelConnection'>,
    id: string,
  ): Promise<void> {
    const panels = await tx.panelConnection.findMany({
      where: { tokenSecretId: id },
      select: { baseUrl: true },
    });
    const panel = panels[0];
    if (panel) {
      throw new ConflictException(
        `This secret is the token of the connection to the panel at ${panel.baseUrl}. Disconnect the panel first.`,
      );
    }
    const using = await tx.serverAccess.findMany({
      where: { OR: [{ secretId: id }, { sudoSecretId: id }] },
      select: { server: { select: { name: true } } },
    });
    if (using.length === 0) {
      return;
    }
    const names = [...new Set(using.map((entry) => entry.server.name))].sort();
    const shown = names.slice(0, 5).join(', ');
    const more = names.length > 5 ? ` and ${String(names.length - 5)} more` : '';
    throw new ConflictException(
      `This secret is used by ${String(names.length)} server${names.length === 1 ? '' : 's'} (${shown}${more}). Remove it from their access entries first.`,
    );
  }

  /**
   * A secret that a command run which is not over was handed is neither replaced nor deleted: the runner takes the
   * value out of the output by looking for the value it delivered, so that value must stay what it was until the run
   * has ended (ADR 0042). The finished history lets go of the secret; a run keeps its name.
   */
  private async refuseWhileHandedToRun(
    tx: Pick<Prisma.TransactionClient, 'commandRunSecret' | '$executeRaw'>,
    id: string,
    what: 'replaced' | 'deleted',
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SECRET_USE_LOCK_KEY})`;
    const active = await tx.commandRunSecret.findMany({
      where: { secretId: id, run: { state: { in: ['pending', 'running'] } } },
      select: { runId: true },
      take: 3,
    });
    if (active.length > 0) {
      throw new ConflictException(
        `This secret was handed to a command run that is still going, so it cannot be ${what} until the run has ended.`,
      );
    }
  }

  /** Works while the vault is sealed: nothing is decrypted. */
  async remove(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const current = await tx.secret.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException('There is no such secret.');
        }
        await this.refuseWhileInUse(tx, id);
        await this.refuseWhileHandedToRun(tx, id, 'deleted');
        await tx.secret.delete({ where: { id } });
        await this.audit.record(
          {
            action: 'secret.deleted',
            outcome: 'success',
            actor,
            object: { type: 'secret', id },
            details: { secret_type: current.type, version: current.version },
            meta,
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        // A server or a panel connection started to use it between the check and the delete; the foreign key is the
        // last word.
        throw new ConflictException(
          'This secret is in use by a server or by the connection to the panel. Remove it from there first.',
        );
      }
      throw error;
    }
  }

  /**
   * The one door through which the value of a secret goes to something that uses it (ADR 0042). The order is fixed: a
   * sealed vault answers 423 first, then the secret must exist and be of a kind this consumer may have, then its expiry
   * must not have passed (409 `secret_expired`, recorded once per ten minutes), and only then is the value decrypted.
   * Not a reveal: no person asked, so there is no `secret.revealed`; the operation that uses the value records its own
   * use. The consumers below say which kinds they take and in which words they fail; none of them decides "expired".
   */
  private takeValue(request: UseRequest): Promise<TakenSecret> {
    return this.serial.run(async () => {
      const { kek, row } = await this.admit(request);
      try {
        const value = decryptSecret(kek, { id: row.id, version: row.version, type: row.type }, row);
        return { value, row };
      } catch {
        this.logger.error(
          `secret ${row.id} did not decrypt: the stored blobs do not match their context`,
        );
        throw new InternalServerErrorException('The secret could not be decrypted.');
      }
    });
  }

  /**
   * Everything `takeValue` decides before a value is decrypted, in the order it decides it: the vault must be open, the
   * secret must exist, be of a kind the consumer may have and not have expired. Must run inside `serial`.
   */
  private async admit(request: UseRequest): Promise<{ kek: Buffer; row: Secret }> {
    const kek = this.openKey();
    const row = await this.db.secret.findUnique({ where: { id: request.id } });
    if (!row) {
      throw new NotFoundException(request.missing);
    }
    if (!request.types.includes(row.type)) {
      throw new ConflictException(request.wrongKind(row));
    }
    if (request.version !== undefined && row.version !== request.version) {
      throw new ConflictException(
        `The secret "${row.name}" was replaced after the run was queued, so it is not the value that was meant.`,
      );
    }
    if (
      request.options?.allowExpired !== true &&
      row.expiresAt !== null &&
      isExpired(row.expiresAt, this.now())
    ) {
      await this.noteRefusal(row, request.consumer);
      throw new SecretExpiredException({ id: row.id, name: row.name, expiresAt: row.expiresAt });
    }
    return { kek, row };
  }

  /** Records that an expired secret was asked for, at most once per secret per ten minutes. No value, ever. */
  private async noteRefusal(row: Secret, consumer: SecretConsumer): Promise<void> {
    const now = this.now();
    const last = this.refusals.get(row.id);
    if (last !== undefined && now - last < REFUSAL_NOTE_WINDOW_MS) {
      return;
    }
    if (this.refusals.size > 1000) {
      for (const [id, at] of this.refusals) {
        if (now - at >= REFUSAL_NOTE_WINDOW_MS) {
          this.refusals.delete(id);
        }
      }
    }
    this.refusals.set(row.id, now);
    await this.audit.note({
      action: 'secret.use_refused',
      outcome: 'denied',
      actor: null,
      object: { type: 'secret', id: row.id },
      details: {
        reason: 'expired',
        secret_type: row.type,
        consumer: consumer.kind,
        consumer_id: consumer.id,
      },
      meta: { ip: undefined, requestId: undefined },
    });
  }

  /**
   * The value of a secret for a plugin that was bound to it (ADR 0029). The type must be the one the plugin declared,
   * so a plugin cannot be pointed at a secret of another kind. The broker records the plugin's use.
   */
  async readForPlugin(
    id: string,
    type: SecretType,
    consumer: SecretConsumer,
    options?: UseOptions,
  ): Promise<string> {
    const taken = await this.takeValue({
      id,
      types: [type],
      consumer,
      options,
      missing: 'The secret chosen for this setting no longer exists.',
      wrongKind: () => 'The secret chosen for this setting is not of the right kind.',
    });
    return taken.value;
  }

  /**
   * The value of a secret for a connection to a server (ADR 0037). The type must be the one the access method needs, so
   * an entry cannot be pointed at a secret of another kind. The operation that connects records its own use
   * (`server.access.verified`, `server.facts.refreshed`). The caller keeps the value in memory for the length of the call
   * and nowhere else.
   */
  async readForServer(
    id: string,
    type: 'ssh_password' | 'ssh_key',
    consumer: SecretConsumer,
    options?: UseOptions,
  ): Promise<string> {
    const taken = await this.takeValue({
      id,
      types: [type],
      consumer,
      options,
      missing: 'The secret that this access entry names no longer exists.',
      wrongKind: (row) =>
        `The secret "${row.name}" is not of the kind "${type}" that this access entry needs.`,
    });
    return taken.value;
  }

  /**
   * The API token of a panel for the connection to it (ADR 0041). Not a reveal: no person asked, and the connection
   * records its own checks (`panel.connected`, `panel.tested`). The secret must be of kind `panel_token`; an expired one
   * is refused like any other (ADR 0042). `connection` is the id of the panel connection, for the record of a refusal.
   */
  async readForPanel(id: string, connection?: string, options?: UseOptions): Promise<string> {
    const taken = await this.takeValue({
      id,
      types: ['panel_token'],
      consumer: { kind: 'panel', id: connection ?? id },
      options,
      missing: 'The secret that holds the token of the panel no longer exists.',
      wrongKind: (row) =>
        `The secret "${row.name}" is not of the kind "panel_token" that a panel connection needs.`,
    });
    return taken.value;
  }

  /**
   * The values of the secrets a command run was handed (ADR 0042), for delivery to a server and for taking them out of
   * its output. Only the kinds in `RUN_SECRET_TYPES`. The expiry rule applies like everywhere else; a run that has
   * started is followed to its end with `allowExpired`. When the version the run was queued with is known, a value that
   * was replaced since is refused (409): what would be delivered, and what the output is scrubbed of, must be what was
   * meant. The caller keeps the values for the length of one operation and nowhere else.
   */
  async readForRun(
    entries: readonly RunSecretRequest[],
    consumer: SecretConsumer,
    options?: UseOptions,
  ): Promise<RunSecretValue[]> {
    const values: RunSecretValue[] = [];
    for (const entry of entries) {
      const taken = await this.takeValue({
        id: entry.secretId,
        types: RUN_SECRET_TYPES,
        consumer,
        options,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        missing: `The secret handed to ${entry.name} no longer exists.`,
        wrongKind: (row) =>
          `The secret "${row.name}" is a ${row.type.replaceAll('_', ' ')}, which cannot be handed to a run.`,
      });
      values.push({
        name: entry.name,
        secretId: taken.row.id,
        secretName: taken.row.name,
        version: taken.row.version,
        value: taken.value,
      });
    }
    return values;
  }

  /**
   * What a run that is being made may be handed (ADR 0042): the same decisions as `readForRun` (a sealed vault is 423, a
   * missing secret, one of a kind a run cannot have or one that expired is refused) without decrypting anything, and the
   * version of each secret, so that the run can say which value it meant.
   */
  inspectForRun(
    entries: readonly { readonly name: string; readonly secretId: string }[],
    consumer: SecretConsumer,
  ): Promise<
    { name: string; secretId: string; secretName: string; type: SecretType; version: number }[]
  > {
    return this.serial.run(async () => {
      const found: {
        name: string;
        secretId: string;
        secretName: string;
        type: SecretType;
        version: number;
      }[] = [];
      for (const entry of entries) {
        const { row } = await this.admit({
          id: entry.secretId,
          types: RUN_SECRET_TYPES,
          consumer,
          options: undefined,
          missing: `The secret chosen for ${entry.name} does not exist.`,
          wrongKind: (secret) =>
            `The secret "${secret.name}" is a ${secret.type.replaceAll('_', ' ')}, which cannot be handed to a run.`,
        });
        found.push({
          name: entry.name,
          secretId: row.id,
          secretName: row.name,
          type: row.type,
          version: row.version,
        });
      }
      return found;
    });
  }

  /**
   * Inside the transaction that makes a run: looks at the secrets once more, under the lock that replacing and deleting
   * a secret take too, so that what the run is queued with is still what is there when it is committed.
   */
  async recheckForRun(
    tx: Pick<Prisma.TransactionClient, 'secret' | '$executeRaw'>,
    entries: readonly { readonly secretId: string; readonly version: number }[],
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SECRET_USE_LOCK_KEY})`;
    const rows = await tx.secret.findMany({
      where: { id: { in: entries.map((entry) => entry.secretId) } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const entry of entries) {
      const row = byId.get(entry.secretId);
      if (!row) {
        throw new ConflictException(
          'A secret chosen for the run was deleted meanwhile. Try again.',
        );
      }
      if (row.version !== entry.version) {
        throw new ConflictException(
          `The secret "${row.name}" was replaced while the run was being made. Try again.`,
        );
      }
      if (row.expiresAt !== null && isExpired(row.expiresAt, this.now())) {
        throw new SecretExpiredException({ id: row.id, name: row.name, expiresAt: row.expiresAt });
      }
    }
  }

  /** The only way a value leaves. Recorded first: no record, no value. */
  reveal(actor: Actor, id: string, meta: RequestMeta): Promise<RevealedSecret> {
    return this.serial.run(() => this.revealNow(actor, id, meta));
  }

  private async revealNow(actor: Actor, id: string, meta: RequestMeta): Promise<RevealedSecret> {
    const kek = this.openKey();
    const row = await this.db.secret.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('There is no such secret.');
    }
    let value: string;
    try {
      value = decryptSecret(kek, { id, version: row.version, type: row.type }, row);
    } catch {
      // The key is right (the vault opened), so a blob that does not open was altered or moved.
      this.logger.error(
        `secret ${id} did not decrypt: the stored blobs do not match their context`,
      );
      throw new InternalServerErrorException('The secret could not be decrypted.');
    }
    await this.audit.record({
      action: 'secret.revealed',
      outcome: 'success',
      actor,
      object: { type: 'secret', id },
      details: { secret_type: row.type, version: row.version },
      meta,
    });
    return {
      id,
      name: row.name,
      type: row.type,
      version: row.version,
      expired: isExpired(row.expiresAt, this.now()),
      value,
    };
  }

  private async storedMeta(): Promise<VaultMeta> {
    const stored = await this.db.vaultMeta.findUnique({ where: { id: 1 } });
    if (!stored) {
      throw new ConflictException('There is no vault yet.');
    }
    return stored;
  }

  /**
   * The key-encryption key behind the stored passphrase wrap, when the passphrase is right. A wrong one is
   * recorded and counts towards the unseal limit: a stolen session must not be able to guess it here.
   */
  private async confirmPassphrase(
    actor: Actor,
    passphrase: string,
    stored: VaultMeta,
    meta: RequestMeta,
    purpose: string,
  ): Promise<Buffer> {
    if (this.attempts.blocked('vault')) {
      throw new RateLimitedException(Math.ceil(UNSEAL_WINDOW_MS / 1000));
    }
    const key = await deriveKey(passphrase, Buffer.from(stored.kdfSalt), {
      memoryKib: stored.kdfMemoryKib,
      passes: stored.kdfPasses,
      parallelism: stored.kdfParallelism,
    });
    const kek = unwrapKekWithPassphraseKey(stored.passphraseWrappedKek, key);
    key.fill(0);
    if (!kek) {
      this.attempts.hit('vault');
      await this.audit.note({
        action: 'vault.unseal.failed',
        outcome: 'failure',
        actor,
        details: { method: 'passphrase', purpose },
        meta,
      });
      throw new UnauthorizedException('Invalid passphrase.');
    }
    return kek;
  }

  /** Re-wraps the key under a new passphrase. Nothing is encrypted again; works while the vault is sealed. */
  changePassphrase(
    actor: Actor,
    request: ChangeVaultPassphraseRequest,
    meta: RequestMeta,
  ): Promise<VaultStatus> {
    return this.serial.run(() => this.changePassphraseNow(actor, request, meta));
  }

  private async changePassphraseNow(
    actor: Actor,
    request: ChangeVaultPassphraseRequest,
    meta: RequestMeta,
  ): Promise<VaultStatus> {
    const stored = await this.storedMeta();
    if (request.currentPassphrase === request.newPassphrase) {
      throw new BadRequestException('The new passphrase is the same as the current one.');
    }
    const kek = await this.confirmPassphrase(
      actor,
      request.currentPassphrase,
      stored,
      meta,
      'change_passphrase',
    );
    const salt = randomBytes(KDF_SALT_BYTES);
    const key = await deriveKey(request.newPassphrase, salt, this.kdf);
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_LOCK_KEY})`;
        const written = await tx.vaultMeta.updateMany({
          where: { id: 1, kekVersion: stored.kekVersion },
          data: {
            kdfSalt: new Uint8Array(salt),
            kdfMemoryKib: this.kdf.memoryKib,
            kdfPasses: this.kdf.passes,
            kdfParallelism: this.kdf.parallelism,
            passphraseWrappedKek: new Uint8Array(wrapKekUnderPassphraseKey(kek, key)),
            passphraseChangedAt: new Date(),
          },
        });
        if (written.count !== 1) {
          throw new ConflictException('The vault was changed meanwhile. Try again.');
        }
        await this.audit.record(
          {
            action: 'vault.passphrase.changed',
            outcome: 'success',
            actor,
            details: { kek_version: stored.kekVersion },
            meta,
          },
          tx,
        );
      }, ROTATION_TX);
    } finally {
      kek.fill(0);
      key.fill(0);
    }
    return this.status();
  }

  /** Issues a new recovery key; the old one stops working. Nothing is encrypted again. */
  rotateRecoveryKey(
    actor: Actor,
    request: ConfirmPassphraseRequest,
    meta: RequestMeta,
  ): Promise<VaultInitialized> {
    return this.serial.run(() => this.rotateRecoveryKeyNow(actor, request, meta));
  }

  private async rotateRecoveryKeyNow(
    actor: Actor,
    request: ConfirmPassphraseRequest,
    meta: RequestMeta,
  ): Promise<VaultInitialized> {
    const stored = await this.storedMeta();
    const kek = await this.confirmPassphrase(
      actor,
      request.passphrase,
      stored,
      meta,
      'rotate_recovery_key',
    );
    const recoveryKey = newRecoveryKey();
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_LOCK_KEY})`;
        const written = await tx.vaultMeta.updateMany({
          where: { id: 1, kekVersion: stored.kekVersion },
          data: {
            recoveryWrappedKek: new Uint8Array(wrapKekUnderRecoveryKey(kek, recoveryKey)),
            recoveryKeyRotatedAt: new Date(),
          },
        });
        if (written.count !== 1) {
          throw new ConflictException('The vault was changed meanwhile. Try again.');
        }
        await this.audit.record(
          {
            action: 'vault.recovery_key.rotated',
            outcome: 'success',
            actor,
            details: { kek_version: stored.kekVersion },
            meta,
          },
          tx,
        );
      }, ROTATION_TX);
      return { status: await this.status(), recoveryKey: formatRecoveryKey(recoveryKey) };
    } finally {
      kek.fill(0);
      recoveryKey.fill(0);
    }
  }

  /**
   * Replaces the key that wraps every data key. The values are not touched. The passphrase and the recovery key
   * both wrap the new key, so a new recovery key is issued (the old one opened the old key). All or nothing.
   */
  rotateKek(
    actor: Actor,
    request: ConfirmPassphraseRequest,
    meta: RequestMeta,
  ): Promise<VaultInitialized> {
    return this.serial.run(() => this.rotateKekNow(actor, request, meta));
  }

  private async rotateKekNow(
    actor: Actor,
    request: ConfirmPassphraseRequest,
    meta: RequestMeta,
  ): Promise<VaultInitialized> {
    const current = this.openKey();
    const stored = await this.storedMeta();
    const confirmed = await this.confirmPassphrase(
      actor,
      request.passphrase,
      stored,
      meta,
      'rotate_kek',
    );
    const same = confirmed.length === current.length && timingSafeEqual(confirmed, current);
    confirmed.fill(0);
    if (!same) {
      throw new ConflictException('The vault was changed meanwhile. Seal it and open it again.');
    }
    const kek = newKek();
    const recoveryKey = newRecoveryKey();
    const salt = randomBytes(KDF_SALT_BYTES);
    const key = await deriveKey(request.passphrase, salt, this.kdf);
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_LOCK_KEY})`;
        const rows = await tx.secret.findMany({
          select: { id: true, version: true, wrappedDek: true },
        });
        for (const row of rows) {
          let wrapped: Buffer;
          try {
            wrapped = rewrapDek(current, kek, row, row.wrappedDek);
          } catch {
            this.logger.error(`secret ${row.id}: its data key did not open under the current key`);
            throw new InternalServerErrorException(
              'A secret could not be re-wrapped, so nothing was changed.',
            );
          }
          const written = await tx.secret.updateMany({
            where: { id: row.id, version: row.version },
            data: { wrappedDek: new Uint8Array(wrapped) },
          });
          if (written.count !== 1) {
            throw new ConflictException('A secret was changed meanwhile. Try again.');
          }
        }
        const now = new Date();
        const written = await tx.vaultMeta.updateMany({
          where: { id: 1, kekVersion: stored.kekVersion },
          data: {
            kdfSalt: new Uint8Array(salt),
            kdfMemoryKib: this.kdf.memoryKib,
            kdfPasses: this.kdf.passes,
            kdfParallelism: this.kdf.parallelism,
            passphraseWrappedKek: new Uint8Array(wrapKekUnderPassphraseKey(kek, key)),
            recoveryWrappedKek: new Uint8Array(wrapKekUnderRecoveryKey(kek, recoveryKey)),
            kekVersion: stored.kekVersion + 1,
            kekRotatedAt: now,
            recoveryKeyRotatedAt: now,
          },
        });
        if (written.count !== 1) {
          throw new ConflictException('The vault was changed meanwhile. Try again.');
        }
        await this.audit.record(
          {
            action: 'vault.kek.rotated',
            outcome: 'success',
            actor,
            details: { kek_version: stored.kekVersion + 1, secrets: rows.length },
            meta,
          },
          tx,
        );
        return rows.length;
      }, ROTATION_TX);
    } catch (error) {
      kek.fill(0);
      recoveryKey.fill(0);
      key.fill(0);
      throw error;
    }
    key.fill(0);
    this.wipe();
    this.kek = kek;
    const formatted = formatRecoveryKey(recoveryKey);
    recoveryKey.fill(0);
    return { status: await this.status(), recoveryKey: formatted };
  }

  /** Encrypts every secret again under a fresh data key. Values and versions stay as they are. All or nothing. */
  rotateDataKeys(actor: Actor, meta: RequestMeta): Promise<VaultRotated> {
    return this.serial.run(() => this.rotateDataKeysNow(actor, meta));
  }

  private async rotateDataKeysNow(actor: Actor, meta: RequestMeta): Promise<VaultRotated> {
    const kek = this.openKey();
    const rotated = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_LOCK_KEY})`;
      const rows = await tx.secret.findMany();
      for (const row of rows) {
        const identity = { id: row.id, version: row.version, type: row.type };
        let value: string;
        try {
          value = decryptSecret(kek, identity, row);
        } catch {
          this.logger.error(
            `secret ${row.id} did not decrypt: the stored blobs do not match their context`,
          );
          throw new InternalServerErrorException(
            'A secret could not be decrypted, so nothing was changed.',
          );
        }
        const blobs = encryptSecret(kek, identity, value);
        const written = await tx.secret.updateMany({
          where: { id: row.id, version: row.version },
          data: {
            ciphertext: new Uint8Array(blobs.ciphertext),
            wrappedDek: new Uint8Array(blobs.wrappedDek),
          },
        });
        if (written.count !== 1) {
          throw new ConflictException('A secret was changed meanwhile. Try again.');
        }
      }
      await tx.vaultMeta.update({ where: { id: 1 }, data: { dataKeysRotatedAt: new Date() } });
      await this.audit.record(
        {
          action: 'vault.data_keys.rotated',
          outcome: 'success',
          actor,
          details: { secrets: rows.length },
          meta,
        },
        tx,
      );
      return rows.length;
    }, ROTATION_TX);
    return { status: await this.status(), rotated };
  }
}
