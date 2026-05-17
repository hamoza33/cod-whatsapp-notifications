-- Add tracking status automation condition
ALTER TABLE "automations" ADD COLUMN "and_tracking_status_contains" TEXT;
