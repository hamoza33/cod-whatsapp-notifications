import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { detectArabic } from "@/lib/ai-agent";

/**
 * Generate 3 suggested reply options using the same AI context as auto-reply.
 * Accepts optional custom context from the operator.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ phone: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { phone } = await params;
  const decodedPhone = decodeURIComponent(phone);
  const digits = decodedPhone.replace(/[^\d]/g, "");
  const phoneVariants = [...new Set([decodedPhone, digits, `+${digits}`])];

  let body: { customContext?: string };
  try {
    body = (await request.json()) as { customContext?: string };
  } catch {
    body = {};
  }

  const apiKey = await getSetting(SETTING_KEYS.OPENAI_API_KEY);
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key not configured" },
      { status: 400 }
    );
  }

  const model =
    (await getSetting(SETTING_KEYS.AI_AGENT_MODEL)) || "gpt-4o-mini";
  let systemPrompt =
    (await getSetting(SETTING_KEYS.AI_AGENT_SYSTEM_PROMPT)) ||
    "You are a helpful customer service agent for a delivery company. Keep responses short for WhatsApp.";

  // Find order context
  const lastInbound = await prisma.inboundMessage.findFirst({
    where: { fromPhoneNumber: { in: phoneVariants } },
    orderBy: { receivedAt: "desc" },
    select: { orderId: true, text: true },
  });

  const order = lastInbound?.orderId
    ? await prisma.order.findUnique({
        where: { id: lastInbound.orderId },
        select: {
          customerName: true,
          productName: true,
          status: true,
          trackingNumber: true,
          customerCity: true,
          codNetworkOrderId: true,
        },
      })
    : null;

  // Check product type filter
  const productTypesFilter = await getSetting(
    SETTING_KEYS.AI_AGENT_PRODUCT_TYPES
  );
  if (productTypesFilter && order?.productName) {
    const allowedTypes = productTypesFilter
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (allowedTypes.length > 0) {
      const product = await prisma.product.findFirst({
        where: { name: order.productName },
        select: { productType: true },
      });
      const orderType = product?.productType?.toLowerCase() || "";
      if (!allowedTypes.some((t) => orderType.includes(t))) {
        return NextResponse.json(
          { error: "Order product type not in allowed list" },
          { status: 400 }
        );
      }
    }
  }

  if (order) {
    systemPrompt = systemPrompt
      .replace(/\{customer_name\}/g, order.customerName || "Customer")
      .replace(/\{product\}/g, order.productName || "their order")
      .replace(/\{order_status\}/g, order.status)
      .replace(/\{tracking\}/g, order.trackingNumber || "N/A")
      .replace(/\{city\}/g, order.customerCity || "")
      .replace(/\{order_id\}/g, order.codNetworkOrderId);
  }

  const orderContext = order
    ? `\n\nCustomer order context:\n- Name: ${order.customerName || "Unknown"}\n- Product: ${order.productName || "Unknown"}\n- Status: ${order.status}\n- Tracking: ${order.trackingNumber || "N/A"}\n- City: ${order.customerCity || "N/A"}\n- Order ID: ${order.codNetworkOrderId}`
    : "";

  // Conversation history
  const recentInbound = await prisma.inboundMessage.findMany({
    where: { fromPhoneNumber: { in: phoneVariants } },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { text: true, receivedAt: true },
  });
  const recentOutbound = await prisma.whatsappMessage.findMany({
    where: { phoneNumber: { in: phoneVariants } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      templateVariablesJson: true,
      templateName: true,
      createdAt: true,
    },
  });

  // Detect language from the most recent inbound text
  const latestText = recentInbound[0]?.text || "";
  const isArabic = detectArabic(latestText);

  if (isArabic) {
    systemPrompt +=
      "\n\nIMPORTANT: The customer is writing in Arabic. You MUST respond in Saudi Arabian Arabic dialect (اللهجة السعودية). Use natural Saudi expressions and wording like a real Saudi customer service agent would use. Do NOT use formal/classical Arabic (فصحى). Use words like 'حياك الله', 'ان شاء الله', 'يعطيك العافية', etc.";
  } else {
    systemPrompt +=
      "\n\nIMPORTANT: The customer is writing in English. Respond in clear, natural English.";
  }

  if (body.customContext) {
    systemPrompt += `\n\nAdditional context from the operator: ${body.customContext}. Use this information to craft your responses.`;
  }

  systemPrompt +=
    "\n\nGenerate exactly 3 different suggested reply options. Return them as a JSON array of 3 strings, nothing else. Each should be a complete, natural WhatsApp message. Vary the tone: one professional, one friendly, one concise.";

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt + orderContext },
  ];

  // Build conversation history
  type HistoryEntry = { role: string; content: string; at: Date };
  const history: HistoryEntry[] = [];
  for (const m of recentInbound) {
    if (m.text)
      history.push({ role: "user", content: m.text, at: m.receivedAt });
  }
  for (const m of recentOutbound) {
    const vars = m.templateVariablesJson;
    const text =
      m.templateName === "<text>" &&
      vars &&
      typeof vars === "object" &&
      "text" in vars
        ? (vars as { text: string }).text
        : `[Sent template: ${m.templateName}]`;
    history.push({ role: "assistant", content: text, at: m.createdAt });
  }
  history.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role, content: h.content });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 500,
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      return NextResponse.json(
        {
          error: `OpenAI API error: ${response.status} ${errBody.slice(0, 200)}`,
        },
        { status: 502 }
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      return NextResponse.json(
        { error: "Empty AI response" },
        { status: 502 }
      );
    }

    // Parse JSON array from the response
    let suggestions: string[];
    try {
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      suggestions = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent) as string[];
      if (!Array.isArray(suggestions)) throw new Error("Not an array");
      suggestions = suggestions.slice(0, 3).map((s) => String(s));
    } catch {
      // Fallback: split by newlines if JSON parsing fails
      suggestions = rawContent
        .split("\n")
        .map((s) => s.replace(/^\d+\.\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 3);
    }

    return NextResponse.json({ suggestions });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to generate suggestions",
      },
      { status: 500 }
    );
  }
}
