import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { looksLikePhoneNumber } from "@/lib/whatsapp-validation";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Uploads a file to Meta's Cloud API Media endpoint and returns the media ID.
 * Used for templates that require an IMAGE header — uploading via Meta is
 * more reliable than passing a public URL because Meta sometimes can't fetch
 * the URL fast enough and falls back to "expected IMAGE, received UNKNOWN".
 *
 * Accepts a multipart/form-data body with a single `file` field. Max ~16 MB
 * (Meta limit varies by media type).
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`whatsapp-media:${user.id}`, 30, 60_000);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for media uploads." },
      { status: 429 }
    );
  }

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

  if (!phoneNumberId || !accessToken) {
    return NextResponse.json(
      { error: "WhatsApp Cloud API credentials not configured." },
      { status: 400 }
    );
  }
  if (looksLikePhoneNumber(phoneNumberId)) {
    return NextResponse.json(
      {
        error: `WhatsApp "Phone Number ID" looks like a phone number (${phoneNumberId}). Set the 15–16 digit Meta Phone Number ID in Settings → WhatsApp Cloud API.`,
      },
      { status: 400 }
    );
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

  const fileType = file.type || "image/jpeg";
  // Accept anything Meta's Cloud API accepts: image/*, video/*, audio/*, and
  // common document types. PDFs go up via /document; everything else maps
  // 1:1 to the matching message type. The endpoint just uploads — the
  // sender chooses the actual message type when calling /messages.
  if (
    !/^image\//.test(fileType) &&
    !/^video\//.test(fileType) &&
    !/^audio\//.test(fileType) &&
    !/^application\/(pdf|msword|vnd\.openxmlformats|vnd\.ms-excel|vnd\.ms-powerpoint|zip|x-zip-compressed)$/.test(
      fileType
    ) &&
    !/^text\/(plain|csv)$/.test(fileType)
  ) {
    return NextResponse.json(
      { error: `Unsupported media type ${fileType}. Allowed: image/*, video/*, audio/*, application/pdf, document files.` },
      { status: 400 }
    );
  }

  // Re-build a fresh FormData to talk to Meta — their API requires the
  // `messaging_product` and `type` fields and a Blob (not a forwarded
  // request body).
  const metaForm = new FormData();
  metaForm.set("messaging_product", "whatsapp");
  metaForm.set("type", fileType);
  // Preserve filename when provided so Meta accepts the part.
  const filename = file instanceof File ? file.name : "upload";
  metaForm.set("file", file, filename);

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: metaForm,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return NextResponse.json({ error: `Network error: ${msg}` }, { status: 502 });
  }

  const responseText = await response.text();
  if (!response.ok) {
    return NextResponse.json(
      { error: `Meta media upload failed (${response.status}): ${responseText.slice(0, 500)}` },
      { status: response.status }
    );
  }

  let parsed: { id?: string };
  try {
    parsed = JSON.parse(responseText) as { id?: string };
  } catch {
    return NextResponse.json(
      { error: `Non-JSON response from Meta media upload: ${responseText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  if (!parsed.id) {
    return NextResponse.json(
      { error: `Meta media upload missing id in response: ${responseText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    mediaId: parsed.id,
    type: fileType,
    size: file.size,
  });
}
