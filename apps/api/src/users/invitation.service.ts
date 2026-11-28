import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type Database } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { databaseNow, inAccountTransaction } from '../auth/account-lock.js';
import { type RequestMeta, requireDatabase } from '../auth/context.js';
import { PasswordHasher } from '../auth/password.js';
import { type IssuedSession, SessionService } from '../auth/session.service.js';
import { hashToken } from '../auth/tokens.js';
import { DATABASE, PASSWORD_HASHER } from '../tokens.js';

const INVALID = 'This invitation is not valid.';

/** Turns an invitation token into a password and a session that still has to set up the authenticator. */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * An unknown, used, replaced or expired token, and a disabled user, all answer the same 401. The password is hashed
   * outside any lock, on a snapshot of the invitation; then, under the account lock, that exact invitation must still be
   * there, unexpired, for an active user at the same credential epoch (ADR 0049). It is claimed by deleting its row,
   * the credential is replaced, the epoch moves on (every older session ends) and the pending session is issued, all in
   * one commit. A reset that came in while the password was hashed therefore wins. The token is never logged. The
   * budget per source (ten per quarter hour) is the guard's (`AuthAttemptGuard`).
   */
  async accept(
    token: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession }> {
    const db = requireDatabase(this.database).client;
    const tokenHash = hashToken(token);
    const snapshot = await db.invitation.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (
      !snapshot ||
      snapshot.expiresAt.getTime() <= Date.now() ||
      snapshot.user.status !== 'active'
    ) {
      throw new UnauthorizedException(INVALID);
    }
    const passwordHash = await this.hasher.hash(password);
    const { user } = snapshot;
    const session = await inAccountTransaction(db, user.id, async (tx) => {
      const now = await databaseNow(tx);
      const current = await tx.invitation.findUnique({
        where: { id: snapshot.id },
        include: { user: true },
      });
      if (
        current?.tokenHash !== tokenHash ||
        current.userId !== user.id ||
        current.expiresAt.getTime() <= now.getTime() ||
        current.user.status !== 'active' ||
        current.user.credentialEpoch !== user.credentialEpoch
      ) {
        throw new UnauthorizedException(INVALID);
      }
      const claimed = await tx.invitation.deleteMany({ where: { id: snapshot.id, tokenHash } });
      if (claimed.count !== 1) {
        throw new UnauthorizedException(INVALID);
      }
      // A fresh start: whatever credential there was belongs to the person the invitation replaces.
      await tx.credential.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.passwordSourceFailure.deleteMany({ where: { userId: user.id } });
      await tx.credential.create({ data: { userId: user.id, passwordHash } });
      const { credentialEpoch } = await tx.user.update({
        where: { id: user.id },
        data: { credentialEpoch: { increment: 1 } },
        select: { credentialEpoch: true },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await this.audit.record(
        {
          action: 'auth.invitation.accepted',
          outcome: 'success',
          actor: { id: user.id, name: user.username },
          object: { type: 'user', id: user.id },
          details: { purpose: snapshot.purpose },
          meta,
        },
        tx,
      );
      return this.sessions.createInTransaction(
        tx,
        user.id,
        credentialEpoch,
        'password_verified',
        meta,
        now,
      );
    });
    return { session };
  }
}
