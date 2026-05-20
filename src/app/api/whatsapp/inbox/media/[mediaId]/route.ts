import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Proxy endpoint that downloads a WhatsApp media object from Meta's Graph
 * API and streams the binary back to the browser so the inbox can render
 * images, video, and audio inline.
 *
 * Meta media URLs are short-lived (~5 min) and require an Authorization
 * header to fetch, so the browser can't talk to them directly. The endpoint
 * does the two-hop lookup on the server:
 *
 *   1. GET https://graph.facebook.com/v17.0/{mediaId}  -> { url, mime_type }
 *   2. GET <url>                                       -> binary
 *
 * Response is cached client-side for 10 minutes to avoid re-doing the
 * lookup on every scroll re-render. The Meta short-lived URL stays valid
 * for ~5 min so 10 min is the practical upper bound.
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
  if (!mediaId || !/^\d+$/.test(mediaId)) {
    return NextResponse.json(
      { error: "Invalid media id" },
      { status: 400 }
    );
  }

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
      { error: "WhatsApp access token not configured" },
      { status: 400 }
    );
  }

  // Step 1: ask Meta for the media metadata (url, mime_type, etc.).
  const metaUrl = `https://graph.facebook.com/${apiVersion}/${mediaId}`;
  let metaResp: Response;
  try {
    metaResp = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error fetching media metadata: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 }
    );
  }
  if (!metaResp.ok) {
    const errBody = await metaResp.text();
    return NextResponse.json(
      { error: `Meta media metadata error (${metaResp.status}): ${errBody.slice(0, 300)}` },
      { status: metaResp.status }
    );
  }
  const meta = (await metaResp.json()) as {
    url?: string;
    mime_type?: string;
    file_size?: number;
  };
  if (!meta.url) {
    return NextResponse.json(
      { error: "Meta media response missing url" },
      { status: 502 }
    );
  }

  // Step 2: fetch the binary using the bearer token. Meta requires the
  // Authorization header even for the temporary CDN URL.
  let binResp: Response;
  try {
    binResp = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error fetching media binary: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 }
    );
  }
  if (!binResp.ok) {
    return NextResponse.json(
      { error: `Meta media binary fetch failed (${binResp.status})` },
      { status: binResp.status }
    );
  }

  const contentType =
    binResp.headers.get("content-type") || meta.mime_type || "application/octet-stream";
  const contentLength = binResp.headers.get("content-length");

  // Stream the body back to the client.
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  if (contentLength) headers.set("Content-Length", contentLength);
  // 10-minute private cache; Meta's URL only stays valid ~5 min but the
  // mediaId itself is stable for 30 days so refetching is cheap.
  headers.set("Cache-Control", "private, max-age=600");

  return new NextResponse(binResp.body, {
    status: 200,
    headers,
  });
}
