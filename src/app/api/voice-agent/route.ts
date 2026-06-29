import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { normalizePhoneNumber } from "@/lib/phone";

/**
 * POST /api/voice-agent
 * Initiates a Vapi outbound voice call for a given order.
 * Passes all relevant customer/order variables so the Vapi assistant
 * can personalise the call script.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { orderId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const orderId = (body.orderId ?? "").trim();
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      codNetworkOrderId: true,
      codNetworkLeadId: true,
      customerName: true,
      customerPhone: true,
      customerCity: true,
      customerAddress: true,
      productName: true,
      productPrice: true,
      productQuantity: true,
      status: true,
      trackingNumber: true,
      deliveryCompany: true,
      callAttempts: true,
      callAgentQueued: true,
      codDeliveryStatus: true,
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  if (!order.customerPhone) {
    return NextResponse.json(
      { error: "Order has no customer phone number" },
      { status: 400 }
    );
  }

  const enabled = await getSetting(SETTING_KEYS.VOICE_AGENT_ENABLED);
  if (enabled !== "true") {
    return NextResponse.json(
      { error: "Voice agent is not enabled. Enable it in Settings → Voice Agent." },
      { status: 400 }
    );
  }

  const vapiKey = await getSetting(SETTING_KEYS.VAPI_API_KEY);
  if (!vapiKey) {
    return NextResponse.json(
      { error: "Vapi API key not configured. Add it in Settings → Voice Agent." },
      { status: 400 }
    );
  }

  const assistantId = await getSetting(SETTING_KEYS.VAPI_ASSISTANT_ID);
  if (!assistantId) {
    return NextResponse.json(
      { error: "Vapi Assistant ID not configured. Add it in Settings → Voice Agent." },
      { status: 400 }
    );
  }

  const phoneNumberId = await getSetting(SETTING_KEYS.VAPI_PHONE_NUMBER_ID);
  if (!phoneNumberId) {
    return NextResponse.json(
      { error: "Vapi Phone Number ID not configured. Add it in Settings → Voice Agent." },
      { status: 400 }
    );
  }

  // Normalize the customer phone number
  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
  let customerPhone: string;
  try {
    customerPhone = normalizePhoneNumber(order.customerPhone, defaultCountryCode);
    if (!customerPhone.startsWith("+")) customerPhone = `+${customerPhone}`;
  } catch {
    customerPhone = order.customerPhone.startsWith("+")
      ? order.customerPhone
      : `+${order.customerPhone}`;
  }

  // Look up the product description from the Products table if available
  let productDescription = "";
  if (order.productName) {
    const product = await prisma.product.findFirst({
      where: {
        OR: [
          { name: order.productName },
          { name: { contains: order.productName, mode: "insensitive" } },
        ],
      },
      select: { description: true },
    });
    if (product?.description) {
      productDescription = product.description;
    }
  }

  // Build the variable values to pass to Vapi assistant
  const variableValues: Record<string, string> = {
    customer_name: order.customerName || "Customer",
    customer_phone: customerPhone,
    customer_city: order.customerCity || "",
    customer_address: order.customerAddress || "",
    product_name: order.productName || "",
    product_price: order.productPrice || "",
    product_quantity: order.productQuantity || "1",
    product_description: productDescription,
    order_id: order.codNetworkOrderId,
    lead_id: order.codNetworkLeadId || "",
    order_status: order.status,
    delivery_status: order.codDeliveryStatus || "",
    tracking_number: order.trackingNumber || "",
    delivery_company: order.deliveryCompany || "",
    call_attempts: String(order.callAttempts),
  };

  try {
    const vapiPayload: Record<string, unknown> = {
      assistantId,
      phoneNumberId,
      customer: {
        number: customerPhone,
        name: order.customerName || "Customer",
      },
      assistantOverrides: {
        variableValues,
      },
    };

    const response = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vapiKey}`,
      },
      body: JSON.stringify(vapiPayload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Vapi API error ${response.status}: ${errorText}`);
    }

    const callResult = (await response.json()) as Record<string, unknown>;

    // Mark order as call-agent-queued and increment call attempts
    await prisma.order.update({
      where: { id: orderId },
      data: {
        callAgentQueued: true,
        callAttempts: { increment: 1 },
      },
    });

    return NextResponse.json({ success: true, callResult });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vapi call failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
