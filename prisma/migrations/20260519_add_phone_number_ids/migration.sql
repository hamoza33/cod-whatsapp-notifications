-- AlterTable
ALTER TABLE "inbound_messages" ADD COLUMN "to_phone_number_id" TEXT;

-- AlterTable
ALTER TABLE "whatsapp_messages" ADD COLUMN "from_phone_number_id" TEXT;

-- CreateIndex
CREATE INDEX "inbound_messages_to_phone_number_id_idx" ON "inbound_messages"("to_phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_from_phone_number_id_idx" ON "whatsapp_messages"("from_phone_number_id");
