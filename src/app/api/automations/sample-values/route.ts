import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Returns real example values for each template variable token by
 * sampling an actual order from the database. The automations UI uses
 * this to show operators what each variable will look like in practice.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find a recent order that has the most fields populated so the
  // examples are meaningful.
  const order = await prisma.order.findFirst({
    where: {
      customerName: { not: null },
      customerPhone: { not: null },
    },
    orderBy: { codCreatedAt: "desc" },
    include: {
      trackingOrders: {
        select: { latestEvent: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });

  if (!order) {
    return NextResponse.json({ examples: {} });
  }

  const trackingStatus = order.trackingOrders?.[0]?.latestEvent ?? null;

  const examples: Record<string, string | null> = {
    "{customer_name}": order.customerName,
    "{phone}": order.customerPhone,
    "{city}": order.customerCity,
    "{product}": order.productName,
    "{price}": order.productPrice,
    "{quantity}": order.productQuantity,
    "{tracking}": order.trackingNumber,
    "{order_id}": order.codNetworkOrderId,
    "{lead_id}": order.codNetworkLeadId,
    "{delivery_company}": order.deliveryCompany,
    "{tracking_status}": trackingStatus,
  };

  return NextResponse.json({ examples });
}
