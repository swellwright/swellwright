import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuditAction, AuthNextStep, TotpEnrollment } from '@swellwright/contracts';
import { type Credential, type Database, type Prisma, type User } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { type AppConfig } from '../config.js';
import { RateLimitedException, StepUpRequiredException } from '../http.js';
import { CONFIG, DATABASE, PASSWORD_HASHER, SECRET_BOX } from '../tokens.js';
import { databaseNow, inAccountTransaction } from './account-lock.js';
import { addressBucket } from './cidr.js';
import { type AuthContext, type RequestMeta, requireDatabase } from './context.js';
import { AuthFailureNotes } from './failure-notes.js';
import { HasherBusyError, PasswordHasher } from './password.js';
import { DEFAULT_LIMITER_KEYS, WindowLimiter } from './rate-limit.js';
import { SecretBox } from './secret-box.js';
import { type IssuedSession, type LiveSession, SessionService } from './session.service.js';
import {
  ACCOUNT_SLOWDOWN_FROM,
  afterMfaFailure,
  afterPasswordFailure,
  afterSourceFailure,
  CLEARED_PASSWORD_FAILURES,
  CLEARED_PENDING_FACTOR_FAILURES,
  CLEARED_STEP_UP_FAILURES,
  currentSource,
  MAX_SOURCE_ROWS,
  MFA_WINDOW_MS,
  type MfaState,
  mfaLockMs,
  type PasswordState,
  PENDING_FACTOR_LIMIT_MULTIPLIER,
  passwordWaitMs,
  retrySeconds,
  type SourceState,
} from './throttle.js';
import { revokeLiveApiTokens } from './token.service.js';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import {
  looksLikeTotpCode,
  newRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
} from './tokens.js';

const ISSUER = 'Swellwright';
/** Charge both real and dummy login proofs before looking up the account. */
const LOGIN_PROOFS_PER_SOURCE = 20;
const LOGIN_PROOF_WINDOW_MS = 5 * 60_000;
/** Wrong current passwords per session when changing the password; they never count towards the sign-in limits. */
const CURRENT_PASSWORD_ATTEMPTS = 5;
const CURRENT_PASSWORD_WINDOW_MS = 15 * 60_000;

const WAIT_MESSAGE = 'Too many failed attempts. Try again later.';

export interface Completed {
  readonly session: IssuedSession;
  readonly user: AuthContext['user'];
  readonly recoveryCodes?: readonly string[];
}

/** The context that binds a sealed TOTP secret to its owner and purpose. */
const totpContext = (userId: string): string => `swellwright:totp:v1:${userId}`;

const passwordStateOf = (c: Credential): PasswordState => ({
  failures: c.passwordFailures,
  windowEndsAt: c.passwordWindowEndsAt,
  retryAt: c.passwordRetryAt,
});

const sourceKey = (userId: string, sourceBucket: string) => ({
  userId_sourceBucket: { userId, sourceBucket },
});

type FactorMethod = 'totp' | 'recovery_code';
type FactorPurpose = 'sign_in' | 'step_up' | 'enrollment';

/** What the transaction of a second-factor proof decided. The answer is sent, and notes written, after the commit. */
type FactorOutcome<T> =
  | { readonly kind: 'accepted'; readonly value: T }
  | {
      readonly kind: 'refused';
      readonly method: FactorMethod | 'enrollment';
      readonly locked: boolean;
      readonly failures: number;
    };

/**
 * Sign-in in two steps: a password makes a session that can only finish the sign-in; a TOTP code (or a recovery code)
 * replaces it with a real one (ADR 0014, ADR 0049).
 *
 * Every decision about an account is taken in a transaction that holds its lock (`inAccountTransaction`) and re-reads
 * what it depends on. Password hashing is slow and happens outside it, on a snapshot; the transaction then checks that
 * the user, the credential epoch and the password hash are still those of the snapshot before it acts on the result.
 * Wrong passwords only slow new sign-ins down. Pending factor checks have account and source limits; an active
 * session has a separate step-up budget and never loses its current elevation because a factor check failed.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly loginProofs = new WindowLimiter(
    LOGIN_PROOFS_PER_SOURCE,
    LOGIN_PROOF_WINDOW_MS,
    undefined,
    DEFAULT_LIMITER_KEYS,
    'evict-oldest',
  );
  private readonly currentPasswordFailures = new WindowLimiter(
    CURRENT_PASSWORD_ATTEMPTS,
    CURRENT_PASSWORD_WINDOW_MS,
  );
  private readonly passwordChangesInFlight = new Set<string>();

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthFailureNotes) private readonly failureNotes: AuthFailureNotes,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /**
   * Step one. Wrong credentials, unknown and disabled users answer alike, after a password hash each. A source that
   * sent too many wrong passwords for this account, or every source together, waits (429) before the next is checked;
   * the right password waits as well, so the answer says nothing about the guess.
   */
  async login(
    username: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession; next: AuthNextStep }> {
    const source = addressBucket(meta.ip);
    if (!this.loginProofs.hit(source)) {
      throw new RateLimitedException(this.loginProofs.retryAfterSeconds(source), WAIT_MESSAGE);
    }
    const snapshot = await this.db.user.findUnique({
      where: { username: username.trim().toLowerCase() },
      include: {
        credential: { include: { mfaSourceFailures: { where: { sourceBucket: source } } } },
        passwordSourceFailures: { where: { sourceBucket: source } },
      },
    });
    const credential = snapshot?.credential;
    if (!snapshot || !credential || snapshot.status !== 'active') {
      try {
        await this.hasher.verifyDummy(password);
      } catch (error) {
        if (error instanceof HasherBusyError) {
          this.failureNotes.suppress('unverified');
        }
        throw error;
      }
      this.logger.warn('sign-in refused: unknown or disabled account');
      // Nothing the caller typed goes into the record: people paste passwords into the name field.
      await this.failureNotes.note(
        {
          action: 'auth.login.failed',
          outcome: 'failure',
          actor: snapshot ? { id: snapshot.id, name: snapshot.username } : null,
          details: {
            reason: !snapshot ? 'unknown_account' : !credential ? 'no_credential' : 'disabled',
          },
          meta,
        },
        'unverified',
      );
      throw new UnauthorizedException('Invalid credentials.');
    }
    this.requireUnlockedFactor(credential.mfaSourceFailures[0] ?? null, new Date());
    // A denial read before the hash: it saves the work, and is checked again under the lock.
    const early = passwordWaitMs(
      passwordStateOf(credential),
      snapshot.passwordSourceFailures[0] ?? null,
      new Date(),
    );
    if (early > 0) {
      throw new RateLimitedException(retrySeconds(early), WAIT_MESSAGE);
    }
    const verified = await this.hasher.verify(credential.passwordHash, password);
    let rehashed: string | undefined;
    if (verified && this.hasher.needsRehash(credential.passwordHash)) {
      try {
        rehashed = await this.hasher.hash(password);
      } catch (error) {
        // A busy hasher skips the upgrade; the sign-in goes on with the hash that was verified.
        if (!(error instanceof HasherBusyError)) {
          throw error;
        }
      }
    }
    const outcome = await inAccountTransaction(this.db, snapshot.id, async (tx) => {
      const now = await databaseNow(tx);
      const user = await tx.user.findUnique({
        where: { id: snapshot.id },
        include: { credential: true },
      });
      const current = user?.credential;
      // A reset, a password change, disabling or an accepted invitation came in while the password was hashed: the
      // result belongs to credentials that are gone.
      if (
        !user ||
        !current ||
        user.status !== 'active' ||
        user.credentialEpoch !== snapshot.credentialEpoch ||
        current.passwordHash !== credential.passwordHash
      ) {
        return { kind: 'stale' } as const;
      }
      const sourceRow = await tx.passwordSourceFailure.findUnique({
        where: { userId_sourceBucket: { userId: user.id, sourceBucket: source } },
      });
      const wait = passwordWaitMs(passwordStateOf(current), sourceRow, now);
      if (wait > 0) {
        throw new RateLimitedException(retrySeconds(wait), WAIT_MESSAGE);
      }
      const factorState = await tx.mfaSourceFailure.findUnique({
        where: sourceKey(user.id, source),
      });
      this.requireUnlockedFactor(factorState, now);
      if (!verified) {
        const slowdownStarted = await this.countPasswordFailure(
          tx,
          current,
          sourceRow,
          source,
          now,
        );
        return { kind: 'wrong', user, slowdownStarted } as const;
      }
      if (rehashed !== undefined) {
        // Only over the hash that was verified: never over a newer one.
        await tx.credential.updateMany({
          where: { userId: user.id, passwordHash: credential.passwordHash },
          data: { passwordHash: rehashed },
        });
      }
      const session = await this.sessions.createInTransaction(
        tx,
        user.id,
        user.credentialEpoch,
        'password_verified',
        meta,
        now,
      );
      const next: AuthNextStep = current.totpConfirmedAt ? 'totp' : 'totp_enrollment';
      return { kind: 'issued', session, next } as const;
    });
    if (outcome.kind === 'stale') {
      throw new UnauthorizedException('Invalid credentials.');
    }
    if (outcome.kind === 'wrong') {
      this.logger.warn(`sign-in refused for user ${outcome.user.id}: wrong password`);
      if (outcome.slowdownStarted) {
        await this.audit.note({
          action: 'auth.password.throttled',
          outcome: 'failure',
          actor: { id: outcome.user.id, name: outcome.user.username },
          details: { failures: ACCOUNT_SLOWDOWN_FROM },
          meta,
        });
      }
      await this.failureNotes.note({
        action: 'auth.login.failed',
        outcome: 'failure',
        actor: { id: outcome.user.id, name: outcome.user.username },
        details: { reason: 'invalid_credentials' },
        meta,
      });
      throw new UnauthorizedException('Invalid credentials.');
    }
    await this.sessions.pruneExpired().catch(() => undefined);
    return { session: outcome.session, next: outcome.next };
  }

  /** Ends the session behind a cookie. A sign-out of a real session is recorded; one that never got that far is not. */
  async logout(token: string, meta: RequestMeta): Promise<void> {
    const ctx = await this.sessions.authenticate(token);
    await this.sessions.revokeToken(token);
    if (ctx?.stage === 'active') {
      await this.audit.note({
        action: 'auth.logout',
        outcome: 'success',
        actor: this.actorOf(ctx),
        meta,
      });
    }
  }

  /**
   * Elevates the signed-in session for the step-up window after the second factor was proved again: a code from the
   * authenticator or a recovery code, with a limit specific to this session (ADR 0049). A code is accepted
   * only for a later time step than the last one used, so the code that signed in cannot be replayed.
   */
  async stepUp(
    ctx: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<{ elevatedUntil: Date }> {
    return this.proveFactor(
      ctx,
      'active',
      'step_up',
      code,
      meta,
      async (tx, now, session, method) => {
        if (method === 'recovery_code') {
          await this.audit.record(
            {
              action: 'auth.recovery_code.used',
              outcome: 'success',
              actor: this.actorOf(ctx),
              meta,
            },
            tx,
          );
        }
        await this.audit.record(
          {
            action: 'auth.step_up.succeeded',
            outcome: 'success',
            actor: this.actorOf(ctx),
            details: { method },
            meta,
          },
          tx,
        );
        const elevatedUntil = new Date(
          Math.min(
            now.getTime() + this.config.stepUpMs,
            session.expiresAt.getTime(),
            session.absoluteExpiresAt.getTime(),
          ),
        );
        await tx.session.update({ where: { id: session.id }, data: { elevatedUntil } });
        return { elevatedUntil };
      },
    );
  }

  /**
   * Changes the password of the signed-in user. Needs the current one and an elevated session. A wrong current
   * password is limited per session and never counts towards the sign-in limits. The credential epoch moves on: every
   * other session ends, this one is carried over, and every live API token of the user is revoked.
   */
  async changePassword(
    ctx: AuthContext,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const limitKey = ctx.sessionId;
    if (
      this.passwordChangesInFlight.has(limitKey) ||
      this.passwordChangesInFlight.size >= DEFAULT_LIMITER_KEYS
    ) {
      throw new RateLimitedException(1, WAIT_MESSAGE);
    }
    this.passwordChangesInFlight.add(limitKey);
    try {
      await this.changePasswordSerially(ctx, currentPassword, newPassword, meta);
    } finally {
      this.passwordChangesInFlight.delete(limitKey);
    }
  }

  private async changePasswordSerially(
    ctx: AuthContext,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const limitKey = ctx.sessionId;
    this.requireCurrentPasswordBudget(limitKey);
    const credential = await this.db.credential.findUnique({ where: { userId: ctx.user.id } });
    if (!credential) {
      throw new UnauthorizedException('Authentication required.');
    }
    const verified = await this.hasher.verify(credential.passwordHash, currentPassword, 'session');
    this.requireCurrentPasswordBudget(limitKey);
    if (!verified) {
      if (!this.currentPasswordFailures.hit(limitKey)) {
        throw new RateLimitedException(
          this.currentPasswordFailures.retryAfterSeconds(limitKey),
          WAIT_MESSAGE,
        );
      }
      await this.failureNotes.note({
        action: 'auth.password.changed',
        outcome: 'failure',
        actor: this.actorOf(ctx),
        details: { reason: 'invalid_current_password' },
        meta,
      });
      throw new UnauthorizedException('The current password is not right.');
    }
    const passwordHash = await this.hasher.hash(newPassword, 'session');
    await inAccountTransaction(this.db, ctx.user.id, async (tx) => {
      this.requireCurrentPasswordBudget(limitKey);
      // Hashing is slow and happens outside the lock; under it, the session must still be signed in, elevated and of
      // the current epoch, and the password must still be the one that was checked.
      const now = await databaseNow(tx);
      const session = await this.sessions.requireLiveSession(tx, ctx, 'active', now);
      const current = await tx.credential.findUnique({ where: { userId: ctx.user.id } });
      if (current?.passwordHash !== credential.passwordHash) {
        throw new UnauthorizedException('Authentication required.');
      }
      if (!session.elevatedUntil || session.elevatedUntil.getTime() <= now.getTime()) {
        throw new StepUpRequiredException();
      }
      await tx.credential.update({
        where: { userId: ctx.user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          ...CLEARED_PASSWORD_FAILURES,
          ...CLEARED_PENDING_FACTOR_FAILURES,
        },
      });
      await tx.passwordSourceFailure.deleteMany({ where: { userId: ctx.user.id } });
      await tx.mfaSourceFailure.deleteMany({ where: { userId: ctx.user.id } });
      const epoch = await this.advanceEpoch(tx, ctx.user.id);
      // This session is carried over to the new epoch; every other one ends.
      await tx.session.update({
        where: { id: session.id },
        data: { credentialEpoch: epoch, ...CLEARED_STEP_UP_FAILURES },
      });
      await tx.session.deleteMany({ where: { userId: ctx.user.id, id: { not: session.id } } });
      const tokensRevoked = await revokeLiveApiTokens(tx, ctx.user.id, now);
      await this.audit.record(
        {
          action: 'auth.password.changed',
          outcome: 'success',
          actor: this.actorOf(ctx),
          details: { tokens_revoked: tokensRevoked },
          meta,
        },
        tx,
      );
    });
  }

  private requireCurrentPasswordBudget(sessionId: string): void {
    if (this.currentPasswordFailures.blocked(sessionId)) {
      throw new RateLimitedException(
        this.currentPasswordFailures.retryAfterSeconds(sessionId),
        WAIT_MESSAGE,
      );
    }
  }

  /** Step two: an authenticator code, or one recovery code. */
  async verifySecondStep(ctx: AuthContext, code: string, meta: RequestMeta): Promise<Completed> {
    return this.proveFactor(
      ctx,
      'password_verified',
      'sign_in',
      code,
      meta,
      async (tx, now, session, method) => {
        if (method === 'recovery_code') {
          // A code was used up: that is a change, so the record is not optional.
          await this.audit.record(
            {
              action: 'auth.recovery_code.used',
              outcome: 'success',
              actor: this.actorOf(ctx),
              meta,
            },
            tx,
          );
        }
        return this.completeSignIn(tx, ctx, session, now, meta, method);
      },
    );
  }

  /**
   * The secret to add to an authenticator. The first call of a pending session writes the proposal under the account
   * lock; every later call, also one that raced it, returns that same proposal until it is confirmed.
   */
  async startEnrollment(ctx: AuthContext, meta: RequestMeta): Promise<TotpEnrollment> {
    const secret = await inAccountTransaction(this.db, ctx.user.id, async (tx) => {
      const now = await databaseNow(tx);
      const session = await this.sessions.requireLiveSession(tx, ctx, 'password_verified', now);
      const sourceBucket = addressBucket(meta.ip);
      this.requirePendingSource(session, sourceBucket);
      const credential = await tx.credential.findUnique({ where: { userId: ctx.user.id } });
      if (!credential) {
        throw new UnauthorizedException('Authentication required.');
      }
      if (credential.totpConfirmedAt) {
        throw new ConflictException('The authenticator is already set up.');
      }
      const factorState = await tx.mfaSourceFailure.findUnique({
        where: sourceKey(ctx.user.id, sourceBucket),
      });
      this.requireUnlockedFactor(factorState, now);
      if (credential.totpSecret) {
        return this.box.open(credential.totpSecret, totpContext(ctx.user.id));
      }
      const fresh = generateTotpSecret();
      await tx.credential.update({
        where: { userId: ctx.user.id },
        // Prisma wants a plain Uint8Array for bytea; Buffer's backing store type is wider.
        data: { totpSecret: new Uint8Array(this.box.seal(fresh, totpContext(ctx.user.id))) },
      });
      return fresh;
    });
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(ISSUER, ctx.user.username, secret),
    };
  }

  /**
   * Proves the user holds the authenticator of the stored proposal, creates the recovery codes and finishes the
   * sign-in, all in one commit: the confirmation, the codes, the records and the new session stand or fall together.
   */
  async confirmEnrollment(ctx: AuthContext, code: string, meta: RequestMeta): Promise<Completed> {
    const recoveryCodes = newRecoveryCodes();
    const completed = await this.proveFactor(
      ctx,
      'password_verified',
      'enrollment',
      code,
      meta,
      async (tx, now, session) => {
        await tx.credential.update({
          where: { userId: ctx.user.id },
          data: { totpConfirmedAt: now },
        });
        await tx.recoveryCode.deleteMany({ where: { userId: ctx.user.id } });
        await tx.recoveryCode.createMany({
          data: recoveryCodes.map((c) => ({
            userId: ctx.user.id,
            codeHash: recoveryCodeHash(normalizeRecoveryCode(c) ?? c),
          })),
        });
        await this.audit.record(
          { action: 'auth.totp.enrolled', outcome: 'success', actor: this.actorOf(ctx), meta },
          tx,
        );
        return this.completeSignIn(tx, ctx, session, now, meta, 'enrollment');
      },
    );
    return { ...completed, recoveryCodes };
  }

  private actorOf(ctx: AuthContext): { id: string; name: string } {
    return { id: ctx.user.id, name: ctx.user.username };
  }

  /** Moves the credential epoch of a user on and returns the new value. Under the account lock. */
  private async advanceEpoch(tx: Prisma.TransactionClient, userId: string): Promise<bigint> {
    const user = await tx.user.update({
      where: { id: userId },
      data: { credentialEpoch: { increment: 1 } },
      select: { credentialEpoch: true },
    });
    return user.credentialEpoch;
  }

  /**
   * One proof of the second factor, from claim to answer, in one transaction under the account lock: the session is
   * re-read and must still be live and of the current epoch. Pending proofs use their source and aggregate budget;
   * active sessions use a separate budget. The proof and any lock transition commit with the related session changes.
   * `onSuccess` writes the rest of the change and its strict
   * records in the same transaction, so a failing record leaves the code unclaimed and nothing changed.
   */
  private async proveFactor<T>(
    ctx: AuthContext,
    stage: 'password_verified' | 'active',
    purpose: FactorPurpose,
    code: string,
    meta: RequestMeta,
    onSuccess: (
      tx: Prisma.TransactionClient,
      now: Date,
      session: LiveSession,
      method: FactorMethod,
    ) => Promise<T>,
  ): Promise<T> {
    const sourceBucket = addressBucket(meta.ip);
    const outcome = await inAccountTransaction(
      this.db,
      ctx.user.id,
      async (tx): Promise<FactorOutcome<T>> => {
        const now = await databaseNow(tx);
        const session = await this.sessions.requireLiveSession(tx, ctx, stage, now);
        const pending = stage === 'password_verified';
        if (pending) {
          this.requirePendingSource(session, sourceBucket);
        }
        const credential = await tx.credential.findUnique({ where: { userId: ctx.user.id } });
        if (!credential) {
          throw new UnauthorizedException('Authentication required.');
        }
        if (purpose === 'enrollment') {
          if (credential.totpConfirmedAt) {
            throw new ConflictException('The authenticator is already set up.');
          }
          if (!credential.totpSecret) {
            throw new ConflictException('Start the enrollment first.');
          }
        } else if (!credential.totpSecret || !credential.totpConfirmedAt) {
          // The authenticator was never confirmed: this session has to enroll, not verify.
          throw new ConflictException('The authenticator is not set up yet.');
        }
        const key = sourceKey(ctx.user.id, sourceBucket);
        const window = credential.pendingFactorWindowEndsAt;
        const pendingWindow = window && window > now ? window : null;
        const pendingFailures = pendingWindow ? credential.pendingFactorFailures : 0;
        if (
          pending &&
          pendingWindow &&
          pendingFailures >= this.config.lockoutAttempts * PENDING_FACTOR_LIMIT_MULTIPLIER
        ) {
          throw new RateLimitedException(
            retrySeconds(pendingWindow.getTime() - now.getTime()),
            WAIT_MESSAGE,
          );
        }
        const factorState = pending
          ? await tx.mfaSourceFailure.findUnique({ where: key })
          : {
              failures: session.stepUpFailures,
              windowEndsAt: session.stepUpWindowEndsAt,
              lockedUntil: session.stepUpLockedUntil,
            };
        this.requireUnlockedFactor(factorState, now);
        // Confirming an enrollment takes an authenticator code only; the others take a recovery code as well.
        const method: FactorMethod =
          purpose === 'enrollment' || looksLikeTotpCode(code) ? 'totp' : 'recovery_code';
        const accepted =
          method === 'totp'
            ? await this.claimTotp(tx, credential, code, now)
            : await this.claimRecoveryCode(tx, ctx.user.id, code, now);
        if (!accepted) {
          const next = afterMfaFailure(
            factorState,
            now,
            this.config.lockoutAttempts,
            this.config.lockoutMs,
          );
          if (pending) {
            await tx.credential.update({
              where: { userId: ctx.user.id },
              data: {
                pendingFactorFailures: pendingFailures + 1,
                pendingFactorWindowEndsAt: pendingWindow ?? new Date(now.getTime() + MFA_WINDOW_MS),
              },
            });
            if (factorState || (await this.makeFactorSlot(tx, ctx.user.id, now))) {
              await tx.mfaSourceFailure.upsert({
                where: key,
                create: { userId: ctx.user.id, sourceBucket, ...next.state },
                update: next.state,
              });
            }
            if (next.locked) {
              await tx.session.deleteMany({
                where: { userId: ctx.user.id, sourceBucket, stage: 'password_verified' },
              });
            }
          } else if (next.locked && (!session.elevatedUntil || session.elevatedUntil <= now)) {
            await tx.session.delete({ where: { id: session.id } });
          } else {
            await tx.session.update({
              where: { id: session.id },
              data: {
                stepUpFailures: next.state.failures,
                stepUpWindowEndsAt: next.state.windowEndsAt,
                stepUpLockedUntil: next.state.lockedUntil,
              },
            });
          }
          return {
            kind: 'refused',
            method: purpose === 'enrollment' ? 'enrollment' : method,
            locked: next.locked,
            failures: next.failures,
          };
        }
        if (pending && factorState) {
          await tx.mfaSourceFailure.deleteMany({ where: { userId: ctx.user.id, sourceBucket } });
        } else if (!pending) {
          await tx.session.update({ where: { id: session.id }, data: CLEARED_STEP_UP_FAILURES });
        }
        return { kind: 'accepted', value: await onSuccess(tx, now, session, method) };
      },
    );
    if (outcome.kind === 'accepted') {
      return outcome.value;
    }
    // The count and the lock are committed; the notes are best effort and cannot undo them.
    const failed: AuditAction =
      purpose === 'step_up' ? 'auth.step_up.failed' : 'auth.second_step.failed';
    this.logger.warn(
      `second factor refused for user ${ctx.user.id} (${String(outcome.failures)} in the window)`,
    );
    await this.failureNotes.note({
      action: failed,
      outcome: 'failure',
      actor: this.actorOf(ctx),
      details: { method: outcome.method },
      meta,
    });
    if (outcome.locked) {
      this.logger.warn(`second factor locked for ${purpose} of user ${ctx.user.id}`);
      // Refusals while the source or active session is locked are not recorded one by one.
      await this.audit.note({
        action: 'auth.account.locked',
        outcome: 'success',
        actor: this.actorOf(ctx),
        details: {
          failures: outcome.failures,
          minutes: Math.round(this.config.lockoutMs / 60_000),
        },
        meta,
      });
    }
    throw new UnauthorizedException('Invalid code.');
  }

  private requireUnlockedFactor(state: MfaState | null, now: Date): void {
    const wait = mfaLockMs(state, now);
    if (wait > 0) {
      throw new RateLimitedException(retrySeconds(wait), WAIT_MESSAGE);
    }
  }

  private requirePendingSource(session: LiveSession, sourceBucket: string): void {
    if (session.sourceBucket !== sourceBucket) {
      throw new UnauthorizedException('Authentication required.');
    }
  }

  /** Only a failure needs a slot. Never evict a live lock; the account counter still counts if all slots are locked. */
  private async makeFactorSlot(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    await tx.mfaSourceFailure.deleteMany({
      where: { userId, OR: [{ windowEndsAt: { lte: now } }, { lockedUntil: { lte: now } }] },
    });
    if ((await tx.mfaSourceFailure.count({ where: { userId } })) < MAX_SOURCE_ROWS) {
      return true;
    }
    const oldest = await tx.mfaSourceFailure.findFirst({
      where: { userId, lockedUntil: null },
      orderBy: [{ windowEndsAt: 'asc' }, { sourceBucket: 'asc' }],
      select: { sourceBucket: true },
    });
    if (!oldest) {
      return false;
    }
    await tx.mfaSourceFailure.delete({ where: sourceKey(userId, oldest.sourceBucket) });
    return true;
  }

  /** True when the code matches a later time step than the last one accepted; that step is claimed in `tx`. */
  private async claimTotp(
    tx: Prisma.TransactionClient,
    credential: Credential,
    code: string,
    now: Date,
  ): Promise<boolean> {
    if (!credential.totpSecret) {
      return false;
    }
    const secret = this.box.open(credential.totpSecret, totpContext(credential.userId));
    const step = verifyTotp({
      secret,
      code,
      nowMs: now.getTime(),
      lastStep: credential.totpLastStep,
    });
    if (step === null) {
      return false;
    }
    // Monotonic: the lock already serializes the claims, and the condition keeps it so even without it.
    const claimed = await tx.credential.updateMany({
      where: {
        userId: credential.userId,
        OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
      },
      data: { totpLastStep: step },
    });
    return claimed.count === 1;
  }

  private async claimRecoveryCode(
    tx: Prisma.TransactionClient,
    userId: string,
    input: string,
    now: Date,
  ): Promise<boolean> {
    const normalized = normalizeRecoveryCode(input);
    if (!normalized) {
      return false;
    }
    const used = await tx.recoveryCode.updateMany({
      where: { userId, codeHash: recoveryCodeHash(normalized), usedAt: null },
      data: { usedAt: now },
    });
    return used.count === 1;
  }

  /**
   * Finishes a sign-in in the caller's transaction: records it, consumes the password-verified session and issues an
   * active, elevated one (the second factor has just been proved, ADR 0017) at the current epoch. Nothing carries over.
   */
  private async completeSignIn(
    tx: Prisma.TransactionClient,
    ctx: AuthContext,
    pending: LiveSession,
    now: Date,
    meta: RequestMeta,
    method: FactorMethod | 'enrollment',
  ): Promise<Completed> {
    const user: User = await tx.user.update({
      where: { id: ctx.user.id },
      data: { lastLoginAt: now },
    });
    await this.audit.record(
      {
        action: 'auth.login.succeeded',
        outcome: 'success',
        actor: this.actorOf(ctx),
        details: { method },
        meta,
      },
      tx,
    );
    await tx.session.delete({ where: { id: pending.id } });
    const session = await this.sessions.createInTransaction(
      tx,
      ctx.user.id,
      user.credentialEpoch,
      'active',
      meta,
      now,
      { elevated: true },
    );
    this.logger.log(`sign-in completed for user ${ctx.user.id}`);
    return { session, user };
  }

  /**
   * Counts one admitted wrong password, account-wide and for its source, under the account lock. The per-source rows
   * of the account are kept to `MAX_SOURCE_ROWS` live ones: an expired row is removed before a new one is added, and a
   * further source counts only account-wide.
   */
  private async countPasswordFailure(
    tx: Prisma.TransactionClient,
    credential: Credential,
    sourceRow: SourceState | null,
    source: string,
    now: Date,
  ): Promise<boolean> {
    const userId = credential.userId;
    const account = afterPasswordFailure(passwordStateOf(credential), now);
    const slowdownStarted = account.failures === ACCOUNT_SLOWDOWN_FROM;
    await tx.credential.update({
      where: { userId },
      data: {
        passwordFailures: account.failures,
        passwordWindowEndsAt: account.windowEndsAt,
        passwordRetryAt: account.retryAt,
      },
    });
    const live = currentSource(sourceRow, now);
    if (live) {
      const next = afterSourceFailure(live, now);
      await tx.passwordSourceFailure.update({
        where: { userId_sourceBucket: { userId, sourceBucket: source } },
        data: { failures: next.failures, windowEndsAt: next.windowEndsAt },
      });
      return slowdownStarted;
    }
    await tx.passwordSourceFailure.deleteMany({ where: { userId, windowEndsAt: { lte: now } } });
    if ((await tx.passwordSourceFailure.count({ where: { userId } })) >= MAX_SOURCE_ROWS) {
      return slowdownStarted;
    }
    const next = afterSourceFailure(null, now);
    await tx.passwordSourceFailure.create({
      data: {
        userId,
        sourceBucket: source,
        failures: next.failures,
        windowEndsAt: next.windowEndsAt,
      },
    });
    return slowdownStarted;
  }
}
