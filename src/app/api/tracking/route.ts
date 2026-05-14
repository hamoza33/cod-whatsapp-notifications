import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const carrier = searchParams.get("carrier");
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const product = searchParams.get("product");
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "50", 10);
  const countsOnly = searchParams.get("countsOnly") === "true";

  const where: Record<string, unknown> = {};
  if (carrier) where.carrier = carrier;
  if (status) where.status = status;
  if (product) where.productName = { startsWith: product, mode: "insensitive" };
  if (search) {
    where.OR = [
      { trackingNumber: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
    ];
  }
  if (dateFrom || dateTo) {
    const dateFilter: Record<string, Date> = {};
    if (dateFrom) dateFilter.gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      dateFilter.lte = to;
    }
    where.codCreatedAt = dateFilter;
  }

  const total = await prisma.trackingOrder.count({ where });

  if (countsOnly) {
    const allStatusCounts = await prisma.trackingOrder.groupBy({
      by: ["status"],
      _count: true,
    });
    const productNamesRaw = await prisma.trackingOrder.findMany({
      where: { productName: { not: null } },
      distinct: ["productName"],
      select: { productName: true },
    });
    // Extract primary product names (before comma) to exclude cross-sells
    const primaryProducts = new Set<string>();
    for (const p of productNamesRaw) {
      if (p.productName) {
        const primary = p.productName.split(",")[0].trim();
        if (primary) primaryProducts.add(primary);
      }
    }
    return NextResponse.json({
      total,
      statusCounts: Object.fromEntries(
        allStatusCounts.map((s) => [s.status, s._count])
      ),
      productNames: Array.from(primaryProducts).sort(),
    });
  }

  const skip = (page - 1) * pageSize;
  const orders = await prisma.trackingOrder.findMany({
    where,
    include: {
      events: { orderBy: { occurredAt: "desc" }, take: 10 },
      order: {
        select: {
          id: true,
          codNetworkOrderId: true,
          customerName: true,
          productName: true,
          customerCity: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    skip,
    take: pageSize,
  });

  return NextResponse.json({
    orders,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}
