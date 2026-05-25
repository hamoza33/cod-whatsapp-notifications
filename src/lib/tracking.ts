import { prisma } from "./prisma";
import { TrackingCarrier, TrackingStatus, type Prisma } from "@prisma/client";
import {
  SETTING_KEYS,
  getSettings,
} from "./settings";
import { runAutomationsForOrder } from "./automations";
import { fireTrackingStatusChangedFlows, safeFireFlows } from "./automation-flows/triggers";
import { fetchNaqelOfficialTracking } from "./tracking-providers/naqel";
import { fetchCourierApiTracking } from "./tracking-providers/courier-api";
import type {
  ProviderResult,
} from "./tracking-providers/types";

// ---------------------------------------------------------------------------
// Re-exports — keep the public surface stable for existing callers and for
// a potential rollback. Per-carrier scrapers live under src/lib/tracking-providers/.
//
// iMile, Injaz, J&T Express, and JDW Logistics all route through the
// unified courier-tracking-api (https://courier-tracking-api.fly.dev),
// which handles per-carrier auth, RSA signing for iMile, JT captcha
// solving, and JDW captcha solving server-side. Naqel is not supported
// by the courier API and continues to hit its public site scraper.
// ---------------------------------------------------------------------------

export async function fetchImileTracking(
  trackingNumber: string,
  apiUrl?: string
): Promise<ProviderResult> {
  return fetchCourierApiTracking(trackingNumber, TrackingCarrier.IMILE, apiUrl);
}

export async function fetchInjazTracking(
  trackingNumber: string,
  apiUrl?: string
): Promise<ProviderResult> {
  return fetchCourierApiTracking(trackingNumber, TrackingCarrier.INJAZ, apiUrl);
}

export async function fetchJteTracking(
  trackingNumber: string,
  apiUrl?: string
): Promise<ProviderResult> {
  return fetchCourierApiTracking(trackingNumber, TrackingCarrier.JTE, apiUrl);
}

export async function fetchJdwTracking(
  trackingNumber: string,
  apiUrl?: string
): Promise<ProviderResult> {
  return fetchCourierApiTracking(trackingNumber, TrackingCarrier.JDW, apiUrl);
}

export type { ParsedEvent, ProviderResult } from "./tracking-providers/types";

// ---------------------------------------------------------------------------
// Carrier detection
// ---------------------------------------------------------------------------

export function detectCarrier(
  trackingNumber: string,
  deliveryCompany?: string | null
): TrackingCarrier | null {
  const tn = trackingNumber.trim().toUpperCase();
  if (/^6[01]\d{11}$/.test(tn)) return TrackingCarrier.IMILE;
  if (tn.startsWith("INJAZ")) return TrackingCarrier.INJAZ;
  if (tn.startsWith("JTE")) return TrackingCarrier.JTE;
  if (tn.startsWith("JDW")) return TrackingCarrier.JDW;
  if (/^3\d{8,}$/.test(tn)) return TrackingCarrier.NAQEL;

  // Fallback: when the tracking-number prefix isn't recognized, fall back to
  // the operator-provided delivery-company string from the order. COD
  // Network exposes this as a free-text label (e.g. "iMile", "Injaz",
  // "J&T Express", "JD Logistics") so we match case-insensitively on the
  // common spellings.
  if (deliveryCompany) {
    const dc = deliveryCompany.toLowerCase();
    if (dc.includes("imile")) return TrackingCarrier.IMILE;
    if (dc.includes("injaz")) return TrackingCarrier.INJAZ;
    // Match J&T / JT / J&T Express only on a word boundary so labels like
    // "Future Logistics FJT" or "JT2 Cargo" don't get misclassified as JTE
    // and routed through the courier API's JT pipeline.
    // Normalize underscores / dots / slashes to spaces before testing so
    // operator labels like "JT_Express", "JT.Express" or "JT/Express"
    // aren't masked by the fact that `_` is a JS-regex word character
    // (so `\b` would not fire between `T` and `_`). After normalization
    // `\b` correctly fires while `FJT` / `JT2` / `Aramex JTX` still don't.
    const dcNormalized = dc.replace(/[_./]/g, " ");
    if (/\bj&?t(?:\s+express)?\b/i.test(dcNormalized))
      return TrackingCarrier.JTE;
    if (
      dc.includes("jdw") ||
      dc.includes("jingdong") ||
      dc.includes("jd logistics")
    )
      return TrackingCarrier.JDW;
    if (dc.includes("naqel"))
      return TrackingCarrier.NAQEL;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Carrier display name helper
// ---------------------------------------------------------------------------

export function carrierDisplayName(
  carrier: TrackingCarrier,
  deliveryCompany?: string | null
): string {
  switch (carrier) {
    case TrackingCarrier.IMILE:
      return "iMile";
    case TrackingCarrier.INJAZ:
      return "Injaz Express";
    case TrackingCarrier.JTE:
      return "JT Express";
    case TrackingCarrier.JDW:
      return "JD Logistics";
    case TrackingCarrier.NAQEL:
      return "Naqel Express";
    default:
      return deliveryCompany || "Other";
  }
}

// ---------------------------------------------------------------------------
// Single-carrier dispatcher (kept for the per-row Refresh button)
// ---------------------------------------------------------------------------

async function fetchTrackingByCarrier(
  carrier: TrackingCarrier,
  trackingNumber: string
): Promise<ProviderResult> {
  // Naqel is handled directly — the courier-tracking-api does not
  // support it. Every other carrier (iMile, Injaz, JTE, JDW) goes
  // through the unified courier API so we have one consistent source
  // of tracking data across the entire fleet.
  if (carrier === TrackingCarrier.NAQEL) {
    return fetchNaqelOfficialTracking(trackingNumber);
  }
  if (
    carrier === TrackingCarrier.IMILE ||
    carrier === TrackingCarrier.INJAZ ||
    carrier === TrackingCarrier.JTE ||
    carrier === TrackingCarrier.JDW
  ) {
    const settings = await getSettings([SETTING_KEYS.COURIER_TRACKING_API_URL]);
    const apiUrl = settings[SETTING_KEYS.COURIER_TRACKING_API_URL] || undefined;
    return fetchCourierApiTracking(trackingNumber, carrier, apiUrl);
  }
  return { events: [], rawStatus: null };
}

// ---------------------------------------------------------------------------
// Unified tracking status mapper
// ---------------------------------------------------------------------------

function mapToTrackingStatus(
  _carrier: TrackingCarrier,
  rawStatus: string | null
): TrackingStatus {
  if (!rawStatus) return TrackingStatus.UNKNOWN;

  const s = rawStatus.toLowerCase();

  if (s.includes("delivered") || s.includes("signed"))
    return TrackingStatus.DELIVERED;
  if (s.includes("out for delivery") || s.includes("dispatched"))
    return TrackingStatus.OUT_FOR_DELIVERY;
  if (
    s.includes("transit") ||
    s.includes("in transit") ||
    s.includes("pick up") ||
    s.includes("pickup") ||
    s.includes("send to") ||
    s.includes("departed") ||
    s.includes("arrived") ||
    s.includes("shipping") ||
    s.includes("on the way") ||
    s.includes("in warehouse")
  )
    return TrackingStatus.IN_TRANSIT;
  if (
    s.includes("order creation") ||
    s.includes("receive") ||
    s.includes("pending") ||
    s.includes("created") ||
    s.includes("accepted") ||
    s.includes("info recieved") ||
    s.includes("info received")
  )
    return TrackingStatus.PENDING;
  if (s.includes("return")) return TrackingStatus.RETURNED;
  if (
    s.includes("exception") ||
    s.includes("failed") ||
    s.includes("problem") ||
    s.includes("expired")
  )
    return TrackingStatus.EXCEPTION;

  return TrackingStatus.IN_TRANSIT;
}

// ---------------------------------------------------------------------------
// Apply a fetched ProviderResult to a TrackingOrder row.
// Used by both refreshTracking() (single-row) and refreshAllTracking()
// (worker pools) so they share identical persistence semantics.
// ---------------------------------------------------------------------------

interface ApplyOpts {
  orderId: string;
  trackingNumber: string;
  currentLatestEvent: string | null;
  currentLatestEventAt: Date | null;
  carrier: TrackingCarrier;
}

async function applyTrackingResult(
  opts: ApplyOpts,
  result: ProviderResult
): Promise<{ status: TrackingStatus; eventsCount: number }> {
  const { events, rawStatus, error } = result;
  const status = mapToTrackingStatus(opts.carrier, rawStatus);

  for (const evt of events) {
    await prisma.trackingEvent.upsert({
      where: {
        trackingOrderId_description_occurredAt: {
          trackingOrderId: opts.orderId,
          description: evt.description,
          occurredAt: evt.occurredAt,
        },
      },
      create: {
        trackingOrderId: opts.orderId,
        status: evt.status,
        description: evt.description,
        location: evt.location ?? null,
        occurredAt: evt.occurredAt,
        rawData: (evt.rawData ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: {},
    });
  }

  // NOTE: We previously upserted a `_debug:<error>` TrackingEvent here when
  // the provider returned no events but did report an error. With
  // `latestError` now living on the TrackingOrder row itself, that debug
  // event is duplicate signal that bloats `tracking_events` linearly across
  // refresh ticks (the unique index only collapses collisions inside the
  // same wall-clock second) and surfaces in the per-row timeline UI as
  // unhelpful "_debug:jte_manual_only" entries. The error code is still
  // persisted via `latestError` below.

  const latestEvent = events.length > 0 ? events[0] : null;

  const newLatestEvent = latestEvent?.description ?? opts.currentLatestEvent;

  await prisma.trackingOrder.update({
    where: { id: opts.orderId },
    data: {
      status,
      latestEvent: newLatestEvent,
      latestEventAt: latestEvent?.occurredAt ?? opts.currentLatestEventAt,
      latestError: error ?? null,
      lastCheckedAt: new Date(),
    },
  });

  // If the latest event changed and this tracking order is linked to an
  // Order, run automations so tracking-status-based rules can fire.
  if (latestEvent && newLatestEvent !== opts.currentLatestEvent) {
    const trackingRow = await prisma.trackingOrder.findUnique({
      where: { id: opts.orderId },
      select: { orderId: true },
    });
    if (trackingRow?.orderId) {
      runAutomationsForOrder(trackingRow.orderId!, { autoTriggered: true }).catch((err) =>
        console.error("[tracking] automation trigger failed", err)
      );
      safeFireFlows(
        fireTrackingStatusChangedFlows(
          trackingRow.orderId,
          null,
          status
        ),
        `TRACKING_STATUS_CHANGED flow for order ${trackingRow.orderId}`
      ).catch(() => {});
    }
  }

  return { status, eventsCount: events.length };
}

// ---------------------------------------------------------------------------
// Refresh a single tracking order (per-row Refresh button)
// ---------------------------------------------------------------------------

export async function refreshTracking(trackingOrderId: string) {
  const order = await prisma.trackingOrder.findUnique({
    where: { id: trackingOrderId },
  });
  if (!order) throw new Error("Tracking order not found");

  if (order.carrier === TrackingCarrier.OTHER) {
    await prisma.trackingOrder.update({
      where: { id: order.id },
      data: { lastCheckedAt: new Date() },
    });
    return { status: order.status, eventsCount: 0 };
  }

  const result = await fetchTrackingByCarrier(
    order.carrier,
    order.trackingNumber
  );

  return applyTrackingResult(
    {
      orderId: order.id,
      trackingNumber: order.trackingNumber,
      currentLatestEvent: order.latestEvent,
      currentLatestEventAt: order.latestEventAt,
      carrier: order.carrier,
    },
    result
  );
}

// ---------------------------------------------------------------------------
// Auto-import: scan the orders table for ALL orders with tracking numbers
// and create TrackingOrder records.
// ---------------------------------------------------------------------------

export async function syncTrackingFromOrders() {
  const orders = await prisma.order.findMany({
    where: {
      trackingNumber: { not: null },
    },
    select: {
      id: true,
      trackingNumber: true,
      customerName: true,
      customerPhone: true,
      deliveryCompany: true,
      productName: true,
      codCreatedAt: true,
    },
  });

  let imported = 0;
  let skipped = 0;
  let updated = 0;

  for (const order of orders) {
    if (!order.trackingNumber) continue;
    const tn = order.trackingNumber.trim();
    if (!tn) { skipped++; continue; }

    const carrier =
      detectCarrier(tn, order.deliveryCompany) ?? TrackingCarrier.OTHER;
    const carrierName = carrierDisplayName(carrier, order.deliveryCompany);

    const existing = await prisma.trackingOrder.findUnique({
      where: { trackingNumber: tn },
    });
    if (existing) {
      const carrierChanged =
        existing.carrier === TrackingCarrier.OTHER &&
        carrier !== TrackingCarrier.OTHER;
      const needsUpdate =
        carrierChanged ||
        existing.customerName !== order.customerName ||
        existing.customerPhone !== order.customerPhone ||
        existing.productName !== order.productName ||
        existing.orderId !== order.id;
      if (needsUpdate) {
        await prisma.trackingOrder.update({
          where: { id: existing.id },
          data: {
            ...(carrierChanged ? { carrier, carrierName } : {}),
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            productName: order.productName,
            codCreatedAt: order.codCreatedAt,
            orderId: order.id,
          },
        });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    await prisma.trackingOrder.create({
      data: {
        trackingNumber: tn,
        carrier,
        carrierName,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        productName: order.productName,
        codCreatedAt: order.codCreatedAt,
        orderId: order.id,
      },
    });
    imported++;
  }

  return { imported, skipped, updated, totalScanned: orders.length };
}

// ---------------------------------------------------------------------------
// Re-classify OTHER tracking orders using improved carrier detection
// ---------------------------------------------------------------------------

export async function reclassifyOtherOrders(deadlineMs?: number) {
  const otherOrders = await prisma.trackingOrder.findMany({
    where: { carrier: TrackingCarrier.OTHER },
    include: {
      order: {
        select: { deliveryCompany: true },
      },
    },
    take: RECLASSIFY_TAKE,
  });

  let reclassified = 0;
  // Drive the per-row UPDATE through drainQueue with chunk-size 1 so 5
  // Postgres writes overlap (matching the carrier-pool topology) and so
  // each worker honours the same wall-clock deadline used by the carrier
  // pools downstream. Without this, a 1,200-row OTHER bucket can blow
  // the entire 45 s budget before any pool starts.
  const queue: typeof otherOrders = [...otherOrders];
  const effectiveDeadline = deadlineMs ?? Number.POSITIVE_INFINITY;
  await drainQueue(queue, RECLASSIFY_CONCURRENCY, effectiveDeadline, async (order) => {
    const deliveryCompany = order.order?.deliveryCompany ?? null;
    const newCarrier = detectCarrier(order.trackingNumber, deliveryCompany);
    if (newCarrier && newCarrier !== TrackingCarrier.OTHER) {
      const newCarrierName = carrierDisplayName(newCarrier, deliveryCompany);
      await prisma.trackingOrder.update({
        where: { id: order.id },
        data: { carrier: newCarrier, carrierName: newCarrierName },
      });
      reclassified++;
    }
  });

  const cappedAt = otherOrders.length === RECLASSIFY_TAKE ? RECLASSIFY_TAKE : null;
  return {
    reclassified,
    totalScanned: otherOrders.length,
    ...(cappedAt !== null ? { cappedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Bulk refresh — 5 concurrent worker pools, one per carrier.
//
// Every carrier the courier-tracking-api supports — iMile, Injaz, JTE,
// JDW — now routes through a single unified provider call. This keeps
// the source of truth consistent across the entire shipment fleet and
// removes the per-carrier authentication / captcha plumbing from this
// codebase. Naqel is the lone exception because the courier API does
// not support it; it continues to hit the Naqel public site scraper.
//
// Pool topology:
//   - imile: 5 workers, chunk-size 1, calling fetchCourierApiTracking().
//   - injaz: 5 workers, chunk-size 1, calling fetchCourierApiTracking().
//   - jdw:   5 workers, chunk-size 1, calling fetchCourierApiTracking().
//   - jte:   3 workers, chunk-size 1, calling fetchCourierApiTracking().
//            Lower concurrency because each JTE call triggers a Tencent
//            Captcha solve upstream and routinely takes 30+ seconds.
//   - naqel: 5 workers, chunk-size 1, calling fetchNaqelOfficialTracking().
//
// Each per-tracking-number outcome is persisted via applyTrackingResult().
// The TrackingOrder.lastCheckedAt always advances even on error so the next
// cron tick doesn't re-pick the same failed orders first.
//
// Bounded by a wall-clock timeout instead of MAX_PER_REQUEST so a single
// HTTP /api/tracking/refresh call returns within Fly's request timeout while
// still draining as many orders as possible per call.
// ---------------------------------------------------------------------------

const IMILE_CONCURRENCY = 5;
const INJAZ_CONCURRENCY = 5;
const JDW_CONCURRENCY = 5;
const RECLASSIFY_CONCURRENCY = 5;
const RECLASSIFY_TAKE = 250;
const DEFAULT_WALL_CLOCK_MS = 45_000;

interface ActiveOrderRow {
  id: string;
  trackingNumber: string;
  carrier: TrackingCarrier;
  status: TrackingStatus;
  latestEvent: string | null;
  latestEventAt: Date | null;
}

interface PerCarrierStats {
  processed: number;
  eventsAdded: number;
  errors: number;
}

function emptyStats(): PerCarrierStats {
  return { processed: 0, eventsAdded: 0, errors: 0 };
}

export interface RefreshResultEntry {
  id: string;
  trackingNumber: string;
  status: string;
  eventsCount: number;
  error?: string;
}

export interface RefreshAllResult {
  results: RefreshResultEntry[];
  totalProcessed: number;
  batches: number;
  remaining: number;
  totalActive: number;
  reclassified: number;
  byCarrier: {
    imile: PerCarrierStats;
    jte: PerCarrierStats;
    jdw: PerCarrierStats;
    injaz: PerCarrierStats;
    naqel: PerCarrierStats;
  };
}

export async function refreshAllTracking(
  limit?: number
): Promise<RefreshAllResult> {
  const wallClockMs = DEFAULT_WALL_CLOCK_MS;
  const startedAt = Date.now();
  const deadline = startedAt + wallClockMs;

  // Run reclassification BEFORE the findMany of active orders, but inside
  // the same wall-clock deadline. This prevents a large OTHER bucket
  // (e.g. ~1,200 stuck rows) from pushing the /api/tracking/refresh route
  // past Fly's request timeout before the deadline even begins counting.
  // reclassifyOtherOrders honours the deadline internally via drainQueue
  // and is also row-capped via RECLASSIFY_TAKE so a single tick can never
  // burn the entire budget on reclassification.
  const reclassifyResult = await reclassifyOtherOrders(deadline);

  // Read the courier API URL override once so every pool shares it.
  const trackingSettings = await getSettings([
    SETTING_KEYS.COURIER_TRACKING_API_URL,
  ]);
  const courierApiUrl =
    trackingSettings[SETTING_KEYS.COURIER_TRACKING_API_URL] || undefined;

  const activeFilter = {
    status: {
      in: [
        TrackingStatus.PENDING,
        TrackingStatus.IN_TRANSIT,
        TrackingStatus.OUT_FOR_DELIVERY,
        TrackingStatus.EXCEPTION,
        TrackingStatus.UNKNOWN,
      ],
    },
    carrier: { not: TrackingCarrier.OTHER },
  };

  const totalActive = await prisma.trackingOrder.count({ where: activeFilter });

  // Pull a healthy chunk per call but don't try to do everything at once.
  // The UI loops until remaining===0 anyway, and the wall-clock guard above
  // ensures we never exceed Fly's request timeout. A `limit` argument from
  // a caller (e.g. cron) overrides the default cap.
  const take = limit ?? 500;
  const activeOrders = (await prisma.trackingOrder.findMany({
    where: activeFilter,
    orderBy: [{ lastCheckedAt: "asc" }, { createdAt: "asc" }],
    take,
    select: {
      id: true,
      trackingNumber: true,
      carrier: true,
      status: true,
      latestEvent: true,
      latestEventAt: true,
    },
  })) as ActiveOrderRow[];

  // Group by carrier into 5 buckets.
  const buckets = {
    imile: [] as ActiveOrderRow[],
    jte: [] as ActiveOrderRow[],
    jdw: [] as ActiveOrderRow[],
    injaz: [] as ActiveOrderRow[],
    naqel: [] as ActiveOrderRow[],
  };
  for (const o of activeOrders) {
    if (o.carrier === TrackingCarrier.IMILE) buckets.imile.push(o);
    else if (o.carrier === TrackingCarrier.JTE) buckets.jte.push(o);
    else if (o.carrier === TrackingCarrier.JDW) buckets.jdw.push(o);
    else if (o.carrier === TrackingCarrier.INJAZ) buckets.injaz.push(o);
    else if (o.carrier === TrackingCarrier.NAQEL) buckets.naqel.push(o);
  }

  const results: RefreshResultEntry[] = [];
  const byCarrier = {
    imile: emptyStats(),
    jte: emptyStats(),
    jdw: emptyStats(),
    injaz: emptyStats(),
    naqel: emptyStats(),
  };

  // Track how many chunks were dispatched in total — surfaced as `batches`
  // for backward compatibility with the existing /api response.
  let totalChunks = 0;

  const recordOutcome = (
    order: ActiveOrderRow,
    outcome:
      | { ok: true; status: TrackingStatus; eventsCount: number; error?: string }
      | { ok: false; error: string }
  ) => {
    const carrierKey: keyof typeof byCarrier =
      order.carrier === TrackingCarrier.IMILE
        ? "imile"
        : order.carrier === TrackingCarrier.JTE
        ? "jte"
        : order.carrier === TrackingCarrier.JDW
        ? "jdw"
        : order.carrier === TrackingCarrier.NAQEL
        ? "naqel"
        : "injaz";
    if (outcome.ok) {
      byCarrier[carrierKey].processed += 1;
      byCarrier[carrierKey].eventsAdded += outcome.eventsCount;
      if (outcome.error) byCarrier[carrierKey].errors += 1;
      results.push({
        id: order.id,
        trackingNumber: order.trackingNumber,
        status: outcome.status,
        eventsCount: outcome.eventsCount,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    } else {
      byCarrier[carrierKey].processed += 1;
      byCarrier[carrierKey].errors += 1;
      results.push({
        id: order.id,
        trackingNumber: order.trackingNumber,
        status: order.status,
        eventsCount: 0,
        error: outcome.error,
      });
    }
  };

  // ---------- iMile pool: 5 workers, one number at a time ----------
  // Routes through the unified courier-tracking-api.
  const imileQueue: ActiveOrderRow[][] = buckets.imile.map((o) => [o]);
  totalChunks += imileQueue.length;

  const imilePool = drainQueue(
    imileQueue,
    IMILE_CONCURRENCY,
    deadline,
    async (chunk) => {
      for (const o of chunk) {
        let result: ProviderResult;
        try {
          result = await fetchCourierApiTracking(
            o.trackingNumber,
            TrackingCarrier.IMILE,
            courierApiUrl
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch_failed";
          result = {
            events: [],
            rawStatus: null,
            error: `courier_api_error:${detail}`,
          };
        }
        try {
          const persisted = await applyTrackingResult(
            {
              orderId: o.id,
              trackingNumber: o.trackingNumber,
              currentLatestEvent: o.latestEvent,
              currentLatestEventAt: o.latestEventAt,
              carrier: o.carrier,
            },
            result
          );
          recordOutcome(o, {
            ok: true,
            status: persisted.status,
            eventsCount: persisted.eventsCount,
            error: result.error,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : "apply_failed";
          recordOutcome(o, { ok: false, error: detail });
        }
      }
    }
  );

  // ---------- JTE pool: courier-tracking-api, 3 workers, one number at a time ----------
  // The courier API handles Tencent Captcha solving for JT Express. Each call
  // takes ~10-30s due to captcha solve time, so we limit concurrency.
  const JTE_CONCURRENCY = 3;
  const jteQueue: ActiveOrderRow[][] = buckets.jte.map((o) => [o]);
  totalChunks += jteQueue.length;

  const jtePool = drainQueue(
    jteQueue,
    JTE_CONCURRENCY,
    deadline,
    async (chunk) => {
      for (const o of chunk) {
        let result: ProviderResult;
        try {
          result = await fetchCourierApiTracking(
            o.trackingNumber,
            TrackingCarrier.JTE,
            courierApiUrl
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch_failed";
          result = {
            events: [],
            rawStatus: null,
            error: `courier_api_error:${detail}`,
          };
        }
        try {
          const persisted = await applyTrackingResult(
            {
              orderId: o.id,
              trackingNumber: o.trackingNumber,
              currentLatestEvent: o.latestEvent,
              currentLatestEventAt: o.latestEventAt,
              carrier: o.carrier,
            },
            result
          );
          recordOutcome(o, {
            ok: true,
            status: persisted.status,
            eventsCount: persisted.eventsCount,
            error: result.error,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : "apply_failed";
          recordOutcome(o, { ok: false, error: detail });
        }
      }
    }
  );

  // ---------- Naqel pool: 5 workers, one number at a time ----------
  // Naqel is not supported by the courier-tracking-api, so we call the
  // Naqel official site scraper directly.
  const NAQEL_CONCURRENCY = 5;
  const naqelQueue: ActiveOrderRow[][] = buckets.naqel.map((o) => [o]);
  totalChunks += naqelQueue.length;

  const naqelPool = drainQueue(
    naqelQueue,
    NAQEL_CONCURRENCY,
    deadline,
    async (chunk) => {
      for (const o of chunk) {
        let result: ProviderResult;
        try {
          result = await fetchNaqelOfficialTracking(o.trackingNumber);
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch_failed";
          result = {
            events: [],
            rawStatus: null,
            error: `naqel_error:${detail}`,
          };
        }
        try {
          const persisted = await applyTrackingResult(
            {
              orderId: o.id,
              trackingNumber: o.trackingNumber,
              currentLatestEvent: o.latestEvent,
              currentLatestEventAt: o.latestEventAt,
              carrier: o.carrier,
            },
            result
          );
          recordOutcome(o, {
            ok: true,
            status: persisted.status,
            eventsCount: persisted.eventsCount,
            error: result.error,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : "apply_failed";
          recordOutcome(o, { ok: false, error: detail });
        }
      }
    }
  );

  // ---------- JDW pool: 5 workers, one number at a time ----------
  // Routes through the unified courier-tracking-api.
  const jdwQueue: ActiveOrderRow[][] = buckets.jdw.map((o) => [o]);
  totalChunks += jdwQueue.length;

  const jdwPool = drainQueue(
    jdwQueue,
    JDW_CONCURRENCY,
    deadline,
    async (chunk) => {
      for (const o of chunk) {
        let result: ProviderResult;
        try {
          result = await fetchCourierApiTracking(
            o.trackingNumber,
            TrackingCarrier.JDW,
            courierApiUrl
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch_failed";
          result = {
            events: [],
            rawStatus: null,
            error: `courier_api_error:${detail}`,
          };
        }
        try {
          const persisted = await applyTrackingResult(
            {
              orderId: o.id,
              trackingNumber: o.trackingNumber,
              currentLatestEvent: o.latestEvent,
              currentLatestEventAt: o.latestEventAt,
              carrier: o.carrier,
            },
            result
          );
          recordOutcome(o, {
            ok: true,
            status: persisted.status,
            eventsCount: persisted.eventsCount,
            error: result.error,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : "apply_failed";
          recordOutcome(o, { ok: false, error: detail });
        }
      }
    }
  );

  // ---------- Injaz pool: 5 workers, one number at a time ----------
  // Routes through the unified courier-tracking-api.
  const injazQueue: ActiveOrderRow[][] = buckets.injaz.map((o) => [o]);
  totalChunks += injazQueue.length;

  const injazPool = drainQueue(
    injazQueue,
    INJAZ_CONCURRENCY,
    deadline,
    async (chunk) => {
      for (const o of chunk) {
        let result: ProviderResult;
        try {
          result = await fetchCourierApiTracking(
            o.trackingNumber,
            TrackingCarrier.INJAZ,
            courierApiUrl
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch_failed";
          result = { events: [], rawStatus: null, error: `courier_api_error:${detail}` };
        }
        try {
          const persisted = await applyTrackingResult(
            {
              orderId: o.id,
              trackingNumber: o.trackingNumber,
              currentLatestEvent: o.latestEvent,
              currentLatestEventAt: o.latestEventAt,
              carrier: o.carrier,
            },
            result
          );
          recordOutcome(o, {
            ok: true,
            status: persisted.status,
            eventsCount: persisted.eventsCount,
            error: result.error,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : "apply_failed";
          recordOutcome(o, { ok: false, error: detail });
        }
      }
    }
  );

  // Run all 4 pools concurrently. Each pool drains its own queue with its
  // own worker count. The shared deadline + applyTrackingResult writes mean
  // the orchestration is naturally back-pressured by Postgres latency.
  await Promise.all([imilePool, injazPool, jdwPool, jtePool, naqelPool]);

  const totalProcessed = results.length;
  const remaining = Math.max(0, totalActive - totalProcessed);

  return {
    results,
    totalProcessed,
    batches: totalChunks,
    remaining,
    totalActive,
    reclassified: reclassifyResult.reclassified,
    byCarrier,
  };
}

// ---------------------------------------------------------------------------
// Internal: drain a queue of chunks with a fixed concurrency, respecting a
// shared wall-clock deadline. Each worker pulls the next chunk off the queue
// and stops when (a) the queue is empty or (b) the deadline has passed.
// ---------------------------------------------------------------------------

async function drainQueue<T>(
  queue: T[],
  concurrency: number,
  deadlineMs: number,
  handler: (chunk: T) => Promise<void>
): Promise<void> {
  if (queue.length === 0) return;
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (true) {
        if (Date.now() > deadlineMs) return;
        const next = queue.shift();
        if (!next) return;
        try {
          await handler(next);
        } catch (err) {
          // The handler is responsible for recording per-chunk failures.
          // This catch is a safety net for unexpected throws.
          console.warn(
            "[tracking-refresh] worker error",
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  );
  await Promise.all(workers);
}
