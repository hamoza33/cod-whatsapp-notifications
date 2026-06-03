import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  getSetting,
  SETTING_KEYS,
  SENSITIVE_SETTING_KEYS,
  MASKABLE_SETTING_KEYS,
  INTERNAL_SETTING_KEYS,
} from "@/lib/settings";

// Keys whose full value the authenticated operator is allowed to reveal in
// the settings UI via the eye toggle. Limited to the user-facing masked keys
// (real secrets + maskable identifiers) — internal cached tokens are never
// revealable.
const REVEALABLE_KEYS = new Set<string>([
  ...SENSITIVE_SETTING_KEYS,
  ...MASKABLE_SETTING_KEYS,
]);

/**
 * Reveal the full plaintext value of a single masked setting.
 *
 * The settings GET endpoint masks secrets / identifiers so they never ship to
 * the client by default. This endpoint lets the authenticated operator pull
 * the full value for one key on demand (behind the eye icon) so they can copy
 * or verify a saved credential. Auth is required and only the explicitly
 * revealable keys are honoured.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  if (
    INTERNAL_SETTING_KEYS.includes(key) ||
    !REVEALABLE_KEYS.has(key) ||
    !Object.values(SETTING_KEYS).includes(key as (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS])
  ) {
    return NextResponse.json({ error: "Key not revealable" }, { status: 400 });
  }

  const value = await getSetting(key);
  return NextResponse.json({ key, value });
}
