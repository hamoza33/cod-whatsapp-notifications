-- Source visits for time-window based source detection
CREATE TABLE IF NOT EXISTS "source_visits" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  "matched" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_visits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "source_visits_source_idx" ON "source_visits"("source");
CREATE INDEX IF NOT EXISTS "source_visits_created_at_idx" ON "source_visits"("created_at");
