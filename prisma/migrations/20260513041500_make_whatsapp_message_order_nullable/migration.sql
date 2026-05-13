-- AlterTable: make order_id nullable on whatsapp_messages
-- so inbox replies and test messages can be stored without an order
ALTER TABLE "whatsapp_messages" ALTER COLUMN "order_id" DROP NOT NULL;
