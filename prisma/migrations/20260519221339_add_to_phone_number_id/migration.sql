-- DropForeignKey
ALTER TABLE "whatsapp_messages" DROP CONSTRAINT "whatsapp_messages_order_id_fkey";

-- AlterTable
ALTER TABLE "inbound_messages" ADD COLUMN     "to_phone_number_id" TEXT;

-- CreateIndex
CREATE INDEX "inbound_messages_to_phone_number_id_idx" ON "inbound_messages"("to_phone_number_id");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
