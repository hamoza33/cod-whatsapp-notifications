import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import {
  extractCodSignatureHeader,
  verifyCodWebhookSignature,
} from "@/lib/cod-webhook";
import { applyWebhookEvent } from "@/lib/cod-webhook-apply";

export const dynamic = "force-dynamic";

/**
 * COD Network — "Order Status" webhook receiver. See
 * `src/app/api/cod-network/webhook/leads/route.ts` for context — this is
 * the sibling endpoint operators paste into the "Webhook Order Status"
 * field of seller.cod.network → API Developer.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = await getSetting(SETTING_KEYS.COD_WEBHOOK_SECRET);
  if (secret) {
    const signature = extractCodSignatureHeader(request.headers);
    if (!verifyCodWebhookSignature(rawBody, signature, secret)) {
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 }
      );
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await applyWebhookEvent(payload, "order");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[cod-webhook:order] failed to persist event", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "cod-network-order-webhook" });
}
