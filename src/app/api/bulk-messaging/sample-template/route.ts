import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { buildSampleCsv } from "@/lib/bulk-messaging/sample";

/**
 * Returns a sample CSV the operator can download and edit. Useful as the
 * "this is the shape we expect" example surfaced from the Bulk Messaging
 * upload step.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const csv = buildSampleCsv();
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="bulk-messaging-sample.csv"',
      "Cache-Control": "no-store",
    },
  });
}
