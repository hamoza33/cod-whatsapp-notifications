import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";

/**
 * Mark messages as read in the support inbox.
 * Accepts the request but no-ops since the schema doesn't track read status
 * on individual inbound messages.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await request.json();
  return NextResponse.json({ ok: true });
}
