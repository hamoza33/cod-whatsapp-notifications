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
  [TrackingCarrier.NAQEL]: "naqel",
};

// Single-waybill timeout. JTE has to solve a Tencent slider captcha
// server-side which routinely takes 60-90 s, so the timeout must be
// generous enough for the slow-path or every JTE order falls through to
// `courier_api_fetch_failed:timeout` and lands in UNKNOWN.
const SINGLE_TIMEOUT_DEFAULT_MS = 30_000;
const SINGLE_TIMEOUT_JTE_MS = 120_000;

function singleTimeoutFor(carrier?: TrackingCarrier | null): number {
  return carrier === TrackingCarrier.JTE
    ? SINGLE_TIMEOUT_JTE_MS
    : SINGLE_TIMEOUT_DEFAULT_MS;
}

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
      signal: AbortSignal.timeout(singleTimeoutFor(carrier)),
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
 * Bulk-fetch tracking for up to 100 waybills in a single HTTP request via
 * the courier API's `POST /track/bulk` endpoint. The API processes non-JT
 * waybills in parallel server-side, so this is dramatically faster than
 * calling /track once per waybill (≈50 numbers per few seconds).
 *
 * J&T waybills are processed sequentially server-side due to the captcha
 * solve, so when the chunk contains JTE numbers they still pay that cost.
 *
 * Returns a Map keyed by trimmed tracking number. Missing entries fall back
 * to a `bulk_missing_response` error.
 */
const BULK_MAX_PER_REQUEST = 100;

interface CourierApiBulkRequestItem {
  waybill: string;
  carrier?: string;
}

interface CourierApiBulkResponseItem {
  waybill: string;
  carrier: string;
  result?: CourierApiResult;
  error?: { message: string; captchaRequired?: boolean };
}

interface CourierApiBulkResponse {
  total: number;
  successful: number;
  failed: number;
  results: CourierApiBulkResponseItem[];
}

export async function fetchCourierApiBulk(
  trackingNumbers: string[],
  carrier?: TrackingCarrier | null,
  apiUrl?: string
): Promise<Map<string, ProviderResult>> {
  const map = new Map<string, ProviderResult>();
  if (trackingNumbers.length === 0) return map;

  const base = (apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
  const carrierCode = carrier ? CARRIER_MAP[carrier] : undefined;

  for (let i = 0; i < trackingNumbers.length; i += BULK_MAX_PER_REQUEST) {
    const slice = trackingNumbers.slice(i, i + BULK_MAX_PER_REQUEST);
    const items: CourierApiBulkRequestItem[] = slice.map((tn) =>
      carrierCode
        ? { waybill: tn, carrier: carrierCode }
        : { waybill: tn }
    );

    let response: Response;
    try {
      response = await fetch(`${base}/track/bulk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ waybills: items }),
        // Allow generous time for chunks containing J&T (~30s/item sequential).
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network_error";
      for (const tn of slice) {
        map.set(tn, {
          events: [],
          rawStatus: null,
          error: `courier_api_bulk_failed:${msg}`,
        });
      }
      continue;
    }

    if (!response.ok) {
      let errMsg = "unknown";
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) errMsg = body.error;
      } catch {
        /* ignore */
      }
      for (const tn of slice) {
        map.set(tn, {
          events: [],
          rawStatus: null,
          error: `courier_api_bulk_error:${response.status}:${errMsg}`,
        });
      }
      continue;
    }

    let body: CourierApiBulkResponse;
    try {
      body = (await response.json()) as CourierApiBulkResponse;
    } catch {
      for (const tn of slice) {
        map.set(tn, {
          events: [],
          rawStatus: null,
          error: "courier_api_bulk_invalid_json",
        });
      }
      continue;
    }

    for (const item of body.results) {
      const waybill = item.waybill;
      if (item.error) {
        if (item.error.captchaRequired) {
          map.set(waybill, {
            events: [],
            rawStatus: null,
            error: "captcha_required",
          });
        } else {
          map.set(waybill, {
            events: [],
            rawStatus: null,
            error: `courier_api_bulk_item_error:${item.error.message}`,
          });
        }
        continue;
      }
      const result = item.result;
      if (!result || !result.found || result.events.length === 0) {
        map.set(waybill, {
          events: [],
          rawStatus: result?.latestStatus ?? null,
          error: "not_found_on_courier_api",
        });
        continue;
      }
      map.set(waybill, {
        events: result.events.map(parseEvent),
        rawStatus: result.latestStatus,
      });
    }

    // Fill in any waybill that the response did not echo back.
    for (const tn of slice) {
      if (!map.has(tn)) {
        map.set(tn, {
          events: [],
          rawStatus: null,
          error: "bulk_missing_response",
        });
      }
    }
  }

  return map;
}

/**
 * Legacy per-call batch helper kept for any consumer that hasn't migrated
 * to the bulk endpoint yet. Internally now delegates to fetchCourierApiBulk
 * so callers get the bulk speed-up for free.
 */
export async function fetchCourierApiBatch(
  trackingNumbers: string[],
  carrier?: TrackingCarrier | null,
  apiUrl?: string
): Promise<Map<string, ProviderResult>> {
  return fetchCourierApiBulk(trackingNumbers, carrier, apiUrl);
}
