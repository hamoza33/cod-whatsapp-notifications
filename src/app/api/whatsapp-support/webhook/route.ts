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

      // Persist inbound messages
      for (const msg of value.messages ?? []) {
        if (!msg.id || !msg.from) continue;
        const fromPhone = normalizePhone(msg.from);
        const text = extractText(msg);
        const { id: mediaId, mimeType } = extractMedia(msg);

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
