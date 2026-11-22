-- CreateEnum
CREATE TYPE "check_run_state" AS ENUM ('queued', 'running', 'completed', 'error');

-- CreateEnum
CREATE TYPE "check_trigger" AS ENUM ('manual', 'scheduled');

-- CreateEnum
CREATE TYPE "check_status" AS ENUM ('pass', 'warn', 'fail', 'error', 'skipped');

-- CreateTable
CREATE TABLE "baseline_profiles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(300),
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "baseline_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_versions" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "document_sha256" VARCHAR(64) NOT NULL,
    "check_count" INTEGER NOT NULL,
    "comment" VARCHAR(200),
    "created_by_id" UUID,
    "created_by_name" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_assignments" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "server_id" UUID,
    "tag" VARCHAR(32),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_runs" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "server_name" VARCHAR(64) NOT NULL,
    "profile_id" UUID,
    "baseline_name" VARCHAR(64) NOT NULL,
    "baseline_version" INTEGER NOT NULL,
    "baseline_sha256" VARCHAR(64) NOT NULL,
    "trigger" "check_trigger" NOT NULL,
    "state" "check_run_state" NOT NULL DEFAULT 'queued',
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "started_by_id" UUID,
    "started_by_name" VARCHAR(64),
    "pass_count" INTEGER NOT NULL DEFAULT 0,
    "warn_count" INTEGER NOT NULL DEFAULT 0,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "changed_since_previous" INTEGER,
    "trend" VARCHAR(6),
    "error_code" VARCHAR(40),
    "error_message" VARCHAR(500),
    "collected_as" VARCHAR(8),
    "script_sha256" VARCHAR(64),

    CONSTRAINT "check_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_results" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "check_id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "category" VARCHAR(16) NOT NULL,
    "severity" VARCHAR(8) NOT NULL,
    "status" "check_status" NOT NULL,
    "observation_kind" VARCHAR(40) NOT NULL,
    "observation_field" VARCHAR(40) NOT NULL,
    "observation_params" JSONB NOT NULL DEFAULT '{}',
    "observation_status" VARCHAR(16) NOT NULL,
    "observed" JSONB,
    "comparator" VARCHAR(16) NOT NULL,
    "expected" JSONB,
    "message" VARCHAR(600),
    "remediation_hint" VARCHAR(300),

    CONSTRAINT "check_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "baseline_profiles_name_key" ON "baseline_profiles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_versions_profile_id_version_key" ON "baseline_versions"("profile_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_assignments_server_id_key" ON "baseline_assignments"("server_id");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_assignments_tag_key" ON "baseline_assignments"("tag");

-- CreateIndex
CREATE INDEX "baseline_assignments_profile_id_idx" ON "baseline_assignments"("profile_id");

-- CreateIndex
CREATE INDEX "check_runs_server_id_queued_at_idx" ON "check_runs"("server_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "check_runs_state_idx" ON "check_runs"("state");

-- CreateIndex
CREATE INDEX "check_runs_profile_id_idx" ON "check_runs"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "check_results_run_id_check_id_key" ON "check_results"("run_id", "check_id");

-- CreateIndex
CREATE INDEX "check_results_run_id_position_idx" ON "check_results"("run_id", "position");

-- AddForeignKey
ALTER TABLE "baseline_versions" ADD CONSTRAINT "baseline_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "baseline_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_assignments" ADD CONSTRAINT "baseline_assignments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "baseline_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_assignments" ADD CONSTRAINT "baseline_assignments_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "baseline_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "check_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An assignment names exactly one thing: a server or a tag (ADR 0045). Prisma does not model check constraints, so this
-- is kept here and is not part of what `db:schema:check` compares.
ALTER TABLE "baseline_assignments" ADD CONSTRAINT "baseline_assignments_one_target" CHECK (("server_id" IS NULL) <> ("tag" IS NULL));
