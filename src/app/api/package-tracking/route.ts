import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = Math.max(
    1,
    Math.min(200, parseInt(searchParams.get("pageSize") || "50", 10))
  );
  const search = searchParams.get("search");
  const carrier = searchParams.get("carrier");
  const product = searchParams.get("product");
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");
  const quickRange = searchParams.get("range");

  // Only track pending and in-transit orders — skip delivered/returned
  const trackableStatuses = [
    OrderStatus.PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.UNKNOWN,
  ];

  const where: Record<string, unknown> = {
    status: { in: trackableStatuses },
  };

  if (search) {
    where.OR = [
      { trackingNumber: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
      { codNetworkOrderId: { contains: search } },
    ];
  }

  if (carrier && carrier !== "all") {
    where.deliveryCompany = { equals: carrier, mode: "insensitive" };
  }

  // Filter by primary product name only (first product before comma — excludes
  // cross-sells/up-sells that appear after the comma in the productName field).
  if (product && product !== "all") {
    where.productName = { startsWith: product, mode: "insensitive" };
  }

  // Date range filters
  let dateStart: Date | null = null;
  let dateEnd: Date | null = null;

  if (quickRange) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (quickRange) {
      case "7d":
        dateStart = new Date(startOfDay.getTime() - 7 * 86400000);
        break;
      case "30d":
        dateStart = new Date(startOfDay.getTime() - 30 * 86400000);
        break;
      case "90d":
        dateStart = new Date(startOfDay.getTime() - 90 * 86400000);
        break;
      case "year":
        dateStart = new Date(now.getFullYear(), 0, 1);
        break;
    }
  }

  if (fromDate) dateStart = new Date(fromDate);
  if (toDate) dateEnd = new Date(toDate + "T23:59:59.999Z");

  if (dateStart || dateEnd) {
    const codCreatedFilter: Record<string, unknown> = {};
    if (dateStart) codCreatedFilter.gte = dateStart;
    if (dateEnd) codCreatedFilter.lte = dateEnd;
    where.codCreatedAt = codCreatedFilter;
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [
        { updatedAt: "desc" },
        { codCreatedAt: { sort: "desc", nulls: "last" } },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  // Status counts for the summary bar (only trackable statuses)
  const statusCounts = await prisma.order.groupBy({
    by: ["status"],
    _count: { id: true },
  });

  const counts = {
    pending: 0,
    inTransit: 0,
    outForDelivery: 0,
    delivered: 0,
    returned: 0,
    exception: 0,
    unknown: 0,
  };
  for (const sc of statusCounts) {
    const c = sc._count.id;
    switch (sc.status) {
      case OrderStatus.PENDING:
      case OrderStatus.CONFIRMED:
      case OrderStatus.PROCESSING:
        counts.pending += c;
        break;
      case OrderStatus.SHIPPED:
        counts.inTransit += c;
        break;
      case OrderStatus.OUT_FOR_DELIVERY:
        counts.outForDelivery += c;
        break;
      case OrderStatus.DELIVERED:
        counts.delivered += c;
        break;
      case OrderStatus.RETURNED:
        counts.returned += c;
        break;
      case OrderStatus.CANCELLED:
        counts.exception += c;
        break;
      case OrderStatus.UNKNOWN:
        counts.unknown += c;
        break;
    }
  }

  // Distinct carriers for filter dropdown
  const carriersRaw = await prisma.order.findMany({
    where: { deliveryCompany: { not: null }, status: { in: trackableStatuses } },
    select: { deliveryCompany: true },
    distinct: ["deliveryCompany"],
  });
  const carriers = carriersRaw
    .map((c) => c.deliveryCompany)
    .filter((c): c is string => !!c)
    .sort();

  // Distinct primary product names for filter dropdown
  // Extract only the primary product (before comma) for each order
  const productsRaw = await prisma.order.findMany({
    where: { productName: { not: null }, status: { in: trackableStatuses } },
    select: { productName: true },
    distinct: ["productName"],
  });
  const primaryProducts = new Set<string>();
  for (const p of productsRaw) {
    if (p.productName) {
      const primary = p.productName.split(",")[0].trim();
      if (primary) primaryProducts.add(primary);
    }
  }
  const products = Array.from(primaryProducts).sort();

  // Enrich orders with product image URLs
  const productNames = [...new Set(
    orders.map((o) => o.productName).filter((n): n is string => !!n)
  )];
  const productImageMap = new Map<string, string>();
  if (productNames.length > 0) {
    const prods = await prisma.product.findMany({
      where: { name: { in: productNames } },
      select: { name: true, imageUrl: true },
    });
    for (const p of prods) {
      if (p.imageUrl) productImageMap.set(p.name, p.imageUrl);
    }
  }

  const enrichedOrders = orders.map((o) => ({
    ...o,
    productImageUrl: o.productName
      ? productImageMap.get(o.productName) ?? null
      : null,
  }));

  return NextResponse.json({
    orders: enrichedOrders,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    counts,
    carriers,
    products,
  });
}
