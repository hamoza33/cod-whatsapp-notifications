import crypto from "crypto";

/**
 * Verify a COD Network webhook signature.
 *
 * COD Network signs each webhook payload with the seller's "Webhook secret
 * key" (visible at seller.cod.network → My Account → API Developer). The
 * provider's docs don't pin a specific header name, so this helper accepts
 * the common variants — `X-Signature`, `X-Webhook-Signature`,
 * `X-Hub-Signature-256`, with or without the `sha256=` prefix — and uses
 * HMAC-SHA256 with hex digest (the de-facto standard used by Meta, Stripe,
 * Coinbase, etc.).
 *
 * Verification is timing-safe. Returns `false` for any malformed input.
 */
export function verifyCodWebhookSignature(
  rawBody: string,
  headerValue: string | null | undefined,
  secret: string
): boolean {
  if (!headerValue || !secret) return false;

  // Strip the optional `sha256=` prefix Meta / GitHub style; COD samples
  // sometimes include it, sometimes not.
  const provided = headerValue.startsWith("sha256=")
    ? headerValue.slice("sha256=".length)
    : headerValue;

  // Expected hex digest
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Also compute base64 — a small number of providers sign in base64 instead
  // of hex. Accept whichever matches.
  const expectedB64 = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  return safeEqual(provided, expectedHex) || safeEqual(provided, expectedB64);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Extract the signature header value from a request. COD Network has used
 * (at various points in time) `X-Signature`, `X-Webhook-Signature`, and
 * `X-Cod-Signature`. We check all three and return the first non-null hit.
 */
export function extractCodSignatureHeader(
  headers: Headers
): string | null {
  return (
    headers.get("x-signature") ||
    headers.get("x-webhook-signature") ||
    headers.get("x-cod-signature") ||
    headers.get("x-cod-webhook-signature") ||
    headers.get("x-hub-signature-256") ||
    null
  );
}
