import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";

/**
 * POST /api/voice-agent
 * Initiates a voice agent call for a given order.
 * Supports ElevenLabs Conversational AI and a generic SIP/HTTP provider.
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
      customerName: true,
      customerPhone: true,
      productName: true,
      status: true,
      trackingNumber: true,
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

  const enabled = await getSetting("voice_agent_enabled");
  if (enabled !== "true") {
    return NextResponse.json(
      { error: "Voice agent is not enabled. Enable it in Settings → Voice Agent." },
      { status: 400 }
    );
  }

  const provider = (await getSetting("voice_agent_provider")) || "elevenlabs";
  const apiKey = await getSetting("voice_agent_api_key");
  if (!apiKey) {
    return NextResponse.json(
      { error: "Voice agent API key not configured" },
      { status: 400 }
    );
  }

  const voiceId = (await getSetting("voice_agent_voice_id")) || "21m00Tcm4TlvDq8ikWAM";
  const systemPrompt = (await getSetting("voice_agent_system_prompt")) || buildDefaultPrompt();
  const language = (await getSetting("voice_agent_language")) || "ar";
  const callerId = await getSetting("voice_agent_caller_id");
  const webhookUrl = await getSetting("voice_agent_webhook_url");

  const contextVars: Record<string, string> = {
    customer_name: order.customerName || "Customer",
    product: order.productName || "your order",
    order_status: order.status,
    tracking: order.trackingNumber || "N/A",
  };

  let resolvedPrompt = systemPrompt;
  for (const [key, val] of Object.entries(contextVars)) {
    resolvedPrompt = resolvedPrompt.replace(new RegExp(`\\{${key}\\}`, "g"), val);
  }

  try {
    let callResult: Record<string, unknown>;

    if (provider === "elevenlabs") {
      callResult = await initiateElevenLabsCall({
        apiKey,
        voiceId,
        systemPrompt: resolvedPrompt,
        customerPhone: order.customerPhone,
        language,
        callerId,
        webhookUrl,
      });
    } else {
      callResult = await initiateGenericCall({
        apiKey,
        systemPrompt: resolvedPrompt,
        customerPhone: order.customerPhone,
        language,
        callerId,
        webhookUrl,
        provider,
      });
    }

    await prisma.order.update({
      where: { id: orderId },
      data: { callAgentQueued: true },
    });

    return NextResponse.json({ success: true, callResult });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice call failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function buildDefaultPrompt(): string {
  return `You are a professional customer service agent for a delivery company.
You are calling the customer to confirm their order.
- Greet them by name: {customer_name}
- Confirm their order: {product}
- Current status: {order_status}
- Tracking number: {tracking}
- Be polite and professional
- Speak in Arabic by default
- Keep the call brief and to the point
- If they want to cancel, note it and end the call politely`;
}

async function initiateElevenLabsCall(opts: {
  apiKey: string;
  voiceId: string;
  systemPrompt: string;
  customerPhone: string;
  language: string;
  callerId: string | null;
  webhookUrl: string | null;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    agent: {
      prompt: {
        prompt: opts.systemPrompt,
      },
      first_message: `مرحبا، هل أنت ${opts.customerPhone}؟`,
      language: opts.language,
    },
    phone_number: opts.customerPhone,
  };

  if (opts.callerId) {
    payload.from = opts.callerId;
  }
  if (opts.webhookUrl) {
    payload.webhook_url = opts.webhookUrl;
  }

  const response = await fetch(
    "https://api.elevenlabs.io/v1/convai/conversation/create_phone_call",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": opts.apiKey,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ElevenLabs API error ${response.status}: ${text}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

async function initiateGenericCall(opts: {
  apiKey: string;
  systemPrompt: string;
  customerPhone: string;
  language: string;
  callerId: string | null;
  webhookUrl: string | null;
  provider: string;
}): Promise<Record<string, unknown>> {
  const payload = {
    to: opts.customerPhone,
    from: opts.callerId,
    system_prompt: opts.systemPrompt,
    language: opts.language,
    webhook_url: opts.webhookUrl,
  };

  const baseUrl = opts.provider === "bland"
    ? "https://api.bland.ai/v1/calls"
    : opts.provider;

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Voice API error ${response.status}: ${text}`);
  }

  return (await response.json()) as Record<string, unknown>;
}
