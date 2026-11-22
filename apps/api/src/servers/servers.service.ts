import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AccessMethod,
  type AddAccessRequest,
  type CreateServerRequest,
  DELETABLE_SERVER_STATES,
  MAX_ACCESS_PER_SERVER,
  type PinHostKeyRequest,
  type SecretRef,
  type SecretType,
  SECRET_TYPE_FOR_METHOD,
  type ServerAccess,
  ServerFactsSchema,
  type ServerFactsRecord,
  type ServerFactsSummary,
  type ServerHostKey,
  type ServerList,
  type ServerListQuery,
  type ServerSummary,
  type ServerView,
  SUDO_SECRET_TYPE,
  type UpdateAccessRequest,
  type UpdateServerRequest,
} from '@swellwright/contracts';
import { type Database, Prisma } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { CodedHttpException } from '../http.js';
import { DATABASE } from '../tokens.js';
import { unreadableFacts } from './facts/parse-facts.js';
import { SshService } from './ssh.service.js';

/** An arbitrary constant: one transaction at a time changes the inventory, so the limits below hold. */
export const SERVERS_LOCK_KEY = 7_761_239;

/** A server shows at most this many pinned host keys; there are only a handful of key types. */
export const MAX_HOST_KEYS_PER_SERVER = 16;

/** Who did it. */
export interface Actor {
  readonly id: string;
  readonly name: string;
}

const WITH_FACT = {
  fact: { select: { facts: true, collectedAt: true, source: true, scriptSha256: true } },
} as const;

const FULL = {
  hostKeys: { orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }] },
  access: {
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: {
      secret: { select: { id: true, name: true, type: true } },
      sudoSecret: { select: { id: true, name: true, type: true } },
    },
  },
  ...WITH_FACT,
} satisfies Prisma.ServerInclude;

type ServerRow = Prisma.ServerGetPayload<{ include: typeof FULL }>;
type SummaryRow = Prisma.ServerGetPayload<{
  include: { _count: { select: { hostKeys: true; access: true } } } & typeof WITH_FACT;
}>;
interface FactRow {
  facts: Prisma.JsonValue;
  collectedAt: Date;
  source: string;
  scriptSha256: string | null;
}
type AccessRow = ServerRow['access'][number];
type HostKeyRow = ServerRow['hostKeys'][number];

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const isForeignKeyViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, 200) : null;

/** The facts as stored, read through the schema; a record that does not fit it (another version) is shown as unreadable. */
function readFacts(fact: FactRow) {
  const parsed = ServerFactsSchema.safeParse(fact.facts);
  return parsed.success ? parsed.data : null;
}

/** The two facts the list shows: the operating system and the kernel, as text. */
function factsSummary(fact: FactRow | null): ServerFactsSummary | null {
  if (!fact) {
    return null;
  }
  const facts = readFacts(fact);
  const os = facts?.os;
  const osText =
    asText(os?.prettyName) ?? asText([os?.id, os?.versionId].filter(Boolean).join(' '));
  return {
    os: osText,
    kernel: asText(facts?.kernel?.release),
    collectedAt: fact.collectedAt.toISOString(),
  };
}

export function factsView(fact: FactRow | null): ServerFactsRecord | null {
  if (!fact) {
    return null;
  }
  return {
    facts:
      readFacts(fact) ??
      unreadableFacts('The stored facts are not of a version this server can read. Refresh them.'),
    collectedAt: fact.collectedAt.toISOString(),
    source: fact.source,
    scriptSha256: fact.scriptSha256,
  };
}

function serverFields(row: {
  id: string;
  name: string;
  address: string;
  sshPort: number;
  country: string | null;
  provider: string | null;
  state: ServerSummary['state'];
  tags: string[];
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    sshPort: row.sshPort,
    country: row.country,
    provider: row.provider,
    state: row.state,
    tags: row.tags,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toServerSummary(row: SummaryRow): ServerSummary {
  return {
    ...serverFields(row),
    hostKeyCount: row._count.hostKeys,
    pinned: row._count.hostKeys > 0,
    accessCount: row._count.access,
    facts: factsSummary(row.fact),
  };
}

const secretRef = (row: { id: string; name: string; type: SecretType }): SecretRef => ({
  id: row.id,
  name: row.name,
  type: row.type,
});

export function toServerAccess(row: AccessRow): ServerAccess {
  return {
    id: row.id,
    method: row.method,
    username: row.username,
    secret: secretRef(row.secret),
    sudoSecret: row.sudoSecret ? secretRef(row.sudoSecret) : null,
    priority: row.priority,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyOk: row.lastVerifyOk,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toHostKey(row: HostKeyRow, names: ReadonlyMap<string, string>): ServerHostKey {
  return {
    id: row.id,
    algorithm: row.algorithm,
    fingerprintSha256: row.fingerprintSha256,
    source: row.source,
    acceptedBy: row.acceptedById ? (names.get(row.acceptedById) ?? null) : null,
    acceptedAt: row.acceptedAt.toISOString(),
  };
}

/** Names in a list: letters ignoring case, then the exact text, so `a-1` and `A-1` have a fixed order. */
export const byName = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Keeps the first of every tag. */
const unique = (tags: readonly string[]): string[] => [...new Set(tags)];

/**
 * The inventory of servers (ADR 0034): what a server is, which host keys are pinned, and which vault secrets log in
 * to it. Every change and its audit record are one transaction, taken under an advisory lock so that the limits
 * (five access entries, sixteen host keys) cannot be beaten by two requests at once. Nothing here opens a
 * connection, and no secret value is ever read.
 */
@Injectable()
export class ServersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SshService) private readonly ssh: SshService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  async list(query: ServerListQuery): Promise<ServerList> {
    const where: Prisma.ServerWhereInput = {
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.tag === undefined ? {} : { tags: { has: query.tag } }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { address: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
    };
    const rows = await this.db.server.findMany({
      where,
      include: { _count: { select: { hostKeys: true, access: true } }, ...WITH_FACT },
    });
    // Sorted here, not by the database: its collation decides how upper and lower case compare, and the order of a
    // list must not depend on how a PostgreSQL was initialised.
    rows.sort((a, b) => byName(a.name, b.name) || (a.id < b.id ? -1 : 1));
    return { servers: rows.map(toServerSummary) };
  }

  async get(id: string): Promise<ServerView> {
    const row = await this.db.server.findUnique({ where: { id }, include: FULL });
    if (!row) {
      throw new NotFoundException('There is no such server.');
    }
    return this.view(row);
  }

  private async view(row: ServerRow): Promise<ServerView> {
    const ids = [
      ...new Set(row.hostKeys.flatMap((key) => (key.acceptedById ? [key.acceptedById] : []))),
    ];
    const users =
      ids.length === 0
        ? []
        : await this.db.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, username: true },
          });
    const names = new Map(users.map((user) => [user.id, user.username]));
    return {
      ...serverFields(row),
      hostKeys: row.hostKeys.map((key) => toHostKey(key, names)),
      access: row.access.map(toServerAccess),
      facts: factsView(row.fact),
    };
  }

  async create(actor: Actor, request: CreateServerRequest, meta: RequestMeta): Promise<ServerView> {
    try {
      const id = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
        const created = await tx.server.create({
          data: {
            name: request.name,
            address: request.address,
            ...(request.sshPort === undefined ? {} : { sshPort: request.sshPort }),
            ...(request.country === undefined ? {} : { country: request.country }),
            ...(request.provider === undefined ? {} : { provider: request.provider }),
            ...(request.state === undefined ? {} : { state: request.state }),
            ...(request.tags === undefined ? {} : { tags: unique(request.tags) }),
            ...(request.notes === undefined ? {} : { notes: request.notes }),
            createdById: actor.id,
          },
        });
        await this.audit.record(
          {
            action: 'server.created',
            outcome: 'success',
            actor,
            object: { type: 'server', id: created.id },
            details: { name: created.name, state: created.state },
            meta,
          },
          tx,
        );
        return created.id;
      });
      return await this.get(id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A server with that name exists already.');
      }
      throw error;
    }
  }

  async update(
    actor: Actor,
    id: string,
    body: UpdateServerRequest,
    meta: RequestMeta,
  ): Promise<ServerView> {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
        const current = await tx.server.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException('There is no such server.');
        }
        const data: Prisma.ServerUpdateInput = {};
        const changed: string[] = [];
        const details: Record<string, string> = {};
        if (body.name !== undefined && body.name !== current.name) {
          data.name = body.name;
          changed.push('name');
          details['name_from'] = current.name;
          details['name_to'] = body.name;
        }
        if (body.address !== undefined && body.address !== current.address) {
          data.address = body.address;
          changed.push('address');
        }
        if (body.sshPort !== undefined && body.sshPort !== current.sshPort) {
          data.sshPort = body.sshPort;
          changed.push('ssh_port');
        }
        if (body.country !== undefined && body.country !== current.country) {
          data.country = body.country;
          changed.push('country');
        }
        if (body.provider !== undefined && body.provider !== current.provider) {
          data.provider = body.provider;
          changed.push('provider');
        }
        if (body.state !== undefined && body.state !== current.state) {
          data.state = body.state;
          changed.push('state');
          details['state_from'] = current.state;
          details['state_to'] = body.state;
        }
        if (body.tags !== undefined) {
          const tags = unique(body.tags);
          if (tags.join('\n') !== current.tags.join('\n')) {
            data.tags = tags;
            changed.push('tags');
          }
        }
        if (body.notes !== undefined && body.notes !== current.notes) {
          data.notes = body.notes;
          changed.push('notes');
        }
        if (changed.length === 0) {
          return;
        }
        await tx.server.update({ where: { id }, data });
        await this.audit.record(
          {
            action: 'server.updated',
            outcome: 'success',
            actor,
            object: { type: 'server', id },
            details: { changed: changed.join(','), ...details },
            meta,
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A server with that name exists already.');
      }
      throw error;
    }
    return this.get(id);
  }

  /** Only a server that was never in service or is out of it. Host keys, access entries and facts go with it. */
  async remove(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
      const current = await tx.server.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('There is no such server.');
      }
      if (!DELETABLE_SERVER_STATES.includes(current.state)) {
        throw new ConflictException(
          `A server in the state "${current.state}" cannot be deleted. Only a draft or a retired server can; change its state first.`,
        );
      }
      await tx.server.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'server.deleted',
          outcome: 'success',
          actor,
          object: { type: 'server', id },
          details: { name: current.name, state: current.state },
          meta,
        },
        tx,
      );
    });
  }

  /** Pins a fingerprint a person checked. Pinning the same fingerprint again changes nothing. */
  async pinHostKey(
    actor: Actor,
    id: string,
    request: PinHostKeyRequest,
    meta: RequestMeta,
  ): Promise<{ key: ServerHostKey; created: boolean }> {
    const result = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
      const server = await tx.server.findUnique({ where: { id }, select: { id: true } });
      if (!server) {
        throw new NotFoundException('There is no such server.');
      }
      const existing = await tx.serverHostKey.findUnique({
        where: {
          serverId_fingerprintSha256: {
            serverId: id,
            fingerprintSha256: request.fingerprintSha256,
          },
        },
      });
      if (existing) {
        return { row: existing, created: false };
      }
      const count = await tx.serverHostKey.count({ where: { serverId: id } });
      if (count >= MAX_HOST_KEYS_PER_SERVER) {
        throw new ConflictException(
          `A server has at most ${String(MAX_HOST_KEYS_PER_SERVER)} pinned host keys. Revoke one first.`,
        );
      }
      const row = await tx.serverHostKey.create({
        data: {
          serverId: id,
          algorithm: request.algorithm,
          fingerprintSha256: request.fingerprintSha256,
          source: 'manual',
          acceptedById: actor.id,
        },
      });
      await this.audit.record(
        {
          action: 'server.host_key.pinned',
          outcome: 'success',
          actor,
          object: { type: 'server', id },
          details: {
            algorithm: row.algorithm,
            fingerprint: row.fingerprintSha256,
            source: row.source,
          },
          meta,
        },
        tx,
      );
      return { row, created: true };
    });
    return {
      key: toHostKey(result.row, new Map([[actor.id, actor.name]])),
      created: result.created,
    };
  }

  /** For a server that was reinstalled: the old key must stop being trusted. */
  async revokeHostKey(actor: Actor, id: string, keyId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
      const key = await tx.serverHostKey.findFirst({ where: { id: keyId, serverId: id } });
      if (!key) {
        throw new NotFoundException('There is no such host key on this server.');
      }
      await tx.serverHostKey.delete({ where: { id: keyId } });
      await this.audit.record(
        {
          action: 'server.host_key.revoked',
          outcome: 'success',
          actor,
          object: { type: 'server', id },
          details: {
            algorithm: key.algorithm,
            fingerprint: key.fingerprintSha256,
            source: key.source,
          },
          meta,
        },
        tx,
      );
    });
    // A connection that was opened under the old trust must not be used again.
    this.ssh.closeConnections();
  }

  /**
   * Pins the key that a scan showed and a person confirmed (ADR 0037): the same record as a key pinned by hand, with the
   * source `scan`. A key that is pinned already changes nothing. When other keys are pinned, a different key needs
   * `replace`, which revokes them in the same transaction (the operating system was reinstalled); each revocation is
   * recorded as such.
   */
  async acceptScannedKey(
    actor: Actor,
    id: string,
    scanned: { algorithm: string; fingerprintSha256: string },
    replace: boolean,
    meta: RequestMeta,
  ): Promise<{ key: ServerHostKey; created: boolean; replaced: number }> {
    const result = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
      const server = await tx.server.findUnique({ where: { id }, select: { id: true } });
      if (!server) {
        throw new NotFoundException('There is no such server.');
      }
      const pinned = await tx.serverHostKey.findMany({
        where: { serverId: id },
        orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }],
      });
      const existing = pinned.find((key) => key.fingerprintSha256 === scanned.fingerprintSha256);
      if (existing) {
        return { row: existing, created: false, replaced: 0 };
      }
      if (pinned.length > 0 && !replace) {
        throw new CodedHttpException(
          409,
          'host_key_replace_required',
          'Other host keys are pinned for this server. If its operating system was reinstalled, confirm that the old keys are to be replaced; otherwise somebody may be answering in its place.',
          { pinned: pinned.map((key) => key.fingerprintSha256) },
        );
      }
      if (pinned.length > 0) {
        await tx.serverHostKey.deleteMany({ where: { serverId: id } });
        for (const old of pinned) {
          await this.audit.record(
            {
              action: 'server.host_key.revoked',
              outcome: 'success',
              actor,
              object: { type: 'server', id },
              details: {
                algorithm: old.algorithm,
                fingerprint: old.fingerprintSha256,
                source: old.source,
                reason: 'replaced',
              },
              meta,
            },
            tx,
          );
        }
      }
      const row = await tx.serverHostKey.create({
        data: {
          serverId: id,
          algorithm: scanned.algorithm,
          fingerprintSha256: scanned.fingerprintSha256,
          source: 'scan',
          acceptedById: actor.id,
        },
      });
      await this.audit.record(
        {
          action: 'server.host_key.pinned',
          outcome: 'success',
          actor,
          object: { type: 'server', id },
          details: {
            algorithm: row.algorithm,
            fingerprint: row.fingerprintSha256,
            source: row.source,
            replaced: pinned.length,
          },
          meta,
        },
        tx,
      );
      return { row, created: true, replaced: pinned.length };
    });
    if (result.replaced > 0) {
      this.ssh.closeConnections();
    }
    return {
      key: toHostKey(result.row, new Map([[actor.id, actor.name]])),
      created: result.created,
      replaced: result.replaced,
    };
  }

  /** What a connection to the server needs: where it is, the pinned fingerprints and the entries by priority. */
  async connectionInfo(id: string): Promise<{
    id: string;
    name: string;
    address: string;
    port: number;
    fingerprints: string[];
    /** The key types of the pinned keys: the connection prefers them (a server has keys of several types). */
    hostKeyTypes: string[];
    access: {
      id: string;
      method: AccessMethod;
      username: string;
      secretId: string;
      sudoSecretId: string | null;
      priority: number;
    }[];
  }> {
    const row = await this.db.server.findUnique({
      where: { id },
      include: {
        hostKeys: { orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }] },
        access: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) {
      throw new NotFoundException('There is no such server.');
    }
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      port: row.sshPort,
      fingerprints: row.hostKeys.map((key) => key.fingerprintSha256),
      hostKeyTypes: [...new Set(row.hostKeys.map((key) => key.algorithm))],
      access: row.access.map((entry) => ({
        id: entry.id,
        method: entry.method,
        username: entry.username,
        secretId: entry.secretId,
        sudoSecretId: entry.sudoSecretId,
        priority: entry.priority,
      })),
    };
  }

  /** The facts collected last; 404 when there is no such server or nothing was ever collected. */
  async getFacts(id: string): Promise<ServerFactsRecord> {
    const row = await this.db.serverFact.findUnique({ where: { serverId: id } });
    if (!row) {
      if (!(await this.db.server.findUnique({ where: { id }, select: { id: true } }))) {
        throw new NotFoundException('There is no such server.');
      }
      throw new NotFoundException('No facts were collected for this server yet.');
    }
    const view = factsView(row);
    if (!view) {
      throw new NotFoundException('No facts were collected for this server yet.');
    }
    return view;
  }

  /**
   * The secrets of an entry must exist and be of the kind the method needs: a password for a password entry, a
   * private key for a key entry, and a password for `sudo`. Anything else is a bad request, not a missing page.
   */
  private async checkSecrets(
    tx: Pick<Database['client'], 'secret'>,
    method: AccessMethod,
    secretId: string,
    sudoSecretId: string | null,
  ): Promise<void> {
    const wanted: string[] = sudoSecretId === null ? [secretId] : [secretId, sudoSecretId];
    const rows = await tx.secret.findMany({
      where: { id: { in: wanted } },
      select: { id: true, name: true, type: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const login = byId.get(secretId);
    if (!login) {
      throw new BadRequestException('The secret chosen for the login does not exist.');
    }
    const needed = SECRET_TYPE_FOR_METHOD[method];
    if (login.type !== needed) {
      throw new BadRequestException(
        `A ${method} entry needs a secret of the kind "${needed}", but "${login.name}" is "${login.type}".`,
      );
    }
    if (sudoSecretId !== null) {
      const sudo = byId.get(sudoSecretId);
      if (!sudo) {
        throw new BadRequestException('The secret chosen for sudo does not exist.');
      }
      if (sudo.type !== SUDO_SECRET_TYPE) {
        throw new BadRequestException(
          `The sudo secret must be of the kind "${SUDO_SECRET_TYPE}", but "${sudo.name}" is "${sudo.type}".`,
        );
      }
    }
  }

  async addAccess(
    actor: Actor,
    id: string,
    request: AddAccessRequest,
    meta: RequestMeta,
  ): Promise<ServerAccess> {
    try {
      const accessId = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
        const server = await tx.server.findUnique({ where: { id }, select: { id: true } });
        if (!server) {
          throw new NotFoundException('There is no such server.');
        }
        const existing = await tx.serverAccess.findMany({
          where: { serverId: id },
          select: { priority: true },
        });
        if (existing.length >= MAX_ACCESS_PER_SERVER) {
          throw new ConflictException(
            `A server has at most ${String(MAX_ACCESS_PER_SERVER)} access entries. Remove one first.`,
          );
        }
        const sudoSecretId = request.sudoSecretId ?? null;
        await this.checkSecrets(tx, request.method, request.secretId, sudoSecretId);
        const priority =
          request.priority ??
          (existing.length === 0 ? 0 : Math.max(...existing.map((entry) => entry.priority)) + 1);
        const created = await tx.serverAccess.create({
          data: {
            serverId: id,
            method: request.method,
            username: request.username,
            secretId: request.secretId,
            sudoSecretId,
            priority,
          },
        });
        await this.audit.record(
          {
            action: 'server.access.added',
            outcome: 'success',
            actor,
            object: { type: 'server', id },
            details: {
              access_id: created.id,
              method: created.method,
              username: created.username,
              secret_id: created.secretId,
              sudo_secret_id: created.sudoSecretId,
              priority: created.priority,
            },
            meta,
          },
          tx,
        );
        return created.id;
      });
      return await this.accessView(id, accessId);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        // A secret deleted between the check and the insert.
        throw new BadRequestException('A secret chosen for this entry no longer exists.');
      }
      throw error;
    }
  }

  async updateAccess(
    actor: Actor,
    id: string,
    accessId: string,
    body: UpdateAccessRequest,
    meta: RequestMeta,
  ): Promise<ServerAccess> {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
        const current = await tx.serverAccess.findFirst({ where: { id: accessId, serverId: id } });
        if (!current) {
          throw new NotFoundException('There is no such access entry on this server.');
        }
        const method = body.method ?? current.method;
        const secretId = body.secretId ?? current.secretId;
        const sudoSecretId =
          body.sudoSecretId === undefined ? current.sudoSecretId : body.sudoSecretId;
        // The result is checked as a whole: changing the method alone must not leave a password secret on a key entry.
        await this.checkSecrets(tx, method, secretId, sudoSecretId);

        const data: Prisma.ServerAccessUncheckedUpdateInput = {};
        const changed: string[] = [];
        if (method !== current.method) {
          data.method = method;
          changed.push('method');
        }
        if (body.username !== undefined && body.username !== current.username) {
          data.username = body.username;
          changed.push('username');
        }
        if (secretId !== current.secretId) {
          data.secretId = secretId;
          changed.push('secret');
        }
        if (sudoSecretId !== current.sudoSecretId) {
          data.sudoSecretId = sudoSecretId;
          changed.push('sudo_secret');
        }
        if (body.priority !== undefined && body.priority !== current.priority) {
          data.priority = body.priority;
          changed.push('priority');
        }
        if (changed.length === 0) {
          return;
        }
        await tx.serverAccess.update({ where: { id: accessId }, data });
        await this.audit.record(
          {
            action: 'server.access.updated',
            outcome: 'success',
            actor,
            object: { type: 'server', id },
            details: { access_id: accessId, changed: changed.join(',') },
            meta,
          },
          tx,
        );
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new BadRequestException('A secret chosen for this entry no longer exists.');
      }
      throw error;
    }
    return this.accessView(id, accessId);
  }

  async removeAccess(actor: Actor, id: string, accessId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERVERS_LOCK_KEY})`;
      const current = await tx.serverAccess.findFirst({ where: { id: accessId, serverId: id } });
      if (!current) {
        throw new NotFoundException('There is no such access entry on this server.');
      }
      await tx.serverAccess.delete({ where: { id: accessId } });
      await this.audit.record(
        {
          action: 'server.access.removed',
          outcome: 'success',
          actor,
          object: { type: 'server', id },
          details: { access_id: accessId, method: current.method, username: current.username },
          meta,
        },
        tx,
      );
    });
  }

  private async accessView(serverId: string, accessId: string): Promise<ServerAccess> {
    const row = await this.db.serverAccess.findFirstOrThrow({
      where: { id: accessId, serverId },
      include: {
        secret: { select: { id: true, name: true, type: true } },
        sudoSecret: { select: { id: true, name: true, type: true } },
      },
    });
    return toServerAccess(row);
  }
}
