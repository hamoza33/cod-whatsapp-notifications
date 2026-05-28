/**
 * GET /api/media-assets/[id]/raw
 *
 * Streams the raw bytes of a gallery image so external services
 * (specifically Meta's WhatsApp Cloud API) can fetch the image via a
 * normal HTTPS URL. The gallery's upload endpoint stores files as
 * base64 data-URIs on the `MediaAsset.url` column — but Meta rejects
 * `data:` URIs as a header image source, so the editor stores the
 * public URL of THIS route on the action node instead.
 *
 * Unauthenticated on purpose: Meta's fetcher hits the URL without any
 * credentials. The asset id is a cuid (effectively unguessable) so
 * leaking content to anonymous viewers is a non-issue, and the data
 * is only ever images the operator explicitly uploaded for sending.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Decode the stored data-URI into raw bytes. Falls back to redirecting
  // when the column holds a non-data URL (e.g. legacy assets that were
  // uploaded straight to an external bucket).
  const match = asset.url.match(/^data:([^;,]+);base64,(.+)$/);
  if (match) {
    const mimeType = match[1] || asset.mimeType || "application/octet-stream";
    const buffer = Buffer.from(match[2], "base64");
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(buffer.length),
        // 1-hour cache: Meta fetches the image once per send.
        "Cache-Control": "public, max-age=3600, immutable",
        "Content-Disposition": `inline; filename="${encodeURIComponent(asset.filename)}"`,
      },
    });
  }

  if (/^https?:\/\//.test(asset.url)) {
    return NextResponse.redirect(asset.url, 302);
  }

  return NextResponse.json(
    { error: "Asset has no servable content" },
    { status: 415 }
  );
}
