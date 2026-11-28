import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { hasPermission, type Permission } from '@swellwright/contracts';
import { type Database, type Prisma, SessionStage, type User } from '@swellwright/db';

import { type AppConfig } from '../config.js';
import { StepUpRequiredException } from '../http.js';
import { CONFIG, DATABASE } from '../tokens.js';
import { inAccountTransaction } from './account-lock.js';
import { addressBucket } from './cidr.js';
import { type AuthContext, type RequestMeta, requireDatabase } from './context.js';
import { hashToken, newSessionToken } from './tokens.js';

/** The password step is valid for this long. Finishing the sign-in starts a real session. */
export const PENDING_TTL_MS = 10 * 60_000;
/** The idle expiry is moved forward at most this often, so a busy page does not write on every request. */
const EXTEND_AFTER_MS = 60_000;
/** Expired rows of every account are removed at most this often, outside any account's transaction. */
const PRUNE_EVERY_MS = 60_000;

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/** A session row read under the account lock, with its user. */
export type LiveSession = Prisma.SessionGetPayload<{ include: { user: true } }>;

const STAGE_OF = {
  password_verified: SessionStage.password_verified,
  active: SessionStage.active,
} as const;

/**
 * Browser sessions. The cookie holds a random token; the table holds its SHA-256 hash, so a database copy
 * cannot be turned into a cookie. A session that gains privileges is replaced, never upgraded in place.
 *
 * Every session carries the credential epoch of its user at the moment it was issued (ADR 0049) and works only while
 * the user's epoch is the same. Whatever must end every session of a user at once (a reset, disabling, a password
 * change, a bulk revocation) moves the epoch on under the account lock, so a session issued by a sign-in that was still in
 * flight is dead as well, however the two interleaved.
 */
@Injectable()
export class SessionService {
  private lastPrune = 0;

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Issues a session inside the caller's transaction, which must hold `lockAccount` for the user (or have created the
   * user in it). Refuses with 401 when the user is not active or its epoch is not `expectedEpoch` any more: the proof
   * the caller holds was made for credentials that have changed since. `elevated` marks it as freshly verified for the
   * step-up window: the sign-in has just proved the second factor. Hand the token out only after the commit.
   */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    expectedEpoch: bigint,
    stage: 'password_verified' | 'active',
    meta: RequestMeta,
    now: Date,
    options: { readonly elevated?: boolean } = {},
  ): Promise<IssuedSession> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, credentialEpoch: true },
    });
    if (user?.status !== 'active' || user.credentialEpoch !== expectedEpoch) {
      throw new UnauthorizedException('Authentication required.');
    }
    const at = now.getTime();
    const token = newSessionToken();
    const absolute = new Date(
      stage === 'active' ? at + this.config.sessionMaxMs : at + PENDING_TTL_MS,
    );
    const idle = new Date(
      stage === 'active'
        ? Math.min(at + this.config.sessionIdleMs, absolute.getTime())
        : at + PENDING_TTL_MS,
    );
    const elevatedUntil =
      options.elevated === true
        ? new Date(Math.min(at + this.config.stepUpMs, absolute.getTime()))
        : null;
    // The account's own expired rows go here; other accounts' are left to `pruneExpired`, outside this lock.
    await tx.session.deleteMany({ where: { userId, expiresAt: { lt: now } } });
    await tx.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        stage: STAGE_OF[stage],
        expiresAt: idle,
        absoluteExpiresAt: absolute,
        elevatedUntil,
        ip: meta.ip?.slice(0, 64) ?? null,
        sourceBucket: addressBucket(meta.ip),
        userAgent: meta.userAgent ?? null,
        credentialEpoch: expectedEpoch,
        createdAt: now,
        lastSeenAt: now,
      },
    });
    return { token, expiresAt: idle };
  }

  /** Removes expired sessions of every account, at most once a minute. Never inside an account's transaction. */
  async pruneExpired(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) {
      return;
    }
    this.lastPrune = now;
    await requireDatabase(this.database).client.session.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    });
  }

  /**
   * The session behind a cookie value, or null when it is unknown, expired, of a disabled user, or of an older
   * credential epoch than its user's.
   */
  async authenticate(token: string): Promise<AuthContext | null> {
    const db = requireDatabase(this.database).client;
    const tokenHash = hashToken(token);
    const read = () => db.session.findUnique({ where: { tokenHash }, include: { user: true } });
    let row = await read();
    const now = new Date();
    const stillLive = (candidate: LiveSession | null): candidate is LiveSession =>
      candidate !== null &&
      candidate.expiresAt > now &&
      candidate.absoluteExpiresAt > now &&
      candidate.user.status === 'active' &&
      candidate.credentialEpoch === candidate.user.credentialEpoch;

    // The included relation may be read separately. A carried-over cookie can straddle the epoch change.
    if (row && row.credentialEpoch !== row.user.credentialEpoch) {
      row = await read();
    }
    const expired = row && (row.expiresAt <= now || row.absoluteExpiresAt <= now) ? row : null;
    if (!stillLive(row)) {
      if (expired) {
        await db.session.deleteMany({
          where: {
            id: expired.id,
            OR: [{ expiresAt: { lte: now } }, { absoluteExpiresAt: { lte: now } }],
          },
        });
      }
      return null;
    }
    const touchBefore = new Date(now.getTime() - EXTEND_AFTER_MS);
    if (row.stage === SessionStage.active && row.lastSeenAt < touchBefore) {
      const expiresAt = new Date(
        Math.min(now.getTime() + this.config.sessionIdleMs, row.absoluteExpiresAt.getTime()),
      );
      // Touch only the same live row, without undoing newer activity. A carried-over epoch is not a revocation.
      await db.session.updateMany({
        where: {
          id: row.id,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
          lastSeenAt: { lt: touchBefore },
        },
        data: { lastSeenAt: now, expiresAt },
      });
      row = await read();
      if (row && row.credentialEpoch !== row.user.credentialEpoch) {
        row = await read();
      }
      if (!stillLive(row)) {
        return null;
      }
    }
    return {
      sessionId: row.id,
      stage: row.stage,
      user: row.user,
      expiresAt: row.expiresAt,
      elevatedUntil: row.elevatedUntil,
      sessionEpoch: row.credentialEpoch,
      via: 'session',
      tokenId: null,
      grants: null,
    };
  }

  /**
   * The session of a request as it is now, read inside a transaction that holds the account lock: still there, of the
   * same user, at the expected stage, not expired, of an active user, and of the user's current epoch, which is still
   * the one the guard saw. A request whose session ended, or whose credentials changed, after the guard let it through
   * is refused with 401 here and writes nothing.
   */
  async requireLiveSession(
    tx: Prisma.TransactionClient,
    ctx: AuthContext,
    stage: 'password_verified' | 'active',
    now: Date,
  ): Promise<LiveSession & { user: User }> {
    if (ctx.via !== 'session' || ctx.sessionEpoch === null) {
      throw new UnauthorizedException('Authentication required.');
    }
    const session = await tx.session.findUnique({
      where: { id: ctx.sessionId },
      include: { user: true },
    });
    if (
      session?.userId !== ctx.user.id ||
      session.stage !== STAGE_OF[stage] ||
      session.expiresAt.getTime() <= now.getTime() ||
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      session.user.status !== 'active' ||
      session.credentialEpoch !== session.user.credentialEpoch ||
      session.credentialEpoch !== ctx.sessionEpoch
    ) {
      throw new UnauthorizedException('Authentication required.');
    }
    return session;
  }

  async requirePrivilegedSession(
    tx: Prisma.TransactionClient,
    ctx: AuthContext,
    permission: Permission,
    now: Date,
  ): Promise<LiveSession> {
    const session = await this.requireLiveSession(tx, ctx, 'active', now);
    if (!hasPermission(session.user.role, permission)) {
      throw new ForbiddenException('Your role does not allow this.');
    }
    if (!session.elevatedUntil || session.elevatedUntil <= now) {
      throw new StepUpRequiredException();
    }
    return session;
  }

  /**
   * Ends the session behind a cookie (sign-out) under the lock of its account, so it cannot race a sign-in that is
   * replacing or elevating it. Idempotent.
   */
  async revokeToken(token: string): Promise<void> {
    const db = requireDatabase(this.database).client;
    const tokenHash = hashToken(token);
    const row = await db.session.findUnique({ where: { tokenHash }, select: { userId: true } });
    if (!row) {
      return;
    }
    await inAccountTransaction(db, row.userId, async (tx) => {
      await tx.session.deleteMany({ where: { tokenHash, userId: row.userId } });
    });
  }
}
