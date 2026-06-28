import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";
import { Prisma, MessageStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * WhatsApp Support webhook — separate from main webhook.
 * Uses wa_support_* settings for verification.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const expected = await getSetting("wa_support_webhook_verify_token");

  if (mode === "subscribe" && token && expected && token === expected) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return new NextResponse("forbidden", { status: 403 });
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string; caption?: string };
  sticker?: { id?: string; mime_type?: string };
  referral?: { source_url?: string; source_id?: string; source_type?: string; body?: string; headline?: string };
  context?: { referred_product?: unknown };
}

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
      };
    }>;
  }>;
}

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");
  const provided = header.slice("sha256=".length);
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

function normalizePhone(raw: string): string {
  const stripped = raw.replace(/[^\d]/g, "");
  return stripped ? `+${stripped}` : raw;
}

function extractText(msg: MetaMessage): string | null {
  if (msg.text?.body) return msg.text.body;
  if (msg.image?.caption) return msg.image.caption;
  if (msg.video?.caption) return msg.video.caption;
  if (msg.document?.caption) return msg.document.caption;
  return null;
}

function extractMedia(msg: MetaMessage): { id?: string; mimeType?: string } {
  const m = msg.image || msg.video || msg.audio || msg.document || msg.sticker || {};
  return { id: (m as { id?: string }).id, mimeType: (m as { mime_type?: string }).mime_type };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const appSecret = await getSetting("wa_support_app_secret");

  if (appSecret) {
    if (!verifySignature(rawBody, signatureHeader, appSecret)) {
      console.warn("[support-webhook] signature verification failed");
    }
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }

  const supportPni = await getSetting("wa_support_phone_number_id");

  const entries = payload.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      const contactNameByWaid = new Map<string, string | undefined>();
      for (const contact of value.contacts ?? []) {
        if (contact.wa_id) {
          contactNameByWaid.set(contact.wa_id, contact.profile?.name);
        }
      }

      const receivedOnPhoneNumberId = value.metadata?.phone_number_id ?? supportPni ?? null;

      // Persist inbound messages with source detection
      for (const msg of value.messages ?? []) {
        if (!msg.id || !msg.from) continue;
        const fromPhone = normalizePhone(msg.from);
        const text = extractText(msg);
        const { id: mediaId, mimeType } = extractMedia(msg);

        // Detect source from referral URL (?source=site1) or from
        // previous messages by the same phone number.
        let source: string | null = null;
        if (msg.referral?.source_url) {
          try {
            const refUrl = new URL(msg.referral.source_url);
            source = refUrl.searchParams.get("source") ?? null;
          } catch {
            // Try regex fallback for malformed URLs
            const match = msg.referral.source_url.match(/[?&]source=([^&]+)/);
            if (match) source = decodeURIComponent(match[1]);
          }
        }
        // If no source in referral, check the message text for the first
        // message (some click-to-chat URLs embed source in the pre-filled text)
        if (!source && text) {
          const match = text.match(/source[=:]\s*(\S+)/i);
          if (match) source = match[1];
        }
        // Inherit source from the customer's previous messages if not detected
        if (!source) {
          const prev = await prisma.inboundMessage.findFirst({
            where: {
              fromPhoneNumber: fromPhone,
              phoneNumberId: receivedOnPhoneNumberId,
              source: { not: null },
            },
            orderBy: { receivedAt: "desc" },
            select: { source: true },
          });
          if (prev?.source) source = prev.source;
        }

        try {
          await prisma.inboundMessage.create({
            data: {
              providerMessageId: msg.id,
              fromPhoneNumber: fromPhone,
              contactName: contactNameByWaid.get(msg.from) ?? null,
              type: msg.type ?? "text",
              text,
              mediaId: mediaId ?? null,
              mediaMimeType: mimeType ?? null,
              phoneNumberId: receivedOnPhoneNumberId,
              rawPayload: msg as unknown as Prisma.InputJsonValue,
              source,
            },
          });
        } catch (err) {
          if (
            !(
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === "P2002"
            )
          ) {
            console.error("[support-webhook] failed to persist inbound message", err);
          }
        }

        // AI auto-reply: use per-source system prompt if available
        if (text) {
          handleSupportAutoReply(fromPhone, text, source, receivedOnPhoneNumberId).catch(
            (err) => console.error("[support-webhook] auto-reply error:", err)
          );
        }
      }

      // Handle delivery status updates
      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const rawStatus = status.status.toUpperCase();
        if (!["SENT", "DELIVERED", "READ", "FAILED"].includes(rawStatus)) continue;
        const msgStatus = rawStatus as keyof typeof MessageStatus;
        try {
          await prisma.whatsappMessage.updateMany({
            where: { providerMessageId: status.id },
            data: {
              status: MessageStatus[msgStatus],
              ...(msgStatus === "FAILED" && status.errors?.[0]
                ? { errorMessage: status.errors[0].title ?? status.errors[0].message ?? "Unknown error" }
                : {}),
            },
          });
        } catch {
          // ignore
        }
      }
    }
  }

  return new NextResponse("EVENT_RECEIVED", { status: 200 });
}

/**
 * AI auto-reply for support messages. Uses per-source system prompt if a
 * SupportSource is configured for the detected source slug, otherwise falls
 * back to the global wa_support_ai_system_prompt.
 */
async function handleSupportAutoReply(
  fromPhone: string,
  text: string,
  source: string | null,
  phoneNumberId: string | null,
) {
  const aiEnabled = await getSetting("wa_support_ai_enabled");
  if (aiEnabled !== "true") return;

  const apiKey = await getSetting("wa_support_ai_api_key");
  if (!apiKey) return;

  const model = (await getSetting("wa_support_ai_model")) || "gpt-4o-mini";

  // Resolve system prompt: per-source first, then global fallback
  let systemPrompt = (await getSetting("wa_support_ai_system_prompt")) || "You are a helpful customer support agent.";
  if (source) {
    const srcRow = await prisma.supportSource.findUnique({
      where: { slug: source },
      select: { systemPrompt: true, enabled: true },
    });
    if (srcRow?.enabled && srcRow.systemPrompt) {
      systemPrompt = srcRow.systemPrompt;
    }
  }

  // Get conversation history for context (last 10 messages)
  const digits = fromPhone.replace(/[^\d]/g, "");
  const phoneVariants = [...new Set([fromPhone, digits, `+${digits}`])];
  const recentInbound = await prisma.inboundMessage.findMany({
    where: {
      fromPhoneNumber: { in: phoneVariants },
      phoneNumberId: phoneNumberId,
    },
    orderBy: { receivedAt: "desc" },
    take: 10,
    select: { text: true, receivedAt: true },
  });
  const recentOutbound = await prisma.whatsappMessage.findMany({
    where: {
      phoneNumber: { in: phoneVariants },
      phoneNumberId: phoneNumberId,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { templateVariablesJson: true, createdAt: true, templateName: true },
  });

  // Build conversation context
  type ChatEntry = { role: "user" | "assistant"; content: string; at: Date };
  const chatHistory: ChatEntry[] = [];
  for (const m of recentInbound) {
    if (m.text) chatHistory.push({ role: "user", content: m.text, at: m.receivedAt });
  }
  for (const m of recentOutbound) {
    if (m.templateName === "<text>") {
      const vars = m.templateVariablesJson as Record<string, string> | null;
      if (vars?.text) chatHistory.push({ role: "assistant", content: vars.text, at: m.createdAt });
    }
  }
  chatHistory.sort((a, b) => a.at.getTime() - b.at.getTime());
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...chatHistory.slice(-10).map((m) => ({ role: m.role, content: m.content })),
  ];

  // Call AI API
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: 500 }),
    });

    if (!resp.ok) {
      console.error("[support-webhook] AI API error:", resp.status, await resp.text());
      return;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return;

    // Send reply via WhatsApp
    const { WhatsAppClient } = await import("@/lib/whatsapp");
    const client = await WhatsAppClient.fromSupportSettings();
    const toForApi = fromPhone.replace(/^\+/, "");
    const result = await client.sendText(toForApi, reply);

    // Record outbound
    await prisma.whatsappMessage.create({
      data: {
        phoneNumber: fromPhone,
        phoneNumberId: client.getPhoneNumberId(),
        templateName: "<text>",
        templateLanguage: "",
        templateVariablesJson: { text: reply },
        providerMessageId: result.messages?.[0]?.id ?? null,
        status: "SENT",
        sentBy: "ai-support-agent",
        sentAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[support-webhook] AI auto-reply failed:", err);
  }
}
