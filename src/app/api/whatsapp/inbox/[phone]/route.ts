import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient, WhatsAppApiError } from "@/lib/whatsapp";
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

  const [inbound, outbound] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: { fromPhoneNumber: decodedPhone },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.whatsappMessage.findMany({
      where: { phoneNumber: decodedPhone },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        templateName: true,
        templateLanguage: true,
        templateVariablesJson: true,
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
        sentBy: string | null;
        status: string;
        providerMessageId: string | null;
        errorMessage: string | null;
      };

  // Pre-fetch template bodies for rendering outbound messages
  const templateNames = [...new Set(outbound.map((m) => m.templateName).filter((n) => n !== "<text>"))];
  const templateBodies = new Map<string, string>();
  if (templateNames.length > 0) {
    const templates = await prisma.whatsappTemplate.findMany({
      where: { name: { in: templateNames } },
      select: { name: true, bodyText: true },
    });
    for (const t of templates) {
      if (t.bodyText) templateBodies.set(t.name, t.bodyText);
    }
  }

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
    if (m.templateName === "<text>") {
      const vars = m.templateVariablesJson;
      if (vars && typeof vars === "object" && "text" in vars) {
        renderedText = (vars as { text: string }).text;
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
    thread.push({
      kind: "outbound",
      id: m.id,
      at: (m.sentAt ?? m.createdAt).toISOString(),
      templateName: m.templateName,
      templateVariables: m.templateVariablesJson,
      renderedText,
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
  let body: { text?: unknown };
  try {
    body = (await request.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { error: "text is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  const lastInbound = await prisma.inboundMessage.findFirst({
    where: { fromPhoneNumber: decodedPhone },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true, orderId: true },
  });

  let client: WhatsAppClient;
  try {
    client = await WhatsAppClient.fromSettings();
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
          orderId: lastInbound?.orderId ?? null,
          phoneNumber: decodedPhone,
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
