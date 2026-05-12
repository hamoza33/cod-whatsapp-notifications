import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@prisma/client";
import { randomBytes } from "crypto";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  // Cap: 100 by default for the table view; the Pipeline (Kanban) view needs
  // to fetch many cards at once and explicitly opts into the higher cap.
  const pageSize = Math.max(
    1,
    Math.min(1000, parseInt(searchParams.get("pageSize") || "20", 10))
  );
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const sentFilter = searchParams.get("sent"); // "true" | "false" | null

  const where: Record<string, unknown> = {};

  if (status && status !== "ALL") {
    if (status === "ELIGIBLE") {
      where.status = { in: [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY] };
    } else {
      where.status = status as OrderStatus;
    }
  }

  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: "insensitive" } },
      { customerPhone: { contains: search } },
      { codNetworkOrderId: { contains: search } },
      { trackingNumber: { contains: search } },
    ];
  }

  if (sentFilter === "true") {
    where.whatsappSentAt = { not: null };
  } else if (sentFilter === "false") {
    where.whatsappSentAt = null;
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        whatsappMessages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      // Newest *placed* order first (codCreatedAt). Falls back to our row's
      // createdAt for orders that pre-date this column. updatedAt is the final
      // tiebreaker so re-syncs of older orders surface together.
      orderBy: [
        { codCreatedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { updatedAt: "desc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return NextResponse.json({
    orders,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}

const VALID_STATUSES = new Set<OrderStatus>([
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
]);

interface ManualOrderInput {
  customerName?: string;
  customerPhone?: string;
  customerCity?: string;
  customerAddress?: string;
  productName?: string;
  productPrice?: string | number;
  productQuantity?: string | number;
  trackingNumber?: string;
  deliveryCompany?: string;
  status?: OrderStatus;
  pipelineNote?: string;
}

/**
 * Create an order manually from the dashboard — covers the "I have a sale
 * that didn't come through COD Network" workflow. We give it a generated
 * `MANUAL-<random>` id so the unique constraint on `codNetworkOrderId` is
 * preserved without leaking into COD's numeric range, and flip the
 * `isManual` flag so a subsequent sync pass never overwrites it.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ManualOrderInput;
  try {
    body = (await request.json()) as ManualOrderInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const customerName = (body.customerName ?? "").trim();
  const customerPhone = normalizePhone(body.customerPhone ?? "");
  const productName = (body.productName ?? "").trim();
  if (!customerName) {
    return NextResponse.json({ error: "customerName is required" }, { status: 400 });
  }
  if (!customerPhone) {
    return NextResponse.json({ error: "customerPhone is required" }, { status: 400 });
  }
  if (!productName) {
    return NextResponse.json({ error: "productName is required" }, { status: 400 });
  }

  const status =
    body.status && VALID_STATUSES.has(body.status) ? body.status : "PENDING";
  const codNetworkOrderId = `MANUAL-${randomBytes(6).toString("hex").toUpperCase()}`;
  const now = new Date();

  const order = await prisma.order.create({
    data: {
      codNetworkOrderId,
      isManual: true,
      customerName,
      customerPhone,
      customerCity: optionalString(body.customerCity),
      customerAddress: optionalString(body.customerAddress),
      productName,
      productPrice:
        body.productPrice !== undefined && body.productPrice !== null
          ? String(body.productPrice)
          : null,
      productQuantity:
        body.productQuantity !== undefined && body.productQuantity !== null
          ? String(body.productQuantity)
          : null,
      trackingNumber: optionalString(body.trackingNumber),
      deliveryCompany: optionalString(body.deliveryCompany),
      pipelineNote: optionalString(body.pipelineNote),
      status,
      statusChangedAt: now,
      codCreatedAt: now,
      codUpdatedAt: now,
      lastSyncedAt: now,
    },
  });

  return NextResponse.json({ order });
}

function optionalString(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t ? t : null;
}

function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Accept either "+212690..." or "212690..." — store with the leading `+`
  // so it matches `Order.customerPhone` rows synced from COD Network and
  // inbound webhook payloads from Meta.
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `+${digits}`;
}
