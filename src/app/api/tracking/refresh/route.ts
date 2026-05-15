import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { refreshAllTracking } from "@/lib/tracking";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // refreshAllTracking now runs reclassifyOtherOrders() inside its own
  // 45 s wall-clock deadline so a large OTHER bucket can't push this route
  // past Fly's request timeout. The orchestrator returns the reclassified
  // count alongside the per-carrier stats.
  const {
    results,
    totalProcessed,
    batches,
    remaining,
    totalActive,
    reclassified,
    byCarrier,
  } = await refreshAllTracking();
  return NextResponse.json({
    results,
    totalProcessed,
    batches,
    remaining,
    totalActive,
    reclassified,
    byCarrier,
  });
}
