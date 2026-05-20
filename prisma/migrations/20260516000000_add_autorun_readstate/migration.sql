-- Add per-automation auto_run toggle
ALTER TABLE "automations" ADD COLUMN "auto_run" BOOLEAN NOT NULL DEFAULT false;

-- Conversation read state for WhatsApp-style unread tracking
CREATE TABLE "conversation_read_states" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_read_states_phone_number_key" ON "conversation_read_states"("phone_number");
