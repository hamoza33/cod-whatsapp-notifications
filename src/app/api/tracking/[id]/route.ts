import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const order = await prisma.trackingOrder.findUnique({
    where: { id },
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
  });

  if (!order) {
    return NextResponse.json(
      { error: "Tracking order not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ order });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  await prisma.trackingOrder.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
