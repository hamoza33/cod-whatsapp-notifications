import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSettings, setSetting, SETTING_KEYS } from "@/lib/settings";

const ALLOWED_KEYS = Object.values(SETTING_KEYS);

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getSettings([...ALLOWED_KEYS]);

  // Redact sensitive values — return null but indicate which are configured
  const redacted = { ...settings };
  const sensitiveKeys = [
    SETTING_KEYS.COD_API_TOKEN,
    SETTING_KEYS.WHATSAPP_ACCESS_TOKEN,
  ];
  const sensitiveKeysSet: string[] = [];
  for (const key of sensitiveKeys) {
    if (redacted[key]) {
      sensitiveKeysSet.push(key);
      redacted[key] = null;
    }
  }

  return NextResponse.json({ settings: redacted, sensitiveKeysSet });
}

export async function PUT(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { settings } = body as { settings: Record<string, string> };

    if (!settings || typeof settings !== "object") {
      return NextResponse.json(
        { error: "Settings object required" },
        { status: 400 }
      );
    }

    for (const [key, value] of Object.entries(settings)) {
      if (!ALLOWED_KEYS.includes(key as (typeof ALLOWED_KEYS)[number])) {
        return NextResponse.json(
          { error: `Invalid setting key: ${key}` },
          { status: 400 }
        );
      }
      await setSetting(key, value);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
