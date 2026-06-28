import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  WhatsAppClient,
  buildTemplateVariables,
  WhatsAppTemplateHeader,
  WhatsAppApiError,
} from "@/lib/whatsapp";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { normalizePhoneNumber } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";

interface SendBody {
  templateName?: string;
  templateLanguage?: string;
  templateVariables?: unknown;
  templateHeaderImage?: unknown;
  templateHeaderImageId?: unknown;
  templateHeaderText?: unknown;
  /** Skip the "already sent" guard. Off by default. */
  force?: boolean;
}

function coerceVariables(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    if (!raw.every((v) => typeof v === "string")) return undefined;
    return raw;
  }
  if (typeof raw === "string") {
    return raw.split(",").map((v) => v.trim());
  }
  return undefined;
}

/**
 * Send a WhatsApp template message for a specific order. Used by the
 * Pipeline view's "WhatsApp Sent" column drop target and by the per-card
 * Send dialog's variable picker.
 *
 * Differs from /api/whatsapp/send (legacy auto-send) by: (a) accepting
 * arbitrary variables / header overrides per request, (b) supporting Meta
 * media IDs (uploaded via /api/whatsapp/media), and (c) marking the order's
 * `whatsappSentAt` so the "WhatsApp Sent" column tracks completion.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`order-send:${user.id}`, 30, 60_000);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please wait before sending more messages." },
      { status: 429 }
    );
  }

  const { id: orderId } = await params;

  let body: SendBody;
  try {
    body = (await request.json().catch(() => ({}))) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  if (order.whatsappSentAt && !body.force) {
    return NextResponse.json(
      {
        error:
          "WhatsApp message already sent for this order. Pass force=true to send again.",
        whatsappSentAt: order.whatsappSentAt,
      },
      { status: 409 }
    );
  }

  if (!order.customerPhone) {
    return NextResponse.json(
      { error: "Order has no customer phone number" },
      { status: 400 }
    );
  }

  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
  let phone: string;
  try {
    phone = normalizePhoneNumber(order.customerPhone, defaultCountryCode);
  } catch {
    return NextResponse.json(
      { error: `Invalid phone number: ${order.customerPhone}` },
      { status: 400 }
    );
  }

  const configuredTemplate = await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME);
  const configuredLanguage = await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE);
  const templateName =
    (typeof body.templateName === "string" && body.templateName.trim()) ||
    configuredTemplate ||
    "order_out_for_delivery";
  const templateLanguage =
    (typeof body.templateLanguage === "string" && body.templateLanguage.trim()) ||
    configuredLanguage ||
    "en";

  let variables = coerceVariables(body.templateVariables);
  if (variables === undefined) {
    // If the caller explicitly chose a template, send empty variables (the
    // template may have zero params).  Only fall back to auto-generated
    // variables when no template name was provided (legacy auto-send).
    if (body.templateName && body.templateName.trim()) {
      variables = [];
    } else {
      variables = buildTemplateVariables(
        order.customerName || "Customer",
        order.codNetworkOrderId
      );
    }
  }

  let header: WhatsAppTemplateHeader | undefined;
  if (
    typeof body.templateHeaderImageId === "string" &&
    body.templateHeaderImageId.trim()
  ) {
    header = {
      type: "image",
      value: body.templateHeaderImageId.trim(),
      imageKind: "id",
    };
  } else if (
    typeof body.templateHeaderImage === "string" &&
    body.templateHeaderImage.trim()
  ) {
    header = {
      type: "image",
      value: body.templateHeaderImage.trim(),
      imageKind: "url",
    };
  } else if (
    typeof body.templateHeaderText === "string" &&
    body.templateHeaderText.trim()
  ) {
    header = { type: "text", value: body.templateHeaderText.trim() };
  } else {
    // Fall back to the configured default header image, if any. Templates
    // without an IMAGE header simply ignore it (we only set this if the user
    // configured one).
    const defaultImage = await getSetting(
      SETTING_KEYS.WHATSAPP_DEFAULT_TEMPLATE_HEADER_IMAGE_URL
    );
    if (defaultImage) {
      header = { type: "image", value: defaultImage, imageKind: "url" };
    }
  }

  let client: WhatsAppClient;
  try {
    client = await WhatsAppClient.fromSettings();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "WhatsApp not configured" },
      { status: 400 }
    );
  }

  try {
    const result = await client.sendTemplate(
      phone,
      templateName,
      templateLanguage,
      variables,
      header
    );

    const headerImageUrl =
      header?.type === "image" && header.imageKind === "url"
        ? header.value
        : null;

    const storedPhone = phone.startsWith("+") ? phone : `+${phone}`;
    const message = await prisma.whatsappMessage.create({
      data: {
        orderId: order.id,
        phoneNumber: storedPhone,
        templateName,
        templateLanguage,
        templateVariablesJson: variables,
        headerImageUrl,
        providerMessageId: result.messages?.[0]?.id ?? null,
        status: "SENT",
        sentBy: user.email,
        sentAt: new Date(),
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { whatsappSentAt: new Date() },
    });

    return NextResponse.json({
      success: true,
      message,
      providerMessageId: result.messages?.[0]?.id ?? null,
    });
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to send WhatsApp message";
    const isApiError = err instanceof WhatsAppApiError;
    try {
      const headerImageUrl =
        header?.type === "image" && header.imageKind === "url"
          ? header.value
          : null;
      const failedPhone = phone.startsWith("+") ? phone : `+${phone}`;
      await prisma.whatsappMessage.create({
        data: {
          orderId: order.id,
          phoneNumber: failedPhone,
          templateName,
          templateLanguage,
          templateVariablesJson: variables,
          headerImageUrl,
          status: "FAILED",
          errorMessage: errorMsg,
          sentBy: user.email,
        },
      });
    } catch {
      // ignore logging failure
    }

    return NextResponse.json(
      {
        error: errorMsg,
        meta: isApiError
          ? {
              code: (err as WhatsAppApiError).metaCode,
              expected: (err as WhatsAppApiError).expectedParamCount,
              received: (err as WhatsAppApiError).receivedParamCount,
            }
          : undefined,
      },
      { status: isApiError ? (err as WhatsAppApiError).status : 500 }
    );
  }
}
