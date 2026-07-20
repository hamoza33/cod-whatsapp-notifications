import { prisma } from "./prisma";
import { TrackingCarrier, TrackingStatus, type Prisma } from "@prisma/client";
import {
  SETTING_KEYS,
  getSettings,
} from "./settings";
import { runAutomationsForOrder } from "./automations";
import { fireTrackingStatusChangedFlows, safeFireFlows } from "./automation-flows/triggers";
import {
  fetchCourierApiBulk,
  fetchCourierApiTracking,
} from "./tracking-providers/courier-api";
import type {
  ProviderResult,
} from "./tracking-providers/types";

// ---------------------------------------------------------------------------
// Re-exports — keep the public surface stable for existing callers and for
// a potential rollback. Per-carrier scrapers live under src/lib/tracking-providers/.
//
// iMile, Injaz, J&T Express, JDW Logistics and Naqel Express all route
// through the unified courier-tracking-api
// (https://courier-tracking-api.fly.dev), which handles per-carrier auth,
// RSA signing for iMile, JT captcha solving, JDW captcha solving, and
// Naqel HTML scraping server-side.
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
  // Every supported carrier (iMile, Injaz, JTE, JDW, Naqel) goes through
  // the unified courier-tracking-api so we have one consistent source of
  // tracking data across the entire fleet.
  if (
    carrier === TrackingCarrier.IMILE ||
    carrier === TrackingCarrier.INJAZ ||
    carrier === TrackingCarrier.JTE ||
    carrier === TrackingCarrier.JDW ||
    carrier === TrackingCarrier.NAQEL
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

/**
 * Map a carrier-side raw status string to our internal TrackingStatus enum.
 *
 * Important nuance for RETURNED — only confirmed return-to-sender states
 * count as terminal RETURNED. Intermediate "returned to the station /
 * facility / warehouse" events on the carrier side mean the package was
 * brought back to a depot for redelivery; they are NOT yet a refund-the-
 * shipper signal and must stay in IN_TRANSIT until the carrier confirms
 * the shipper-side hand-off.
 *
 * Per-carrier examples calibrated against real `latest_event` strings
 * seen in production (2026-05-23):
 *
 *  JDW  RETURNED ✓  "ready to return to senders address"
 *       IN_TRANSIT  "Your package has been returned to the station for the reason: ..."
 *  Naqel RETURNED ✓ "Shipment Returned to Origin"
 *       IN_TRANSIT  "Shipment Returned to Naqel Facility"
 *       IN_TRANSIT  "Return request created"
 *       OUT_FOR_DELIVERY "Out For Delivery with Courier"
 *       EXCEPTION   "Delivery attempted – Consignee refused"
 *  iMile RETURNED ✓ "returned to sender" / "sign for failure - returned"
 *  JTE   DELIVERED ✓ status="Sign scan"        desc="...has been signed by [Receiver signed]..."
 *        RETURNED ✓  status="Sign scan"        desc="...returned to the sender..."
 *
 * `rawStatus` is the short upstream status code (e.g. JT's "Sign scan"
 * or JDW's null) and `eventDescription` is the human-readable narrative
 * from the latest event. Both signals are merged because real carriers
 * leave the meaningful keywords in different fields — JDW puts them in
 * the description and leaves status empty, while iMile puts them in the
 * status. We honour whichever signal hints at a terminal state first.
 */
/**
 * Map the courier-tracking-api's canonical category string to our internal
 * TrackingStatus enum. The aggregator already applies per-carrier return
 * rules server-side, so when it returns one of these four values we trust it
 * directly and skip the local heuristic. Returns null for an unrecognized /
 * absent value so the caller can fall back to {@link mapToTrackingStatus}.
 */
function canonicalToTrackingStatus(
  normalized: string | null | undefined
): TrackingStatus | null {
  if (!normalized) return null;
  switch (normalized.trim().toLowerCase()) {
    case "in transit":
      return TrackingStatus.IN_TRANSIT;
    case "out for delivery":
      return TrackingStatus.OUT_FOR_DELIVERY;
    case "delivered":
      return TrackingStatus.DELIVERED;
    case "returned":
      return TrackingStatus.RETURNED;
    default:
      return null;
  }
}

function mapToTrackingStatus(
  _carrier: TrackingCarrier,
  rawStatus: string | null,
  eventDescription?: string | null
): TrackingStatus {
  const parts: string[] = [];
  if (rawStatus) parts.push(rawStatus);
  if (eventDescription && eventDescription !== rawStatus) {
    parts.push(eventDescription);
  }
  if (parts.length === 0) return TrackingStatus.UNKNOWN;

  const s = parts.join(" | ").toLowerCase();

  if (
    s.includes("delivered") ||
    s.includes("signed") ||
    s.includes("sign for success") ||
    s.includes("successfully delivered")
  )
    return TrackingStatus.DELIVERED;

  // Intermediate "ready to return / returning / at station / pending
  // return decision" — NOT terminal. Checked BEFORE the RETURNED block
  // because narratives like "ready to return to senders address" or
  // "preparing to return to origin" contain the substrings that the
  // terminal block would otherwise match. The package is at a carrier
  // depot / waybill stage; the carrier has NOT yet confirmed an actual
  // delivery back to the shipper. Operator should still see it as an
  // active order.
  if (
    s.includes("ready to return") ||
    s.includes("is ready to return") ||
    s.includes("waiting to return") ||
    s.includes("pending return") ||
    s.includes("preparing to return") ||
    s.includes("preparing for return") ||
    s.includes("scheduled to return") ||
    s.includes("returning to") ||
    s.includes("being returned") ||
    s.includes("return in progress") ||
    s.includes("return request created") ||
    s.includes("returned to the station") ||
    s.includes("returned to station") ||
    s.includes("returned to naqel facility") ||
    s.includes("returned to facility") ||
    s.includes("returned to warehouse") ||
    s.includes("returned to the warehouse") ||
    s.includes("back to station") ||
    s.includes("back to facility") ||
    s.includes("back to warehouse")
  )
    return TrackingStatus.IN_TRANSIT;

  // Terminal RETURNED — confirmed handed back to shipper / origin.
  // Only PAST-TENSE patterns ("returned to ...", "has been returned",
  // "sign for failure - returned") count, because present-tense phrases
  // like "ready to return to senders address" appear in JDW narratives
  // when the package is still at the carrier's facility (caught above).
  if (
    s.includes("returned to origin") ||
    s.includes("returned to sender") ||
    s.includes("returned to the sender") ||
    s.includes("returned to shipper") ||
    s.includes("returned to the shipper") ||
    s.includes("returned to consignor") ||
    s.includes("returned to the consignor") ||
    s.includes("has been returned to") ||
    s.includes("successfully returned") ||
    s.includes("return completed") ||
    s.includes("sign for failure - returned")
  )
    return TrackingStatus.RETURNED;

  if (s.includes("out for delivery") || s.includes("dispatched"))
    return TrackingStatus.OUT_FOR_DELIVERY;

  // Generic delivery-failed signal that is NOT yet a refund-the-shipper
  // event. The package may be reattempted; surface as EXCEPTION so the
  // operator can act before the courier escalates to a true return.
  if (
    s.includes("delivery attempted") ||
    s.includes("consignee refused") ||
    s.includes("undeliverable") ||
    s.includes("address not found") ||
    s.includes("address incorrect") ||
    s.includes("no answer")
  )
    return TrackingStatus.EXCEPTION;

  if (
    s.includes("transit") ||
    s.includes("in transit") ||
    s.includes("pick up") ||
    s.includes("pickup") ||
    s.includes("picked up") ||
    s.includes("send to") ||
    s.includes("departed") ||
    s.includes("arrived") ||
    s.includes("shipping") ||
    s.includes("on the way") ||
    s.includes("in warehouse") ||
    s.includes("prepared for delivery")
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
  if (
    s.includes("exception") ||
    s.includes("failed") ||
    s.includes("problem")
  )
    return TrackingStatus.EXCEPTION;

  return TrackingStatus.IN_TRANSIT;
}

// ---------------------------------------------------------------------------
// EXPIRED auto-classifier
// ---------------------------------------------------------------------------
//
// EXPIRED is a terminal "we gave up on this order" state. The operator
// asked for this because COD orders that have been stuck in PENDING /
// IN_TRANSIT / OUT_FOR_DELIVERY / EXCEPTION / UNKNOWN for more than 30
// days from their COD-Network creation date are essentially abandoned —
// they will not be delivered, the customer will not call back, and the
// carrier will not magically resolve them.
//
// We compute it from `codCreatedAt` (the source-of-truth timestamp from
// COD Network's seller-orders API) rather than `createdAt` (when we
// imported the row) so re-syncing the database does not reset the
// 30-day window.
//
// The classifier runs both inline (on every applyTrackingResult call,
// so the moment a stale order gets refreshed it transitions to EXPIRED)
// AND as a periodic sweep via `sweepExpiredTracking()` so the rest of
// the long-tail-stuck orders eventually transition without needing a
// fresh refresh cycle.

const EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isExpirable(status: TrackingStatus): boolean {
  return (
    status === TrackingStatus.PENDING ||
    status === TrackingStatus.IN_TRANSIT ||
    status === TrackingStatus.OUT_FOR_DELIVERY ||
    status === TrackingStatus.EXCEPTION ||
    status === TrackingStatus.UNKNOWN
  );
}

function isStaleForExpiry(codCreatedAt: Date | null | undefined): boolean {
  if (!codCreatedAt) return false;
  return Date.now() - codCreatedAt.getTime() > EXPIRED_AGE_MS;
}

/**
 * Sweep every TrackingOrder whose `codCreatedAt` is older than 30 days
 * and whose status is still non-terminal (i.e. not DELIVERED, RETURNED,
 * or already EXPIRED), and bulk-update them to EXPIRED. Returns the
 * number of rows transitioned.
 */
export async function sweepExpiredTracking(): Promise<number> {
  const cutoff = new Date(Date.now() - EXPIRED_AGE_MS);
  const res = await prisma.trackingOrder.updateMany({
    where: {
      codCreatedAt: { not: null, lt: cutoff },
      status: {
        in: [
          TrackingStatus.PENDING,
          TrackingStatus.IN_TRANSIT,
          TrackingStatus.OUT_FOR_DELIVERY,
          TrackingStatus.EXCEPTION,
          TrackingStatus.UNKNOWN,
        ],
      },
    },
    data: { status: TrackingStatus.EXPIRED },
  });
  return res.count;
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
  currentStatus: TrackingStatus;
  carrier: TrackingCarrier;
  codCreatedAt: Date | null;
}

async function applyTrackingResult(
  opts: ApplyOpts,
  result: ProviderResult
): Promise<{ status: TrackingStatus; eventsCount: number }> {
  const { events, rawStatus, normalizedStatus, error } = result;

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

  // Preserve the existing status whenever the provider returned no fresh
  // events. This avoids demoting a correctly-recorded DELIVERED / RETURNED
  // order back to UNKNOWN just because a single courier-API call failed,
  // timed out, or returned an empty response. Status only moves forward
  // when we actually have a new event we can map (rawStatus OR the event
  // description — JDW returns no status field and JT's "Sign scan" is too
  // generic, so the description is often the only place the real terminal
  // signal — "returned to the sender", "Receiver signed" — appears).
  let status = opts.currentStatus;
  if (latestEvent) {
    // Prefer the courier-tracking-api's canonical category when present — it
    // already encodes the per-carrier return rules. Fall back to the local
    // heuristic mapper for older API deployments / unclassified values.
    const canonical = canonicalToTrackingStatus(normalizedStatus);
    const mapped =
      canonical ??
      mapToTrackingStatus(opts.carrier, rawStatus, latestEvent.description);
    if (mapped !== TrackingStatus.UNKNOWN) {
      status = mapped;
    }
  }

  // Inline EXPIRED classification: if the order is older than 30 days
  // since its COD-Network creation date AND the carrier-derived status
  // is still non-terminal, transition to EXPIRED. DELIVERED and
  // RETURNED are never overridden — they are real terminal outcomes.
  if (isExpirable(status) && isStaleForExpiry(opts.codCreatedAt)) {
    status = TrackingStatus.EXPIRED;
  }

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
      currentStatus: order.status,
      carrier: order.carrier,
      codCreatedAt: order.codCreatedAt,
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
// Re-classify stored tracking statuses without re-fetching
// ---------------------------------------------------------------------------
//
// When the mapper rules change (e.g. we add "returned to the sender" as a
// terminal pattern), existing tracking_orders rows can be stuck on a
// stale status even though their `tracking_events` already contain the
// signal we now recognise. This sweeps all non-terminal orders, re-maps
// based on their most-recent stored event, and writes the new status
// without hitting the courier-tracking-api.
//
// EXPIRED is skipped (purely time-derived and only ever an upgrade away
// from an active bucket). DELIVERED is also skipped because every
// DELIVERED pattern is unambiguous past-tense and can't be turned into
// an active bucket by a mapper change. RETURNED IS included so that any
// previously-mis-mapped intermediate signal (e.g. JDW "is ready to
// return to senders address" wrongly stuck on RETURNED) gets demoted
// back to its real bucket — correctly-classified RETURNED orders still
// re-map to RETURNED via the past-tense patterns.
export async function reclassifyStoredStatuses() {
  const candidates = await prisma.trackingOrder.findMany({
    where: {
      status: {
        in: [
          TrackingStatus.PENDING,
          TrackingStatus.IN_TRANSIT,
          TrackingStatus.OUT_FOR_DELIVERY,
          TrackingStatus.EXCEPTION,
          TrackingStatus.UNKNOWN,
          TrackingStatus.RETURNED,
        ],
      },
    },
    select: {
      id: true,
      carrier: true,
      status: true,
      codCreatedAt: true,
      events: {
        orderBy: { occurredAt: "desc" },
        take: 1,
        select: { status: true, description: true },
      },
    },
  });

  let reclassified = 0;
  for (const row of candidates) {
    const latest = row.events[0];
    let target: TrackingStatus = row.status;

    if (latest) {
      const mapped = mapToTrackingStatus(
        row.carrier,
        latest.status,
        latest.description
      );
      if (mapped !== TrackingStatus.UNKNOWN) {
        target = mapped;
      }
    }

    if (isExpirable(target) && isStaleForExpiry(row.codCreatedAt)) {
      target = TrackingStatus.EXPIRED;
    }

    if (target !== row.status) {
      await prisma.trackingOrder.update({
        where: { id: row.id },
        data: { status: target },
      });
      reclassified++;
    }
  }

  return { reclassified, totalScanned: candidates.length };
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
//   - imile: 5 workers, chunk-size 50, calling fetchCourierApiBulk().
//   - injaz: 5 workers, chunk-size 50, calling fetchCourierApiBulk().
//   - jdw:   5 workers, chunk-size 50, calling fetchCourierApiBulk().
//            All three carriers above are parallelised server-side by the
//            courier API's POST /track/bulk endpoint, so a single 50-item
//            HTTP request returns in seconds rather than a single-shot per
//            waybill (~50× speed-up for iMile's ~2 750 orders).
//   - jte:   1 worker, chunk-size 10, calling fetchCourierApiBulk().
//            The courier API now solves the Tencent captcha via 2Captcha and
//            processes J&T waybills with bounded concurrency
//            (JT_BULK_CONCURRENCY, up to 10), so one /track/bulk request of 10
//            waybills solves a full captcha wave concurrently. Keeping our own
//            concurrency at 1 (one batch in flight) avoids stacking multiple
//            waves on the upstream and blowing the client timeout.
//   - naqel: 5 workers, chunk-size 1, calling fetchCourierApiTracking().
//            Routed through the courier API (which scrapes the public
//            Naqel tracking page server-side); the local scraper used
//            an old URL that returned 404 and dumped every order into
//            UNKNOWN.
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
// 120 s gives a single /api/tracking/refresh round enough budget to drain
// ~3× more orders than the previous 45 s before the UI loops. Stays well
// under Fly's per-request limit while still letting iMile's per-IP rate
// limit do its thing.
const DEFAULT_WALL_CLOCK_MS = 120_000;
// Number of waybills sent in a single POST /track/bulk request. 50 keeps the
// request body small while still giving ~50× speed-up over per-waybill calls.
const BULK_CHUNK_SIZE = 50;
// J&T Express: the courier-tracking-api now solves the Tencent captcha via
// 2Captcha and processes J&T waybills with bounded concurrency
// (JT_BULK_CONCURRENCY, up to 10). We send JTE in batches of 10 so the
// service solves a full wave of captchas concurrently per request.
const JTE_BULK_CHUNK_SIZE = 10;
// Each JT captcha solve can take 60-90s server-side; a batch of 10 solved
// concurrently needs generous headroom before the client aborts. Kept just
// under the wall-clock budget so a JTE request can't outlive the refresh call.
const JTE_BULK_TIMEOUT_MS = 110_000;

interface ActiveOrderRow {
  id: string;
  trackingNumber: string;
  carrier: TrackingCarrier;
  status: TrackingStatus;
  latestEvent: string | null;
  latestEventAt: Date | null;
  codCreatedAt: Date | null;
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

export interface RefreshAllOptions {
  limit?: number;
  /**
   * When true, the bulk pool also re-checks DELIVERED and RETURNED orders.
   * Defaults to false so the cron tick stays bounded to active states
   * (the manual "Refresh All" UI button passes true).
   */
  includeFinal?: boolean;
  /**
   * Restrict the refresh to orders matching this single status. Used by the
   * "Refresh Section" button so e.g. clicking it while the Delivered pill is
   * selected only re-checks delivered orders. When set, takes precedence
   * over `includeFinal`'s active-state allowlist.
   */
  statusFilter?: TrackingStatus;
  /**
   * Restrict the refresh to a single carrier. Used by the "Refresh Section"
   * button when a carrier filter is active. Always paired with statusFilter
   * in practice but can be passed independently.
   */
  carrierFilter?: TrackingCarrier;
}

export async function refreshAllTracking(
  opts: RefreshAllOptions = {}
): Promise<RefreshAllResult> {
  const {
    limit,
    includeFinal = false,
    statusFilter,
    carrierFilter,
  } = opts;
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
  // Skip reclassification entirely when the caller is targeting a single
  // status / carrier — they only want to refresh the matching bucket.
  const reclassifyResult =
    statusFilter || carrierFilter
      ? { reclassified: 0, totalScanned: 0 }
      : await reclassifyOtherOrders(deadline);

  // Read the courier API URL override once so every pool shares it.
  const trackingSettings = await getSettings([
    SETTING_KEYS.COURIER_TRACKING_API_URL,
  ]);
  const courierApiUrl =
    trackingSettings[SETTING_KEYS.COURIER_TRACKING_API_URL] || undefined;

  // Build the carrier predicate. carrierFilter (set by the "Refresh Section"
  // button when a carrier is selected) narrows to a single carrier. When not
  // set, we exclude OTHER as before so we don't pay courier-API costs on
  // rows whose carrier we couldn't detect.
  const carrierPredicate: Prisma.TrackingOrderWhereInput["carrier"] =
    carrierFilter ? carrierFilter : { not: TrackingCarrier.OTHER };

  // Build the status predicate.
  //   - statusFilter present: narrow to that single status (used by the
  //     "Refresh Section" button) — always wins.
  //   - includeFinal=true: no status filter (Refresh All across every status
  //     including DELIVERED + RETURNED).
  //   - default: cron-style active-state allowlist. EXPIRED is included so
  //     abandoned orders keep getting re-checked and move to their correct
  //     terminal status (DELIVERED / RETURNED) if the carrier finally resolves
  //     them — otherwise the inline classifier just re-stamps them EXPIRED.
  //     DELIVERED + RETURNED stay excluded so the 5-min cron doesn't
  //     repeatedly bill the courier API for genuinely terminal orders.
  const statusPredicate: Prisma.TrackingOrderWhereInput["status"] | undefined =
    statusFilter
      ? statusFilter
      : includeFinal
        ? undefined
        : {
            in: [
              TrackingStatus.PENDING,
              TrackingStatus.IN_TRANSIT,
              TrackingStatus.OUT_FOR_DELIVERY,
              TrackingStatus.EXCEPTION,
              TrackingStatus.UNKNOWN,
              TrackingStatus.EXPIRED,
            ],
          };

  const activeFilter: Prisma.TrackingOrderWhereInput = {
    carrier: carrierPredicate,
    ...(statusPredicate !== undefined ? { status: statusPredicate } : {}),
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
      codCreatedAt: true,
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

  // Helper: chunk an array into N-sized arrays.
  const chunkBy = <T>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // Apply a single ProviderResult to one order and record the outcome.
  const persistAndRecord = async (
    o: ActiveOrderRow,
    result: ProviderResult
  ) => {
    try {
      const persisted = await applyTrackingResult(
        {
          orderId: o.id,
          trackingNumber: o.trackingNumber,
          currentLatestEvent: o.latestEvent,
          currentLatestEventAt: o.latestEventAt,
          currentStatus: o.status,
          carrier: o.carrier,
          codCreatedAt: o.codCreatedAt,
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
  };

  // Build a bulk pool for a carrier that supports the POST /track/bulk
  // endpoint (iMile, Injaz, JDW). Each "chunk" in the queue is up to 50
  // orders → one HTTP call. The courier API parallelises non-J&T waybills
  // server-side so a 50-item bulk request returns in seconds.
  const buildBulkPool = (
    orders: ActiveOrderRow[],
    carrier: TrackingCarrier,
    concurrency: number,
    chunkSize: number = BULK_CHUNK_SIZE,
    bulkOpts?: { maxPerRequest?: number; timeoutMs?: number }
  ): Promise<void> => {
    const chunks = chunkBy(orders, chunkSize);
    totalChunks += chunks.length;
    return drainQueue(chunks, concurrency, deadline, async (chunk) => {
      const trackingNumbers = chunk.map((o) => o.trackingNumber);
      let resultMap: Map<string, ProviderResult>;
      try {
        resultMap = await fetchCourierApiBulk(
          trackingNumbers,
          carrier,
          courierApiUrl,
          bulkOpts
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : "fetch_failed";
        resultMap = new Map();
        for (const tn of trackingNumbers) {
          resultMap.set(tn, {
            events: [],
            rawStatus: null,
            error: `courier_api_bulk_error:${detail}`,
          });
        }
      }
      for (const o of chunk) {
        const result =
          resultMap.get(o.trackingNumber) ?? {
            events: [],
            rawStatus: null,
            error: "bulk_missing_response",
          };
        await persistAndRecord(o, result);
      }
    });
  };

  // ---------- iMile pool: 5 workers × chunk-50 via /track/bulk ----------
  const imilePool = buildBulkPool(
    buckets.imile,
    TrackingCarrier.IMILE,
    IMILE_CONCURRENCY
  );

  // ---------- Injaz pool: 5 workers × chunk-50 via /track/bulk ----------
  const injazPool = buildBulkPool(
    buckets.injaz,
    TrackingCarrier.INJAZ,
    INJAZ_CONCURRENCY
  );

  // ---------- JDW pool: 5 workers × chunk-50 via /track/bulk ----------
  const jdwPool = buildBulkPool(
    buckets.jdw,
    TrackingCarrier.JDW,
    JDW_CONCURRENCY
  );

  // ---------- JTE pool: /track/bulk in batches of 10 ----------
  // The courier-tracking-api now solves the J&T Tencent captcha via 2Captcha
  // and processes J&T waybills with bounded concurrency (JT_BULK_CONCURRENCY,
  // up to 10). We send JTE through POST /track/bulk in batches of 10 so the
  // service solves a full wave of captchas concurrently per request — a large
  // speed-up over the old one-waybill-at-a-time path. Concurrency stays at 1
  // (one batch in flight) so we don't stack multiple captcha waves on the
  // upstream and blow the client timeout.
  const JTE_CONCURRENCY = 1;
  const jtePool = buildBulkPool(
    buckets.jte,
    TrackingCarrier.JTE,
    JTE_CONCURRENCY,
    JTE_BULK_CHUNK_SIZE,
    { maxPerRequest: JTE_BULK_CHUNK_SIZE, timeoutMs: JTE_BULK_TIMEOUT_MS }
  );

  // ---------- Naqel pool: 5 workers, one at a time ----------
  // Naqel is routed through the courier-tracking-api like every other
  // carrier. The courier API scrapes the public Naqel tracking page
  // server-side and returns a normalized event timeline.
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
          result = await fetchCourierApiTracking(
            o.trackingNumber,
            TrackingCarrier.NAQEL,
            courierApiUrl
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch_failed";
          result = {
            events: [],
            rawStatus: null,
            error: `naqel_error:${detail}`,
          };
        }
        await persistAndRecord(o, result);
      }
    }
  );

  // Run all 5 pools concurrently. Each pool drains its own queue with its
  // own worker count. The shared deadline + applyTrackingResult writes mean
  // the orchestration is naturally back-pressured by Postgres latency.
  await Promise.all([imilePool, injazPool, jdwPool, jtePool, naqelPool]);

  // After every refresh cycle, sweep stale orders (>30 days since
  // codCreatedAt, not DELIVERED / RETURNED) into EXPIRED. This is
  // bounded by a single UPDATE so it doesn't pressure the deadline.
  try {
    await sweepExpiredTracking();
  } catch (err) {
    console.warn(
      "[tracking-refresh] sweepExpiredTracking failed",
      err instanceof Error ? err.message : err
    );
  }

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
