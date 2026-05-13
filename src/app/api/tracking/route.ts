import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncTrackingFromOrders } from "@/lib/tracking";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Auto-import any new orders with tracking numbers
  const syncResult = await syncTrackingFromOrders();

  const { searchParams } = new URL(request.url);
  const carrier = searchParams.get("carrier");
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const where: Record<string, unknown> = {};
  if (carrier) where.carrier = carrier;
  if (status) where.status = status;
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

  const orders = await prisma.trackingOrder.findMany({
    where,
    include: {
      events: { orderBy: { occurredAt: "desc" } },
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
  });

  return NextResponse.json({ orders, imported: syncResult.imported });
}
