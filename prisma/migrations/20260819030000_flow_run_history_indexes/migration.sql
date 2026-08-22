-- Indexes for the once-per-order dedupe lookup and for retention pruning of
-- automation flow run history (the largest table on busy stores).
CREATE INDEX IF NOT EXISTS "automation_flow_runs_flow_id_order_id_started_at_idx"
  ON "automation_flow_runs" ("flow_id", "order_id", "started_at");

CREATE INDEX IF NOT EXISTS "automation_flow_runs_started_at_idx"
  ON "automation_flow_runs" ("started_at");
