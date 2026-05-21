import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { Prisma } from "@prisma/client";
import { handleAiAutoReply } from "@/lib/ai-agent";
import {
  fireMessageReceivedFlows,
  safeFireFlows,
} from "@/lib/automation-flows/triggers";

export const dynamic = "force-dynamic";

/**
 * Meta's webhook verification handshake — they hit `GET /webhook` with
 * `hub.mode=subscribe`, `hub.verify_token=<your token>`, and
 * `hub.challenge=<random>`. We echo back `hub.challenge` if (and only if)
 * the token matches what's saved in Settings.
 *
 * Note: Next.js Edge runtime can't read `Buffer`, so this route is forced
 * onto the Node runtime (`dynamic = "force-dynamic"` and the absence of
 * `export const runtime = "edge"`).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const expected = await getSetting(SETTING_KEYS.WHATSAPP_WEBHOOK_VERIFY_TOKEN);

  if (mode === "subscribe" && token && expected && token === expected) {
    // Meta expects a plain-text response with just the challenge.
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return new NextResponse("forbidden", { status: 403 });
}

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface MetaTextMessage {
  body?: string;
}

interface MetaMediaMessage {
  id?: string;
  mime_type?: string;
  caption?: string;
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: MetaTextMessage;
  image?: MetaMediaMessage;
  video?: MetaMediaMessage;
  audio?: MetaMediaMessage;
  document?: MetaMediaMessage;
  sticker?: MetaMediaMessage;
}

interface MetaStatus {
  id?: string;
  status?: string; // sent, delivered, read, failed
  timestamp?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface MetaChange {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { display_phone_number?: string; phone_number_id?: string };
    contacts?: MetaContact[];
    messages?: MetaMessage[];
    statuses?: MetaStatus[];
  };
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: MetaChange[];
  }>;
}

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");
  const provided = header.slice("sha256=".length);
  // Both buffers must be equal length for timingSafeEqual.
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
  // wa_id from Meta is the international number without `+`. Normalize to
  // a leading `+` so it matches Order.customerPhone (which we save with `+`).
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
  const m =
    msg.image || msg.video || msg.audio || msg.document || msg.sticker || {};
  return { id: m.id, mimeType: m.mime_type };
}

async function findOrderByPhone(phone: string): Promise<string | null> {
  const normalized = normalizePhone(phone);
  // Try exact match first, then a "ends with the wa_id digits" fallback for
  // orders saved without the country prefix.
  const order =
    (await prisma.order.findFirst({
      where: { customerPhone: normalized },
      orderBy: { codCreatedAt: "desc" },
      select: { id: true },
    })) ||
    (await prisma.order.findFirst({
      where: { customerPhone: { contains: phone.replace(/[^\d]/g, "").slice(-9) } },
      orderBy: { codCreatedAt: "desc" },
      select: { id: true },
    }));
  return order?.id ?? null;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const appSecret = await getSetting(SETTING_KEYS.WHATSAPP_APP_SECRET);

  console.log("[webhook] POST received, body length:", rawBody.length);

  if (appSecret) {
    if (!verifySignature(rawBody, signatureHeader, appSecret)) {
      console.warn("[webhook] signature verification failed — processing anyway to avoid losing messages. Please update Settings → WhatsApp App Secret to match your Meta App Secret.");
    } else {
      console.log("[webhook] signature verified OK");
    }
  }
  // If no app secret is configured we accept the payload — useful for local
  // tunnels (ngrok) where signature verification is overkill. Production
  // operators are expected to set Settings → WhatsApp App Secret.

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }

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

      // Persist inbound messages
      const msgs = value.messages ?? [];
      const receivedOnPhoneNumberId = value.metadata?.phone_number_id ?? null;
      console.log(
        "[webhook] processing",
        msgs.length,
        "inbound message(s)",
        receivedOnPhoneNumberId ? `on pni=${receivedOnPhoneNumberId}` : ""
      );
      for (const msg of msgs) {
        if (!msg.id || !msg.from) continue;
        const fromPhone = normalizePhone(msg.from);
        const orderId = await findOrderByPhone(msg.from);
        const text = extractText(msg);
        const { id: mediaId, mimeType } = extractMedia(msg);
        console.log("[webhook] persisting message from", fromPhone, "type:", msg.type, "text:", text?.slice(0, 50));
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
              orderId,
            },
          });
        } catch (err) {
          // Re-delivered webhook payloads will collide on the unique
          // providerMessageId index. Swallow that case but log others.
          if (
            !(
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === "P2002"
            )
          ) {
            console.error("[webhook] failed to persist inbound message", err);
          }
        }
      }

      // Trigger AI auto-reply for each inbound text message (fire-and-forget)
      for (const msg of msgs) {
        if (!msg.from) continue;
        const fromPhone = normalizePhone(msg.from);
        const text = extractText(msg);
        if (!text) continue;
        const orderId = await findOrderByPhone(msg.from);
        const rawOrder = orderId
          ? await prisma.order.findUnique({
              where: { id: orderId },
              select: {
                customerName: true,
                productName: true,
                productPrice: true,
                status: true,
                trackingNumber: true,
                customerCity: true,
                codNetworkOrderId: true,
                deliveryCompany: true,
              },
            })
          : null;
        let latestTrackingEvent: string | null = null;
        if (rawOrder) {
          const latestEvent = await prisma.trackingEvent.findFirst({
            where: {
              trackingOrder: { orderId },
            },
            orderBy: { occurredAt: "desc" },
            select: { description: true },
          });
          latestTrackingEvent = latestEvent?.description ?? null;
        }
        const order = rawOrder
          ? {
              ...rawOrder,
              productPrice: rawOrder.productPrice?.toString() ?? null,
              latestTrackingEvent,
            }
          : null;
        handleAiAutoReply(fromPhone, text, order).catch((err) =>
          console.error("[webhook] AI auto-reply error:", err)
        );
        // Also fire any visual-builder flows whose trigger is
        // MESSAGE_RECEIVED. Runs in best-effort mode so a misconfigured
        // flow can't 500 the webhook.
        safeFireFlows(
          fireMessageReceivedFlows({
            fromPhone,
            text,
            messageType: msg.type ?? "text",
            matchedOrderId: orderId,
          }),
          `MESSAGE_RECEIVED flow for ${fromPhone}`
        ).catch(() => {});
      }

      // Update status of outbound messages we previously sent.
      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const mappedStatus = (() => {
          switch (status.status) {
            case "sent":
              return "SENT";
            case "delivered":
              return "DELIVERED";
            case "read":
              return "READ";
            case "failed":
              return "FAILED";
            default:
              return null;
          }
        })();
        if (!mappedStatus) continue;
        const errMsg = status.errors?.[0]
          ? `${status.errors[0].code ?? "?"} ${status.errors[0].title ?? ""}: ${
              status.errors[0].message ?? ""
            }`.trim()
          : undefined;
        await prisma.whatsappMessage.updateMany({
          where: { providerMessageId: status.id },
          data: {
            status: mappedStatus,
            errorMessage: errMsg ?? undefined,
          },
        });

        // Mirror the receipt onto any matching bulk-messaging recipient so
        // the Bulk Messaging status table updates the same way as the
        // inbox/message logs. Keyed by providerMessageId, which the bulk
        // sender stores at send time.
        const recipientData: {
          status: typeof mappedStatus;
          errorMessage?: string;
          deliveredAt?: Date;
          readAt?: Date;
          failedAt?: Date;
        } = { status: mappedStatus };
        if (mappedStatus === "DELIVERED") recipientData.deliveredAt = new Date();
        else if (mappedStatus === "READ") recipientData.readAt = new Date();
        else if (mappedStatus === "FAILED") {
          recipientData.failedAt = new Date();
          if (errMsg) recipientData.errorMessage = errMsg;
        }
        await prisma.bulkRecipient.updateMany({
          where: { providerMessageId: status.id },
          data: recipientData,
        });
      }
    }
  }

  // Meta wants a 200 quickly; otherwise it retries.
  return new NextResponse("ok", { status: 200 });
}
