/**
 * Client for the iMile scheduling service
 * (https://github.com/hamoza33/imile_schedule, deployed at
 * https://imile.shopinzo.bond).
 *
 * The service is primarily an MCP server, but it also exposes a plain REST
 * surface under `/api` for server-to-server callers like the automation
 * engine. Everything here runs server-side only — the API key never reaches
 * the browser.
 */

import { SETTING_KEYS, getSettings } from "./settings";

const DEFAULT_API_URL = "https://imile.shopinzo.bond";
const REQUEST_TIMEOUT_MS = 30_000;

export interface ImileScheduleSuccess {
  success: true;
  trackingNumber: string;
  /** The date iMile actually accepted — may differ from the requested one. */
  scheduledDate: string;
  requestedDate: string;
  usedSuggestedDate: boolean;
  warning: string | null;
}

export interface ImileScheduleFailure {
  success: false;
  error: string;
  /** Date iMile offered instead, when it rejected the requested one. */
  suggestedDate?: string | null;
  availableDates?: string[];
}

export type ImileScheduleResult = ImileScheduleSuccess | ImileScheduleFailure;

interface ImileConfig {
  apiUrl: string;
  apiKey: string | null;
}

async function loadConfig(): Promise<ImileConfig> {
  const settings = await getSettings([
    SETTING_KEYS.IMILE_SCHEDULE_API_URL,
    SETTING_KEYS.IMILE_SCHEDULE_API_KEY,
  ]);
  const apiUrl =
    settings[SETTING_KEYS.IMILE_SCHEDULE_API_URL]?.trim() ||
    process.env.IMILE_SCHEDULE_API_URL?.trim() ||
    DEFAULT_API_URL;
  const apiKey =
    settings[SETTING_KEYS.IMILE_SCHEDULE_API_KEY]?.trim() ||
    process.env.IMILE_SCHEDULE_API_KEY?.trim() ||
    null;
  return { apiUrl: apiUrl.replace(/\/+$/, ""), apiKey };
}

/**
 * Format a date as `YYYY-MM-DD` in the given IANA timezone.
 *
 * iMile schedules by calendar day, so the date has to be resolved in the
 * operator's timezone (Settings → Automation → Timezone) rather than the
 * server's UTC clock — otherwise a late-evening run books the wrong day.
 */
export function formatDateInTimezone(date: Date, timeZone: string | null): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

/** Calendar date `daysAhead` days from `from`, in the given timezone. */
export function dateDaysAhead(
  daysAhead: number,
  timeZone: string | null,
  from: Date = new Date()
): string {
  const target = new Date(from.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  return formatDateInTimezone(target, timeZone);
}

/**
 * Reschedule an iMile parcel to `date` (YYYY-MM-DD).
 *
 * Never throws: transport errors and iMile refusals both come back as
 * `{ success: false }` so the automation engine can record them as a failed
 * step without aborting the whole run.
 */
export async function scheduleImileDelivery(
  trackingNumber: string,
  date: string
): Promise<ImileScheduleResult> {
  const { apiUrl, apiKey } = await loadConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl}/api/schedule`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ tracking_number: trackingNumber, date }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | (Partial<ImileScheduleSuccess> & Partial<ImileScheduleFailure>)
      | null;

    if (!response.ok || !payload?.success) {
      return {
        success: false,
        error:
          payload?.error ||
          `iMile scheduling service returned HTTP ${response.status}`,
        suggestedDate: payload?.suggestedDate ?? null,
        availableDates: payload?.availableDates ?? [],
      };
    }

    return {
      success: true,
      trackingNumber,
      scheduledDate: payload.scheduledDate || date,
      requestedDate: date,
      usedSuggestedDate: Boolean(payload.usedSuggestedDate),
      warning: payload.warning ?? null,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `iMile scheduling service timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    return { success: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
