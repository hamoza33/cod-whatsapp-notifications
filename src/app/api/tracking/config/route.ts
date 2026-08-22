import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSettings, SETTING_KEYS } from "@/lib/settings";

const DEFAULT_TRACKING_URL = "https://tracking.shopinzo.bond";

async function trackingBaseUrl(): Promise<string> {
  const settings = await getSettings([SETTING_KEYS.COURIER_TRACKING_API_URL]);
  const url = settings[SETTING_KEYS.COURIER_TRACKING_API_URL] || DEFAULT_TRACKING_URL;
  return url.replace(/\/$/, "");
}

function adminToken(): string | null {
  const token = process.env.COURIER_TRACKING_ADMIN_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = adminToken();
  if (!token) {
    return NextResponse.json({ available: false });
  }
  try {
    const base = await trackingBaseUrl();
    const res = await fetch(`${base}/admin/config`, {
      headers: { "x-admin-token": token, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { available: false, error: `tracking service returned ${res.status}` },
        { status: 502 }
      );
    }
    const config = await res.json();
    return NextResponse.json({ available: true, config });
  } catch (err) {
    return NextResponse.json(
      {
        available: false,
        error: err instanceof Error ? err.message : "request failed",
      },
      { status: 502 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = adminToken();
  if (!token) {
    return NextResponse.json(
      { error: "Tracking admin token is not configured on the dashboard" },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const base = await trackingBaseUrl();
    const res = await fetch(`${base}/admin/config`, {
      method: "PATCH",
      headers: {
        "x-admin-token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: (data as { error?: string })?.error || `tracking service returned ${res.status}` },
        { status: res.status === 401 ? 502 : res.status }
      );
    }
    return NextResponse.json({ config: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "request failed" },
      { status: 502 }
    );
  }
}
