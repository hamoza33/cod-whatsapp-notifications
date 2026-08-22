import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { syncOrders, syncLeads } from "@/lib/sync";
import { autoExpireOrders } from "@/lib/automations";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncOrders();
    // Pull leads too so the Lead pipeline refreshes alongside orders. Never
    // let a lead-sync error fail the whole manual sync.
    let leadResult: Awaited<ReturnType<typeof syncLeads>> | null = null;
    try {
      leadResult = await syncLeads();
    } catch (leadErr) {
      console.warn(
        "[sync] manual lead sync failed",
        leadErr instanceof Error ? leadErr.message : leadErr
      );
    }
    const expiredCount = await autoExpireOrders();
    return NextResponse.json({ success: true, result, leadResult, expiredCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
