import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@prisma/client";
import { randomBytes } from "crypto";
import {
  fireOrderCreatedFlows,
  fireOrderTrackingAssignedFlows,
  safeFireFlows,
} from "@/lib/automation-flows/triggers";

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
  const dateFilter = searchParams.get("dateFilter"); // "today" | null

  const where: Record<string, unknown> = {};

  if (dateFilter === "today") {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    where.codCreatedAt = { gte: todayStart };
  }

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

  // Enrich orders with product image URLs from the products catalog. Orders
  // synced from /orders carry item images inline (extractProductImages), but
  // leads (and some multi-product / Arabic-named orders) don't — so we also
  // resolve against the catalog by SKU and normalized name. Leads carry the
  // SKU in `products` ("Name/SKU") and `original_payload.sku_1…`, which is the
  // most reliable key since names often don't match the catalog exactly.
  const allNames = new Set<string>();
  const allSkus = new Set<string>();
  for (const o of orders) {
    const { names, skus } = collectProductKeys(o.productName, o.rawOrderJson);
    for (const n of names) allNames.add(n);
    for (const s of skus) allSkus.add(s);
  }

  const imageByNameLower = new Map<string, string>();
  const imageBySkuLower = new Map<string, string>();
  if (allNames.size > 0 || allSkus.size > 0) {
    const products = await prisma.product.findMany({
      where: {
        OR: [
          { name: { in: [...allNames] } },
          { nameArabic: { in: [...allNames] } },
          { sku: { in: [...allSkus] } },
        ],
      },
      select: { name: true, nameArabic: true, sku: true, imageUrl: true },
    });
    for (const p of products) {
      if (!p.imageUrl) continue;
      imageByNameLower.set(p.name.trim().toLowerCase(), p.imageUrl);
      if (p.nameArabic) {
        imageByNameLower.set(p.nameArabic.trim().toLowerCase(), p.imageUrl);
      }
      if (p.sku) imageBySkuLower.set(p.sku.trim().toLowerCase(), p.imageUrl);
    }
  }

  const enrichedOrders = orders.map((o) => {
    const inlineImages = extractProductImages(o.rawOrderJson);
    let catalogImage: string | null = null;
    if (inlineImages.length === 0) {
      const { names, skus } = collectProductKeys(o.productName, o.rawOrderJson);
      for (const s of skus) {
        const hit = imageBySkuLower.get(s.trim().toLowerCase());
        if (hit) {
          catalogImage = hit;
          break;
        }
      }
      if (!catalogImage) {
        for (const n of names) {
          const hit = imageByNameLower.get(n.trim().toLowerCase());
          if (hit) {
            catalogImage = hit;
            break;
          }
        }
      }
    }
    return {
      ...o,
      productImages: inlineImages,
      productImageUrl: catalogImage,
    };
  });

  return NextResponse.json({
    orders: enrichedOrders,
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

  // Fire new visual-builder flows for the order creation event.
  safeFireFlows(
    fireOrderCreatedFlows(order.id),
    `ORDER_CREATED flow for order ${order.id}`
  ).catch(() => {});
  if (order.trackingNumber && order.trackingNumber.trim() !== "") {
    safeFireFlows(
      fireOrderTrackingAssignedFlows(order.id),
      `ORDER_TRACKING_ASSIGNED flow for order ${order.id}`
    ).catch(() => {});
  }

  return NextResponse.json({ order });
}

function extractProductImages(rawOrderJson: unknown): string[] {
  if (!rawOrderJson || typeof rawOrderJson !== "object") return [];
  const raw = rawOrderJson as Record<string, unknown>;
  const images: string[] = [];
  const items = raw.items;
  const itemList = Array.isArray(items)
    ? items
    : items && typeof items === "object" && "data" in items
      ? (items as { data?: unknown[] }).data ?? []
      : [];
  for (const item of itemList) {
    if (item && typeof item === "object") {
      const it = item as Record<string, unknown>;
      const imgUrl =
        (it.image_url as string) ??
        (it.path_image as string) ??
        ((it.product as Record<string, unknown>)?.data as Record<string, unknown>)?.image_url ??
        ((it.product as Record<string, unknown>)?.data as Record<string, unknown>)?.path_image ??
        ((it.product as Record<string, unknown>)?.image_url as string) ??
        null;
      if (typeof imgUrl === "string" && imgUrl) images.push(imgUrl);
    }
  }
  if (images.length === 0) {
    const topImage = (raw.image_url ?? raw.path_image) as string | undefined;
    if (topImage) images.push(topImage);
  }
  return images;
}

/**
 * Collect every candidate product name and SKU referenced by an order/lead so
 * the catalog image lookup can succeed even when `product_name` doesn't match
 * a catalog entry exactly. Handles:
 *  - multi-product names comma-joined ("Hearing aid D, Fast car charger")
 *  - lead "Name/SKU" strings ("Energy Coffee Drink for Men/MP-X1TGXPHPN3QZ")
 *  - lead `original_payload.sku_1…` / `product_name_1…`
 *  - order item SKUs (items.data[].product.data.sku)
 */
function collectProductKeys(
  productName: string | null,
  rawOrderJson: unknown
): { names: string[]; skus: string[] } {
  const names = new Set<string>();
  const skus = new Set<string>();

  const addSegment = (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    // "Name/SKU" → the last "/"-part is the SKU, the rest is the name.
    const slash = trimmed.lastIndexOf("/");
    if (slash > 0 && slash < trimmed.length - 1) {
      const namePart = trimmed.slice(0, slash).trim();
      const skuPart = trimmed.slice(slash + 1).trim();
      if (namePart) names.add(namePart);
      if (skuPart) skus.add(skuPart);
    } else {
      names.add(trimmed);
    }
  };

  if (productName) {
    for (const part of productName.split(",")) addSegment(part);
  }

  if (rawOrderJson && typeof rawOrderJson === "object") {
    const raw = rawOrderJson as Record<string, unknown>;
    if (typeof raw.products === "string") {
      for (const part of raw.products.split(",")) addSegment(part);
    }

    // Lead payload: original_payload is a JSON string with sku_N / product_name_N.
    const original =
      typeof raw.original_payload === "string"
        ? safeParseObject(raw.original_payload)
        : raw.original_payload && typeof raw.original_payload === "object"
          ? (raw.original_payload as Record<string, unknown>)
          : null;
    if (original) {
      for (let i = 1; i <= 10; i++) {
        const sku = original[`sku_${i}`];
        const name = original[`product_name_${i}`];
        if (typeof sku === "string" && sku.trim()) skus.add(sku.trim());
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      }
    }

    // Order payload: items.data[].product.data.sku
    const items = raw.items;
    const itemList = Array.isArray(items)
      ? items
      : items && typeof items === "object" && "data" in items
        ? (items as { data?: unknown[] }).data ?? []
        : [];
    for (const item of itemList) {
      if (item && typeof item === "object") {
        const product = (item as Record<string, unknown>).product;
        const data =
          product && typeof product === "object"
            ? (product as Record<string, unknown>).data
            : null;
        const sku =
          data && typeof data === "object"
            ? (data as Record<string, unknown>).sku
            : null;
        if (typeof sku === "string" && sku.trim()) skus.add(sku.trim());
      }
    }
  }

  return { names: [...names], skus: [...skus] };
}

function safeParseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
