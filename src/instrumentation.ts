/**
 * Next.js calls `register()` once per server process at startup.
 * Used here to start the in-process auto-sync scheduler so the user doesn't
 * have to set up an external cron for the default 5-minute pull from
 * COD Network.
 */
export async function register() {
  // Guard: only run on the Node server runtime, not Edge.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoSync } = await import("./lib/auto-sync");
    await startAutoSync();
    // Resume any bulk-messaging campaigns that were mid-send when the
    // process died (deploy / fly auto-stop / crash). Fire-and-forget; the
    // recover function spawns one in-process worker per campaign.
    const { recoverInFlightCampaigns } = await import(
      "./lib/bulk-messaging/runner"
    );
    void recoverInFlightCampaigns();
  }
}
