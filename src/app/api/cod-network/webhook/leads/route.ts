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
 * COD Network — "Lead Status" webhook receiver.
 *
 * COD Network seller dashboard → My Account → API Developer → Webhooks
 * exposes two URLs the operator can paste in:
 *   • Webhook Lead Status
 *   • Webhook Order Status
 *
 * This endpoint is meant for the *lead* one. It expects a JSON body roughly
 * shaped like an order (the exact field names vary slightly between leads
 * and orders) plus a signature header signed with the seller's "Webhook
 * secret key" (HMAC-SHA256). Both fields are persisted via the shared
 * upsert helper.
 *
 * The endpoint returns 200 on success, 401 on missing/invalid signature,
 * and 400 on unparseable JSON. COD Network retries 5xx but treats 4xx as
 * permanent failure, so we deliberately use 200 even for "no-op" payloads.
 */
export async function POST(request: NextRequest) {
  return handleCodWebhook(request, "lead");
}

// GET — handshake compatibility. Most providers don't issue one for COD-style
// webhooks, but exposing 200 here makes the URL look healthy to whoever's
// pasting it into the dashboard.
export async function GET() {
  return NextResponse.json({ ok: true, service: "cod-network-lead-webhook" });
}

async function handleCodWebhook(
  request: NextRequest,
  kind: "lead" | "order"
): Promise<NextResponse> {
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
  // If no webhook secret has been configured, accept the payload (intended
  // for one-off testing — production operators are expected to set
  // Settings → COD Network → Webhook Secret).

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await applyWebhookEvent(payload, kind);
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Duplicate unique key — usually means the webhook was re-delivered.
      return NextResponse.json({ ok: true, duplicate: true });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[cod-webhook:${kind}] failed to persist event`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
