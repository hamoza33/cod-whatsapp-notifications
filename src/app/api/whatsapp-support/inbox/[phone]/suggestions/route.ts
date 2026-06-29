import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";

interface RouteContext {
  params: Promise<{ phone: string }>;
}

/**
 * AI suggestions for the support inbox.
 * Uses the support AI agent settings (wa_support_ai_*).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const aiEnabled = await getSetting("wa_support_ai_enabled");
  if (aiEnabled !== "true") {
    return NextResponse.json({ suggestions: [] });
  }

  // For now return empty — full AI integration can be wired up using
  // the wa_support_ai_api_key and wa_support_ai_system_prompt settings.
  return NextResponse.json({ suggestions: [] });
}
