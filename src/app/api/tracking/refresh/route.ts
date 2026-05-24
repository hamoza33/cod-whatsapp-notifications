import { NextRequest, NextResponse } from "next/server";
import { TrackingCarrier, TrackingStatus } from "@prisma/client";
import { getAuthUser } from "@/lib/auth";
import { refreshAllTracking } from "@/lib/tracking";

const VALID_STATUSES = new Set<TrackingStatus>([
  TrackingStatus.PENDING,
  TrackingStatus.IN_TRANSIT,
  TrackingStatus.OUT_FOR_DELIVERY,
  TrackingStatus.DELIVERED,
  TrackingStatus.RETURNED,
  TrackingStatus.EXCEPTION,
  TrackingStatus.UNKNOWN,
  TrackingStatus.EXPIRED,
]);
const VALID_CARRIERS = new Set<TrackingCarrier>([
  TrackingCarrier.IMILE,
  TrackingCarrier.INJAZ,
  TrackingCarrier.JTE,
  TrackingCarrier.JDW,
  TrackingCarrier.NAQEL,
  TrackingCarrier.OTHER,
]);

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

  // ?status=DELIVERED and ?carrier=IMILE narrow the refresh to a single
  // status / carrier. Used by the "Refresh Section" button so users can
  // re-check the orders matching the currently selected pill without
  // touching any other bucket.
  const rawStatus = request.nextUrl.searchParams.get("status");
  const rawCarrier = request.nextUrl.searchParams.get("carrier");

  const statusFilter =
    rawStatus && VALID_STATUSES.has(rawStatus as TrackingStatus)
      ? (rawStatus as TrackingStatus)
      : undefined;
  const carrierFilter =
    rawCarrier && VALID_CARRIERS.has(rawCarrier as TrackingCarrier)
      ? (rawCarrier as TrackingCarrier)
      : undefined;

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
  } = await refreshAllTracking({
    includeFinal,
    statusFilter,
    carrierFilter,
  });
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
