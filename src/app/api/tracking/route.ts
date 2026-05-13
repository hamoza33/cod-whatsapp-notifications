import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { detectCarrier } from "@/lib/tracking";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const carrier = searchParams.get("carrier");
  const status = searchParams.get("status");
  const search = searchParams.get("search");

  const where: Record<string, unknown> = {};
  if (carrier) where.carrier = carrier;
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { trackingNumber: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
    ];
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
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ orders });
}

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { trackingNumber, customerName, customerPhone, orderId } = body;

  if (!trackingNumber || typeof trackingNumber !== "string") {
    return NextResponse.json(
      { error: "trackingNumber is required" },
      { status: 400 }
    );
  }

  const carrier = detectCarrier(trackingNumber.trim());
  if (!carrier) {
    return NextResponse.json(
      {
        error:
          "Unsupported tracking number. Must start with '60' (iMile) or 'INJAZ.' (Injaz Express).",
      },
      { status: 400 }
    );
  }

  const existing = await prisma.trackingOrder.findUnique({
    where: { trackingNumber: trackingNumber.trim() },
  });
  if (existing) {
    return NextResponse.json(
      { error: "This tracking number is already being tracked." },
      { status: 409 }
    );
  }

  const order = await prisma.trackingOrder.create({
    data: {
      trackingNumber: trackingNumber.trim(),
      carrier,
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      orderId: orderId || null,
    },
  });

  return NextResponse.json({ order }, { status: 201 });
}
