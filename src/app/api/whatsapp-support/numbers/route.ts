import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";

/**
 * Returns the support WhatsApp number configuration.
 * Unlike the main inbox which supports multiple numbers, the support section
 * uses a single configured number.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pni = await getSetting("wa_support_phone_number_id");
  if (!pni) {
    return NextResponse.json({ numbers: [] });
  }

  return NextResponse.json({
    numbers: [
      {
        id: "support-default",
        label: "Support Line",
        phoneNumberId: pni,
        displayPhone: pni,
        isDefault: true,
      },
    ],
  });
}
