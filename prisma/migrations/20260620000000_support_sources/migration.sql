-- Add source column to inbound_messages for tracking which website the customer came from
ALTER TABLE "inbound_messages" ADD COLUMN IF NOT EXISTS "source" TEXT;
CREATE INDEX IF NOT EXISTS "inbound_messages_source_idx" ON "inbound_messages"("source");

-- Create support_sources table for per-source AI system prompts
CREATE TABLE IF NOT EXISTS "support_sources" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "support_sources_slug_key" ON "support_sources"("slug");
