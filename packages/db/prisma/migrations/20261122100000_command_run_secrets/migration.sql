-- AlterTable
ALTER TABLE "command_run_targets" ADD COLUMN     "stderr_read" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stdout_read" INTEGER NOT NULL DEFAULT 0;

-- Until now what was read was what was kept: runs that are going keep reading where they stopped.
UPDATE "command_run_targets" SET "stdout_read" = "stdout_stored", "stderr_read" = "stderr_stored";

-- CreateTable
CREATE TABLE "command_run_secrets" (
    "run_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "secret_id" UUID,
    "secret_name" VARCHAR(100) NOT NULL,
    "secret_version" INTEGER NOT NULL,

    CONSTRAINT "command_run_secrets_pkey" PRIMARY KEY ("run_id","name")
);

-- CreateIndex
CREATE INDEX "command_run_secrets_secret_id_idx" ON "command_run_secrets"("secret_id");

-- AddForeignKey
ALTER TABLE "command_run_secrets" ADD CONSTRAINT "command_run_secrets_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "command_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_run_secrets" ADD CONSTRAINT "command_run_secrets_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules the schema language cannot express: the application checks them first, the database is the second wall.
ALTER TABLE "command_run_secrets" ADD CONSTRAINT "command_run_secrets_name_check" CHECK ("name" ~ '^[A-Z][A-Z0-9_]{0,63}$');
ALTER TABLE "command_run_targets" ADD CONSTRAINT "command_run_targets_read_check" CHECK ("stdout_read" >= 0 AND "stderr_read" >= 0);
