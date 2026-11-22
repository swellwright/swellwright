-- CreateEnum
CREATE TYPE "panel_snapshot_kind" AS ENUM ('manual', 'scheduled', 'before_change', 'imported');

-- CreateTable
CREATE TABLE "panel_snapshots" (
    "id" UUID NOT NULL,
    "connection_id" UUID,
    "panel_url" VARCHAR(2048) NOT NULL,
    "label" VARCHAR(100),
    "kind" "panel_snapshot_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_by_name" VARCHAR(64),
    "panel_version" VARCHAR(64),
    "counts" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "object_count" INTEGER NOT NULL,
    "overall_hash" VARCHAR(64) NOT NULL,
    "kind_hashes" JSONB NOT NULL,
    "mask_key_id" VARCHAR(16) NOT NULL,
    "raw_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checked_at" TIMESTAMPTZ(3),
    "changes_since" INTEGER,

    CONSTRAINT "panel_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_snapshot_contents" (
    "snapshot_id" UUID NOT NULL,
    "encoding" VARCHAR(16) NOT NULL,
    "data" BYTEA NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,

    CONSTRAINT "panel_snapshot_contents_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateIndex
CREATE INDEX "panel_snapshots_panel_url_created_at_idx" ON "panel_snapshots"("panel_url", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "panel_snapshot_contents" ADD CONSTRAINT "panel_snapshot_contents_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "panel_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
