import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient, WhatsAppApiError } from "@/lib/whatsapp";
import { getSetting } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ phone: string }>;
}

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
      latitude: number | null;
      longitude: number | null;
      locationName: string | null;
      locationAddress: string | null;
      reactionEmoji: string | null;
      transcription: string | null;
    }
  | {
      kind: "outbound";
      id: string;
      at: string;
      templateName: string;
      templateVariables: unknown;
      renderedText: string | null;
      headerImageUrl: string | null;
      outboundMedia: {
        mediaType: string;
        mediaId: string;
        mime: string | null;
        filename: string | null;
        caption: string | null;
      } | null;
      sentBy: string | null;
      status: string;
      providerMessageId: string | null;
      errorMessage: string | null;
    };

/**
 * GET: Return thread for a phone number scoped to the support PNI.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { phone } = await context.params;
  const decodedPhone = decodeURIComponent(phone);
  const digits = decodedPhone.replace(/[^\d]/g, "");
  const phoneVariants = [...new Set([decodedPhone, digits, `+${digits}`])];

  const supportPni = await getSetting("wa_support_phone_number_id");
  if (!supportPni) {
    return NextResponse.json({ phoneNumber: decodedPhone, thread: [], inSession: false, lastInboundAt: null });
  }

  const inbound = await prisma.inboundMessage.findMany({
    where: {
      fromPhoneNumber: { in: phoneVariants },
      phoneNumberId: supportPni,
    },
    orderBy: { receivedAt: "asc" },
  });

  const outbound = await prisma.whatsappMessage.findMany({
    where: {
      phoneNumber: { in: phoneVariants },
      phoneNumberId: supportPni,
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
  });

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
      latitude: m.latitude,
      longitude: m.longitude,
      locationName: m.locationName,
      locationAddress: m.locationAddress,
      reactionEmoji: m.reactionEmoji,
      transcription: m.transcription,
    });
  }

  for (const m of outbound) {
    let renderedText: string | null = null;
    let outboundMedia: {
      mediaType: string;
      mediaId: string;
      mime: string | null;
      filename: string | null;
      caption: string | null;
    } | null = null;

    if (m.templateName === "<text>") {
      const vars = m.templateVariablesJson;
      if (vars && typeof vars === "object" && "text" in vars) {
        renderedText = (vars as { text: string }).text;
      }
    } else if (m.templateName === "<media>") {
      const vars = m.templateVariablesJson;
      if (vars && typeof vars === "object" && !Array.isArray(vars)) {
        const v = vars as Record<string, unknown>;
        if (typeof v.mediaType === "string" && typeof v.mediaId === "string") {
          outboundMedia = {
            mediaType: v.mediaType,
            mediaId: v.mediaId,
            mime: typeof v.mime === "string" ? v.mime : null,
            filename: typeof v.filename === "string" ? v.filename : null,
            caption: typeof v.caption === "string" ? v.caption : null,
          };
          renderedText = outboundMedia.caption;
        }
      }
    }

    thread.push({
      kind: "outbound",
      id: m.id,
      at: (m.sentAt ?? m.createdAt).toISOString(),
      templateName: m.templateName,
      templateVariables: m.templateVariablesJson,
      renderedText,
      headerImageUrl: m.headerImageUrl ?? null,
      outboundMedia,
      sentBy: m.sentBy,
      status: m.status,
      providerMessageId: m.providerMessageId,
      errorMessage: m.errorMessage,
    });
  }

  thread.sort((a, b) => a.at.localeCompare(b.at));

  const lastInboundAt = inbound[inbound.length - 1]?.receivedAt ?? null;
  const inSession = lastInboundAt
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
 * POST: Send a free-form text reply via the support WhatsApp account.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`wa-support-reply:${user.id}`, 60, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
  }

  const { phone } = await context.params;
  const decodedPhone = decodeURIComponent(phone);
  let body: { text?: unknown };
  try {
    body = (await request.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  let client: WhatsAppClient;
  try {
    client = await WhatsAppClient.fromSupportSettings();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "WhatsApp Support not configured" },
      { status: 400 }
    );
  }

  const toForApi = decodedPhone.replace(/^\+/, "");

  try {
    const result = await client.sendText(toForApi, body.text);

    try {
      await prisma.whatsappMessage.create({
        data: {
          phoneNumber: decodedPhone,
          phoneNumberId: client.getPhoneNumberId(),
          templateName: "<text>",
          templateLanguage: "",
          templateVariablesJson: { text: body.text },
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
      providerMessageId: result.messages?.[0]?.id ?? null,
    });
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      const inSessionExpired = err.metaCode === 131047 || err.metaCode === 131051;
      return NextResponse.json(
        {
          error: inSessionExpired
            ? "The 24-hour reply window has closed. Use a template message instead."
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
