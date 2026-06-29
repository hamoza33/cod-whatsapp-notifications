import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Media proxy for WhatsApp Support — same 2-hop approach as the main inbox
 * but uses wa_support_access_token instead of the main credentials.
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
    return NextResponse.json({ error: "Invalid media id" }, { status: 400 });
  }

  const accessToken = await getSetting("wa_support_access_token");
  if (!accessToken) {
    return NextResponse.json(
      { error: "WhatsApp Support access token not configured" },
      { status: 400 }
    );
  }

  const apiVersion = "v17.0";

  // Step 1: get media metadata from Meta
  const metaUrl = `https://graph.facebook.com/${apiVersion}/${mediaId}`;
  let metaResp: Response;
  try {
    metaResp = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 }
    );
  }
  if (!metaResp.ok) {
    const errBody = await metaResp.text();
    return NextResponse.json(
      { error: `Meta error (${metaResp.status}): ${errBody.slice(0, 300)}` },
      { status: metaResp.status }
    );
  }
  const meta = (await metaResp.json()) as { url?: string; mime_type?: string };
  if (!meta.url) {
    return NextResponse.json({ error: "Meta response missing url" }, { status: 502 });
  }

  // Step 2: download binary
  let binResp: Response;
  try {
    binResp = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Binary fetch error: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 }
    );
  }
  if (!binResp.ok) {
    return NextResponse.json(
      { error: `Binary fetch failed (${binResp.status})` },
      { status: binResp.status }
    );
  }

  const contentType = binResp.headers.get("content-type") || meta.mime_type || "application/octet-stream";
  const contentLength = binResp.headers.get("content-length");

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  if (contentLength) headers.set("Content-Length", contentLength);
  headers.set("Cache-Control", "private, max-age=600");

  return new NextResponse(binResp.body, { status: 200, headers });
}
