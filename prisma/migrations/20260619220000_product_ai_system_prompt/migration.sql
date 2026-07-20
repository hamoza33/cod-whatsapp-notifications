-- Per-product AI system prompt for the auto-reply agent.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "ai_system_prompt" TEXT;
