import { Prisma, type PrismaClient } from '@swellwright/db';

import { RateLimitedException } from '../http.js';

/**
 * How long a sign-in transaction waits for a connection and may run. Many requests for one account queue on its lock
 * one after another; each holds it for a few queries.
 */
const ACCOUNT_TX = { maxWait: 5_000, timeout: 15_000 } as const;

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

/**
 * Runs `work` with one account lock, or both caller and target locks. An optional broader lock is taken first.
 * A transaction that
 * could not get a connection, or ran out of time, under a burst of requests has rolled back and changed nothing: the
 * caller hears 429 with a short `Retry-After` instead of 500.
 */
export async function inAccountTransaction<T>(
  client: Pick<PrismaClient, '$transaction'>,
  accounts: string | readonly [string, string],
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  beforeAccounts?: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<T> {
  return busyAsRateLimited(() =>
    client.$transaction(
      async (tx) => {
        await beforeAccounts?.(tx);
        if (typeof accounts === 'string' || accounts[0] === accounts[1]) {
          await lockAccount(tx, typeof accounts === 'string' ? accounts : accounts[0]);
        } else {
          // Order the actual lock keys, not IDs, so even a hash collision cannot invert the lock order.
          const keys = await tx.$queryRaw<{ lock_key: number }[]>`
            SELECT DISTINCT hashtext(id) AS lock_key FROM unnest(ARRAY[${Prisma.join(accounts)}]::text[]) AS ids(id)
            ORDER BY lock_key`;
          for (const { lock_key } of keys) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_NAMESPACE}::int, ${lock_key}::int)`;
          }
        }
        return work(tx);
      },
      { ...ACCOUNT_TX, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}

/** What the connection pool says when no connection came free in time; the adapter passes it on as it is. */
const POOL_TIMEOUT = /timeout exceeded when trying to connect/iu;

/**
 * Whether an error means the database had no connection or no time for this request: Prisma's transaction timeouts
 * (P2028, P2024) and the pool's own acquisition timeout, in whatever wrapper the adapter hands it over. Nothing was
 * written.
 */
export function isDatabaseBusy(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2028' || error.code === 'P2024')
  ) {
    return true;
  }
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; depth += 1) {
    if (POOL_TIMEOUT.test(e.message)) {
      return true;
    }
    e = e.cause;
  }
  return false;
}

/**
 * Runs an authentication step and turns "the database is busy" into 429 with a short `Retry-After`, so a burst of
 * sign-ins is told to come back instead of seeing 500.
 */
export async function busyAsRateLimited<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDatabaseBusy(error)) {
      throw new RateLimitedException(1, 'The server is busy. Try again in a moment.');
    }
    throw error;
  }
}

/**
 * The time by the database's clock, read now (not at the start of the transaction): what an expiry or a cooldown is
 * compared with once the account lock is held, so every API process judges a window by the same clock. Read it once
 * per transaction, after `lockAccount`.
 */
export async function databaseNow(tx: Pick<PrismaClient, '$queryRaw'>): Promise<Date> {
  // Milliseconds since the epoch, not a timestamp value: a raw timestamptz is read back through the server's time zone
  // setting, which a driver can get wrong; a number cannot be.
  const rows = await tx.$queryRaw<
    { ms: number | string }[]
  >`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`;
  const ms = Number(rows[0]?.ms);
  return Number.isFinite(ms) ? new Date(Math.floor(ms)) : new Date();
}
