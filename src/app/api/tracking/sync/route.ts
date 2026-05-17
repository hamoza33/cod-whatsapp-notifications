import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import { syncOrders } from "@/lib/sync";
import { syncTrackingFromOrders, reclassifyOtherOrders } from "@/lib/tracking";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Save old sync_days_back setting
    const oldDaysBack = await getSetting(SETTING_KEYS.SYNC_DAYS_BACK);

    // Calculate days from Jan 1, 2025 to now
    const startOfYear = new Date("2025-01-01T00:00:00Z");
    const daysSinceStart = Math.ceil(
      (Date.now() - startOfYear.getTime()) / (24 * 60 * 60 * 1000)
    );

    // Temporarily set days-back to cover all of 2025+
    await setSetting(SETTING_KEYS.SYNC_DAYS_BACK, String(daysSinceStart + 1));

    // Run the full sync — skip automations to prevent unintended WhatsApp messages
    const syncResult = await syncOrders({ skipAutomations: true });

    // Restore old setting
    if (oldDaysBack) {
      await setSetting(SETTING_KEYS.SYNC_DAYS_BACK, oldDaysBack);
    } else {
      await setSetting(SETTING_KEYS.SYNC_DAYS_BACK, "30");
    }

    // Sync tracking records from all imported orders
    const trackingResult = await syncTrackingFromOrders();

    // Re-classify OTHER orders with improved carrier detection
    const reclassifyResult = await reclassifyOtherOrders();

    return NextResponse.json({
      ordersFound: syncResult.ordersFound,
      ordersCreated: syncResult.ordersCreated,
      ordersUpdated: syncResult.ordersUpdated,
      trackingImported: trackingResult.imported,
      trackingUpdated: trackingResult.updated,
      reclassified: reclassifyResult.reclassified,
      errors: syncResult.errors.length > 0 ? syncResult.errors : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Full sync failed" },
      { status: 500 }
    );
  }
}
