import { syncOrders, isSyncInProgress } from "./sync";
import { getSetting, SETTING_KEYS } from "./settings";

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
}

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;

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
