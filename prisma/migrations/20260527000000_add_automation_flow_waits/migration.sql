-- Parked-run state for the `wait_for_reply` action node. Each row is
-- one in-flight execution of an AutomationFlow that's paused on a
-- specific node (`waiting_node_id`) until either the customer at
-- `from_phone` sends a reply or `expires_at` passes.
--
-- The next inbound WhatsApp webhook checks this table BEFORE running
-- MESSAGE_RECEIVED flows: if a WAITING row matches, the engine resumes
-- the flow from `waiting_node_id` down the branch keyed by
-- `matched_handle` ("yes" / "no") and the row is flipped to MATCHED.
-- A periodic sweep (or lazy check on read) flips overdue rows to
-- EXPIRED and resumes them down the "timeout" branch.

CREATE TABLE IF NOT EXISTS "automation_flow_waits" (
  "id" TEXT PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "flow_id" TEXT NOT NULL,
  "order_id" TEXT,
  "from_phone" TEXT NOT NULL,
  "waiting_node_id" TEXT NOT NULL,
  "context_json" JSONB NOT NULL,
  "steps_json" JSONB NOT NULL,
  "yes_keywords" TEXT NOT NULL DEFAULT '',
  "no_keywords" TEXT NOT NULL DEFAULT '',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "matched_handle" TEXT,
  "matched_at" TIMESTAMP(3),
  "matched_message_text" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_flow_waits_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "automation_flow_runs"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "automation_flow_waits_from_phone_status_idx"
  ON "automation_flow_waits" ("from_phone", "status");
CREATE INDEX IF NOT EXISTS "automation_flow_waits_flow_id_idx"
  ON "automation_flow_waits" ("flow_id");
CREATE INDEX IF NOT EXISTS "automation_flow_waits_status_expires_at_idx"
  ON "automation_flow_waits" ("status", "expires_at");
