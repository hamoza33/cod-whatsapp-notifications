-- Add new enum values to OrderStatus for complete lead + order lifecycle
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CALL_LATER_SCHEDULED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DELAYED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'BLACK_LISTED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'OUT_OF_STOCK';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURN_ON_PROCESS';

-- Add call_attempts field to orders table
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "call_attempts" INTEGER NOT NULL DEFAULT 0;

-- Add automation fields for call attempts and time-based scheduling
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "and_min_call_attempts" INTEGER;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "and_max_call_attempts" INTEGER;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "scheduled_send_hour" INTEGER;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "increment_call_attempts" BOOLEAN NOT NULL DEFAULT false;
