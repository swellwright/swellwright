-- CreateEnum
CREATE TYPE "run_state" AS ENUM ('planned', 'awaiting_approval', 'queued', 'running', 'paused', 'awaiting_input', 'succeeded', 'failed', 'cancelled', 'rollback_requested', 'rolling_back', 'rolled_back', 'rollback_partial');

-- CreateEnum
CREATE TYPE "run_risk" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "run_step_state" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped', 'undone', 'undo_failed');

-- CreateEnum
CREATE TYPE "undo_record_state" AS ENUM ('pending', 'done', 'failed');

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "workflow_key" VARCHAR(80) NOT NULL,
    "params" JSONB NOT NULL,
    "plan" JSONB NOT NULL,
    "plan_hash" VARCHAR(64) NOT NULL,
    "state" "run_state" NOT NULL DEFAULT 'planned',
    "risk" "run_risk" NOT NULL,
    "requested_by" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "pause_requested_at" TIMESTAMPTZ(3),
    "worker_id" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(3),
    "fence" INTEGER NOT NULL DEFAULT 0,
    "waiting" VARCHAR(300),
    "retry_after" TIMESTAMPTZ(3),

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_steps" (
    "run_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "state" "run_step_state" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "remote_id" VARCHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error_code" VARCHAR(80),
    "error_message" VARCHAR(500),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "retry_approved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("run_id","index")
);

-- CreateTable
CREATE TABLE "undo_records" (
    "run_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" VARCHAR(80) NOT NULL,
    "data" JSONB NOT NULL,
    "state" "undo_record_state" NOT NULL DEFAULT 'pending',

    CONSTRAINT "undo_records_pkey" PRIMARY KEY ("run_id","step_index","seq")
);

-- CreateTable
CREATE TABLE "run_events" (
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("run_id","seq")
);

-- CreateTable
CREATE TABLE "resource_locks" (
    "key" VARCHAR(160) NOT NULL,
    "run_id" UUID NOT NULL,
    "fence" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_locks_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "runs_state_created_at_id_idx" ON "runs"("state", "created_at", "id");

-- CreateIndex
CREATE INDEX "resource_locks_run_id_idx" ON "resource_locks"("run_id");

-- AddForeignKey
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "undo_records" ADD CONSTRAINT "undo_records_run_id_step_index_fkey" FOREIGN KEY ("run_id", "step_index") REFERENCES "run_steps"("run_id", "index") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_locks" ADD CONSTRAINT "resource_locks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The engine's own rules, kept by the database as well (they are not part of the Prisma model).
ALTER TABLE "runs" ADD CONSTRAINT "runs_fence_not_negative" CHECK ("fence" >= 0);
ALTER TABLE "runs" ADD CONSTRAINT "runs_lease_and_worker_together" CHECK (("worker_id" IS NULL) = ("lease_expires_at" IS NULL));
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_index_not_negative" CHECK ("index" >= 0);
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_attempt_not_negative" CHECK ("attempt" >= 0);
ALTER TABLE "undo_records" ADD CONSTRAINT "undo_records_seq_not_negative" CHECK ("seq" >= 0);
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_seq_from_one" CHECK ("seq" >= 1);

