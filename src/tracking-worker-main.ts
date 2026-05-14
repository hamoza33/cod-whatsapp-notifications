/**
 * Standalone entry point for the tracking background worker.
 *
 * Run with: npx tsx src/tracking-worker-main.ts
 * Or in production: node dist/tracking-worker-main.js
 *
 * This process runs independently of the web server and polls for
 * queued TrackingJob records, processing them to completion.
 */

import "dotenv/config";
import { startTrackingWorkerLoop } from "./lib/tracking-worker";

console.log("[tracking-worker-main] Starting tracking worker process...");
console.log(`[tracking-worker-main] DATABASE_URL is ${process.env.DATABASE_URL ? "set" : "NOT SET"}`);

startTrackingWorkerLoop().catch((err) => {
  console.error("[tracking-worker-main] Fatal error:", err);
  process.exit(1);
});
