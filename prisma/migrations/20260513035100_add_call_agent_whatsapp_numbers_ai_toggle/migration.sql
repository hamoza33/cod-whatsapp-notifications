-- AlterTable: Add call_agent_queued to orders
ALTER TABLE "orders" ADD COLUMN "call_agent_queued" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add ai_agent_enabled to products
ALTER TABLE "products" ADD COLUMN "ai_agent_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: whatsapp_numbers
CREATE TABLE "whatsapp_numbers" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);
