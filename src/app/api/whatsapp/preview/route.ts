import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { buildTemplateVariables } from "@/lib/whatsapp";
import { normalizePhoneNumber } from "@/lib/phone";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { orderId } = await request.json();

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404 }
      );
    }

    const templateName =
      (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME)) ||
      "order_out_for_delivery";
    const templateLanguage =
      (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE)) || "en";
    const defaultCountryCode =
      (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

    const variables = buildTemplateVariables(
      order.customerName || "Customer",
      order.codNetworkOrderId
    );

    let normalizedPhone = order.customerPhone;
    if (normalizedPhone) {
      try {
        normalizedPhone = normalizePhoneNumber(
          normalizedPhone,
          defaultCountryCode
        );
      } catch {
        // Keep original if normalization fails
      }
    }

    const previewMessage = `Hello ${variables[0]}, your package for order ${variables[1]} is out for delivery today. Please keep your phone reachable. Thank you.`;

    return NextResponse.json({
      preview: {
        templateName,
        templateLanguage,
        variables,
        phoneNumber: normalizedPhone,
        message: previewMessage,
        order: {
          id: order.id,
          codNetworkOrderId: order.codNetworkOrderId,
          customerName: order.customerName,
          status: order.status,
        },
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to generate preview";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
