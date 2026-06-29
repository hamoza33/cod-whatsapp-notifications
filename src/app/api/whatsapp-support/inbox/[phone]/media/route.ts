import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient, WhatsAppApiError } from "@/lib/whatsapp";
import { getSetting } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Upload and send media via the support WhatsApp account.
 * Same pattern as the main inbox media route but uses wa_support_* credentials.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ phone: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`wa-support-media:${user.id}`, 30, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
  }

  const { phone } = await params;
  const decodedPhone = decodeURIComponent(phone);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a 'file' field." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "'file' field is required." }, { status: 400 });
  }
  const caption = typeof form.get("caption") === "string" ? (form.get("caption") as string).trim() : "";
  const fileType = file.type || "application/octet-stream";
  const filename = file instanceof File ? file.name : "upload";

  let mediaType: "image" | "video" | "audio" | "document";
  if (/^image\//.test(fileType)) mediaType = "image";
  else if (/^video\//.test(fileType)) mediaType = "video";
  else if (/^audio\//.test(fileType)) mediaType = "audio";
  else mediaType = "document";

  let client: WhatsAppClient;
  try {
    client = await WhatsAppClient.fromSupportSettings();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "WhatsApp Support not configured" },
      { status: 400 }
    );
  }

  const accessToken = await getSetting("wa_support_access_token");
  const apiVersion = "v17.0";

  // Step 1: upload media to Meta
  const metaForm = new FormData();
  metaForm.set("messaging_product", "whatsapp");
  metaForm.set("type", fileType);
  metaForm.set("file", file, filename);

  const uploadUrl = `https://graph.facebook.com/${apiVersion}/${client.getPhoneNumberId()}/media`;
  let uploadResp: Response;
  try {
    uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: metaForm,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error uploading media: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 }
    );
  }
  const uploadText = await uploadResp.text();
  if (!uploadResp.ok) {
    return NextResponse.json(
      { error: `Media upload failed (${uploadResp.status}): ${uploadText.slice(0, 400)}` },
      { status: uploadResp.status }
    );
  }
  let uploaded: { id?: string };
  try {
    uploaded = JSON.parse(uploadText) as { id?: string };
  } catch {
    return NextResponse.json({ error: "Non-JSON upload response" }, { status: 502 });
  }
  if (!uploaded.id) {
    return NextResponse.json({ error: "Upload response missing id" }, { status: 502 });
  }

  // Step 2: send the message
  const toForApi = decodedPhone.replace(/^\+/, "");

  try {
    const result = await client.sendMedia(toForApi, mediaType, uploaded.id, {
      caption: caption || undefined,
      filename: mediaType === "document" ? filename : undefined,
    });

    try {
      await prisma.whatsappMessage.create({
        data: {
          phoneNumber: decodedPhone,
          phoneNumberId: client.getPhoneNumberId(),
          templateName: "<media>",
          templateLanguage: "",
          templateVariablesJson: {
            mediaType,
            mediaId: uploaded.id,
            mime: fileType,
            filename,
            caption: caption || null,
          },
          providerMessageId: result.messages?.[0]?.id ?? null,
          status: "SENT",
          sentBy: user.email,
          sentAt: new Date(),
        },
      });
    } catch {
      // ignore logging failure
    }

    return NextResponse.json({
      success: true,
      mediaId: uploaded.id,
      providerMessageId: result.messages?.[0]?.id ?? null,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      return NextResponse.json(
        { error: err.message, meta: { code: err.metaCode, status: err.status } },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Send failed" },
      { status: 500 }
    );
  }
}
