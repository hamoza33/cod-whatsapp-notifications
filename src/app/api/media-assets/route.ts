import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { looksLikePhoneNumber } from "@/lib/whatsapp-validation";

/**
 * GET /api/media-assets — list all uploaded media assets (newest first).
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assets = await prisma.mediaAsset.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ assets });
}

/**
 * POST /api/media-assets — upload an image file.
 *
 * Accepts multipart/form-data with a `file` field. The image is uploaded to
 * Meta's Cloud API to get a media ID, and a MediaAsset record is saved. The
 * `url` stored is the original public URL (if available) or a data-URI
 * thumbnail for gallery display. The `metaMediaId` is saved for sending.
 *
 * For simplicity the file is stored as a base64 data-URI so the gallery
 * works without an external storage bucket. In production this should be
 * replaced with S3/R2/Cloudflare Images.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a 'file' field." },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "'file' field is required and must be a file." },
      { status: 400 }
    );
  }

  const mimeType = file.type || "image/jpeg";
  if (!/^image\//.test(mimeType)) {
    return NextResponse.json(
      { error: `Only image files are supported. Got: ${mimeType}` },
      { status: 400 }
    );
  }

  const MAX_SIZE = 16 * 1024 * 1024; // 16 MB
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: "File too large. Max 16 MB." },
      { status: 400 }
    );
  }

  const filename = file instanceof File ? file.name : "image.jpg";

  // Convert to base64 data-URI for gallery thumbnail storage.
  const buffer = Buffer.from(await file.arrayBuffer());
  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;

  // Try to upload to Meta for the media ID (optional — gallery works without).
  let metaMediaId: string | null = null;
  try {
    const phoneNumberId =
      (await getSetting(SETTING_KEYS.WHATSAPP_PHONE_NUMBER_ID)) ||
      process.env.WHATSAPP_PHONE_NUMBER_ID ||
      "";
    const accessToken =
      (await getSetting(SETTING_KEYS.WHATSAPP_ACCESS_TOKEN)) ||
      process.env.WHATSAPP_ACCESS_TOKEN ||
      "";
    const apiVersion =
      (await getSetting(SETTING_KEYS.WHATSAPP_API_VERSION)) ||
      process.env.WHATSAPP_API_VERSION ||
      "v17.0";

    if (phoneNumberId && accessToken && !looksLikePhoneNumber(phoneNumberId)) {
      const metaForm = new FormData();
      metaForm.set("messaging_product", "whatsapp");
      metaForm.set("type", mimeType);
      metaForm.set("file", file, filename);

      const response = await fetch(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: metaForm,
        }
      );
      if (response.ok) {
        const parsed = (await response.json()) as { id?: string };
        metaMediaId = parsed.id ?? null;
      }
    }
  } catch {
    // Non-fatal — the gallery still works; media just won't be pre-uploaded.
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      filename,
      mimeType,
      size: file.size,
      url: dataUri,
      metaMediaId,
    },
  });

  return NextResponse.json({ asset }, { status: 201 });
}
