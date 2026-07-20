import { syncOrders, syncLeads, isSyncInProgress } from "./sync";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { importTemplatesFromMeta } from "./template-import";
import { syncProductsFromCodNetwork } from "./product-sync";
import { refreshAllTracking, syncTrackingFromOrders } from "./tracking";
import { runScheduledAutomations } from "./automations";

/**
 * Lightweight in-process scheduler that runs `syncOrders()` on a recurring
 * interval (5 minutes by default). Designed for self-hosted / single-process
 * deployments — for serverless/multi-instance setups, use an external cron
 * (Vercel cron, GitHub Actions, etc.) calling /api/cron/sync instead.
 *
 * Singleton-protected via a `globalThis` flag so the Next.js dev server
 * reloading the module doesn't spawn extra timers.
 */
declare global {
  var __codWhatsappAutoSyncStarted__: boolean | undefined;
  var __codWhatsappAutoSyncTimer__: NodeJS.Timeout | undefined;
  var __codWhatsappTemplateImportTimer__: NodeJS.Timeout | undefined;
  var __codWhatsappProductSyncTimer__: NodeJS.Timeout | undefined;
  var __codWhatsappTrackingRefreshTimer__: NodeJS.Timeout | undefined;
}

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
// Templates rarely change, so a long cadence is fine. The user can also
// click "Sync now" in /templates whenever they want a fresh pull.
const TEMPLATE_IMPORT_INTERVAL_MINUTES = 6 * 60;
// Products change occasionally — once an hour keeps the automation editor
// product picker fresh without hammering COD Network.
const PRODUCT_SYNC_INTERVAL_MINUTES = 60;
const DEFAULT_TRACKING_REFRESH_INTERVAL_MINUTES = 60;

let lastRunStartedAt: Date | null = null;
let lastRunFinishedAt: Date | null = null;
let lastRunError: string | null = null;
let lastRunOrdersFound = 0;

export interface AutoSyncStatus {
  running: boolean;
  inProgress: boolean;
  intervalMinutes: number;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunError: string | null;
  lastRunOrdersFound: number;
}

async function tick(): Promise<void> {
  // Respect the per-tick "auto sync enabled" flag so the user can pause
  // automation without restarting the server.
  const enabled = await getSetting(SETTING_KEYS.AUTO_SYNC_ENABLED);
  if (enabled === "false") return;
  if (isSyncInProgress()) return;

  lastRunStartedAt = new Date();
  lastRunError = null;
  try {
    const result = await syncOrders();
    lastRunOrdersFound = result.ordersFound;
    if (result.errors.length > 0) {
      lastRunError = result.errors.join("; ");
    }
  } catch (err) {
    lastRunError = err instanceof Error ? err.message : String(err);
  } finally {
    lastRunFinishedAt = new Date();
  }

  // Poll the leads endpoint on the same cadence so the Lead pipeline stays
  // fresh even when the lead-status webhook misses a delivery. Best-effort:
  // a lead-sync failure must never break the order sync above.
  try {
    const leadResult = await syncLeads();
    if (leadResult.errors.length > 0) {
      const leadErr = `leads: ${leadResult.errors.join("; ")}`;
      lastRunError = lastRunError ? `${lastRunError}; ${leadErr}` : leadErr;
    }
  } catch (err) {
    console.warn(
      "[auto-sync] lead sync tick failed",
      err instanceof Error ? err.message : err
    );
  }

  // Fire time-gated automations whose scheduled hour has arrived. This is what
  // delivers "status changed earlier → act after 06:00": the earlier status
  // event was correctly skipped, and this sweep picks it up once the window
  // opens. Best-effort — failures never break the sync loop.
  try {
    await runScheduledAutomations();
  } catch (err) {
    console.warn(
      "[auto-sync] scheduled automation sweep failed",
      err instanceof Error ? err.message : err
    );
  }
}

async function resolveIntervalMinutes(): Promise<number> {
  const stored = await getSetting(SETTING_KEYS.AUTO_SYNC_INTERVAL_MINUTES);
  const parsed = stored ? parseInt(stored, 10) : DEFAULT_INTERVAL_MINUTES;
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MINUTES) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return parsed;
}

/**
 * Start the auto-sync scheduler. Idempotent: subsequent calls in the same
 * process are no-ops. Safe to call from a Next.js route or layout.
 */
export async function startAutoSync(): Promise<void> {
  if (globalThis.__codWhatsappAutoSyncStarted__) return;
  globalThis.__codWhatsappAutoSyncStarted__ = true;

  const intervalMinutes = await resolveIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  // Fire a tick a few seconds after boot so a fresh deploy syncs almost
  // immediately, then settle into the configured cadence.
  setTimeout(() => {
    tick().catch(() => {
      // tick() already records errors; swallowing here keeps the timer alive
    });
  }, 10_000);

  const timer = setInterval(() => {
    tick().catch(() => {
      // see above
    });
  }, intervalMs);
  // Don't keep the Node process alive solely for the timer.
  if (typeof timer.unref === "function") timer.unref();
  globalThis.__codWhatsappAutoSyncTimer__ = timer;

  // Kick off the template-import cron alongside the order-sync cron. It
  // runs much less frequently (every 6 hours) so it won't slow boot time.
  startTemplateImportCron();
  startProductSyncCron();
  startTrackingRefreshCron().catch(() => undefined);
}

async function tickTemplateImport(): Promise<void> {
  try {
    const result = await importTemplatesFromMeta();
    await setSetting(
      SETTING_KEYS.WHATSAPP_TEMPLATES_LAST_IMPORT_AT,
      new Date().toISOString()
    );
    console.log(
      `[template-import] cron pulled ${result.imported} templates (${JSON.stringify(result.statusCounts)})`
    );
  } catch (err) {
    // Templates are non-critical — never crash the process if Meta is down
    // or the user hasn't configured a WABA ID yet.
    console.warn(
      "[template-import] cron tick failed",
      err instanceof Error ? err.message : err
    );
  }
}

function startTemplateImportCron(): void {
  if (globalThis.__codWhatsappTemplateImportTimer__) return;
  // Run once a minute after boot so the user sees templates on their first
  // visit (assuming a WABA ID is configured), then settle into the long
  // cadence so we don't hammer Meta.
  setTimeout(() => {
    tickTemplateImport().catch(() => undefined);
  }, 60_000);
  const timer = setInterval(
    () => {
      tickTemplateImport().catch(() => undefined);
    },
    TEMPLATE_IMPORT_INTERVAL_MINUTES * 60 * 1000
  );
  if (typeof timer.unref === "function") timer.unref();
  globalThis.__codWhatsappTemplateImportTimer__ = timer;
}

async function tickProductSync(): Promise<void> {
  try {
    const result = await syncProductsFromCodNetwork();
    console.log(
      `[product-sync] cron pulled ${result.fetched} products (${result.created} new, ${result.updated} updated)`
    );
  } catch (err) {
    // Products are non-critical — never crash the process if COD is down or
    // the user hasn't configured COD creds yet.
    console.warn(
      "[product-sync] cron tick failed",
      err instanceof Error ? err.message : err
    );
  }
}

function startProductSyncCron(): void {
  if (globalThis.__codWhatsappProductSyncTimer__) return;
  // Run 90 seconds after boot so the first visit to /products + the
  // automation editor's product picker have data, then settle into the
  // hourly cadence.
  setTimeout(() => {
    tickProductSync().catch(() => undefined);
  }, 90_000);
  const timer = setInterval(
    () => {
      tickProductSync().catch(() => undefined);
    },
    PRODUCT_SYNC_INTERVAL_MINUTES * 60 * 1000
  );
  if (typeof timer.unref === "function") timer.unref();
  globalThis.__codWhatsappProductSyncTimer__ = timer;
}

async function tickTrackingRefresh(): Promise<void> {
  try {
    // Auto-import new orders with iMile/Injaz tracking numbers
    const syncResult = await syncTrackingFromOrders();
    if (syncResult.imported > 0) {
      console.log(
        `[tracking-refresh] auto-imported ${syncResult.imported} new tracking orders from orders table`
      );
    }

    const { results, totalProcessed, batches } = await refreshAllTracking();
    const updated = results.filter((r) => r.eventsCount > 0).length;
    const errors = results.filter((r) => r.error).length;
    console.log(
      `[tracking-refresh] cron refreshed ${totalProcessed} orders in ${batches} batches (${updated} updated, ${errors} errors)`
    );
  } catch (err) {
    console.warn(
      "[tracking-refresh] cron tick failed",
      err instanceof Error ? err.message : err
    );
  }
}

async function resolveTrackingIntervalMinutes(): Promise<number> {
  const stored = await getSetting(SETTING_KEYS.TRACKING_REFRESH_INTERVAL_MINUTES);
  const parsed = stored ? parseInt(stored, 10) : DEFAULT_TRACKING_REFRESH_INTERVAL_MINUTES;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_TRACKING_REFRESH_INTERVAL_MINUTES;
  }
  return parsed;
}

async function startTrackingRefreshCron(): Promise<void> {
  if (globalThis.__codWhatsappTrackingRefreshTimer__) return;
  const intervalMinutes = await resolveTrackingIntervalMinutes();
  // First run 2 minutes after boot, then at configured interval.
  setTimeout(() => {
    tickTrackingRefresh().catch(() => undefined);
  }, 120_000);
  const timer = setInterval(
    () => {
      tickTrackingRefresh().catch(() => undefined);
    },
    intervalMinutes * 60 * 1000
  );
  if (typeof timer.unref === "function") timer.unref();
  globalThis.__codWhatsappTrackingRefreshTimer__ = timer;
}

export function getAutoSyncStatus(): AutoSyncStatus {
  return {
    running: !!globalThis.__codWhatsappAutoSyncStarted__,
    inProgress: isSyncInProgress(),
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    lastRunStartedAt: lastRunStartedAt?.toISOString() ?? null,
    lastRunFinishedAt: lastRunFinishedAt?.toISOString() ?? null,
    lastRunError,
    lastRunOrdersFound,
  };
}
