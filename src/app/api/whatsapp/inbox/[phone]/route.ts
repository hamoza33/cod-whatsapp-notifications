import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient, WhatsAppApiError } from "@/lib/whatsapp";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Returns a unified, time-ordered thread for a single phone number,
 * combining inbound messages and outbound (template) messages. Used by the
 * Inbox view's right pane.
 *
 * Accepts optional `?phoneNumberId=` to filter by which WhatsApp number.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ phone: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { phone } = await params;
  const decodedPhone = decodeURIComponent(phone);
  const phoneNumberId = request.nextUrl.searchParams.get("phoneNumberId");

  // Webhook stores inbound phones with "+" prefix, outbound may omit it.
  // Query both variants so messages always match regardless of format.
  const digits = decodedPhone.replace(/[^\d]/g, "");
  const phoneVariants = [...new Set([decodedPhone, digits, `+${digits}`])];

  const [inbound, outbound] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: {
        fromPhoneNumber: { in: phoneVariants },
        ...(phoneNumberId ? { toPhoneNumberId: phoneNumberId } : {}),
      },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.whatsappMessage.findMany({
      where: {
        phoneNumber: { in: phoneVariants },
        ...(phoneNumberId ? { fromPhoneNumberId: phoneNumberId } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        templateName: true,
        templateLanguage: true,
        templateVariablesJson: true,
        headerImageUrl: true,
        providerMessageId: true,
        status: true,
        errorMessage: true,
        sentBy: true,
        sentAt: true,
        createdAt: true,
      },
    }),
  ]);

  type ThreadEntry =
    | {
        kind: "inbound";
        id: string;
        at: string;
        type: string;
        text: string | null;
        mediaId: string | null;
        mediaMimeType: string | null;
        contactName: string | null;
      }
    | {
        kind: "outbound";
        id: string;
        at: string;
        templateName: string;
        templateVariables: unknown;
        renderedText: string | null;
        headerImageUrl: string | null;
        sentBy: string | null;
        status: string;
        providerMessageId: string | null;
        errorMessage: string | null;
      };

  // Pre-fetch template bodies and header types for rendering outbound messages
  const templateNames = [...new Set(outbound.map((m) => m.templateName).filter((n) => n !== "<text>" && n !== "<image>" && n !== "<video>" && n !== "<audio>" && n !== "<document>"))];
  const templateBodies = new Map<string, string>();
  const templateHeaderTypes = new Map<string, string | null>();
  if (templateNames.length > 0) {
    const templates = await prisma.whatsappTemplate.findMany({
      where: { name: { in: templateNames } },
      select: { name: true, bodyText: true, headerType: true },
    });
    for (const t of templates) {
      if (t.bodyText) templateBodies.set(t.name, t.bodyText);
      templateHeaderTypes.set(t.name, t.headerType);
    }
  }

  const defaultHeaderImage = await getSetting(
    SETTING_KEYS.WHATSAPP_DEFAULT_TEMPLATE_HEADER_IMAGE_URL
  );

  const thread: ThreadEntry[] = [];
  for (const m of inbound) {
    thread.push({
      kind: "inbound",
      id: m.id,
      at: m.receivedAt.toISOString(),
      type: m.type,
      text: m.text,
      mediaId: m.mediaId,
      mediaMimeType: m.mediaMimeType,
      contactName: m.contactName,
    });
  }
  for (const m of outbound) {
    let renderedText: string | null = null;
    const isMediaTag = ["<image>", "<video>", "<audio>", "<document>"].includes(m.templateName);
    if (m.templateName === "<text>") {
      const vars = m.templateVariablesJson;
      if (vars && typeof vars === "object" && "text" in vars) {
        renderedText = (vars as { text: string }).text;
      }
    } else if (isMediaTag) {
      const vars = m.templateVariablesJson;
      if (vars && typeof vars === "object" && "caption" in vars) {
        renderedText = (vars as { caption: string }).caption;
      }
    } else {
      const body = templateBodies.get(m.templateName);
      if (body) {
        const vars = Array.isArray(m.templateVariablesJson)
          ? (m.templateVariablesJson as string[])
          : [];
        renderedText = body.replace(/\{\{(\d+)\}\}/g, (_, idx) => {
          const i = parseInt(idx, 10) - 1;
          return vars[i] ?? `{{${idx}}}`;
        });
      }
    }
    // Resolve header image: stored per-message first, then fall back to
    // the default header image if the template has an IMAGE header.
    let headerImageUrl: string | null = m.headerImageUrl ?? null;
    if (!headerImageUrl && templateHeaderTypes.get(m.templateName) === "IMAGE" && defaultHeaderImage) {
      headerImageUrl = defaultHeaderImage;
    }

    thread.push({
      kind: "outbound",
      id: m.id,
      at: (m.sentAt ?? m.createdAt).toISOString(),
      templateName: m.templateName,
      templateVariables: m.templateVariablesJson,
      renderedText,
      headerImageUrl,
      sentBy: m.sentBy,
      status: m.status,
      providerMessageId: m.providerMessageId,
      errorMessage: m.errorMessage,
    });
  }
  thread.sort((a, b) => a.at.localeCompare(b.at));

  // Compute whether we're inside Meta's 24h customer-service window
  const lastInboundAt = inbound[inbound.length - 1]?.receivedAt ?? null;
  const inSession =
    lastInboundAt
      ? Date.now() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000
      : false;

  return NextResponse.json({
    phoneNumber: decodedPhone,
    thread,
    inSession,
    lastInboundAt: lastInboundAt?.toISOString() ?? null,
  });
}

/**
 * Send a free-form text or media reply. Only valid inside Meta's 24-hour
 * customer service window.
 *
 * Body: { text?: string, phoneNumberId?: string, mediaFile?: string (base64),
 *         mediaType?: string, mediaMimeType?: string, mediaFilename?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ phone: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`whatsapp-reply:${user.id}`, 60, 60_000);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for replies." },
      { status: 429 }
    );
  }

  const { phone } = await params;
  const decodedPhone = decodeURIComponent(phone);
  let body: {
    text?: unknown;
    phoneNumberId?: string;
    mediaFile?: string;
    mediaType?: string;
    mediaMimeType?: string;
    mediaFilename?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hasMedia = body.mediaFile && body.mediaType && body.mediaMimeType;
  if (!hasMedia && (typeof body.text !== "string" || !body.text.trim())) {
    return NextResponse.json(
      { error: "text is required (or attach media)" },
      { status: 400 }
    );
  }

  const postDigits = decodedPhone.replace(/[^\d]/g, "");
  const postPhoneVariants = [...new Set([decodedPhone, postDigits, `+${postDigits}`])];
  const lastInbound = await prisma.inboundMessage.findFirst({
    where: { fromPhoneNumber: { in: postPhoneVariants } },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true, orderId: true },
  });

  let client: WhatsAppClient;
  try {
    client = body.phoneNumberId
      ? await WhatsAppClient.fromPhoneNumberId(body.phoneNumberId)
      : await WhatsAppClient.fromSettings();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "WhatsApp not configured" },
      { status: 400 }
    );
  }

  const toForApi = decodedPhone.replace(/^\+/, "");
  const usedPhoneNumberId = client.getPhoneNumberId();

  try {
    if (hasMedia) {
      // Upload the media file to Meta, then send as media message
      const fileBuffer = Buffer.from(body.mediaFile!, "base64");
      const mimeType = body.mediaMimeType!;
      const filename = body.mediaFilename || "attachment";
      const mediaType = body.mediaType as "image" | "video" | "audio" | "document";

      const uploadedMediaId = await client.uploadMedia(fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength), mimeType, filename);
      const caption = typeof body.text === "string" ? body.text.trim() : undefined;
      const result = await client.sendMedia(toForApi, mediaType, uploadedMediaId, caption || undefined);

      try {
        await prisma.whatsappMessage.create({
          data: {
            orderId: lastInbound?.orderId ?? undefined,
            phoneNumber: decodedPhone,
            templateName: `<${mediaType}>`,
            templateLanguage: "",
            templateVariablesJson: {
              mediaId: uploadedMediaId,
              caption: caption || null,
              mimeType,
              filename,
            },
            providerMessageId: result.messages?.[0]?.id ?? null,
            status: "SENT",
            sentBy: user.email,
            sentAt: new Date(),
            fromPhoneNumberId: usedPhoneNumberId,
          },
        });
      } catch {
        // ignore logging failure
      }

      return NextResponse.json({
        success: true,
        providerMessageId: result.messages?.[0]?.id ?? null,
      });
    }

    // Text-only reply
    const result = await client.sendText(toForApi, body.text as string);

    try {
      await prisma.whatsappMessage.create({
        data: {
          orderId: lastInbound?.orderId ?? undefined,
          phoneNumber: decodedPhone,
          templateName: "<text>",
          templateLanguage: "",
          templateVariablesJson: { text: String(body.text) },
          providerMessageId: result.messages?.[0]?.id ?? null,
          status: "SENT",
          sentBy: user.email,
          sentAt: new Date(),
          fromPhoneNumberId: usedPhoneNumberId,
        },
      });
    } catch {
      // ignore logging failure
    }

    return NextResponse.json({
      success: true,
      providerMessageId: result.messages?.[0]?.id ?? null,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      const inSessionExpired =
        err.metaCode === 131047 || err.metaCode === 131051;
      return NextResponse.json(
        {
          error: inSessionExpired
            ? "The 24-hour reply window has closed for this contact. Use the Pipeline → Send WhatsApp dialog to send an approved template instead."
            : err.message,
          meta: { code: err.metaCode, status: err.status },
        },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Send failed" },
      { status: 500 }
    );
  }
}

/**
 * Simulate an inbound message for testing. Auth-protected — only logged-in
 * users can call this. Useful when the Meta webhook isn't configured yet.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ phone: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { phone } = await params;
  const decodedPhone = decodeURIComponent(phone);
  let body: { text?: unknown; contactName?: unknown };
  try {
    body = (await request.json()) as { text?: unknown; contactName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { error: "text is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  const digits = decodedPhone.replace(/[^\d]/g, "");
  const normalizedPhone = `+${digits}`;

  const msg = await prisma.inboundMessage.create({
    data: {
      providerMessageId: `simulated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromPhoneNumber: normalizedPhone,
      contactName: typeof body.contactName === "string" ? body.contactName : null,
      type: "text",
      text: body.text.trim(),
      rawPayload: { simulated: true, by: user.email },
    },
  });

  return NextResponse.json({ success: true, id: msg.id });
}
