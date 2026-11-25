import type { PrismaClient } from '@swellwright/db';

/**
 * The namespace of the per-account lock: the first of the two integers of `pg_advisory_xact_lock(int, int)`. Locks
 * taken with one bigint (the users, the audit chain, the vault...) live apart from two-integer ones in PostgreSQL,
 * so this cannot collide with them; the engine's namespaces are different numbers.
 */
export const ACCOUNT_LOCK_NAMESPACE = 7_761_240;

/** What a transaction needs to take the lock. */
export type LockingClient = Pick<PrismaClient, '$executeRaw'>;

/**
 * Serializes, until the end of the transaction, every change to the credentials and tokens of one account: issuing
 * and revoking API tokens, a credential reset, a password change, disabling the account. Take it after the users lock
 * (`USERS_LOCK_KEY`) where that one is used, before writing rows and before the audit record, and read the state the
 * decision depends on only after it is held. Two different accounts can hash to the same key; that only makes them
 * wait for each other.
 */
export async function lockAccount(tx: LockingClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
}
