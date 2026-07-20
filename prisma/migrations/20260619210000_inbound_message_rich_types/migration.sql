-- Structured payloads for non-text inbound WhatsApp message types.
ALTER TABLE "inbound_messages"
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "location_name" TEXT,
  ADD COLUMN IF NOT EXISTS "location_address" TEXT,
  ADD COLUMN IF NOT EXISTS "reaction_emoji" TEXT,
  ADD COLUMN IF NOT EXISTS "reaction_to_id" TEXT,
  ADD COLUMN IF NOT EXISTS "transcription" TEXT;
