import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { refreshAllTracking } from "@/lib/tracking";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await refreshAllTracking();
  return NextResponse.json({ results });
}
