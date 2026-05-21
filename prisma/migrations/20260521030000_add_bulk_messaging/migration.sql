-- Add bulk-messaging campaigns + recipients

CREATE TYPE "BulkCampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "BulkRecipientStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED');

CREATE TABLE "bulk_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_name" TEXT NOT NULL,
    "template_language" TEXT NOT NULL,
    "body_param_count" INTEGER NOT NULL DEFAULT 0,
    "header_type" TEXT,
    "header_value" TEXT,
    "header_kind" TEXT,
    "phone_number_id" TEXT,
    "column_mapping_json" JSONB,
    "status" "BulkCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "default_country_code" TEXT NOT NULL DEFAULT '212',
    "throttle_ms" INTEGER NOT NULL DEFAULT 200,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bulk_campaigns_status_idx" ON "bulk_campaigns" ("status");
CREATE INDEX "bulk_campaigns_created_at_idx" ON "bulk_campaigns" ("created_at");

CREATE TABLE "bulk_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "phone_number" TEXT NOT NULL,
    "phone_number_raw" TEXT,
    "display_name" TEXT,
    "variables_json" JSONB NOT NULL,
    "header_value" TEXT,
    "status" "BulkRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "whatsapp_message_id" TEXT,
    "error_message" TEXT,
    "error_code" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_recipients_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bulk_recipients_campaign_id_idx" ON "bulk_recipients" ("campaign_id");
CREATE INDEX "bulk_recipients_status_idx" ON "bulk_recipients" ("status");
CREATE INDEX "bulk_recipients_provider_message_id_idx" ON "bulk_recipients" ("provider_message_id");

ALTER TABLE "bulk_recipients" ADD CONSTRAINT "bulk_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "bulk_campaigns" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
