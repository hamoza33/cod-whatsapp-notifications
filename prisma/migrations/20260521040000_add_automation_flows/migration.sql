-- Visual-builder automation flows: each row is one graph of trigger →
-- conditions → actions. The graph itself (nodes + edges + viewport) is
-- stored as JSON so new node types can be added without migrations.

CREATE TABLE IF NOT EXISTS "automation_flows" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "is_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "trigger_type" TEXT NOT NULL,
  "graph_json" JSONB NOT NULL,
  "last_fired_at" TIMESTAMP(3),
  "run_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "automation_flows_is_enabled_trigger_type_idx"
  ON "automation_flows" ("is_enabled", "trigger_type");

-- One row per flow execution attempt. The step-by-step log lives in
-- `steps_json` so the run-detail UI can render a timeline of which nodes
-- were visited, which branch each condition took, and why a flow stopped.
CREATE TABLE IF NOT EXISTS "automation_flow_runs" (
  "id" TEXT PRIMARY KEY,
  "flow_id" TEXT NOT NULL,
  "order_id" TEXT,
  "context_json" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "steps_json" JSONB NOT NULL,
  "error_message" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "automation_flow_runs_flow_id_fkey"
    FOREIGN KEY ("flow_id") REFERENCES "automation_flows"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "automation_flow_runs_flow_id_started_at_idx"
  ON "automation_flow_runs" ("flow_id", "started_at");
CREATE INDEX IF NOT EXISTS "automation_flow_runs_order_id_idx"
  ON "automation_flow_runs" ("order_id");
