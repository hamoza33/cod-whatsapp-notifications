import { NextRequest, NextResponse } from "next/server";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * Proxy for Meta's media download API. Inbound media (images, videos, audio,
 * documents, stickers) stored by Meta require an authenticated request to
 * retrieve. This endpoint:
 * 1. Calls GET graph.facebook.com/{mediaId} to obtain the download URL
 * 2. Fetches the binary from the returned URL (with Bearer token)
 * 3. Returns the binary with the correct Content-Type
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> }
) {
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
      { error: "WhatsApp access token not configured" },
      { status: 400 }
    );
  }

  // Step 1: Get the media URL from Meta
  const metaUrl = `https://graph.facebook.com/${apiVersion}/${mediaId}`;
  let mediaResponse: Response;
  try {
    mediaResponse = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return NextResponse.json(
      { error: `Failed to fetch media metadata: ${msg}` },
      { status: 502 }
    );
  }

  if (!mediaResponse.ok) {
    const body = await mediaResponse.text();
    return NextResponse.json(
      { error: `Meta API error (${mediaResponse.status}): ${body.slice(0, 300)}` },
      { status: mediaResponse.status }
    );
  }

  const mediaData = (await mediaResponse.json()) as {
    url?: string;
    mime_type?: string;
  };

  if (!mediaData.url) {
    return NextResponse.json(
      { error: "No download URL returned by Meta" },
      { status: 502 }
    );
  }

  // Step 2: Download the actual media binary
  let binaryResponse: Response;
  try {
    binaryResponse = await fetch(mediaData.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return NextResponse.json(
      { error: `Failed to download media: ${msg}` },
      { status: 502 }
    );
  }

  if (!binaryResponse.ok) {
    return NextResponse.json(
      { error: `Media download failed (${binaryResponse.status})` },
      { status: binaryResponse.status }
    );
  }

  const contentType =
    binaryResponse.headers.get("content-type") ||
    mediaData.mime_type ||
    "application/octet-stream";
  const buffer = await binaryResponse.arrayBuffer();

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
