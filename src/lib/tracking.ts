import crypto from "node:crypto";
import { prisma } from "./prisma";
import { TrackingCarrier, TrackingStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// Carrier detection
// ---------------------------------------------------------------------------

export function detectCarrier(
  trackingNumber: string
): TrackingCarrier | null {
  if (trackingNumber.startsWith("60")) return TrackingCarrier.IMILE;
  if (trackingNumber.toUpperCase().startsWith("INJAZ."))
    return TrackingCarrier.INJAZ;
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
// Unified tracking status mapper
// ---------------------------------------------------------------------------

function mapToTrackingStatus(
  carrier: TrackingCarrier,
  rawStatus: string | null
): TrackingStatus {
  if (!rawStatus) return TrackingStatus.UNKNOWN;

  const s = rawStatus.toLowerCase();

  if (carrier === TrackingCarrier.IMILE) {
    if (s.includes("delivered")) return TrackingStatus.DELIVERED;
    if (s.includes("out for delivery"))
      return TrackingStatus.OUT_FOR_DELIVERY;
    if (s.includes("transit") || s.includes("in transit"))
      return TrackingStatus.IN_TRANSIT;
    if (s.includes("pick up") || s.includes("pickup"))
      return TrackingStatus.IN_TRANSIT;
    if (s.includes("order creation"))
      return TrackingStatus.PENDING;
    if (s.includes("return")) return TrackingStatus.RETURNED;
    if (s.includes("exception")) return TrackingStatus.EXCEPTION;
  }

  if (carrier === TrackingCarrier.INJAZ) {
    if (s.includes("deliver")) return TrackingStatus.DELIVERED;
    if (s.includes("out for")) return TrackingStatus.OUT_FOR_DELIVERY;
    if (s.includes("transit") || s.includes("send to"))
      return TrackingStatus.IN_TRANSIT;
    if (s.includes("pick")) return TrackingStatus.IN_TRANSIT;
    if (s.includes("return")) return TrackingStatus.RETURNED;
    if (s.includes("receive")) return TrackingStatus.PENDING;
  }

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

  const { events, rawStatus } =
    order.carrier === TrackingCarrier.IMILE
      ? await fetchImileTracking(order.trackingNumber)
      : await fetchInjazTracking(order.trackingNumber);

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
// Auto-import: scan the orders table for tracking numbers that match iMile
// or Injaz patterns and create TrackingOrder records for any new ones.
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
    },
  });

  let imported = 0;
  let skipped = 0;

  for (const order of orders) {
    if (!order.trackingNumber) continue;
    const tn = order.trackingNumber.trim();
    const carrier = detectCarrier(tn);
    if (!carrier) {
      skipped++;
      continue;
    }

    const existing = await prisma.trackingOrder.findUnique({
      where: { trackingNumber: tn },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.trackingOrder.create({
      data: {
        trackingNumber: tn,
        carrier,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        orderId: order.id,
      },
    });
    imported++;
  }

  return { imported, skipped, totalScanned: orders.length };
}

// ---------------------------------------------------------------------------
// Refresh all active tracking orders
// ---------------------------------------------------------------------------

export async function refreshAllTracking() {
  const activeOrders = await prisma.trackingOrder.findMany({
    where: {
      status: {
        notIn: [
          TrackingStatus.DELIVERED,
          TrackingStatus.RETURNED,
        ],
      },
    },
  });

  const results: Array<{
    id: string;
    trackingNumber: string;
    status: string;
    eventsCount: number;
    error?: string;
  }> = [];

  for (const order of activeOrders) {
    try {
      const result = await refreshTracking(order.id);
      results.push({
        id: order.id,
        trackingNumber: order.trackingNumber,
        status: result.status,
        eventsCount: result.eventsCount,
      });
    } catch (err) {
      results.push({
        id: order.id,
        trackingNumber: order.trackingNumber,
        status: order.status,
        eventsCount: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return results;
}
