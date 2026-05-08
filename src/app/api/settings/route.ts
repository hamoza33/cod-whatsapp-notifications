import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  getSettings,
  setSetting,
  deleteSetting,
  SETTING_KEYS,
  SENSITIVE_SETTING_KEYS,
  INTERNAL_SETTING_KEYS,
} from "@/lib/settings";

// User-facing keys: everything except internal cached tokens.
const PUBLIC_KEYS = Object.values(SETTING_KEYS).filter(
  (k) => !INTERNAL_SETTING_KEYS.includes(k)
);
const WRITABLE_KEYS = PUBLIC_KEYS;

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getSettings([...PUBLIC_KEYS]);

  // Redact sensitive values — return null but indicate which are configured.
  const redacted = { ...settings };
  const sensitiveKeysSet: string[] = [];
  for (const key of SENSITIVE_SETTING_KEYS) {
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

    // Whether any COD-auth-affecting field is being changed; if so, drop
    // any cached login token so the next request re-logs in.
    let codAuthChanged = false;
    const codAuthKeys: string[] = [
      SETTING_KEYS.COD_API_TOKEN,
      SETTING_KEYS.COD_API_EMAIL,
      SETTING_KEYS.COD_API_PASSWORD,
      SETTING_KEYS.COD_API_BASE_URL,
    ];

    for (const [key, value] of Object.entries(settings)) {
      if (!WRITABLE_KEYS.includes(key as (typeof WRITABLE_KEYS)[number])) {
        return NextResponse.json(
          { error: `Invalid setting key: ${key}` },
          { status: 400 }
        );
      }
      await setSetting(key, value);
      if (codAuthKeys.includes(key)) codAuthChanged = true;
    }

    if (codAuthChanged) {
      await deleteSetting(SETTING_KEYS.COD_API_TOKEN_CACHED);
      await deleteSetting(SETTING_KEYS.COD_API_TOKEN_EXPIRES_AT);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
