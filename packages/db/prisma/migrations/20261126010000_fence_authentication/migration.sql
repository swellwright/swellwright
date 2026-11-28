-- The credential epoch and separate password and second-factor failure state (ADR 0049).
--
-- PostgreSQL runs the statements of one migration file, sent as one query, in a single transaction: the epoch columns,
-- the end of the existing sessions and the new failure state appear together or not at all. Stop the old API and the
-- host admin command before applying it; every browser session, pending ones included, ends here once.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "credential_epoch" BIGINT NOT NULL DEFAULT 0;

-- Take the table lock before clearing legacy sessions. Stop old writers before applying the migration.
ALTER TABLE "sessions" ADD COLUMN "credential_epoch" BIGINT,
ADD COLUMN "source_bucket" VARCHAR(64),
ADD COLUMN "step_up_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "step_up_window_ends_at" TIMESTAMPTZ(3),
ADD COLUMN "step_up_locked_until" TIMESTAMPTZ(3);

-- A session made before this migration has no epoch to compare with: it ends, and its user signs in again.
DELETE FROM "sessions";
ALTER TABLE "sessions" ALTER COLUMN "credential_epoch" SET NOT NULL,
ALTER COLUMN "source_bucket" SET NOT NULL;

-- AlterTable: the old combined count cannot be split into password and second-factor failures, so it goes.
ALTER TABLE "credentials" DROP COLUMN "failed_attempts",
DROP COLUMN "locked_until",
ADD COLUMN "password_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "password_window_ends_at" TIMESTAMPTZ(3),
ADD COLUMN "password_retry_at" TIMESTAMPTZ(3),
ADD COLUMN "pending_factor_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pending_factor_window_ends_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "auth_password_source_failures" (
    "user_id" UUID NOT NULL,
    "source_bucket" VARCHAR(64) NOT NULL,
    "failures" INTEGER NOT NULL,
    "window_ends_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_password_source_failures_pkey" PRIMARY KEY ("user_id","source_bucket")
);

-- AddForeignKey
ALTER TABLE "auth_password_source_failures" ADD CONSTRAINT "auth_password_source_failures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_mfa_source_failures" (
    "user_id" UUID NOT NULL,
    "source_bucket" VARCHAR(64) NOT NULL,
    "failures" INTEGER NOT NULL,
    "window_ends_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "auth_mfa_source_failures_pkey" PRIMARY KEY ("user_id","source_bucket"),
    CONSTRAINT "auth_mfa_source_failures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "credentials"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
