-- Fix autoRun default: change from false to true so automations fire
-- automatically by default. Also backfill existing rows.
ALTER TABLE "automations" ALTER COLUMN "auto_run" SET DEFAULT true;
UPDATE "automations" SET "auto_run" = true WHERE "auto_run" = false;
