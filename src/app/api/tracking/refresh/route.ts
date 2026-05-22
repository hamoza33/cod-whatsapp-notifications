import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { refreshAllTracking } from "@/lib/tracking";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?includeFinal=true lets the UI's "Refresh All" button re-check
  // DELIVERED and RETURNED orders too. The cron tick keeps the default
  // (active states only) so it doesn't repeatedly bill the courier API
  // for terminal orders.
  const includeFinal =
    request.nextUrl.searchParams.get("includeFinal") === "true";

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
  } = await refreshAllTracking({ includeFinal });
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
