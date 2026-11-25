import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthNextStep, TotpEnrollment } from '@swellwright/contracts';
import { type Credential, type Database, SessionStage } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { type AppConfig } from '../config.js';
import { RateLimitedException, StepUpRequiredException } from '../http.js';
import { CONFIG, DATABASE, PASSWORD_HASHER, SECRET_BOX } from '../tokens.js';
import { lockAccount } from './account-lock.js';
import { type AuthContext, type RequestMeta, requireDatabase } from './context.js';
import { PasswordHasher } from './password.js';
import { WindowLimiter } from './rate-limit.js';
import { SecretBox } from './secret-box.js';
import { type IssuedSession, SessionService } from './session.service.js';
import { revokeLiveApiTokens } from './token.service.js';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import {
  looksLikeTotpCode,
  newRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
} from './tokens.js';

const ISSUER = 'Swellwright';
const LOGIN_ATTEMPTS_PER_ADDRESS = 30;
const LOGIN_WINDOW_MS = 5 * 60_000;
/**
 * Sign-ins for accounts that do not exist or are disabled are written to the audit chain at most this often
 * per address. The chain is never pruned, and a caller who is not signed in must not be able to grow it
 * without bound. The server log still has every one.
 */
const UNKNOWN_ACCOUNT_EVENTS_PER_ADDRESS = 10;
const UNKNOWN_ACCOUNT_WINDOW_MS = 15 * 60_000;

export interface Completed {
  readonly session: IssuedSession;
  readonly user: AuthContext['user'];
  readonly recoveryCodes?: readonly string[];
}

/** The context that binds a sealed TOTP secret to its owner and purpose. */
const totpContext = (userId: string): string => `swellwright:totp:v1:${userId}`;

/**
 * Sign-in in two steps: a password makes a session that can only finish the sign-in; a TOTP code (or a
 * recovery code) replaces it with a real one. Failures of either step count towards one lockout.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly loginLimiter = new WindowLimiter(LOGIN_ATTEMPTS_PER_ADDRESS, LOGIN_WINDOW_MS);
  private readonly unknownAccountEvents = new WindowLimiter(
    UNKNOWN_ACCOUNT_EVENTS_PER_ADDRESS,
    UNKNOWN_ACCOUNT_WINDOW_MS,
  );

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  /** Step one. Wrong credentials and unknown users answer alike, after the same amount of work. */
  async login(
    username: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession; next: AuthNextStep }> {
    if (!this.loginLimiter.hit(meta.ip ?? 'unknown')) {
      throw new RateLimitedException(Math.ceil(LOGIN_WINDOW_MS / 1000));
    }
    const user = await this.db.user.findUnique({
      where: { username: username.trim().toLowerCase() },
      include: { credential: true },
    });
    const credential = user?.credential;
    if (!user || !credential || user.status !== 'active') {
      await this.hasher.verifyDummy(password);
      this.logger.warn('sign-in refused: unknown or disabled account');
      // Nothing the caller typed goes into the record: people paste passwords into the name field.
      if (this.unknownAccountEvents.hit(meta.ip ?? 'unknown')) {
        await this.audit.note({
          action: 'auth.login.failed',
          outcome: 'failure',
          actor: user ? { id: user.id, name: user.username } : null,
          details: {
            reason: !user ? 'unknown_account' : !credential ? 'no_credential' : 'disabled',
          },
          meta,
        });
      }
      throw new UnauthorizedException('Invalid credentials.');
    }
    this.assertNotLocked(credential.lockedUntil);
    if (!(await this.hasher.verify(credential.passwordHash, password))) {
      await this.audit.note({
        action: 'auth.login.failed',
        outcome: 'failure',
        actor: { id: user.id, name: user.username },
        details: { reason: 'invalid_credentials' },
        meta,
      });
      await this.registerFailure(user, meta);
      throw new UnauthorizedException('Invalid credentials.');
    }
    if (this.hasher.needsRehash(credential.passwordHash)) {
      await this.db.credential.update({
        where: { userId: user.id },
        data: { passwordHash: await this.hasher.hash(password) },
      });
    }
    const session = await this.sessions.create(user.id, SessionStage.password_verified, meta);
    return { session, next: credential.totpConfirmedAt ? 'totp' : 'totp_enrollment' };
  }

  /** Ends the session behind a cookie. A sign-out of a real session is recorded; one that never got that far is not. */
  async logout(token: string, meta: RequestMeta): Promise<void> {
    const ctx = await this.sessions.authenticate(token);
    await this.sessions.revokeToken(token);
    if (ctx?.stage === SessionStage.active) {
      await this.audit.note({
        action: 'auth.logout',
        outcome: 'success',
        actor: this.actorOf(ctx),
        meta,
      });
    }
  }

  /**
   * Elevates the signed-in session for the step-up window after the second factor was proved again: a code
   * from the authenticator or a recovery code, under the same lockout as at sign-in (ADR 0017). A code is
   * accepted only for a later time step than the last one used, so the code that signed in cannot be replayed.
   */
  async stepUp(
    ctx: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<{ elevatedUntil: Date }> {
    const credential = await this.credentialOf(ctx);
    if (!credential.totpSecret || !credential.totpConfirmedAt) {
      throw new ConflictException('The authenticator is not set up yet.');
    }
    this.assertNotLocked(credential.lockedUntil);
    const method = looksLikeTotpCode(code) ? 'totp' : 'recovery_code';
    const accepted =
      method === 'totp'
        ? await this.acceptTotp(ctx.user.id, credential.totpSecret, credential.totpLastStep, code)
        : await this.acceptRecoveryCode(ctx.user.id, code);
    if (!accepted) {
      await this.audit.note({
        action: 'auth.step_up.failed',
        outcome: 'failure',
        actor: this.actorOf(ctx),
        details: { method },
        meta,
      });
      await this.registerFailure(ctx.user, meta);
      throw new UnauthorizedException('Invalid code.');
    }
    if (method === 'recovery_code') {
      await this.audit.record({
        action: 'auth.recovery_code.used',
        outcome: 'success',
        actor: this.actorOf(ctx),
        meta,
      });
    }
    // Recorded before the elevation exists: without a record there is no elevation.
    await this.audit.record({
      action: 'auth.step_up.succeeded',
      outcome: 'success',
      actor: this.actorOf(ctx),
      details: { method },
      meta,
    });
    await this.db.credential.update({
      where: { userId: ctx.user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    return { elevatedUntil: await this.sessions.elevate(ctx.sessionId) };
  }

  /**
   * Changes the password of the signed-in user. Needs the current one and an elevated session; a wrong one counts
   * towards the lockout. The other sessions of the user end, this one stays, and every live API token of the user
   * is revoked.
   */
  async changePassword(
    ctx: AuthContext,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const credential = await this.credentialOf(ctx);
    this.assertNotLocked(credential.lockedUntil);
    if (!(await this.hasher.verify(credential.passwordHash, currentPassword))) {
      await this.audit.note({
        action: 'auth.password.changed',
        outcome: 'failure',
        actor: this.actorOf(ctx),
        details: { reason: 'invalid_current_password' },
        meta,
      });
      await this.registerFailure(ctx.user, meta);
      throw new UnauthorizedException('The current password is not right.');
    }
    const passwordHash = await this.hasher.hash(newPassword);
    await this.db.$transaction(async (tx) => {
      // Hashing is slow and happens outside the lock; under it, the session must still be signed in and elevated
      // and the password must still be the one that was checked, or a reset or another change came in between.
      await lockAccount(tx, ctx.user.id);
      const now = new Date();
      const session = await tx.session.findUnique({
        where: { id: ctx.sessionId },
        include: { user: { include: { credential: true } } },
      });
      if (!session) {
        throw new UnauthorizedException('Authentication required.');
      }
      if (
        session.userId !== ctx.user.id ||
        session.stage !== SessionStage.active ||
        session.expiresAt.getTime() <= now.getTime() ||
        session.absoluteExpiresAt.getTime() <= now.getTime() ||
        session.user.status !== 'active' ||
        session.user.credential?.passwordHash !== credential.passwordHash
      ) {
        throw new UnauthorizedException('Authentication required.');
      }
      if (!session.elevatedUntil || session.elevatedUntil.getTime() <= now.getTime()) {
        throw new StepUpRequiredException();
      }
      await tx.credential.update({
        where: { userId: ctx.user.id },
        data: { passwordHash, passwordChangedAt: now, failedAttempts: 0, lockedUntil: null },
      });
      await tx.session.deleteMany({ where: { userId: ctx.user.id, id: { not: ctx.sessionId } } });
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

  /** Starts a password-verified session for an account created in the setup. */
  async startPending(userId: string, meta: RequestMeta): Promise<IssuedSession> {
    return this.sessions.create(userId, SessionStage.password_verified, meta);
  }

  /** Step two: an authenticator code, or one recovery code. */
  async verifySecondStep(ctx: AuthContext, code: string, meta: RequestMeta): Promise<Completed> {
    const credential = await this.credentialOf(ctx);
    if (!credential.totpSecret || !credential.totpConfirmedAt) {
      // The authenticator was never confirmed: this session has to enroll, not verify.
      throw new ConflictException('The authenticator is not set up yet.');
    }
    this.assertNotLocked(credential.lockedUntil);
    const method = looksLikeTotpCode(code) ? 'totp' : 'recovery_code';
    const accepted =
      method === 'totp'
        ? await this.acceptTotp(ctx.user.id, credential.totpSecret, credential.totpLastStep, code)
        : await this.acceptRecoveryCode(ctx.user.id, code);
    if (!accepted) {
      await this.audit.note({
        action: 'auth.second_step.failed',
        outcome: 'failure',
        actor: this.actorOf(ctx),
        details: { method },
        meta,
      });
      await this.registerFailure(ctx.user, meta);
      throw new UnauthorizedException('Invalid code.');
    }
    if (method === 'recovery_code') {
      // A code was used up: that is a change, so the record is not optional.
      await this.audit.record({
        action: 'auth.recovery_code.used',
        outcome: 'success',
        actor: this.actorOf(ctx),
        meta,
      });
    }
    return this.complete(ctx, meta, method);
  }

  /** The secret to add to an authenticator. The same secret is returned until it is confirmed. */
  async startEnrollment(ctx: AuthContext): Promise<TotpEnrollment> {
    const credential = await this.credentialOf(ctx);
    if (credential.totpConfirmedAt) {
      throw new ConflictException('The authenticator is already set up.');
    }
    let secret: Buffer;
    if (credential.totpSecret) {
      secret = this.box.open(credential.totpSecret, totpContext(ctx.user.id));
    } else {
      secret = generateTotpSecret();
      await this.db.credential.update({
        where: { userId: ctx.user.id },
        // Prisma wants a plain Uint8Array for bytea; Buffer's backing store type is wider.
        data: { totpSecret: new Uint8Array(this.box.seal(secret, totpContext(ctx.user.id))) },
      });
    }
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(ISSUER, ctx.user.username, secret),
    };
  }

  /** Proves the user holds the authenticator, creates the recovery codes and finishes the sign-in. */
  async confirmEnrollment(ctx: AuthContext, code: string, meta: RequestMeta): Promise<Completed> {
    const credential = await this.credentialOf(ctx);
    if (credential.totpConfirmedAt) {
      throw new ConflictException('The authenticator is already set up.');
    }
    if (!credential.totpSecret) {
      throw new ConflictException('Start the enrollment first.');
    }
    this.assertNotLocked(credential.lockedUntil);
    const accepted = await this.acceptTotp(
      ctx.user.id,
      credential.totpSecret,
      credential.totpLastStep,
      code,
    );
    if (!accepted) {
      await this.audit.note({
        action: 'auth.second_step.failed',
        outcome: 'failure',
        actor: this.actorOf(ctx),
        details: { method: 'enrollment' },
        meta,
      });
      await this.registerFailure(ctx.user, meta);
      throw new UnauthorizedException('Invalid code.');
    }
    const recoveryCodes = newRecoveryCodes();
    await this.db.$transaction([
      this.db.credential.update({
        where: { userId: ctx.user.id },
        data: { totpConfirmedAt: new Date() },
      }),
      this.db.recoveryCode.deleteMany({ where: { userId: ctx.user.id } }),
      this.db.recoveryCode.createMany({
        data: recoveryCodes.map((c) => ({
          userId: ctx.user.id,
          codeHash: recoveryCodeHash(normalizeRecoveryCode(c) ?? c),
        })),
      }),
    ]);
    await this.audit.record({
      action: 'auth.totp.enrolled',
      outcome: 'success',
      actor: this.actorOf(ctx),
      meta,
    });
    return { ...(await this.complete(ctx, meta, 'enrollment')), recoveryCodes };
  }

  private actorOf(ctx: AuthContext): { id: string; name: string } {
    return { id: ctx.user.id, name: ctx.user.username };
  }

  private async credentialOf(ctx: AuthContext): Promise<Credential> {
    const credential = await this.db.credential.findUnique({ where: { userId: ctx.user.id } });
    if (!credential) {
      throw new UnauthorizedException('Invalid session.');
    }
    return credential;
  }

  /** True when the code matches a later time step than the last one accepted. Records the step atomically. */
  private async acceptTotp(
    userId: string,
    sealed: Uint8Array,
    lastStep: number | null,
    code: string,
  ): Promise<boolean> {
    const secret = this.box.open(sealed, totpContext(userId));
    const step = verifyTotp({ secret, code, nowMs: Date.now(), lastStep });
    if (step === null) {
      return false;
    }
    // Two requests with the same code race here; only one may move the step forward.
    const claimed = await this.db.credential.updateMany({
      where: { userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return claimed.count === 1;
  }

  private async acceptRecoveryCode(userId: string, input: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(input);
    if (!normalized) {
      return false;
    }
    const used = await this.db.recoveryCode.updateMany({
      where: { userId, codeHash: recoveryCodeHash(normalized), usedAt: null },
      data: { usedAt: new Date() },
    });
    return used.count === 1;
  }

  private async complete(
    ctx: AuthContext,
    meta: RequestMeta,
    method: 'totp' | 'recovery_code' | 'enrollment',
  ): Promise<Completed> {
    const now = new Date();
    await this.db.credential.update({
      where: { userId: ctx.user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    const user = await this.db.user.update({
      where: { id: ctx.user.id },
      data: { lastLoginAt: now },
    });
    // Recorded before the session exists: without a record there is no session.
    await this.audit.record({
      action: 'auth.login.succeeded',
      outcome: 'success',
      actor: this.actorOf(ctx),
      details: { method },
      meta,
    });
    // The password-verified session is replaced by a new one: nothing carries over. The second factor has
    // just been proved, so the new session starts elevated (ADR 0017).
    const session = await this.sessions.create(ctx.user.id, SessionStage.active, meta, {
      elevated: true,
    });
    await this.sessions.revokeSession(ctx.sessionId);
    this.logger.log(`sign-in completed for user ${ctx.user.id}`);
    return { session, user };
  }

  private assertNotLocked(lockedUntil: Date | null): void {
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new RateLimitedException(
        Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
        'Too many failed attempts. Try again later.',
      );
    }
  }

  /** Counts a failed step; at the limit the account locks and every session of the user ends. */
  private async registerFailure(
    user: { readonly id: string; readonly username: string },
    meta: RequestMeta,
  ): Promise<void> {
    const userId = user.id;
    const updated = await this.db.credential.update({
      where: { userId },
      data: { failedAttempts: { increment: 1 } },
    });
    this.logger.warn(`sign-in step failed for user ${userId} (${String(updated.failedAttempts)})`);
    if (updated.failedAttempts >= this.config.lockoutAttempts) {
      await this.db.credential.update({
        where: { userId },
        data: { failedAttempts: 0, lockedUntil: new Date(Date.now() + this.config.lockoutMs) },
      });
      await this.sessions.revokeAllOf(userId);
      this.logger.warn(`account of user ${userId} locked`);
      // Refusals while the account is locked are not recorded one by one; this event is the one that counts.
      await this.audit.note({
        action: 'auth.account.locked',
        outcome: 'success',
        actor: { id: user.id, name: user.username },
        details: {
          failures: updated.failedAttempts,
          minutes: Math.round(this.config.lockoutMs / 60_000),
        },
        meta,
      });
    }
  }
}
