import crypto from "node:crypto";
import { prisma } from "./prisma";
import { TrackingCarrier, TrackingStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// Carrier detection
// ---------------------------------------------------------------------------

export function detectCarrier(
  trackingNumber: string
): TrackingCarrier | null {
  const tn = trackingNumber.toUpperCase();
  if (tn.startsWith("60")) return TrackingCarrier.IMILE;
  if (tn.startsWith("INJAZ.") || tn.startsWith("INJAZ"))
    return TrackingCarrier.INJAZ;
  if (tn.startsWith("JTE")) return TrackingCarrier.JTE;
  if (tn.startsWith("JDW")) return TrackingCarrier.JDW;
  return null;
}

// ---------------------------------------------------------------------------
// iMile tracking
// ---------------------------------------------------------------------------

const IMILE_RSA_PUB_DER_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3dFPiKNZwt+HoBbPAG/t" +
  "7kZC2k3pBX2eCl5LeyeW8woNuEV5bA5kB9Y9KKTOQng62ERGPLwi84CdIB8s265lj" +
  "QUib//iO3jVrZesJueO5Xu+s80s3Z/89jgJleT1XawN1GubgkGXOoT1a7tvX8+aItk" +
  "GgR//48ELqJVVUL+yGsBtXxFjNmOEWxBJNQuwAf9yWcCIl1enD60GjZjPWrsfw8QU" +
  "qam7K5e45ealcPEYGenNePwuPpCq6twdD0YYYzKdRN0dZP1uTviFpNfph90c9YgQ8" +
  "kgDkRMcpjVv6KZ+bg5JZ4sK6LkV4vwOjPijisthHBvUXhu3fyhMgvoDO/j5gwIDAQ" +
  "AB";

const IMILE_SALT = "imileTrackQuery2024";

interface ImileTrackInfo {
  content: string;
  trackStage: number | null;
  trackStageTx: string | null;
  time: string;
  operateStationName: string | null;
}

interface ImileResponse {
  status: string;
  resultObject: {
    waybillNo: string;
    trackInfos: ImileTrackInfo[];
  } | null;
}

export async function fetchImileTracking(
  waybillNo: string
): Promise<{ events: ParsedEvent[]; rawStatus: string | null }> {
  const code = crypto
    .createHash("md5")
    .update(waybillNo + IMILE_SALT)
    .digest("hex");

  const keyObj = crypto.createPublicKey({
    key: Buffer.from(IMILE_RSA_PUB_DER_B64, "base64"),
    format: "der",
    type: "spki",
  });

  const sign = crypto
    .publicEncrypt(
      { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(waybillNo)
    )
    .toString("base64");

  const url = `https://www.imile.com/saastms/mobileWeb/track/query?waybillNo=${waybillNo}&code=${code}`;
  const resp = await fetch(url, {
    headers: { lang: "en", sign },
  });

  const data = (await resp.json()) as ImileResponse;

  if (
    data.status !== "success" ||
    !data.resultObject?.trackInfos?.length
  ) {
    return { events: [], rawStatus: null };
  }

  const events: ParsedEvent[] = data.resultObject.trackInfos.map(
    (info) => ({
      status: info.trackStageTx ?? "Unknown",
      description: info.content,
      location: info.operateStationName ?? undefined,
      occurredAt: parseImileDate(info.time),
      rawData: info,
    })
  );

  const latest = data.resultObject.trackInfos[0];
  return { events, rawStatus: latest.trackStageTx ?? null };
}

function parseImileDate(dateStr: string): Date {
  // iMile format: "2026-05-13 02:30:07"
  return new Date(dateStr.replace(" ", "T") + "+03:00");
}

// ---------------------------------------------------------------------------
// Injaz Express tracking
// ---------------------------------------------------------------------------

interface ParsedEvent {
  status: string;
  description: string;
  location?: string;
  occurredAt: Date;
  rawData?: unknown;
}

export async function fetchInjazTracking(
  trackingNumber: string
): Promise<{ events: ParsedEvent[]; rawStatus: string | null }> {
  const resp = await fetch(
    "https://injaz-express.com/track_order.php",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `order_id=${encodeURIComponent(trackingNumber)}`,
    }
  );

  const html = await resp.text();
  return parseInjazHtml(html);
}

function parseInjazHtml(
  html: string
): { events: ParsedEvent[]; rawStatus: string | null } {
  const events: ParsedEvent[] = [];

  // Extract timeline items:
  // <div class='orderTravel_status'>Status text</div>
  // <div class='orderTravel_time'...>2022-06-06</div>
  const itemRegex =
    /<li\s+class='ant-timeline-item[^']*'[^>]*>[\s\S]*?<div\s+class='orderTravel_status'\s*>(.*?)<\/div>[\s\S]*?<div\s+class='orderTravel_time'[^>]*>(.*?)<\/div>/g;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) !== null) {
    const status = match[1].trim();
    const dateStr = match[2].trim();
    if (!status || !dateStr) continue;

    events.push({
      status,
      description: status,
      occurredAt: new Date(dateStr),
    });
  }

  // Reverse to chronological (newest first)
  events.reverse();

  const rawStatus = events.length > 0 ? events[0].status : null;
  return { events, rawStatus };
}

// ---------------------------------------------------------------------------
// JT Express tracking (scrape public tracking page)
// ---------------------------------------------------------------------------

export async function fetchJteTracking(
  trackingNumber: string
): Promise<{ events: ParsedEvent[]; rawStatus: string | null }> {
  try {
    const resp = await fetch(
      `https://www.jtexpress-sa.com/api/tracking/query?waybillNo=${encodeURIComponent(trackingNumber)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      }
    );
    if (!resp.ok) return { events: [], rawStatus: null };
    const data = (await resp.json()) as {
      data?: {
        trackInfos?: Array<{
          content?: string;
          status?: string;
          time?: string;
          location?: string;
        }>;
        status?: string;
      };
    };
    if (!data.data?.trackInfos?.length) return { events: [], rawStatus: null };
    const events: ParsedEvent[] = data.data.trackInfos.map((info) => ({
      status: info.status ?? "Unknown",
      description: info.content ?? info.status ?? "Update",
      location: info.location,
      occurredAt: new Date(info.time ?? Date.now()),
      rawData: info,
    }));
    return { events, rawStatus: data.data.status ?? events[0]?.status ?? null };
  } catch {
    return { events: [], rawStatus: null };
  }
}

// ---------------------------------------------------------------------------
// JD Logistics tracking (scrape public tracking page)
// ---------------------------------------------------------------------------

export async function fetchJdwTracking(
  trackingNumber: string
): Promise<{ events: ParsedEvent[]; rawStatus: string | null }> {
  try {
    const resp = await fetch(
      `https://www.jingdonglogistics.com/api/tracking/query?waybillNo=${encodeURIComponent(trackingNumber)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      }
    );
    if (!resp.ok) return { events: [], rawStatus: null };
    const data = (await resp.json()) as {
      data?: {
        trackInfos?: Array<{
          content?: string;
          status?: string;
          time?: string;
          location?: string;
        }>;
        status?: string;
      };
    };
    if (!data.data?.trackInfos?.length) return { events: [], rawStatus: null };
    const events: ParsedEvent[] = data.data.trackInfos.map((info) => ({
      status: info.status ?? "Unknown",
      description: info.content ?? info.status ?? "Update",
      location: info.location,
      occurredAt: new Date(info.time ?? Date.now()),
      rawData: info,
    }));
    return { events, rawStatus: data.data.status ?? events[0]?.status ?? null };
  } catch {
    return { events: [], rawStatus: null };
  }
}

// ---------------------------------------------------------------------------
// Fetch tracking by carrier (dispatcher)
// ---------------------------------------------------------------------------

async function fetchTrackingByCarrier(
  carrier: TrackingCarrier,
  trackingNumber: string
): Promise<{ events: ParsedEvent[]; rawStatus: string | null }> {
  switch (carrier) {
    case TrackingCarrier.IMILE:
      return fetchImileTracking(trackingNumber);
    case TrackingCarrier.INJAZ:
      return fetchInjazTracking(trackingNumber);
    case TrackingCarrier.JTE:
      return fetchJteTracking(trackingNumber);
    case TrackingCarrier.JDW:
      return fetchJdwTracking(trackingNumber);
    default:
      return { events: [], rawStatus: null };
  }
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
    default:
      return deliveryCompany || "Other";
  }
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
    s.includes("accepted")
  )
    return TrackingStatus.PENDING;
  if (s.includes("return")) return TrackingStatus.RETURNED;
  if (s.includes("exception") || s.includes("failed") || s.includes("problem"))
    return TrackingStatus.EXCEPTION;

  return TrackingStatus.IN_TRANSIT;
}

// ---------------------------------------------------------------------------
// Refresh a single tracking order
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

  const { events, rawStatus } = await fetchTrackingByCarrier(
    order.carrier,
    order.trackingNumber
  );

  const status = mapToTrackingStatus(order.carrier, rawStatus);

  // Upsert events (de-duplicate by description + timestamp)
  for (const evt of events) {
    await prisma.trackingEvent.upsert({
      where: {
        trackingOrderId_description_occurredAt: {
          trackingOrderId: order.id,
          description: evt.description,
          occurredAt: evt.occurredAt,
        },
      },
      create: {
        trackingOrderId: order.id,
        status: evt.status,
        description: evt.description,
        location: evt.location ?? null,
        occurredAt: evt.occurredAt,
        rawData: evt.rawData ?? undefined,
      },
      update: {},
    });
  }

  const latestEvent =
    events.length > 0 ? events[0] : null;

  await prisma.trackingOrder.update({
    where: { id: order.id },
    data: {
      status,
      latestEvent: latestEvent?.description ?? order.latestEvent,
      latestEventAt: latestEvent?.occurredAt ?? order.latestEventAt,
      lastCheckedAt: new Date(),
    },
  });

  return { status, eventsCount: events.length };
}

// ---------------------------------------------------------------------------
// Auto-import: scan the orders table for ALL orders with tracking numbers
// and create TrackingOrder records. iMile/Injaz get auto-status-fetching;
// other carriers are listed as OTHER with the delivery company name.
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

    const carrier = detectCarrier(tn) ?? TrackingCarrier.OTHER;
    const carrierName = carrierDisplayName(carrier, order.deliveryCompany);

    const existing = await prisma.trackingOrder.findUnique({
      where: { trackingNumber: tn },
    });
    if (existing) {
      // Update metadata that may have changed (customer info, product, etc.)
      const needsUpdate =
        existing.customerName !== order.customerName ||
        existing.customerPhone !== order.customerPhone ||
        existing.productName !== order.productName ||
        existing.orderId !== order.id;
      if (needsUpdate) {
        await prisma.trackingOrder.update({
          where: { id: existing.id },
          data: {
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
// Refresh all active tracking orders (batches of 10)
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10;

export async function refreshAllTracking() {
  const activeOrders = await prisma.trackingOrder.findMany({
    where: {
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
    orderBy: { lastCheckedAt: "asc" },
  });

  const results: Array<{
    id: string;
    trackingNumber: string;
    status: string;
    eventsCount: number;
    error?: string;
  }> = [];

  for (let i = 0; i < activeOrders.length; i += BATCH_SIZE) {
    const batch = activeOrders.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (order) => {
        const result = await refreshTracking(order.id);
        return {
          id: order.id,
          trackingNumber: order.trackingNumber,
          status: result.status,
          eventsCount: result.eventsCount,
        };
      })
    );

    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        results.push({
          id: batch[j].id,
          trackingNumber: batch[j].trackingNumber,
          status: batch[j].status,
          eventsCount: 0,
          error: r.reason instanceof Error ? r.reason.message : "Unknown error",
        });
      }
    }

    // Brief pause between batches to avoid rate limiting
    if (i + BATCH_SIZE < activeOrders.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return { results, totalProcessed: activeOrders.length, batches: Math.ceil(activeOrders.length / BATCH_SIZE) };
}
