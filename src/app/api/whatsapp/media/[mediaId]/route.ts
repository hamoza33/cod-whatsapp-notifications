import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

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
      { error: "WhatsApp access token not configured" },
      { status: 400 }
    );
  }

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!metaRes.ok) {
      const body = await metaRes.text();
      return NextResponse.json(
        { error: `Meta API error: ${body.slice(0, 300)}` },
        { status: metaRes.status }
      );
    }
    const meta = (await metaRes.json()) as {
      url?: string;
      mime_type?: string;
    };
    if (!meta.url) {
      return NextResponse.json(
        { error: "No media URL returned by Meta" },
        { status: 502 }
      );
    }

    const mediaRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!mediaRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch media binary: ${mediaRes.status}` },
        { status: mediaRes.status }
      );
    }

    const contentType =
      mediaRes.headers.get("content-type") || meta.mime_type || "application/octet-stream";
    const blob = await mediaRes.arrayBuffer();

    return new NextResponse(blob, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Media proxy error" },
      { status: 500 }
    );
  }
}
