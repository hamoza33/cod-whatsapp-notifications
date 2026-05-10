import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { WhatsAppClient } from "@/lib/whatsapp";
import { normalizePhoneNumber } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`whatsapp-test:${user.id}`, 5, 60_000);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for test messages." },
      { status: 429 }
    );
  }

  try {
    const { phoneNumber } = await request.json();

    if (!phoneNumber) {
      return NextResponse.json(
        { error: "phoneNumber is required" },
        { status: 400 }
      );
    }

    const defaultCountryCode =
      (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

    let phone: string;
    try {
      phone = normalizePhoneNumber(phoneNumber, defaultCountryCode);
    } catch {
      return NextResponse.json(
        { error: `Invalid phone number: ${phoneNumber}` },
        { status: 400 }
      );
    }

    const whatsappClient = await WhatsAppClient.fromSettings();
    const result = await whatsappClient.sendTestMessage(phone);

    return NextResponse.json({ success: true, result });
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to send test message";
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
