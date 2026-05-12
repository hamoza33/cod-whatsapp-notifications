import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [
    totalOrders,
    pendingOrders,
    confirmedOrders,
    processingOrders,
    shippedOrders,
    outForDeliveryOrders,
    deliveredOrders,
    returnedOrders,
    cancelledOrders,
    totalMessages,
    sentMessages,
    failedMessages,
    recentSync,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "PENDING" } }),
    prisma.order.count({ where: { status: "CONFIRMED" } }),
    prisma.order.count({ where: { status: "PROCESSING" } }),
    prisma.order.count({ where: { status: "SHIPPED" } }),
    prisma.order.count({ where: { status: "OUT_FOR_DELIVERY" } }),
    prisma.order.count({ where: { status: "DELIVERED" } }),
    prisma.order.count({ where: { status: "RETURNED" } }),
    prisma.order.count({ where: { status: "CANCELLED" } }),
    prisma.whatsappMessage.count(),
    prisma.whatsappMessage.count({ where: { status: "SENT" } }),
    prisma.whatsappMessage.count({ where: { status: "FAILED" } }),
    prisma.syncLog.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);

  return NextResponse.json({
    stats: {
      totalOrders,
      pendingOrders,
      confirmedOrders,
      processingOrders,
      shippedOrders,
      outForDeliveryOrders,
      deliveredOrders,
      returnedOrders,
      cancelledOrders,
      totalMessages,
      sentMessages,
      failedMessages,
      lastSyncAt: recentSync?.createdAt ?? null,
      lastSyncStatus: recentSync?.status ?? null,
    },
  });
}
