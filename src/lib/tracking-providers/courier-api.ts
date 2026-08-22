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

const DEFAULT_API_URL = "https://tracking.shopinzo.bond";

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
  // In the current API `latestStatus` is the canonical category (one of
  // "In Transit" | "Out for Delivery" | "Delivered" | "Returned") while the
  // raw carrier-side text lives in `latestStatusDetail`. `normalizedStatus`
  // carries the same canonical value explicitly. Older deployments only set
  // `latestStatus` (raw) and omit the other two, so both are optional.
  latestStatus: string | null;
  latestStatusDetail?: string | null;
  normalizedStatus?: string | null;
  latestTime: string | null;
  events: CourierApiEvent[];
  extra?: Record<string, unknown>;
  warnings?: string[];
}

/**
 * Pull the raw carrier-side status text out of a result, preferring the
 * dedicated `latestStatusDetail` field (new API) and falling back to
 * `latestStatus` (older API where it still held the raw text).
 */
function rawStatusOf(data: CourierApiResult): string | null {
  return data.latestStatusDetail ?? data.latestStatus;
}

/**
 * Pull the canonical category out of a result. Prefers the explicit
 * `normalizedStatus` field; on the current API `latestStatus` is also the
 * canonical value, so it's an equivalent fallback.
 */
function normalizedStatusOf(data: CourierApiResult): string | null {
  return data.normalizedStatus ?? null;
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
 * @param apiUrl Override the API base URL (defaults to tracking.shopinzo.bond)
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
      rawStatus: rawStatusOf(data),
      normalizedStatus: normalizedStatusOf(data),
      error: `not_found_on_courier_api`,
    };
  }

  const events = data.events.map(parseEvent);
  return {
    events,
    rawStatus: rawStatusOf(data),
    normalizedStatus: normalizedStatusOf(data),
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
const BULK_DEFAULT_TIMEOUT_MS = 120_000;

export interface CourierApiBulkOptions {
  /** Max waybills per HTTP request. Defaults to 100 (server cap is 250). */
  maxPerRequest?: number;
  /**
   * Per-request timeout. Defaults to 120s. J&T chunks need more headroom
   * because each waybill requires a captcha solve; the server runs them with
   * bounded concurrency (JT_BULK_CONCURRENCY groups at a time).
   */
  timeoutMs?: number;
  /**
   * J&T provider hint forwarded to the courier-tracking-api:
   *   - "auto" (default): TrackingMore first, Tencent captcha fallback.
   *   - "trackingmore": force the TrackingMore page (Turnstile via 2Captcha).
   *   - "tencent": force the legacy Tencent-captcha solver.
   * Ignored for non-J&T carriers.
   */
  jtProvider?: "auto" | "trackingmore" | "tencent";
}

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
  apiUrl?: string,
  opts: CourierApiBulkOptions = {}
): Promise<Map<string, ProviderResult>> {
  const map = new Map<string, ProviderResult>();
  if (trackingNumbers.length === 0) return map;

  const base = (apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
  const carrierCode = carrier ? CARRIER_MAP[carrier] : undefined;
  const maxPerRequest = Math.max(
    1,
    Math.min(250, opts.maxPerRequest ?? BULK_MAX_PER_REQUEST)
  );
  const timeoutMs = opts.timeoutMs ?? BULK_DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < trackingNumbers.length; i += maxPerRequest) {
    const slice = trackingNumbers.slice(i, i + maxPerRequest);
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
        body: JSON.stringify(
          opts.jtProvider
            ? { waybills: items, jtProvider: opts.jtProvider }
            : { waybills: items }
        ),
        // Allow generous time for chunks containing J&T (captcha solved
        // server-side with bounded concurrency). Configurable per carrier.
        signal: AbortSignal.timeout(timeoutMs),
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
          rawStatus: result ? rawStatusOf(result) : null,
          normalizedStatus: result ? normalizedStatusOf(result) : null,
          error: "not_found_on_courier_api",
        });
        continue;
      }
      map.set(waybill, {
        events: result.events.map(parseEvent),
        rawStatus: rawStatusOf(result),
        normalizedStatus: normalizedStatusOf(result),
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
