import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  getSettings,
  setSetting,
  deleteSetting,
  SETTING_KEYS,
  SENSITIVE_SETTING_KEYS,
  INTERNAL_SETTING_KEYS,
  maskSecret,
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

  // Mask sensitive values: show first 4 chars + dots + last 2 chars instead
  // of nulling them out. The user explicitly asked for this UX so they can
  // tell at a glance which secret is in which slot without ever exposing the
  // full value. Stored separately on `sensitivePreviews` so the client can
  // distinguish "configured" placeholder from a real input value.
  const redacted: Record<string, string | null> = { ...settings };
  const sensitiveKeysSet: string[] = [];
  const sensitivePreviews: Record<string, string> = {};
  for (const key of SENSITIVE_SETTING_KEYS) {
    const raw = settings[key];
    if (raw) {
      sensitiveKeysSet.push(key);
      sensitivePreviews[key] = maskSecret(raw);
      redacted[key] = null;
    }
  }

  return NextResponse.json({
    settings: redacted,
    sensitiveKeysSet,
    sensitivePreviews,
  });
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
