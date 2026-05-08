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
    const body = (await request.json().catch(() => ({}))) as {
      phoneNumber?: string;
      templateName?: string;
      templateLanguage?: string;
    };
    const { phoneNumber, templateName: overrideTemplate, templateLanguage: overrideLanguage } = body;

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

    // Use the configured template by default (avoids hard-coded
    // `hello_world`, which only works if it happens to be approved on the
    // user's WABA). Callers can still override per-request from the UI.
    const configuredTemplate = await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME);
    const configuredLanguage = await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE);

    const templateName = overrideTemplate || configuredTemplate || "hello_world";
    const language = overrideLanguage || configuredLanguage || "en_US";

    const whatsappClient = await WhatsAppClient.fromSettings();
    const result = await whatsappClient.sendTestMessage(phone, {
      templateName,
      language,
      variables: [],
    });

    return NextResponse.json({
      success: true,
      result,
      templateName,
      language,
    });
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to send test message";
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
