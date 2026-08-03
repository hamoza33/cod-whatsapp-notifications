import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * Generate AI reply suggestions for a conversation. Reads the full chat
 * history + any matched order details, then asks the configured OpenAI model
 * for N short reply options the operator can pick from.
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

  // Accept an optional `customContext` string — typed by the operator before
  // hitting "Generate with context". When provided we pass it to the model
  // as additional grounding information (delays, custom updates, special
  // offers, etc.).
  let customContext = "";
  if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
    try {
      const body = (await request.json()) as { customContext?: unknown };
      if (typeof body.customContext === "string") {
        customContext = body.customContext.trim().slice(0, 1000);
      }
    } catch {
      // ignore malformed JSON — treat as no custom context
    }
  }

  const enabled = await getSetting(SETTING_KEYS.AI_SUGGESTIONS_ENABLED);
  if (enabled !== "true") {
    return NextResponse.json(
      { error: "AI suggestions are disabled. Enable them in Settings → AI Agent." },
      { status: 400 }
    );
  }

  const apiKey = await getSetting(SETTING_KEYS.OPENAI_API_KEY);
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key not configured. Add it in Settings → AI Agent." },
      { status: 400 }
    );
  }

  const model =
    (await getSetting(SETTING_KEYS.AI_AGENT_MODEL)) || "gpt-4o-mini";
  // Dedicated token budget for suggestions so operators can allow longer
  // replies without changing the auto-reply agent's budget. Falls back to the
  // agent's setting, then to 500.
  const rawMaxTokens =
    (await getSetting(SETTING_KEYS.AI_SUGGESTIONS_MAX_TOKENS)) ||
    (await getSetting(SETTING_KEYS.AI_AGENT_MAX_TOKENS)) ||
    "500";
  const parsedMaxTokens = parseInt(rawMaxTokens, 10);
  const maxTokens = Number.isFinite(parsedMaxTokens)
    ? Math.max(50, Math.min(4000, parsedMaxTokens))
    : 500;
  const suggestionsCount = parseInt(
    (await getSetting(SETTING_KEYS.AI_SUGGESTIONS_COUNT)) || "3",
    10
  );

  let systemPrompt =
    (await getSetting(SETTING_KEYS.AI_SUGGESTIONS_SYSTEM_PROMPT)) ||
    "You are a helpful customer service agent for a COD (cash on delivery) company. Generate short, professional WhatsApp reply suggestions. Keep each suggestion concise (1-2 sentences max). Reply in the same language as the customer.";

  // Build the conversation-language hint. We look at the most recent inbound
  // messages first (what the customer actually wrote); if they used Arabic
  // characters we force Saudi dialect responses, otherwise we force English.
  // This is appended to the system prompt so the language rule wins over any
  // generic guidance baked into the operator-configured prompt.

  // Find matched order for this phone number
  const order = await prisma.order.findFirst({
    where: { customerPhone: { contains: decodedPhone.replace(/^\+/, "") } },
    orderBy: { codCreatedAt: "desc" },
    select: {
      codNetworkOrderId: true,
      codNetworkLeadId: true,
      customerName: true,
      customerPhone: true,
      customerCity: true,
      productName: true,
      productPrice: true,
      productQuantity: true,
      trackingNumber: true,
      deliveryCompany: true,
      status: true,
    },
  });

  if (order) {
    systemPrompt +=
      `\n\nOrder context:\n` +
      `- Customer: ${order.customerName || "Unknown"}\n` +
      `- Product: ${order.productName || "Unknown"}\n` +
      `- Price: ${order.productPrice || "N/A"}\n` +
      `- Status: ${order.status}\n` +
      `- Tracking: ${order.trackingNumber || "N/A"}\n` +
      `- Delivery: ${order.deliveryCompany || "N/A"}\n` +
      `- City: ${order.customerCity || "N/A"}\n` +
      `- Order ID: ${order.codNetworkOrderId}`;
  }

  // Fetch conversation history
  const [inbound, outbound] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: { fromPhoneNumber: decodedPhone },
      orderBy: { receivedAt: "desc" },
      take: 10,
      select: { text: true, receivedAt: true },
    }),
    prisma.whatsappMessage.findMany({
      where: { phoneNumber: decodedPhone },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        templateVariablesJson: true,
        templateName: true,
        createdAt: true,
      },
    }),
  ]);

  type HistoryEntry = { role: string; content: string; at: Date };
  const history: HistoryEntry[] = [];
  for (const m of inbound) {
    if (m.text)
      history.push({ role: "user", content: m.text, at: m.receivedAt });
  }
  for (const m of outbound) {
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

  // Language detection — scan the customer's most-recent inbound text.
  // Arabic Unicode block: U+0600..U+06FF. We bias toward what the customer
  // most recently wrote so the operator's English custom-context input
  // never accidentally forces an English reply when the chat is Arabic.
  const ARABIC_RE = /[\u0600-\u06FF]/;
  const recentCustomerTexts = inbound
    .map((m) => m.text)
    .filter((t): t is string => !!t && t.trim().length > 0);
  const detectedArabic = recentCustomerTexts.some((t) => ARABIC_RE.test(t));
  if (detectedArabic) {
    systemPrompt +=
      "\n\nLANGUAGE RULE (highest priority — overrides everything else):" +
      "\n- The customer is writing in Arabic. Reply in SAUDI ARABIC DIALECT (اللهجة السعودية / لهجة سعودية)." +
      "\n- Use natural Saudi everyday expressions, e.g. 'هلا والله', 'حياك الله', 'وش الأخبار', 'إن شاء الله', 'تمام', 'يعطيك العافية', 'تكفى', 'أبشر', 'يسعد صباحك / مساك'." +
      "\n- DO NOT use formal Modern Standard Arabic (الفصحى) — sound like a real Saudi customer-service rep, not a textbook." +
      "\n- DO NOT use Egyptian / Levantine / Moroccan dialect words.";
  } else {
    systemPrompt +=
      "\n\nLANGUAGE RULE (highest priority — overrides everything else):" +
      "\n- The customer is writing in English. Reply in clear, professional English.";
  }

  if (customContext) {
    systemPrompt +=
      "\n\nOperator's extra context for THIS reply (treat as ground truth — incorporate into the suggestions):" +
      `\n"""\n${customContext}\n"""` +
      "\n\nIMPORTANT: even though the operator may have written this context in English, the LANGUAGE RULE above still applies — the suggestions you generate must follow the customer's language.";
  }

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  for (const h of history.slice(-10)) {
    messages.push({ role: h.role, content: h.content });
  }

  messages.push({
    role: "user",
    content: `Based on the conversation above, generate exactly ${suggestionsCount} short reply suggestions I can send to this customer via WhatsApp. Return ONLY a JSON array of strings, no other text. Example: ["suggestion 1", "suggestion 2", "suggestion 3"]`,
  });

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
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return NextResponse.json(
        { error: "Empty AI response" },
        { status: 502 }
      );
    }

    // Parse the JSON array from the response
    let suggestions: string[];
    try {
      // The model might wrap the JSON in markdown code fences
      const cleaned = content
        .replace(/^```json?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      suggestions = JSON.parse(cleaned) as string[];
      if (!Array.isArray(suggestions)) {
        suggestions = [content];
      }
    } catch {
      // If JSON parsing fails, split by newlines and clean up
      suggestions = content
        .split("\n")
        .map((s) => s.replace(/^\d+[\.\)]\s*/, "").replace(/^["']|["']$/g, "").trim())
        .filter(Boolean)
        .slice(0, suggestionsCount);
    }

    return NextResponse.json({ suggestions });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to generate suggestions",
      },
      { status: 500 }
    );
  }
}
