import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { refreshAllTracking, reclassifyOtherOrders } from "@/lib/tracking";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Re-classify OTHER orders first so they can be tracked by carrier APIs
  const reclassify = await reclassifyOtherOrders();

  const { results, totalProcessed, batches, remaining, totalActive } = await refreshAllTracking();
  return NextResponse.json({
    results,
    totalProcessed,
    batches,
    remaining,
    totalActive,
    reclassified: reclassify.reclassified,
  });
}
