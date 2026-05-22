/**
 * Courier Tracking Aggregator API provider.
 *
 * Calls the unified `/track` endpoint of the courier-tracking-api service
 * (https://github.com/hamoza33/courier-tracking-api) which supports iMile,
 * Injaz, J&T Express (with captcha solving), and JDW Logistics.
 *
 * This replaces the old 4tracking.net scraper and the manual JTE stub.
 */

import type { ParsedEvent, ProviderResult } from "./types";
import { TrackingCarrier } from "@prisma/client";

const DEFAULT_API_URL = "https://courier-tracking-api.fly.dev";

/**
 * Map from our internal TrackingCarrier enum to the courier-api carrier codes.
 */
const CARRIER_MAP: Partial<Record<TrackingCarrier, string>> = {
  [TrackingCarrier.IMILE]: "imile",
  [TrackingCarrier.INJAZ]: "injaz",
  [TrackingCarrier.JTE]: "jt",
  [TrackingCarrier.JDW]: "jdw",
};

interface CourierApiEvent {
  time: string | null;
  status: string | null;
  description: string;
  location?: string | null;
  timezone?: string | null;
}

interface CourierApiResult {
  carrier: string;
  carrierName: string;
  waybillNo: string;
  found: boolean;
  latestStatus: string | null;
  latestTime: string | null;
  events: CourierApiEvent[];
  extra?: Record<string, unknown>;
  warnings?: string[];
}

interface CourierApiError {
  error: string;
  carrier?: string;
  captchaRequired?: boolean;
}

function parseEvent(evt: CourierApiEvent): ParsedEvent {
  return {
    status: evt.status ?? evt.description,
    description: evt.description,
    location: evt.location ?? undefined,
    occurredAt: evt.time ? new Date(evt.time) : new Date(),
  };
}

/**
 * Fetch tracking for a single waybill via the courier-tracking-api.
 *
 * @param trackingNumber The waybill / tracking number
 * @param carrier Optional internal TrackingCarrier enum — maps to the API's carrier code.
 *                When omitted, the API auto-detects the carrier.
 * @param apiUrl Override the API base URL (defaults to the Fly.io deployment)
 */
export async function fetchCourierApiTracking(
  trackingNumber: string,
  carrier?: TrackingCarrier | null,
  apiUrl?: string
): Promise<ProviderResult> {
  const base = (apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
  const carrierCode = carrier ? CARRIER_MAP[carrier] : undefined;

  let url: string;
  if (carrierCode) {
    url = `${base}/track/${carrierCode}/${encodeURIComponent(trackingNumber)}`;
  } else {
    url = `${base}/track?waybill=${encodeURIComponent(trackingNumber)}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network_error";
    return { events: [], rawStatus: null, error: `courier_api_fetch_failed:${msg}` };
  }

  if (!response.ok) {
    let errBody: CourierApiError | null = null;
    try {
      errBody = (await response.json()) as CourierApiError;
    } catch { /* ignore */ }

    if (errBody?.captchaRequired) {
      return { events: [], rawStatus: null, error: "captcha_required" };
    }
    return {
      events: [],
      rawStatus: null,
      error: `courier_api_error:${response.status}:${errBody?.error ?? "unknown"}`,
    };
  }

  let data: CourierApiResult;
  try {
    data = (await response.json()) as CourierApiResult;
  } catch {
    return { events: [], rawStatus: null, error: "courier_api_invalid_json" };
  }

  if (!data.found || data.events.length === 0) {
    return {
      events: [],
      rawStatus: data.latestStatus,
      error: `not_found_on_courier_api`,
    };
  }

  const events = data.events.map(parseEvent);
  return {
    events,
    rawStatus: data.latestStatus,
  };
}

/**
 * Batch-fetch tracking for multiple waybills. Calls the courier API
 * sequentially for each number (the API doesn't have a batch endpoint).
 * Returns a map of tracking number → ProviderResult.
 */
export async function fetchCourierApiBatch(
  trackingNumbers: string[],
  carrier?: TrackingCarrier | null,
  apiUrl?: string
): Promise<Map<string, ProviderResult>> {
  const map = new Map<string, ProviderResult>();
  for (const tn of trackingNumbers) {
    const result = await fetchCourierApiTracking(tn, carrier, apiUrl);
    map.set(tn, result);
  }
  return map;
}
