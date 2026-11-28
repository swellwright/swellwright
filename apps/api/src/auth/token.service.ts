import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type CreatedToken,
  type CreateTokenRequest,
  hasPermission,
  PERMISSIONS,
  type Permission,
  STEP_UP_PERMISSIONS,
  TOKEN_MAX_ACTIVE,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
  type TokenList,
  type TokenListQuery,
  type TokenState,
  type TokenView,
} from '@swellwright/contracts';
import { type Database, SessionStage, type User } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { RateLimitedException, StepUpRequiredException } from '../http.js';
import { DATABASE } from '../tokens.js';
import { databaseNow, inAccountTransaction } from './account-lock.js';
import { addressBucket, ipInRanges } from './cidr.js';
import { type AuthContext, type RequestMeta, requireDatabase } from './context.js';
import { WindowLimiter } from './rate-limit.js';
import { SessionService } from './session.service.js';
import { hashToken } from './tokens.js';

/** The most tokens one listing returns. */
const LIST_LIMIT = 500;
/** `lastUsedAt` moves forward at most this often, so a busy integration does not write on every request. */
const TOUCH_AFTER_MS = 60_000;
/** Revoked and expired tokens stay listed this long, then they are removed. */
const KEEP_AFTER_END_MS = 30 * 24 * 3_600_000;
/** Wrong tokens per address and window: guessing 256 random bits cannot work, but it should not be free. */
const FAILURES_PER_ADDRESS = 30;
const FAILURE_WINDOW_MS = 10 * 60_000;
/** A dead token that keeps being used fills the audit chain, which is never pruned: cap it per token. */
const DENIED_NOTES_PER_TOKEN = 5;

interface Row {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly permissions: string[];
  readonly ipAllowlist: string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly revokedAt: Date | null;
  readonly user: { readonly username: string };
}

const PERMISSION_SET = new Set<string>(PERMISSIONS);

function stateOf(row: Row, now: number): TokenState {
  if (row.revokedAt) {
    return 'revoked';
  }
  return row.expiresAt.getTime() <= now ? 'expired' : 'active';
}

function toView(row: Row, now: number): TokenView {
  return {
    id: row.id,
    userId: row.userId,
    username: row.user.username,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions.filter((p): p is Permission => PERMISSION_SET.has(p)),
    ipAllowlist: row.ipAllowlist,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    state: stateOf(row, now),
  };
}

/** What a token may do right now: what it carries, as far as the role of its owner still allows it. */
export function grantsOf(row: { permissions: string[] }, user: Pick<User, 'role'>): Permission[] {
  return row.permissions.filter(
    (p): p is Permission =>
      PERMISSION_SET.has(p) &&
      !STEP_UP_PERMISSIONS.includes(p as Permission) &&
      hasPermission(user.role, p as Permission),
  );
}

/**
 * Revokes every live API token of a user (not yet revoked, not yet expired) and returns how many. For a credential
 * reset, a password change and disabling the account: the transaction must hold `lockAccount` for the user. Rows stay
 * for the listing; a revoked token never becomes usable again, also not when the account is enabled again.
 */
export async function revokeLiveApiTokens(
  tx: Pick<Database['client'], 'apiToken'>,
  userId: string,
  now: Date,
): Promise<number> {
  const { count } = await tx.apiToken.updateMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  });
  return count;
}

/**
 * API tokens (ADR 0023): bearer credentials for the CLI and integrations, issued in the name of a user. Only the
 * hash is stored. A token carries a subset of its owner's permissions, never one that needs a second factor,
 * and what it may do is checked against the owner's role on every request, so a demoted or disabled owner
 * takes the token's power away at once.
 */
@Injectable()
export class TokenService {
  private readonly failures = new WindowLimiter(FAILURES_PER_ADDRESS, FAILURE_WINDOW_MS);
  private readonly deniedNotes = new WindowLimiter(DENIED_NOTES_PER_TOKEN, FAILURE_WINDOW_MS);

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /**
   * Issues a token. Everything the decision depends on is read again under the lock of the account, so a token
   * cannot be issued from a session that a reset, a password change or disabling the account has just ended (they
   * take the same lock and revoke the live tokens), and two requests cannot both pass the quota.
   */
  async create(
    auth: AuthContext,
    input: CreateTokenRequest,
    meta: RequestMeta,
  ): Promise<CreatedToken> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const { row, now } = await inAccountTransaction(this.db, auth.user.id, async (tx) => {
      const now = await databaseNow(tx);
      const user = await this.requireLiveCreator(tx, auth, now);
      const missing = input.permissions.filter((p) => !hasPermission(user.role, p));
      if (missing.length > 0) {
        throw new BadRequestException(
          `Your role does not have: ${missing.join(', ')}. A token cannot carry more than you can do.`,
        );
      }
      const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
      const active = await tx.apiToken.count({
        where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: now } },
      });
      if (active >= TOKEN_MAX_ACTIVE) {
        throw new ConflictException(
          `You already have ${String(TOKEN_MAX_ACTIVE)} active tokens. Revoke one first.`,
        );
      }
      const cutoff = new Date(now.getTime() - KEEP_AFTER_END_MS);
      await tx.apiToken.deleteMany({
        where: {
          userId: auth.user.id,
          OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }],
        },
      });
      const created = await tx.apiToken.create({
        data: {
          userId: auth.user.id,
          name: input.name,
          tokenHash: hashToken(token),
          prefix: token.slice(0, 8),
          permissions: input.permissions,
          ipAllowlist: input.ipAllowlist,
          expiresAt,
        },
        include: { user: { select: { username: true } } },
      });
      await this.audit.record(
        {
          action: 'token.created',
          outcome: 'success',
          actor: { id: auth.user.id, name: auth.user.username },
          object: { type: 'token', id: created.id },
          details: {
            name: input.name,
            prefix: created.prefix,
            days: input.expiresInDays,
            permissions: input.permissions.length,
            restricted: input.ipAllowlist.length > 0,
          },
          meta,
        },
        tx,
      );
      return { row: created, now };
    });
    return { token, view: toView(row, now.getTime()) };
  }

  /**
   * The creator as they are now, read under the lock: the same user, still active, from a session that is still
   * signed in, not expired and freshly verified, whose role still allows `tokens:create`.
   */
  private async requireLiveCreator(
    tx: Pick<Database['client'], 'session' | 'user'>,
    auth: AuthContext,
    now: Date,
  ): Promise<User> {
    if (auth.via !== 'session') {
      throw new UnauthorizedException('Authentication required.');
    }
    const session = await tx.session.findUnique({
      where: { id: auth.sessionId },
      include: { user: { include: { credential: { select: { totpConfirmedAt: true } } } } },
    });
    if (!session) {
      throw new UnauthorizedException('Authentication required.');
    }
    // A session of an older credential epoch than its user's (a reset, a password change, disabling came in between,
    // ADR 0049) is dead, also when the guard still saw it alive; so is one without a confirmed authenticator.
    if (
      session.userId !== auth.user.id ||
      session.stage !== SessionStage.active ||
      session.expiresAt.getTime() <= now.getTime() ||
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      session.user.status !== 'active' ||
      session.credentialEpoch !== session.user.credentialEpoch ||
      session.credentialEpoch !== auth.sessionEpoch ||
      !session.user.credential?.totpConfirmedAt
    ) {
      throw new UnauthorizedException('Authentication required.');
    }
    if (!hasPermission(session.user.role, 'tokens:create')) {
      throw new ForbiddenException('Your role does not allow this.');
    }
    if (!session.elevatedUntil || session.elevatedUntil.getTime() <= now.getTime()) {
      throw new StepUpRequiredException();
    }
    return session.user;
  }

  async listOwn(auth: AuthContext): Promise<TokenList> {
    const rows = await this.db.apiToken.findMany({
      where: { userId: auth.user.id },
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    const now = Date.now();
    return { tokens: rows.map((row) => toView(row, now)) };
  }

  async listAll(query: TokenListQuery): Promise<TokenList> {
    const rows = await this.db.apiToken.findMany({
      where: query.userId ? { userId: query.userId } : {},
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    const now = Date.now();
    return { tokens: rows.map((row) => toView(row, now)) };
  }

  /** Revokes a token. `own` limits it to the caller's tokens: someone else's is "not found". Idempotent. */
  async revoke(
    auth: AuthContext,
    id: string,
    scope: 'own' | 'any',
    meta: RequestMeta,
  ): Promise<void> {
    const owner = await this.db.apiToken.findUnique({ where: { id }, select: { userId: true } });
    if (!owner || (scope === 'own' && owner.userId !== auth.user.id)) {
      throw new NotFoundException('There is no such token.');
    }
    await inAccountTransaction(this.db, [auth.user.id, owner.userId], async (tx) => {
      // The same lock as a reset or disabling the account, which revoke every live token of the owner: whichever
      // comes second sees the token revoked and neither moves the time or writes a second record.
      const now = await databaseNow(tx);
      if (scope === 'any') {
        await this.sessions.requirePrivilegedSession(tx, auth, 'tokens:revoke', now);
      } else {
        await this.sessions.requireLiveSession(tx, auth, 'active', now);
      }
      const row = await tx.apiToken.findUnique({
        where: { id },
        include: { user: { select: { username: true } } },
      });
      if (!row || (scope === 'own' && row.userId !== auth.user.id)) {
        throw new NotFoundException('There is no such token.');
      }
      if (row.revokedAt) {
        return;
      }
      await tx.apiToken.update({ where: { id }, data: { revokedAt: now } });
      await this.audit.record(
        {
          action: 'token.revoked',
          outcome: 'success',
          actor: { id: auth.user.id, name: auth.user.username },
          object: { type: 'token', id },
          details: {
            scope: row.userId === auth.user.id ? 'own' : 'user',
            user: row.user.username,
            name: row.name,
          },
          meta,
        },
        tx,
      );
    });
  }

  /**
   * The context of a request that carries a bearer token, or null when the token is unknown, malformed, revoked,
   * expired, used from an address it is not allowed from, or its owner is disabled. Too many wrong tokens from
   * one address answer 429.
   */
  async authenticate(raw: string, meta: RequestMeta): Promise<AuthContext | null> {
    if (!TOKEN_PATTERN.test(raw)) {
      return this.failed(meta);
    }
    const row = await this.db.apiToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { user: true },
    });
    if (!row) {
      return this.failed(meta);
    }
    const now = Date.now();
    const deny = async (reason: 'revoked' | 'expired' | 'address'): Promise<null> => {
      if (this.deniedNotes.hit(row.id)) {
        await this.audit.note({
          action: 'auth.token.denied',
          outcome: 'denied',
          actor: { id: row.user.id, name: row.user.username },
          object: { type: 'token', id: row.id },
          details: { reason, prefix: row.prefix },
          meta,
        });
      }
      return null;
    };
    if (row.revokedAt) {
      return deny('revoked');
    }
    if (row.expiresAt.getTime() <= now) {
      return deny('expired');
    }
    if (row.user.status !== 'active') {
      return null;
    }
    if (!ipInRanges(meta.ip, row.ipAllowlist)) {
      return deny('address');
    }
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
      await this.db.apiToken.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(now), lastUsedIp: meta.ip?.slice(0, 64) ?? null },
      });
    }
    return {
      sessionId: '',
      stage: 'active',
      user: row.user,
      expiresAt: row.expiresAt,
      elevatedUntil: null,
      sessionEpoch: null,
      via: 'token',
      tokenId: row.id,
      grants: grantsOf(row, row.user),
    };
  }

  private failed(meta: RequestMeta): null {
    // Counted by source (an IPv4 address, an IPv6 /64), so rotating through one's own /64 does not reset the count.
    const source = addressBucket(meta.ip);
    if (!this.failures.hit(source)) {
      throw new RateLimitedException(this.failures.retryAfterSeconds(source));
    }
    return null;
  }
}
