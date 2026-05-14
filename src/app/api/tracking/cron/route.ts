import { NextRequest, NextResponse } from "next/server";
import { refreshAllTracking } from "@/lib/tracking";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { results, totalProcessed, batches } = await refreshAllTracking();
  return NextResponse.json({
    refreshed: totalProcessed,
    batches,
    results,
    nextRunIn: "30 minutes",
  });
}
