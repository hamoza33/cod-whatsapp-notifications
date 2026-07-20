import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient, WhatsAppApiError } from "@/lib/whatsapp";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Returns a unified, time-ordered thread for a single phone number,
 * combining inbound messages and outbound (template) messages. Used by the
 * Inbox view's right pane.
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

  // Webhook stores inbound phones with "+" prefix, outbound may omit it.
  // Query both variants so messages always match regardless of format.
  const digits = decodedPhone.replace(/[^\d]/g, "");
  const phoneVariants = [...new Set([decodedPhone, digits, `+${digits}`])];

  // Optional account isolation — mirrors the listing route. When the inbox
  // UI passes `?numberId=...` we narrow the thread to that account's PNI.
  // The DEFAULT account additionally inherits all legacy rows (phone_number_id
  // is null); any other account sees ONLY its own messages so the chat thread
  // is truly isolated per WhatsApp number.
  const url = new URL(request.url);
  const numberIdParam = url.searchParams.get("numberId");
  let pniFilter: string | null = null;
  let includeLegacy = false;
  if (numberIdParam) {
    const row = await prisma.whatsappNumber.findUnique({
      where: { id: numberIdParam },
    });
    if (row) {
      pniFilter = row.phoneNumberId;
      includeLegacy = row.isDefault;
    } else if (/^\d{6,20}$/.test(numberIdParam)) {
      pniFilter = numberIdParam;
      const defaultRow = await prisma.whatsappNumber.findFirst({
        where: { isDefault: true },
      });
      includeLegacy = defaultRow?.phoneNumberId === pniFilter;
    }
  }
  // Prisma's `in` filter does not match null values, so for the default
  // account we express the OR with two branches instead.
  const accountClause: Prisma.InboundMessageWhereInput &
    Prisma.WhatsappMessageWhereInput = pniFilter
    ? includeLegacy
      ? { OR: [{ phoneNumberId: pniFilter }, { phoneNumberId: null }] }
      : { phoneNumberId: pniFilter }
    : {};

  const [inbound, outbound] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: { fromPhoneNumber: { in: phoneVariants }, ...accountClause },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.whatsappMessage.findMany({
      where: { phoneNumber: { in: phoneVariants }, ...accountClause },
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

  // Pre-fetch template bodies and header types for rendering outbound messages
  const templateNames = [...new Set(outbound.map((m) => m.templateName).filter((n) => n !== "<text>"))];
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
      // Inbox-sent media: templateVariablesJson holds { mediaType, mediaId,
      // mime, filename, caption } — surface those so the UI can render the
      // image / video / audio bubble.
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
    } else {
      const body = templateBodies.get(m.templateName);
      const vars = Array.isArray(m.templateVariablesJson)
        ? (m.templateVariablesJson as string[])
        : [];
      if (body) {
        renderedText = body.replace(/\{\{(\d+)\}\}/g, (_, idx) => {
          const i = parseInt(idx, 10) - 1;
          return vars[i] ?? `{{${idx}}}`;
        });
      } else if (vars.length > 0) {
        // Template body not cached yet — show the resolved variables so the
        // user can still see what was sent instead of a generic placeholder.
        renderedText = vars.join(" | ");
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
      outboundMedia,
      sentBy: m.sentBy,
      status: m.status,
      providerMessageId: m.providerMessageId,
      errorMessage: m.errorMessage,
    });
  }
  thread.sort((a, b) => a.at.localeCompare(b.at));

  // Compute whether we're inside Meta's 24h customer-service window — we
  // use this to disable / enable the free-form text reply UI client-side.
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
 * Send a free-form text reply. Only valid inside Meta's 24-hour customer
 * service window — if Meta refuses we return a clear error suggesting the
 * user use the Pipeline → Send WhatsApp dialog to send a template instead.
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
  let body: { text?: unknown; numberId?: unknown };
  try {
    body = (await request.json()) as { text?: unknown; numberId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { error: "text is required and must be a non-empty string" },
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

  // Optional WABA override — when the operator picks a non-default
  // WhatsApp account from the inbox dropdown, the UI passes its DB id (or
  // the phone_number_id directly) so we route the send through that PNI
  // instead of the global default setting.
  let phoneNumberIdOverride: string | null = null;
  if (typeof body.numberId === "string" && body.numberId.trim()) {
    const numberRow = await prisma.whatsappNumber.findUnique({
      where: { id: body.numberId.trim() },
    });
    if (numberRow) {
      phoneNumberIdOverride = numberRow.phoneNumberId;
    } else if (/^\d{6,20}$/.test(body.numberId.trim())) {
      // Allow passing the raw Meta PNI as a fallback.
      phoneNumberIdOverride = body.numberId.trim();
    }
  }

  let client: WhatsAppClient;
  try {
    client = await WhatsAppClient.fromSettings({ phoneNumberIdOverride });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "WhatsApp not configured" },
      { status: 400 }
    );
  }

  // The Cloud API expects the recipient phone WITHOUT the leading "+"
  const toForApi = decodedPhone.replace(/^\+/, "");

  try {
    const result = await client.sendText(toForApi, body.text);

    // Always record the outbound text in whatsapp_messages so it shows
    // in the conversation thread. Link to the order if we have one.
    try {
      await prisma.whatsappMessage.create({
        data: {
          orderId: lastInbound?.orderId ?? undefined,
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
      // 131047 / 131051 = re-engagement / 24h window expired. Surface a
      // friendly message so the UI can suggest sending a template instead.
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
