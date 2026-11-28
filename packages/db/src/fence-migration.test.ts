import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import pg from 'pg';

import { shippedMigrations } from './migrations.js';

const databaseUrl = process.env['SW_TEST_DATABASE_URL'];
const MIGRATIONS_DIR = new URL('../prisma/migrations/', import.meta.url);
const FENCE = '20261126010000_fence_authentication';

/**
 * The migration of the credential epoch (ADR 0049) against a database with data in it: every session ends, the old
 * combined failure count goes, and the password, the authenticator, used recovery codes, open invitations and API tokens
 * stay. Runs in one transaction that is rolled back.
 */
describe('the migration that fences authentication', { skip: !databaseUrl }, () => {
  it('ends every session and keeps the credentials, codes, invitations and tokens', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `sw_test_${randomBytes(6).toString('hex')}`;
    const apply = async (name: string): Promise<void> => {
      await client.query(await readFile(new URL(`${name}/migration.sql`, MIGRATIONS_DIR), 'utf8'));
    };
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const names = await shippedMigrations();
      const fenceAt = names.indexOf(FENCE);
      assert.ok(fenceAt > 0, 'the migration is shipped');
      for (const name of names.slice(0, fenceAt)) {
        await apply(name);
      }

      const user = (
        await client.query<{ id: string }>(
          `INSERT INTO users (id, username, role, updated_at)
           VALUES (gen_random_uuid(), 'migrated', 'owner', now()) RETURNING id`,
        )
      ).rows[0]?.id;
      assert.ok(user);
      await client.query(
        `INSERT INTO credentials (user_id, password_hash, totp_secret, totp_confirmed_at, totp_last_step,
                                  failed_attempts, locked_until)
         VALUES ($1, '$argon2id$kept', '\\x0102'::bytea, now(), 1234, 4, now() + interval '10 minutes')`,
        [user],
      );
      for (const stage of ['active', 'password_verified']) {
        await client.query(
          `INSERT INTO sessions (id, user_id, token_hash, stage, expires_at, absolute_expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3::session_stage, now() + interval '1 hour', now() + interval '2 hours')`,
          [user, randomBytes(32).toString('hex'), stage],
        );
      }
      await client.query(
        `INSERT INTO recovery_codes (id, user_id, code_hash, used_at)
         VALUES (gen_random_uuid(), $1, $2, now())`,
        [user, 'a'.repeat(64)],
      );
      await client.query(
        `INSERT INTO invitations (id, user_id, token_hash, purpose, expires_at)
         VALUES (gen_random_uuid(), $1, $2, 'reset', now() + interval '1 day')`,
        [user, 'b'.repeat(64)],
      );
      await client.query(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, permissions, ip_allowlist, expires_at)
         VALUES (gen_random_uuid(), $1, 'ci', $2, 'swt_abcd', '{servers:read}', '{}', now() + interval '30 days')`,
        [user, 'c'.repeat(64)],
      );

      await apply(FENCE);

      const one = async <T extends pg.QueryResultRow>(sql: string): Promise<T> => {
        const row = (await client.query<T>(sql)).rows[0];
        assert.ok(row, sql);
        return row;
      };
      assert.equal((await one<{ n: string }>('SELECT count(*) AS n FROM sessions')).n, '0');
      assert.equal(
        (await one<{ e: string }>('SELECT credential_epoch::text AS e FROM users')).e,
        '0',
      );
      const credential = await one<{
        password_hash: string;
        totp_last_step: number;
        confirmed: boolean;
        password_failures: number;
        password_retry_at: Date | null;
      }>(
        `SELECT password_hash, totp_last_step, totp_confirmed_at IS NOT NULL AS confirmed,
                password_failures, password_retry_at
         FROM credentials`,
      );
      assert.deepEqual(credential, {
        password_hash: '$argon2id$kept',
        totp_last_step: 1234,
        confirmed: true,
        password_failures: 0,
        password_retry_at: null,
      });
      assert.equal(
        (await one<{ n: string }>('SELECT count(*) AS n FROM auth_mfa_source_failures')).n,
        '0',
      );
      const columns = (
        await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'credentials'`,
          [schema],
        )
      ).rows.map((r) => r.column_name);
      assert.ok(!columns.includes('failed_attempts') && !columns.includes('locked_until'));
      assert.equal(
        (
          await one<{ n: string }>(
            'SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL',
          )
        ).n,
        '1',
      );
      assert.equal((await one<{ n: string }>('SELECT count(*) AS n FROM invitations')).n, '1');
      assert.equal(
        (await one<{ n: string }>('SELECT count(*) AS n FROM api_tokens WHERE revoked_at IS NULL'))
          .n,
        '1',
      );
      // A session needs its epoch from now on.
      await client.query('SAVEPOINT before_insert');
      await assert.rejects(
        client.query(
          `INSERT INTO sessions (id, user_id, token_hash, stage, expires_at, absolute_expires_at, source_bucket)
           VALUES (gen_random_uuid(), $1, $2, 'active', now(), now(), 'unknown')`,
          [user, 'd'.repeat(64)],
        ),
        /credential_epoch/u,
      );
      await client.query('ROLLBACK TO SAVEPOINT before_insert');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
