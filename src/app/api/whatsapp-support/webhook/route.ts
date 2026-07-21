import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";
import { Prisma, MessageStatus } from "@prisma/client";
import {
  parseInboundMessage,
  type MetaMessage as SharedMetaMessage,
} from "@/lib/whatsapp-message";
import { downloadWhatsAppMedia, transcribeAudio } from "@/lib/whatsapp-media";

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

type MetaMessage = SharedMetaMessage & {
  referral?: { source_url?: string; source_id?: string; source_type?: string; body?: string; headline?: string };
  context?: { referred_product?: unknown };
};

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

/**
 * Download a support voice note via the support access token, transcribe it
 * via OpenAI, persist the transcript, and return it. Best-effort — returns
 * null on any failure so the webhook keeps working.
 */
async function transcribeSupportVoice(
  providerMessageId: string,
  mediaId: string
): Promise<string | null> {
  try {
    const accessToken = await getSetting("wa_support_access_token");
    // Reuse the support AI key for transcription; fall back to the global
    // OpenAI key so voice notes still transcribe if only that is set.
    const openaiKey =
      (await getSetting("wa_support_ai_api_key")) ||
      (await getSetting("openai_api_key"));
    if (!accessToken || !openaiKey) return null;

    const media = await downloadWhatsAppMedia(mediaId, accessToken);
    const transcript = await transcribeAudio(media, { apiKey: openaiKey });
    if (!transcript) return null;

    await prisma.inboundMessage.updateMany({
      where: { providerMessageId },
      data: { transcription: transcript },
    });
    return transcript;
  } catch (err) {
    console.error(
      "[support-webhook] voice transcription failed",
      err instanceof Error ? err.message : err
    );
    return null;
  }
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

  // How long a /wa/<source> visit stays eligible for matching (minutes).
  // Configurable in Settings → WA Support; defaults to 3, clamped to 1..1440.
  const windowRaw = Number.parseInt(
    (await getSetting("wa_support_source_match_window_minutes")) ?? "",
    10
  );
  const sourceMatchWindowMs =
    (Number.isFinite(windowRaw) && windowRaw >= 1
      ? Math.min(1440, windowRaw)
      : 3) *
    60 *
    1000;

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
        const parsed = parseInboundMessage(msg as SharedMetaMessage);
        const text = parsed.text;

        // Detect source from referral, raw payload, or message text.
        // The user wants dynamic switching: each message carries its own
        // source. If a new source is detected it overrides the previous one.
        let source: string | null = null;

        // 1. Check referral source_url (Meta sends this on click-to-chat)
        if (msg.referral?.source_url) {
          source = extractSourceParam(msg.referral.source_url);
        }
        // 2. Check referral body (some click-to-chat links embed it here)
        if (!source && msg.referral?.body) {
          source = extractSourceParam(msg.referral.body);
        }
        // 3. Deep-scan the raw payload for any source field
        if (!source) {
          source = findSourceInPayload(msg as unknown as Record<string, unknown>);
        }
        // 4. Check the message text for source= or source: pattern
        if (!source && text) {
          const match = text.match(/source[=:]\s*(\S+)/i);
          if (match) source = match[1];
        }
        // 5. Time-window matching: if a recent /wa/<source> page visit exists
        //    within the configured window, claim it (landing-page redirect
        //    approach). This runs for BOTH new and returning customers so a
        //    customer can switch source mid-conversation just by clicking a
        //    new /wa/<source> link and then sending any message — the most
        //    recent click wins.
        if (!source) {
          const windowStart = new Date(Date.now() - sourceMatchWindowMs);
          // Pull the most recent unmatched visits and claim the first one we
          // can win atomically. The guarded updateMany (id + matched:false)
          // ensures that under concurrent traffic two messages can never be
          // assigned the same visit — only one request flips `matched`.
          const recentVisits = await prisma.sourceVisit.findMany({
            where: {
              matched: false,
              createdAt: { gte: windowStart },
            },
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { id: true, source: true },
          });
          for (const visit of recentVisits) {
            const claim = await prisma.sourceVisit.updateMany({
              where: { id: visit.id, matched: false },
              data: { matched: true },
            });
            if (claim.count === 1) {
              source = visit.source;
              break;
            }
          }
        }
        // 6. If no source detected on this message, inherit the most recent
        //    source from this customer (continuity within the same chat)
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
              type: parsed.type,
              text,
              mediaId: parsed.mediaId,
              mediaMimeType: parsed.mediaMimeType,
              latitude: parsed.latitude,
              longitude: parsed.longitude,
              locationName: parsed.locationName,
              locationAddress: parsed.locationAddress,
              reactionEmoji: parsed.reactionEmoji,
              reactionToId: parsed.reactionToId,
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

        // Transcribe voice notes so the AI answers them with a normal text
        // reply, then hand the (possibly transcribed) text to the auto-reply.
        let aiText = text;
        if (parsed.isAudio && parsed.mediaId) {
          const transcript = await transcribeSupportVoice(msg.id, parsed.mediaId);
          if (transcript) aiText = transcript;
        }

        // AI auto-reply: use per-source system prompt if available
        if (aiText) {
          handleSupportAutoReply(fromPhone, aiText, source, receivedOnPhoneNumberId).catch(
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
    select: { text: true, transcription: true, receivedAt: true },
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
    const content = m.transcription || m.text;
    if (content) chatHistory.push({ role: "user", content, at: m.receivedAt });
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

/** Extract `source` query parameter from a URL string or text containing a URL. */
function extractSourceParam(input: string): string | null {
  // Try parsing as a full URL first
  try {
    const url = new URL(input);
    const src = url.searchParams.get("source");
    if (src) return src;
  } catch {
    // not a valid URL
  }
  // Regex fallback for partial URLs or text containing source=
  const match = input.match(/[?&]source=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

/** Recursively scan a webhook payload object for a "source" field. */
function findSourceInPayload(obj: Record<string, unknown>): string | null {
  if (!obj || typeof obj !== "object") return null;
  // Check direct "source" key
  if (typeof obj.source === "string" && obj.source.trim()) return obj.source.trim();
  // Check referral.source_url
  const referral = obj.referral as Record<string, unknown> | undefined;
  if (referral?.source_url && typeof referral.source_url === "string") {
    const src = extractSourceParam(referral.source_url);
    if (src) return src;
  }
  // Check context
  const context = obj.context as Record<string, unknown> | undefined;
  if (context) {
    const src = findSourceInPayload(context);
    if (src) return src;
  }
  return null;
}
