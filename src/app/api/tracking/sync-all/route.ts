import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus, TrackingJobStatus } from "@prisma/client";
import { normalizeCarrier } from "@/lib/carrier-normalization";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if there's already a running or queued job
  const existingJob = await prisma.trackingJob.findFirst({
    where: { status: { in: [TrackingJobStatus.QUEUED, TrackingJobStatus.RUNNING] } },
  });
  if (existingJob) {
    return NextResponse.json(
      {
        error: "A tracking job is already in progress",
        jobId: existingJob.id,
      },
      { status: 409 }
    );
  }

  // Select all eligible orders:
  // - has tracking number
  // - not delivered, not returned, not cancelled
  const eligibleOrders = await prisma.order.findMany({
    where: {
      trackingNumber: { not: null },
      status: {
        in: [
          OrderStatus.PENDING,
          OrderStatus.CONFIRMED,
          OrderStatus.PROCESSING,
          OrderStatus.SHIPPED,
          OrderStatus.OUT_FOR_DELIVERY,
          OrderStatus.UNKNOWN,
        ],
      },
    },
    select: {
      id: true,
      trackingNumber: true,
      deliveryCompany: true,
      normalizedCarrier: true,
    },
  });

  if (eligibleOrders.length === 0) {
    return NextResponse.json(
      { error: "No eligible orders to track" },
      { status: 404 }
    );
  }

  // Normalize carriers for orders that don't have one yet and prepare items
  const jobItems: Array<{
    orderId: string;
    trackingNumber: string;
    carrier: string;
  }> = [];

  const unknownClassifications: Array<{
    orderId: string;
    trackingNumber: string;
    originalCarrierName: string;
    reason: string;
  }> = [];

  for (const order of eligibleOrders) {
    if (!order.trackingNumber) continue;

    let carrier = order.normalizedCarrier;
    if (!carrier) {
      const result = normalizeCarrier(order.deliveryCompany, order.trackingNumber);
      carrier = result.carrier;

      // Update the order's normalizedCarrier
      if (carrier) {
        await prisma.order.update({
          where: { id: order.id },
          data: { normalizedCarrier: carrier },
        });
      } else {
        unknownClassifications.push({
          orderId: order.id,
          trackingNumber: order.trackingNumber,
          originalCarrierName: order.deliveryCompany ?? "",
          reason: result.reason ?? "unknown",
        });
      }
    }

    jobItems.push({
      orderId: order.id,
      trackingNumber: order.trackingNumber,
      carrier: carrier ?? "UNKNOWN",
    });
  }

  // Log unknown classifications
  if (unknownClassifications.length > 0) {
    console.warn(
      `[tracking-sync] ${unknownClassifications.length} orders classified as UNKNOWN:`,
      unknownClassifications.slice(0, 10)
    );
  }

  // Create the job and all items in a single transaction
  const job = await prisma.trackingJob.create({
    data: {
      totalOrders: jobItems.length,
      items: {
        create: jobItems.map((item) => ({
          orderId: item.orderId,
          trackingNumber: item.trackingNumber,
          carrier: item.carrier,
        })),
      },
    },
  });

  console.log(
    `[tracking-sync] Created job ${job.id} with ${jobItems.length} items ` +
    `(${unknownClassifications.length} unknown)`
  );

  return NextResponse.json({ jobId: job.id, totalOrders: jobItems.length });
}
