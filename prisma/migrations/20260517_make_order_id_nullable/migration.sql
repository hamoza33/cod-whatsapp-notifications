-- AlterTable: make order_id nullable on whatsapp_messages
ALTER TABLE "whatsapp_messages" ALTER COLUMN "order_id" DROP NOT NULL;
