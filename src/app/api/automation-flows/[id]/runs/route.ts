/**
 * List recent execution runs for a flow. The UI uses this to render the
 * per-flow timeline view (Run history) — including step-by-step output
 * for debugging.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "30", 10), 1), 200);

  const runs = await prisma.automationFlowRun.findMany({
    where: { flowId: id },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ runs });
}
