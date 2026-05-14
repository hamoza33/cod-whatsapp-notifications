/**
 * Next.js calls `register()` once per server process at startup.
 * Used here to start the in-process auto-sync scheduler so the user doesn't
 * have to set up an external cron for the default 5-minute pull from
 * COD Network.
 *
 * Also starts the tracking worker loop as an in-process fallback when
 * no separate worker process is configured (TRACKING_WORKER_DISABLED !== "true").
 */
export async function register() {
  // Guard: only run on the Node server runtime, not Edge.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoSync } = await import("./lib/auto-sync");
    await startAutoSync();

    // Start tracking worker in-process unless explicitly disabled
    // (e.g. when a separate worker process is configured via fly.toml).
    if (process.env.TRACKING_WORKER_DISABLED !== "true") {
      const { startTrackingWorkerLoop } = await import("./lib/tracking-worker");
      startTrackingWorkerLoop().catch((err) => {
        console.error("[instrumentation] Tracking worker loop crashed:", err);
      });
    }
  }
}
