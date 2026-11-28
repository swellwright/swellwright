import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type CreateUserRequest,
  type UpdateUserRequest,
  type UserSummary,
  USER_PAGE_DEFAULT,
  type UserInvitation,
  type UserList,
  type UserListQuery,
  type UserView,
} from '@swellwright/contracts';
import { type Database, Prisma, type User } from '@swellwright/db';

import { AuditService } from '../audit/audit.service.js';
import { databaseNow, inAccountTransaction, lockAccount } from '../auth/account-lock.js';
import { type RequestMeta, requireDatabase, toUserSummary } from '../auth/context.js';
import { CLEARED_PASSWORD_FAILURES, CLEARED_PENDING_FACTOR_FAILURES } from '../auth/throttle.js';
import { revokeLiveApiTokens } from '../auth/token.service.js';
import { DATABASE } from '../tokens.js';
import { issueInvitation, pruneExpiredInvitations } from './invitations.js';

/** An arbitrary constant: one transaction at a time may change who the users are and what they are. */
const USERS_LOCK_KEY = 7_761_236;
const lockUsers = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(${USERS_LOCK_KEY})`;

/** Who did it. Null for the server command, which has no signed-in user. */
export type Actor = { readonly id: string; readonly name: string } | null;

type UserRow = User & {
  credential: { totpConfirmedAt: Date | null } | null;
  invitation: { expiresAt: Date } | null;
};

const WITH_SETUP = {
  credential: { select: { totpConfirmedAt: true } },
  invitation: { select: { expiresAt: true } },
} as const;

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    state:
      row.status === 'disabled'
        ? 'disabled'
        : row.credential?.totpConfirmedAt
          ? 'active'
          : 'invited',
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    invitationExpiresAt: row.invitation?.expiresAt.toISOString() ?? null,
  };
}

/**
 * An owner who can sign in and act now: active, with a confirmed authenticator (the same mark that makes the
 * console show the account as `active`). An owner who was invited but never finished the sign-in cannot.
 */
function isEnrolledActiveOwner(row: UserRow): boolean {
  return row.role === 'owner' && row.status === 'active' && row.credential?.totpConfirmedAt != null;
}

/** Refuses with 409 when no enrolled active owner other than `id` would remain. Run under `USERS_LOCK_KEY`. */
async function assertAnotherEnrolledOwner(
  tx: Pick<Database['client'], 'user'>,
  id: string,
): Promise<void> {
  const others = await tx.user.count({
    where: {
      role: 'owner',
      status: 'active',
      id: { not: id },
      credential: { is: { totpConfirmedAt: { not: null } } },
    },
  });
  if (others === 0) {
    throw new ConflictException('There must be at least one enrolled active owner.');
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Creating, changing and recovering users (ADR 0016). Every change and its audit record are one transaction.
 * Changes are serialized under an advisory lock so the rule "there is always an active owner" cannot be
 * beaten by two requests at once.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get db(): Database['client'] {
    return requireDatabase(this.database).client;
  }

  async list(query: UserListQuery): Promise<UserList> {
    const limit = query.limit ?? USER_PAGE_DEFAULT;
    const rows = await this.db.user.findMany({
      where: query.cursor === undefined ? {} : { id: { gt: query.cursor } },
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: WITH_SETUP,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      users: page.map(toUserView),
      nextCursor: rows.length > limit && last ? last.id : null,
    };
  }

  /** Creates the account without a password and returns the invitation to set one. */
  async create(
    actor: NonNullable<Actor>,
    request: CreateUserRequest,
    meta: RequestMeta,
  ): Promise<UserInvitation> {
    try {
      const { id, invitation } = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USERS_LOCK_KEY})`;
        const user = await tx.user.create({
          data: {
            username: request.username,
            role: request.role,
            ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
            ...(request.email === undefined ? {} : { email: request.email.toLowerCase() }),
          },
        });
        const invite = await issueInvitation(tx, user.id, 'invite', actor.id);
        await this.audit.record(
          {
            action: 'user.created',
            outcome: 'success',
            actor,
            object: { type: 'user', id: user.id },
            details: { role: user.role },
            meta,
          },
          tx,
        );
        return { id: user.id, invitation: invite };
      });
      await pruneExpiredInvitations(this.db).catch(() => undefined);
      return { user: await this.view(id), invitation };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('That login name or e-mail address is already taken.');
      }
      throw error;
    }
  }

  async update(
    actor: NonNullable<Actor>,
    id: string,
    body: UpdateUserRequest,
    meta: RequestMeta,
  ): Promise<UserView> {
    try {
      await inAccountTransaction(
        this.db,
        id,
        async (tx) => {
          const now = await databaseNow(tx);
          const target = await tx.user.findUnique({ where: { id }, include: WITH_SETUP });
          if (!target) {
            throw new NotFoundException('There is no such user.');
          }
          const roleChanges = body.role !== undefined && body.role !== target.role;
          const statusChanges = body.status !== undefined && body.status !== target.status;
          if (id === actor.id && (roleChanges || statusChanges)) {
            throw new ConflictException('You cannot change your own role or status.');
          }
          const staysActiveOwner =
            (body.role ?? target.role) === 'owner' && (body.status ?? target.status) === 'active';
          if (isEnrolledActiveOwner(target) && !staysActiveOwner) {
            await assertAnotherEnrolledOwner(tx, id);
          }

          const data: Prisma.UserUpdateInput = {};
          const changed: string[] = [];
          const details: Record<string, string> = {};
          if (roleChanges && body.role !== undefined) {
            data.role = body.role;
            changed.push('role');
            details['role_from'] = target.role;
            details['role_to'] = body.role;
          }
          if (statusChanges && body.status !== undefined) {
            data.status = body.status;
            changed.push('status');
            details['status_from'] = target.status;
            details['status_to'] = body.status;
          }
          if (body.displayName !== undefined && body.displayName !== target.displayName) {
            data.displayName = body.displayName;
            changed.push('display_name');
          }
          const email = body.email === undefined ? undefined : (body.email?.toLowerCase() ?? null);
          if (email !== undefined && email !== target.email) {
            data.email = email;
            changed.push('email');
          }
          if (changed.length === 0) {
            return;
          }
          await tx.user.update({ where: { id }, data });
          let tokensRevoked: number | undefined;
          if (body.status === 'disabled' && statusChanges) {
            // A disabled user is refused on the next request anyway; the epoch moves on, so a sign-in still in flight
            // cannot leave a session behind (ADR 0049), the rows go, the failure counts start over, and the API tokens
            // are revoked for good, so enabling the account again does not bring them back.
            await tx.user.update({ where: { id }, data: { credentialEpoch: { increment: 1 } } });
            await tx.session.deleteMany({ where: { userId: id } });
            await tx.credential.updateMany({
              where: { userId: id },
              data: { ...CLEARED_PASSWORD_FAILURES, ...CLEARED_PENDING_FACTOR_FAILURES },
            });
            await tx.passwordSourceFailure.deleteMany({ where: { userId: id } });
            await tx.mfaSourceFailure.deleteMany({ where: { userId: id } });
            tokensRevoked = await revokeLiveApiTokens(tx, id, now);
          }
          await this.audit.record(
            {
              action: 'user.updated',
              outcome: 'success',
              actor,
              object: { type: 'user', id },
              details: {
                changed: changed.join(','),
                ...details,
                ...(tokensRevoked === undefined ? {} : { tokens_revoked: tokensRevoked }),
              },
              meta,
            },
            tx,
          );
        },
        lockUsers,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('That e-mail address is already taken.');
      }
      throw error;
    }
    return this.view(id);
  }

  /**
   * Deletes the password, the authenticator, the recovery codes and every session of the user, and returns a
   * new invitation. The old credentials stop working at once. A signed-in owner cannot do this to themselves
   * (they change their password, or use the server command when everything is lost); the server command
   * passes no actor.
   */
  async resetCredentials(
    actor: Actor,
    id: string,
    meta: RequestMeta,
    via: 'console' | 'cli',
  ): Promise<UserInvitation> {
    const invitation = await inAccountTransaction(
      this.db,
      id,
      async (tx) => {
        const now = await databaseNow(tx);
        const target = await tx.user.findUnique({ where: { id }, include: WITH_SETUP });
        if (!target) {
          throw new NotFoundException('There is no such user.');
        }
        if (actor?.id === id) {
          throw new ConflictException(
            'You cannot reset your own credentials here. Change your password.',
          );
        }
        // A reset removes the authenticator, so it can take away the last owner who can sign in. The server command
        // (no actor) stays the way back in when that owner has lost everything.
        if (via === 'console' && isEnrolledActiveOwner(target)) {
          await assertAnotherEnrolledOwner(tx, id);
        }
        // The epoch moves on first: whatever proof of the old credentials is still in flight (a sign-in, an invitation
        // being accepted, a second step) finds it changed under the same lock and issues nothing (ADR 0049).
        await tx.user.update({ where: { id }, data: { credentialEpoch: { increment: 1 } } });
        await tx.credential.deleteMany({ where: { userId: id } });
        await tx.recoveryCode.deleteMany({ where: { userId: id } });
        await tx.session.deleteMany({ where: { userId: id } });
        await tx.passwordSourceFailure.deleteMany({ where: { userId: id } });
        const tokensRevoked = await revokeLiveApiTokens(tx, id, now);
        const invite = await issueInvitation(tx, id, 'reset', actor?.id ?? null, now);
        await this.audit.record(
          {
            action: 'user.credentials.reset',
            outcome: 'success',
            actor,
            object: { type: 'user', id },
            details: { via, tokens_revoked: tokensRevoked },
            meta,
          },
          tx,
        );
        return invite;
      },
      lockUsers,
    );
    await pruneExpiredInvitations(this.db).catch(() => undefined);
    return { user: await this.view(id), invitation };
  }

  /** The id of a user by login name, or null. For the server command. */
  async idOf(username: string): Promise<string | null> {
    const user = await this.db.user.findUnique({
      where: { username: username.trim().toLowerCase() },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  private async view(id: string): Promise<UserView> {
    const row = await this.db.user.findUniqueOrThrow({ where: { id }, include: WITH_SETUP });
    return toUserView(row);
  }

  /**
   * Removes a disabled account for good, with everything that hangs on it: password, authenticator, recovery
   * codes, sessions, tokens, the open invitation. What the account did stays in the audit log under the name
   * it had (the log keeps no foreign key to users). Disabling comes first so that deleting is never the only
   * step between a person and losing an account by a slip.
   */
  async remove(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USERS_LOCK_KEY})`;
      // After the users lock, like every other path: a sign-in of the account cannot be half-way through its issue.
      await lockAccount(tx, id);
      const target = await tx.user.findUnique({ where: { id } });
      if (!target) {
        throw new NotFoundException('There is no such user.');
      }
      if (actor?.id === id) {
        throw new ConflictException('You cannot delete your own account.');
      }
      if (target.status !== 'disabled') {
        throw new ConflictException('Disable the account before deleting it.');
      }
      await tx.user.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'user.deleted',
          outcome: 'success',
          actor,
          object: { type: 'user', id },
          details: { username: target.username, role: target.role },
          meta,
        },
        tx,
      );
    });
  }

  /** The language a person chose, kept on their account so it follows them to every browser. */
  async setLanguage(id: string, language: string | null): Promise<UserSummary> {
    return toUserSummary(await this.db.user.update({ where: { id }, data: { language } }));
  }
}
