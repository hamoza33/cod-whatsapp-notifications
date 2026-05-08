-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pipeline_note" TEXT,
ADD COLUMN     "whatsapp_sent_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "from_phone_number" TEXT NOT NULL,
    "contact_name" TEXT,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "media_id" TEXT,
    "media_mime_type" TEXT,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order_id" TEXT,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_provider_message_id_key" ON "inbound_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "inbound_messages_from_phone_number_idx" ON "inbound_messages"("from_phone_number");

-- CreateIndex
CREATE INDEX "inbound_messages_received_at_idx" ON "inbound_messages"("received_at");

-- CreateIndex
CREATE INDEX "inbound_messages_order_id_idx" ON "inbound_messages"("order_id");

-- CreateIndex
CREATE INDEX "orders_whatsapp_sent_at_idx" ON "orders"("whatsapp_sent_at");

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
