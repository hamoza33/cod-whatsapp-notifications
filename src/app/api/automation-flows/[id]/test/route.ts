/**
 * Manually trigger a flow against a specific order — used by the
 * "Test run" button in the canvas inspector. Bypasses the
 * `isEnabled` filter so disabled flows can still be exercised.
 *
 * Body: `{ orderId: string }`
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeFlow, buildContextForOrder } from "@/lib/automation-flows/engine";
import type { FlowTriggerType } from "@/lib/automation-flows/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface TestBody {
  orderId?: string;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;

  let body: TestBody = {};
  try {
    body = (await request.json()) as TestBody;
  } catch {
    /* allow empty body */
  }

  const flow = await prisma.automationFlow.findUnique({ where: { id } });
  if (!flow) {
    return NextResponse.json({ error: "Flow not found" }, { status: 404 });
  }

  let orderId = body.orderId ?? null;
  if (!orderId) {
    // No explicit order — pick the most recent matching order so the
    // operator can verify the wiring without supplying an ID.
    const recent = await prisma.order.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    orderId = recent?.id ?? null;
  }

  if (!orderId) {
    return NextResponse.json(
      { error: "No order available to test against. Create an order first." },
      { status: 400 }
    );
  }

  const ctx = await buildContextForOrder(orderId, {
    type: flow.triggerType as FlowTriggerType,
    firedAt: new Date(),
    payload: { manual: true },
  });
  if (!ctx) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const result = await executeFlow(flow, ctx);
  return NextResponse.json(result);
}
