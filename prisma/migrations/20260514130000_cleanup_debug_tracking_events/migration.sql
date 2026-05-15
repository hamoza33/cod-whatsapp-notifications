-- Cleanup: previous deploys wrote `_debug:<error>` rows into tracking_events
-- when applyTrackingResult had a debug-event upsert path. That path is gone
-- (latestError on the row carries the same signal); this delete removes the
-- legacy rows so they stop showing in the per-row timeline UI.
DELETE FROM "tracking_events" WHERE "description" LIKE E'\\_debug:%';
