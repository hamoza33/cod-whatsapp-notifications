import { NextRequest, NextResponse } from "next/server";
import { refreshAllTracking } from "@/lib/tracking";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // refreshAllTracking() now runs reclassifyOtherOrders() inside its own
  // wall-clock deadline so the cron call stays bounded.
  const { results, totalProcessed, batches, byCarrier, reclassified } =
    await refreshAllTracking();
  return NextResponse.json({
    refreshed: totalProcessed,
    batches,
    results,
    byCarrier,
    reclassified,
    nextRunIn: "30 minutes",
  });
}
