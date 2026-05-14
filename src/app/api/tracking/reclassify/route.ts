import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeCarrier } from "@/lib/carrier-normalization";

/**
 * POST /api/tracking/reclassify
 *
 * Reclassifies existing orders that have a null or incorrect normalizedCarrier
 * using the updated carrier normalization rules. This is a repair endpoint
 * meant to be called after updating the carrier normalization aliases.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find all orders that have a tracking number but no normalized carrier,
  // or that are currently UNKNOWN
  const orders = await prisma.order.findMany({
    where: {
      trackingNumber: { not: null },
      OR: [
        { normalizedCarrier: null },
        { normalizedCarrier: "UNKNOWN" },
      ],
    },
    select: {
      id: true,
      codNetworkOrderId: true,
      trackingNumber: true,
      deliveryCompany: true,
      normalizedCarrier: true,
    },
  });

  let reclassified = 0;
  let stillUnknown = 0;
  const reclassifications: Array<{
    orderId: string;
    from: string | null;
    to: string;
    deliveryCompany: string | null;
  }> = [];
  const unknowns: Array<{
    orderId: string;
    trackingNumber: string | null;
    deliveryCompany: string | null;
    reason: string | null;
  }> = [];

  for (const order of orders) {
    const result = normalizeCarrier(order.deliveryCompany, order.trackingNumber);
    if (result.carrier) {
      await prisma.order.update({
        where: { id: order.id },
        data: { normalizedCarrier: result.carrier },
      });
      reclassifications.push({
        orderId: order.codNetworkOrderId,
        from: order.normalizedCarrier,
        to: result.carrier,
        deliveryCompany: order.deliveryCompany,
      });
      reclassified++;
    } else {
      stillUnknown++;
      unknowns.push({
        orderId: order.codNetworkOrderId,
        trackingNumber: order.trackingNumber,
        deliveryCompany: order.deliveryCompany,
        reason: result.reason,
      });
    }
  }

  console.log(
    `[reclassify] Processed ${orders.length} orders: ` +
    `${reclassified} reclassified, ${stillUnknown} still unknown`
  );

  return NextResponse.json({
    total: orders.length,
    reclassified,
    stillUnknown,
    reclassifications: reclassifications.slice(0, 50),
    unknowns: unknowns.slice(0, 50),
  });
}
