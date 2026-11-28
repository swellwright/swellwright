import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { SetupOwnerRequest, SetupStatus } from '@swellwright/contracts';
import { type Database, UserRole } from '@swellwright/db';

import { type AppConfig } from '../config.js';
import { CONFIG, DATABASE, PASSWORD_HASHER } from '../tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { databaseNow, lockAccount } from './account-lock.js';
import { type RequestMeta, requireDatabase } from './context.js';
import { AuthFailureNotes } from './failure-notes.js';
import { PasswordHasher } from './password.js';
import { type IssuedSession, SessionService } from './session.service.js';
import { hashToken } from './tokens.js';

/** An arbitrary constant: one transaction at a time may create the first user. */
const SETUP_LOCK_KEY = 7_761_234;

/**
 * First-run setup: creates the instance owner once. A new instance is reachable from the network before
 * anyone owns it, so the call needs a token only the operator of the host can read: the one printed to the
 * log at start (or `SW_SETUP_TOKEN`).
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Setup');
  private token: string | undefined;

  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthFailureNotes) private readonly failureNotes: AuthFailureNotes,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.database) {
      return;
    }
    // A database that cannot be reached yet must not stop the process: /ready reports it.
    let initialized: boolean;
    try {
      initialized = await this.isInitialized();
    } catch {
      return;
    }
    if (!initialized) {
      this.ensureToken();
    }
  }

  /** Makes the setup token (from the configuration or a random one) and tells the operator where to find it. */
  private ensureToken(): void {
    if (this.token !== undefined) {
      return;
    }
    this.token = this.config.setupToken ?? randomBytes(24).toString('base64url');
    if (!this.config.silent) {
      this.logger.warn(
        this.config.setupToken
          ? 'No instance owner yet. Open the console and enter the setup token from SW_SETUP_TOKEN.'
          : `No instance owner yet. Open the console and enter this setup token: ${this.token}`,
      );
    }
  }

  async status(): Promise<SetupStatus> {
    return { initialized: await this.isInitialized() };
  }

  async createOwner(
    request: SetupOwnerRequest,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession }> {
    const db = requireDatabase(this.database).client;
    // The budget per source (ten per quarter hour) is the guard's (`AuthAttemptGuard`), before this runs.
    if (await this.isInitialized()) {
      throw new ConflictException('The instance is already set up.');
    }
    // The database was down at start: the token is made now, and printed, on the first attempt.
    this.ensureToken();
    if (!this.tokenMatches(request.setupToken)) {
      this.logger.warn('setup refused: wrong token');
      // At most 10 attempts per source and quarter hour get this far, under the process-wide budget of failure notes.
      await this.failureNotes.note({
        action: 'setup.owner.refused',
        outcome: 'failure',
        details: { reason: 'invalid_token' },
        meta,
      });
      throw new ForbiddenException('Invalid setup token.');
    }
    const passwordHash = await this.hasher.hash(request.password);
    const { userId, session } = await db.$transaction(async (tx) => {
      // Two requests that both passed the check above must not both create an owner.
      // $executeRaw: the function returns void, which a $queryRaw result cannot represent.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`;
      if ((await tx.user.count()) > 0) {
        throw new ConflictException('The instance is already set up.');
      }
      const user = await tx.user.create({
        data: {
          username: request.username,
          role: UserRole.owner,
          credential: { create: { passwordHash } },
        },
      });
      // The owner was made in this transaction, so no other one can hold its lock yet; taken all the same, in the
      // order every other path uses.
      await lockAccount(tx, user.id);
      // The owner and the record of the owner stand or fall together.
      await this.audit.record(
        {
          action: 'setup.owner.created',
          outcome: 'success',
          actor: { id: user.id, name: user.username },
          object: { type: 'user', id: user.id },
          meta,
        },
        tx,
      );
      // The owner, the record and the session that goes on to the authenticator stand or fall together.
      const issued = await this.sessions.createInTransaction(
        tx,
        user.id,
        user.credentialEpoch,
        'password_verified',
        meta,
        await databaseNow(tx),
      );
      return { userId: user.id, session: issued };
    });
    this.token = undefined;
    this.logger.log(`instance owner created (user ${userId})`);
    return { session };
  }

  private async isInitialized(): Promise<boolean> {
    return (await requireDatabase(this.database).client.user.count()) > 0;
  }

  private tokenMatches(given: string): boolean {
    if (this.token === undefined) {
      return false;
    }
    // Hashing makes both sides the same length, so the comparison does not leak the token's length.
    return timingSafeEqual(Buffer.from(hashToken(given)), Buffer.from(hashToken(this.token)));
  }
}
