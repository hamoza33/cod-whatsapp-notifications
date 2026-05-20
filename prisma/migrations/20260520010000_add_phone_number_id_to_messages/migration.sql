-- Add phone_number_id (Meta WABA PNI) tracking so the inbox can filter
-- conversations by which WhatsApp account they belong to, and so outbound
-- messages record which account sent them.

ALTER TABLE "inbound_messages"
  ADD COLUMN IF NOT EXISTS "phone_number_id" TEXT;

ALTER TABLE "whatsapp_messages"
  ADD COLUMN IF NOT EXISTS "phone_number_id" TEXT;

CREATE INDEX IF NOT EXISTS "inbound_messages_phone_number_id_idx"
  ON "inbound_messages" ("phone_number_id");

CREATE INDEX IF NOT EXISTS "whatsapp_messages_phone_number_id_idx"
  ON "whatsapp_messages" ("phone_number_id");
