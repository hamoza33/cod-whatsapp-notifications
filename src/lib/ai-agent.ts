import { getSetting, SETTING_KEYS } from "./settings";
import { prisma } from "./prisma";
import { WhatsAppClient } from "./whatsapp";

interface OrderContext {
  customerName: string | null;
  productName: string | null;
  status: string;
  trackingNumber: string | null;
  customerCity: string | null;
  codNetworkOrderId: string;
  productPrice: string | null;
  deliveryCompany: string | null;
  latestTrackingEvent: string | null;
}

/**
 * AI auto-reply: given an inbound message and optionally a matched order,
 * generate a ChatGPT response and send it back via WhatsApp free-form text.
 */
export async function handleAiAutoReply(
  fromPhone: string,
  messageText: string,
  order: OrderContext | null
): Promise<{ replied: boolean; error?: string }> {
  const enabled = await getSetting(SETTING_KEYS.AI_AGENT_ENABLED);
  if (enabled !== "true") return { replied: false };

  const apiKey = await getSetting(SETTING_KEYS.OPENAI_API_KEY);
  if (!apiKey) return { replied: false, error: "OpenAI API key not configured" };

  // Two-level opt-in: the agent only replies when BOTH the global toggle
  // (checked above) AND the per-product toggle are enabled. Auto-reply is
  // therefore silent unless the inbound message maps to a known product whose
  // `aiAgentEnabled` flag is true — conversations with no product context, or
  // a product that isn't tracked / isn't enabled, get no automatic response.
  if (!order?.productName) {
    return { replied: false, error: "No product context for AI auto-reply" };
  }
  const product = await prisma.product.findFirst({
    where: { name: order.productName },
    select: { aiAgentEnabled: true },
  });
  if (!product || !product.aiAgentEnabled) {
    return { replied: false, error: "AI agent not enabled for this product" };
  }

  const model = (await getSetting(SETTING_KEYS.AI_AGENT_MODEL)) || "gpt-4o-mini";
  const maxTokens = parseInt(
    (await getSetting(SETTING_KEYS.AI_AGENT_MAX_TOKENS)) || "300",
    10
  );
  let systemPrompt =
    (await getSetting(SETTING_KEYS.AI_AGENT_SYSTEM_PROMPT)) ||
    "You are a helpful customer service agent for a delivery company. Keep responses short for WhatsApp.";

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
    ? `\n\nCustomer order context:\n- Name: ${order.customerName || "Unknown"}\n- Product: ${order.productName || "Unknown"}\n- Price: ${order.productPrice || "N/A"}\n- Status: ${order.status}\n- Tracking: ${order.trackingNumber || "N/A"}\n- Latest tracking update: ${order.latestTrackingEvent || "N/A"}\n- Carrier: ${order.deliveryCompany || "N/A"}\n- City: ${order.customerCity || "N/A"}\n- Order ID: ${order.codNetworkOrderId}`
    : "";

  // Language detection — Arabic customer => Saudi dialect, English => English.
  // Same rule as the suggestions endpoint; kept inline here so the auto-reply
  // path doesn't depend on the suggestions module.
  const ARABIC_RE = /[\u0600-\u06FF]/;
  const detectedArabic = ARABIC_RE.test(messageText || "");
  const languageRule = detectedArabic
    ? "\n\nLANGUAGE RULE (highest priority — overrides everything else):" +
      "\n- The customer is writing in Arabic. Reply in SAUDI ARABIC DIALECT (اللهجة السعودية)." +
      "\n- Use natural Saudi everyday expressions (e.g. 'هلا والله', 'حياك الله', 'إن شاء الله', 'تمام', 'يعطيك العافية', 'أبشر')." +
      "\n- DO NOT use formal Modern Standard Arabic (الفصحى) or Egyptian / Levantine / Moroccan dialect words."
    : "\n\nLANGUAGE RULE (highest priority — overrides everything else):" +
      "\n- The customer is writing in English. Reply in clear, professional English.";

  // Fetch recent conversation history for context
  const recentInbound = await prisma.inboundMessage.findMany({
    where: { fromPhoneNumber: fromPhone },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { text: true, receivedAt: true },
  });
  const recentOutbound = await prisma.whatsappMessage.findMany({
    where: { phoneNumber: fromPhone },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { templateVariablesJson: true, templateName: true, createdAt: true },
  });

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt + orderContext + languageRule },
  ];

  // Build conversation history
  type HistoryEntry = { role: string; content: string; at: Date };
  const history: HistoryEntry[] = [];
  for (const m of recentInbound) {
    if (m.text) history.push({ role: "user", content: m.text, at: m.receivedAt });
  }
  for (const m of recentOutbound) {
    const vars = m.templateVariablesJson;
    const text =
      m.templateName === "<text>" && vars && typeof vars === "object" && "text" in vars
        ? (vars as { text: string }).text
        : `[Sent template: ${m.templateName}]`;
    history.push({ role: "assistant", content: text, at: m.createdAt });
  }
  history.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role, content: h.content });
  }

  // Ensure the latest message is always included
  if (messageText) {
    messages.push({ role: "user", content: messageText });
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
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      return { replied: false, error: `OpenAI API error: ${response.status} ${errBody.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const replyText = data.choices?.[0]?.message?.content?.trim();
    if (!replyText) return { replied: false, error: "Empty AI response" };

    // Send the reply via WhatsApp
    let client: WhatsAppClient;
    try {
      client = await WhatsAppClient.fromSettings();
    } catch (err) {
      return {
        replied: false,
        error: err instanceof Error ? err.message : "WhatsApp not configured",
      };
    }

    const toForApi = fromPhone.replace(/^\+/, "");
    const result = await client.sendText(toForApi, replyText);

    // Record the outbound message
    if (order) {
      await prisma.whatsappMessage.create({
        data: {
          orderId: order.codNetworkOrderId
            ? (
                await prisma.order.findFirst({
                  where: { codNetworkOrderId: order.codNetworkOrderId },
                  select: { id: true },
                })
              )?.id || ""
            : "",
          phoneNumber: fromPhone,
          templateName: "<text>",
          templateLanguage: "en",
          templateVariablesJson: { text: replyText },
          providerMessageId: result?.messages?.[0]?.id ?? null,
          status: "SENT",
          sentBy: "ai_agent",
          sentAt: new Date(),
        },
      });
    }

    return { replied: true };
  } catch (err) {
    return {
      replied: false,
      error: err instanceof Error ? err.message : "AI reply failed",
    };
  }
}
