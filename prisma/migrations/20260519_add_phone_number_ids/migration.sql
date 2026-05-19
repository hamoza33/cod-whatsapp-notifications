-- AlterTable
ALTER TABLE "whatsapp_messages" ADD COLUMN "from_phone_number_id" TEXT;

-- CreateIndex
CREATE INDEX "whatsapp_messages_from_phone_number_id_idx" ON "whatsapp_messages"("from_phone_number_id");
