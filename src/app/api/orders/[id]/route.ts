import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus, Prisma } from "@prisma/client";
import { runAutomationsForOrder } from "@/lib/automations";

const ALLOWED_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      whatsappMessages: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  return NextResponse.json({ order });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: { status?: unknown; pipelineNote?: unknown; callAgentQueued?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: Prisma.OrderUpdateInput = {};

  if (body.callAgentQueued !== undefined) {
    if (typeof body.callAgentQueued !== "boolean") {
      return NextResponse.json(
        { error: "callAgentQueued must be a boolean" },
        { status: 400 }
      );
    }
    data.callAgentQueued = body.callAgentQueued;
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string") {
      return NextResponse.json(
        { error: "status must be a string" },
        { status: 400 }
      );
    }
    if (!ALLOWED_STATUSES.includes(body.status as OrderStatus)) {
      return NextResponse.json(
        { error: `Invalid status: ${body.status}` },
        { status: 400 }
      );
    }
    data.status = body.status as OrderStatus;
    data.statusChangedAt = new Date();
  }

  if (body.pipelineNote !== undefined) {
    if (
      body.pipelineNote !== null &&
      typeof body.pipelineNote !== "string"
    ) {
      return NextResponse.json(
        { error: "pipelineNote must be a string or null" },
        { status: 400 }
      );
    }
    data.pipelineNote = body.pipelineNote as string | null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const previousOrder = await prisma.order.findUnique({
    where: { id },
    select: { status: true },
  });

  const order = await prisma.order
    .update({
      where: { id },
      data,
    })
    .catch((err: unknown) => {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        return null;
      }
      throw err;
    });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Fire automations whenever the status actually changed (drag in the
  // Pipeline UI, /api/orders PATCH, etc.). Best-effort — failure here MUST
  // NOT 500 the PATCH because the status update already succeeded.
  if (
    body.status !== undefined &&
    previousOrder &&
    previousOrder.status !== order.status
  ) {
    try {
      await runAutomationsForOrder(order.id);
    } catch (err) {
      console.error("[orders/PATCH] automation engine threw", err);
    }
  }

  return NextResponse.json({ order });
}
