-- CreateTable
CREATE TABLE "convention_packs" (
    "id" UUID NOT NULL,
    "panel_key" VARCHAR(32) NOT NULL DEFAULT 'default',
    "version" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "document" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "comment" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "convention_packs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "convention_packs_panel_key_active_idx" ON "convention_packs"("panel_key", "active");

-- CreateIndex
CREATE UNIQUE INDEX "convention_packs_panel_key_version_key" ON "convention_packs"("panel_key", "version");
