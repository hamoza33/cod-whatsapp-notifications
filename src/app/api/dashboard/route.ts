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
    shippedOrders,
    outForDeliveryOrders,
    deliveredOrders,
    totalMessages,
    sentMessages,
    failedMessages,
    recentSync,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "SHIPPED" } }),
    prisma.order.count({ where: { status: "OUT_FOR_DELIVERY" } }),
    prisma.order.count({ where: { status: "DELIVERED" } }),
    prisma.whatsappMessage.count(),
    prisma.whatsappMessage.count({ where: { status: "SENT" } }),
    prisma.whatsappMessage.count({ where: { status: "FAILED" } }),
    prisma.syncLog.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);

  return NextResponse.json({
    stats: {
      totalOrders,
      shippedOrders,
      outForDeliveryOrders,
      deliveredOrders,
      totalMessages,
      sentMessages,
      failedMessages,
      lastSyncAt: recentSync?.createdAt ?? null,
      lastSyncStatus: recentSync?.status ?? null,
    },
  });
}
