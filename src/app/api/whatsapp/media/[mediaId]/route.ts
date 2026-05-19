import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Proxies media downloads from Meta's Cloud API. Inbound messages store a
 * `mediaId` — this endpoint resolves it to the temporary download URL and
 * streams the binary back with the correct Content-Type, so the browser can
 * render images / play audio without needing the Meta access token.
 *
 * Flow:
 *   1. GET graph.facebook.com/{version}/{mediaId} → { url, mime_type }
 *   2. GET that url with Bearer token → binary payload
 *   3. Stream binary to client
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { mediaId } = await params;

  const accessToken =
    (await getSetting(SETTING_KEYS.WHATSAPP_ACCESS_TOKEN)) ||
    process.env.WHATSAPP_ACCESS_TOKEN ||
    "";
  const apiVersion =
    (await getSetting(SETTING_KEYS.WHATSAPP_API_VERSION)) ||
    process.env.WHATSAPP_API_VERSION ||
    "v17.0";

  if (!accessToken) {
    return NextResponse.json(
      { error: "WhatsApp access token not configured." },
      { status: 400 }
    );
  }

  // Step 1: Resolve mediaId → download URL
  const metaUrl = `https://graph.facebook.com/${apiVersion}/${mediaId}`;
  let metaRes: Response;
  try {
    metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return NextResponse.json(
      { error: `Failed to resolve media URL: ${msg}` },
      { status: 502 }
    );
  }

  if (!metaRes.ok) {
    const body = await metaRes.text();
    return NextResponse.json(
      { error: `Meta API error (${metaRes.status}): ${body.slice(0, 500)}` },
      { status: metaRes.status }
    );
  }

  let mediaInfo: { url?: string; mime_type?: string };
  try {
    mediaInfo = (await metaRes.json()) as { url?: string; mime_type?: string };
  } catch {
    return NextResponse.json(
      { error: "Non-JSON response from Meta media endpoint" },
      { status: 502 }
    );
  }

  if (!mediaInfo.url) {
    return NextResponse.json(
      { error: "No download URL returned by Meta" },
      { status: 502 }
    );
  }

  // Step 2: Download the actual binary
  let binaryRes: Response;
  try {
    binaryRes = await fetch(mediaInfo.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return NextResponse.json(
      { error: `Failed to download media: ${msg}` },
      { status: 502 }
    );
  }

  if (!binaryRes.ok) {
    return NextResponse.json(
      { error: `Media download failed (${binaryRes.status})` },
      { status: binaryRes.status }
    );
  }

  const contentType =
    mediaInfo.mime_type ||
    binaryRes.headers.get("content-type") ||
    "application/octet-stream";

  const body = binaryRes.body;
  if (!body) {
    return NextResponse.json(
      { error: "Empty response body from Meta" },
      { status: 502 }
    );
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=86400",
    },
  });
}
