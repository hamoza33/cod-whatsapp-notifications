import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  reclassifyOtherOrders,
  reclassifyStoredStatuses,
} from "@/lib/tracking";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `?scope=status` re-maps stored statuses using the latest event already
  // in the database (no upstream fetch). Useful after a mapper rule change.
  // Default (`scope=carrier` or unspecified) re-runs the OTHER → known-
  // carrier detection sweep.
  const scope = request.nextUrl.searchParams.get("scope") ?? "carrier";

  if (scope === "status") {
    const { reclassified, totalScanned } = await reclassifyStoredStatuses();
    return NextResponse.json({ scope: "status", reclassified, totalScanned });
  }

  const { reclassified, totalScanned } = await reclassifyOtherOrders();
  return NextResponse.json({ scope: "carrier", reclassified, totalScanned });
}
