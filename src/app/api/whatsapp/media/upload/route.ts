import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`whatsapp-media-upload:${user.id}`, 30, 60_000);
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

  const fileType = file.type || "application/octet-stream";

  const metaForm = new FormData();
  metaForm.set("messaging_product", "whatsapp");
  metaForm.set("type", fileType);
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
      { error: `Non-JSON response from Meta: ${responseText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  if (!parsed.id) {
    return NextResponse.json(
      { error: `Meta upload missing id: ${responseText.slice(0, 300)}` },
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
