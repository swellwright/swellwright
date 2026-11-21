-- CreateEnum
CREATE TYPE "panel_connection_state" AS ENUM ('connected', 'degraded', 'unreachable', 'unauthorized', 'unsupported');

-- CreateTable
CREATE TABLE "panel_connections" (
    "id" UUID NOT NULL,
    "base_url" VARCHAR(2048) NOT NULL,
    "token_secret_id" UUID NOT NULL,
    "state" "panel_connection_state" NOT NULL,
    "panel_version" VARCHAR(64),
    "capabilities" JSONB,
    "trusted_ca" VARCHAR(20000),
    "token_expires_at" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(64),
    "last_error_message" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "panel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "panel_connections_token_secret_id_idx" ON "panel_connections"("token_secret_id");

-- AddForeignKey
ALTER TABLE "panel_connections" ADD CONSTRAINT "panel_connections_token_secret_id_fkey" FOREIGN KEY ("token_secret_id") REFERENCES "secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
