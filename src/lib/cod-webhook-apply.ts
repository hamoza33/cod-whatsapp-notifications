import { Prisma, OrderStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { mapCodStatus, extractProductName, CodNetworkOrder } from "./cod-network";
import { deriveOrderStatus } from "./order-status";
import { normalizePhoneNumber } from "./phone";
import { getSetting, SETTING_KEYS } from "./settings";
import { runAutomationsForOrder } from "./automations";

interface CodWebhookEnvelope {
  event?: string;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  order?: Record<string, unknown>;
  lead?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CodWebhookPayloadLike extends Record<string, unknown> {
  id?: string | number;
  order_id?: string | number;
  lead_id?: string | number;
  reference?: string;
  status?: unknown;
  tracking_number?: string | null;
  tracking_status?: string | null;
  customer_name?: string;
  customer_phone?: string;
  customer_city?: string;
  customer_address?: string;
  delivery_company?: string;
  product_name?: string;
  total_price?: string | number;
  total?: string | number;
  amount?: string | number;
  quantity?: string | number;
  items?: unknown;
  created_at?: string;
  updated_at?: string;
}

/** Pull the actual payload out of common envelope shapes. */
function unwrapEnvelope(input: unknown): CodWebhookPayloadLike {
  if (!input || typeof input !== "object") return {};
  const obj = input as CodWebhookEnvelope;
  // Common envelope shapes: { data: {...} }, { payload: {...} },
  // { order: {...} }, { lead: {...} }, or the bare payload itself.
  const inner =
    (obj.data as CodWebhookPayloadLike | undefined) ||
    (obj.payload as CodWebhookPayloadLike | undefined) ||
    (obj.order as CodWebhookPayloadLike | undefined) ||
    (obj.lead as CodWebhookPayloadLike | undefined) ||
    (obj as CodWebhookPayloadLike);
  return inner;
}

function extractStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  return String(value);
}

/**
 * Apply a single COD Network webhook event (lead or order) to the database.
 *
 * Behavior:
 *   • Identifies the existing Order by `cod_network_order_id` first, then
 *     by `cod_network_lead_id` (for lead-status webhooks that arrive before
 *     the order is created in the seller dashboard).
 *   • Re-derives the status using `deriveOrderStatus()` so the
 *     tracking-number / delivered / returned auto-transitions apply.
 *   • If the status changes, fires the automation rules engine.
 *
 * Returns a summary of what changed so the webhook endpoint can echo it
 * back in the response (useful when testing with curl).
 */
export async function applyWebhookEvent(
  rawEvent: unknown,
  kind: "lead" | "order"
): Promise<{
  orderId: string | null;
  created: boolean;
  updated: boolean;
  statusChanged: boolean;
  newStatus: OrderStatus | null;
}> {
  const payload = unwrapEnvelope(rawEvent);

  // The "id" field can be the order id or the lead id depending on which
  // webhook delivered the event. We collect both, then look up an existing
  // order via either path.
  const declaredOrderId = extractStr(payload.order_id) || extractStr(payload.id);
  const declaredLeadId =
    extractStr(payload.lead_id) ||
    (kind === "lead" ? extractStr(payload.id) : null);

  // If neither id is present we have no useful key — log and bail.
  if (!declaredOrderId && !declaredLeadId) {
    return {
      orderId: null,
      created: false,
      updated: false,
      statusChanged: false,
      newStatus: null,
    };
  }

  const existing =
    (declaredOrderId
      ? await prisma.order.findUnique({
          where: { codNetworkOrderId: declaredOrderId },
        })
      : null) ||
    (declaredLeadId
      ? await prisma.order.findUnique({
          where: { codNetworkLeadId: declaredLeadId },
        })
      : null);

  // Normalize fields. Cast through CodNetworkOrder for product extraction —
  // it's a superset of the webhook payload shape.
  const codOrderLike = payload as unknown as CodNetworkOrder;
  const productName = extractProductName(codOrderLike);
  const trackingNumber = extractStr(payload.tracking_number);
  const trackingStatus = extractStr(payload.tracking_status);
  const rawStatusLabel =
    typeof payload.status === "string"
      ? payload.status
      : typeof payload.status === "object" && payload.status
        ? extractStr((payload.status as { label?: unknown }).label)
        : null;

  const mappedFromCode = mapCodStatus(
    payload.status as Parameters<typeof mapCodStatus>[0],
    trackingStatus
  ) as OrderStatus;

  const derived = deriveOrderStatus({
    rawStatusLabel,
    trackingStatus,
    trackingNumber,
    mappedFromCode,
    previousStatus: existing?.status ?? null,
  });

  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
  let normalizedPhone: string | null = null;
  const phoneRaw = extractStr(payload.customer_phone);
  if (phoneRaw) {
    try {
      normalizedPhone = normalizePhoneNumber(phoneRaw, defaultCountryCode);
    } catch {
      normalizedPhone = phoneRaw;
    }
  }

  const codCreatedAt = parseIsoDate(extractStr(payload.created_at));
  const codUpdatedAt = parseIsoDate(extractStr(payload.updated_at));

  const writeData: Prisma.OrderUncheckedCreateInput = {
    codNetworkOrderId: declaredOrderId ?? declaredLeadId!,
    codNetworkLeadId: declaredLeadId,
    customerName: extractStr(payload.customer_name),
    customerPhone: normalizedPhone,
    customerCity: extractStr(payload.customer_city),
    customerAddress: extractStr(payload.customer_address),
    productName,
    productPrice:
      extractStr(payload.total_price) ??
      extractStr(payload.total) ??
      extractStr(payload.amount) ??
      null,
    productQuantity: extractStr(payload.quantity),
    trackingNumber,
    deliveryCompany: extractStr(payload.delivery_company),
    status: derived,
    statusChangedAt: existing?.status === derived ? existing?.statusChangedAt : new Date(),
    codDeliveryStatus: rawStatusLabel,
    rawOrderJson: payload as Prisma.InputJsonValue,
    codCreatedAt,
    codUpdatedAt,
    lastSyncedAt: new Date(),
  };

  let orderRow: { id: string; status: OrderStatus };
  let created = false;
  let updated = false;
  const statusChanged = !existing || existing.status !== derived;

  if (existing) {
    const updateData: Prisma.OrderUncheckedUpdateInput = {};
    // Only overwrite fields that the webhook actually carries — never blank
    // out useful data with `null`.
    for (const [k, v] of Object.entries(writeData)) {
      if (v === null || v === undefined) continue;
      // codNetworkOrderId is immutable per row.
      if (k === "codNetworkOrderId") continue;
      (updateData as Record<string, unknown>)[k] = v;
    }
    // Always update the status (including null→PENDING transitions) — the
    // whole point of the webhook is to convey new status.
    updateData.status = derived;
    if (statusChanged) updateData.statusChangedAt = new Date();
    orderRow = await prisma.order.update({
      where: { id: existing.id },
      data: updateData,
      select: { id: true, status: true },
    });
    updated = true;
  } else {
    orderRow = await prisma.order.create({
      data: writeData,
      select: { id: true, status: true },
    });
    created = true;
  }

  // Fire automation rules. Run in best-effort mode so a single bad rule
  // doesn't 500 the webhook (COD Network would otherwise retry forever).
  if (statusChanged) {
    try {
      await runAutomationsForOrder(orderRow.id);
    } catch (err) {
      console.error("[cod-webhook] automation engine threw", err);
    }
  }

  return {
    orderId: orderRow.id,
    created,
    updated,
    statusChanged,
    newStatus: orderRow.status,
  };
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}
