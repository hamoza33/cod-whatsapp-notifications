import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient, buildTemplateVariables } from "@/lib/whatsapp";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { normalizePhoneNumber } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`whatsapp-send:${user.id}`, 30, 60_000);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please wait before sending more messages." },
      { status: 429 }
    );
  }

  let orderId: string | undefined;
  let phone: string | undefined;
  let templateName = "order_out_for_delivery";
  let templateLanguage = "en";

  try {
    const body = await request.json();
    orderId = body.orderId;

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { whatsappMessages: true },
    });

    if (!order) {
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404 }
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

    try {
      phone = normalizePhoneNumber(order.customerPhone, defaultCountryCode);
    } catch {
      return NextResponse.json(
        { error: `Invalid phone number: ${order.customerPhone}` },
        { status: 400 }
      );
    }

    templateName =
      (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME)) ||
      "order_out_for_delivery";
    templateLanguage =
      (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE)) || "en";

    const variables = buildTemplateVariables(
      order.customerName || "Customer",
      order.codNetworkOrderId
    );

    const whatsappClient = await WhatsAppClient.fromSettings();
    const result = await whatsappClient.sendTemplate(
      phone,
      templateName,
      templateLanguage,
      variables
    );

    const storedPhone = phone.startsWith("+") ? phone : `+${phone}`;
    const message = await prisma.whatsappMessage.create({
      data: {
        orderId: order.id,
        phoneNumber: storedPhone,
        templateName,
        templateLanguage,
        templateVariablesJson: variables,
        providerMessageId: result.messages?.[0]?.id ?? null,
        status: "SENT",
        sentBy: user.email,
        sentAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, message });
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to send WhatsApp message";

    try {
      if (orderId) {
        await prisma.whatsappMessage.create({
          data: {
            orderId,
            phoneNumber: phone ? (phone.startsWith("+") ? phone : `+${phone}`) : "unknown",
            templateName,
            templateLanguage,
            templateVariablesJson: [],
            status: "FAILED",
            errorMessage: errorMsg,
            sentBy: user.email,
          },
        });
      }
    } catch {
      // ignore logging failure
    }

    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
