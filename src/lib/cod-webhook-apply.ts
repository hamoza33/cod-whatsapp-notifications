import { Prisma, OrderStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { mapCodStatus, extractProductName, CodNetworkOrder } from "./cod-network";
import { deriveOrderStatus } from "./order-status";
import { normalizePhoneNumber } from "./phone";
import { getSetting, SETTING_KEYS } from "./settings";
import { runAutomationsForOrder } from "./automations";
import {
  fireOrderCreatedFlows,
  fireOrderStatusChangedFlows,
  fireOrderTrackingAssignedFlows,
  safeFireFlows,
} from "./automation-flows/triggers";

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
  // --- Seller /leads endpoint shape (differs from /orders) ---
  // Top-level phone + call count, product summary string, and a nested
  // `original_payload` (a JSON string) carrying the real customer details.
  phone?: string | null;
  calls?: number | string | null;
  products?: string | null;
  original_payload?: unknown;
}

/** Customer details nested inside a lead's `original_payload` JSON string. */
interface LeadOriginalPayload {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  original_phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  area?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  total_price?: string | number | null;
  total_quantity?: string | number | null;
  product_name_1?: string | null;
}

/** Parse a lead's `original_payload`, which arrives as a JSON string. */
function parseOriginalPayload(value: unknown): LeadOriginalPayload | null {
  if (!value) return null;
  if (typeof value === "object") return value as LeadOriginalPayload;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as LeadOriginalPayload;
    } catch {
      return null;
    }
  }
  return null;
}

/** Join non-empty string parts with a separator, or null if all empty. */
function joinNonEmpty(
  parts: Array<string | null | undefined>,
  sep: string
): string | null {
  const vals = parts
    .map((p) => (p ?? "").toString().trim())
    .filter((p) => p.length > 0);
  return vals.length ? vals.join(sep) : null;
}

// Lead-only pipeline statuses. A CONFIRMED lead sitting in one of these (or a
// brand-new row) is promoted into the order pipeline; one already advanced to
// a real order stage (ASSIGNED/SHIPPED/…) is never downgraded by a stale
// re-confirmation.
const LEAD_ONLY_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.NEW,
  OrderStatus.CONFIRMED,
  OrderStatus.NO_REPLY,
  OrderStatus.WRONG,
  OrderStatus.EXPIRED,
  OrderStatus.CALL_LATER,
  OrderStatus.CALL_LATER_SCHEDULED,
  OrderStatus.DELAYED,
  OrderStatus.CANCELLED_PRICE,
  OrderStatus.BLACK_LISTED,
  OrderStatus.UNKNOWN,
]);

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
  // For a lead webhook the ambiguous `id` field is the LEAD id, so it must
  // not be treated as an order id — otherwise a lead with no explicit
  // `order_id` would be keyed on `codNetworkOrderId = <leadId>` up front and
  // could never be matched/upgraded when the real order webhook (carrying a
  // distinct `order_id` + the same `lead_id`) arrives. Order/any webhooks keep
  // treating `id` as the order id.
  const declaredOrderId =
    extractStr(payload.order_id) ||
    (kind === "lead" ? null : extractStr(payload.id));
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
      ? await prisma.order.findFirst({
          where: { codNetworkLeadId: declaredLeadId },
        })
      : null);

  // Normalize fields. Cast through CodNetworkOrder for product extraction —
  // it's a superset of the webhook payload shape.
  const codOrderLike = payload as unknown as CodNetworkOrder;
  const productName = extractProductName(codOrderLike);

  // The /leads endpoint nests the real customer details inside a JSON-string
  // `original_payload` and puts phone/product/calls at the top level under
  // different keys than /orders. Resolve every display field from both shapes
  // so lead cards carry the same info as order cards.
  const original = parseOriginalPayload(payload.original_payload);
  const resolvedName =
    extractStr(payload.customer_name) ??
    (original ? joinNonEmpty([original.first_name, original.last_name], " ") : null);
  const resolvedProductName =
    productName ??
    (original ? extractStr(original.product_name_1) : null) ??
    extractStr(payload.products);
  const resolvedCity =
    extractStr(payload.customer_city) ??
    (original
      ? extractStr(original.city) ??
        extractStr(original.area) ??
        extractStr(original.state)
      : null);
  const resolvedAddress =
    extractStr(payload.customer_address) ??
    (original ? joinNonEmpty([original.line1, original.line2, original.zip], ", ") : null);
  const resolvedPrice =
    extractStr(payload.total_price) ??
    extractStr(payload.total) ??
    extractStr(payload.amount) ??
    (original ? extractStr(original.total_price) : null);
  const resolvedQuantity =
    extractStr(payload.quantity) ??
    (original ? extractStr(original.total_quantity) : null);
  const callsRaw =
    typeof payload.calls === "number"
      ? payload.calls
      : typeof payload.calls === "string" && payload.calls.trim() !== ""
        ? parseInt(payload.calls, 10)
        : null;
  const callAttempts =
    callsRaw !== null && Number.isFinite(callsRaw) ? callsRaw : undefined;

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
    trackingStatus,
    kind
  ) as OrderStatus;

  const derived = deriveOrderStatus({
    rawStatusLabel,
    trackingStatus,
    trackingNumber,
    mappedFromCode,
    previousStatus: existing?.status ?? null,
  });

  // Auto-promote a confirmed lead into the order pipeline: a confirmed lead is
  // now a real order, so surface it with an initial PENDING order status
  // instead of leaving it in the lead-only CONFIRMED column.
  let effectiveStatus = derived;
  if (kind === "lead" && derived === OrderStatus.CONFIRMED) {
    const prev = existing?.status ?? null;
    effectiveStatus =
      prev === null || LEAD_ONLY_STATUSES.has(prev)
        ? OrderStatus.PENDING
        : prev;
  }

  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
  let normalizedPhone: string | null = null;
  const phoneRaw =
    extractStr(payload.customer_phone) ??
    extractStr(payload.phone) ??
    (original
      ? extractStr(original.phone) ?? extractStr(original.original_phone)
      : null);
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
    customerName: resolvedName,
    customerPhone: normalizedPhone,
    customerCity: resolvedCity,
    customerAddress: resolvedAddress,
    productName: resolvedProductName,
    productPrice: resolvedPrice,
    productQuantity: resolvedQuantity,
    callAttempts,
    trackingNumber,
    deliveryCompany: extractStr(payload.delivery_company),
    status: effectiveStatus,
    statusChangedAt:
      existing?.status === effectiveStatus
        ? existing?.statusChangedAt
        : new Date(),
    codDeliveryStatus: rawStatusLabel,
    rawOrderJson: payload as Prisma.InputJsonValue,
    codCreatedAt,
    codUpdatedAt,
    lastSyncedAt: new Date(),
  };

  let orderRow: { id: string; status: OrderStatus };
  let created = false;
  let updated = false;
  const statusChanged = !existing || existing.status !== effectiveStatus;
  const trackingChanged = existing
    ? (trackingNumber !== null && trackingNumber !== existing.trackingNumber) ||
      (rawStatusLabel !== null && rawStatusLabel !== existing.codDeliveryStatus)
    : false;

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
    updateData.status = effectiveStatus;
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

  // Detect whether the webhook just observed a tracking number for the
  // first time — either on a brand-new order or as the first update that
  // fills in a previously-empty tracking field. Empty strings are treated
  // the same as null so a whitespace-only previous value still counts.
  const hadTrackingBefore =
    !!(existing?.trackingNumber && existing.trackingNumber.trim() !== "");
  const hasTrackingNow = !!(trackingNumber && trackingNumber.trim() !== "");
  const trackingJustAssigned = !hadTrackingBefore && hasTrackingNow;

  // Fire automation rules when status OR tracking data changes. Run in
  // best-effort mode so a single bad rule doesn't 500 the webhook (COD
  // Network would otherwise retry forever).
  if (statusChanged || trackingChanged || created) {
    try {
      await runAutomationsForOrder(orderRow.id, { autoTriggered: true });
    } catch (err) {
      console.error("[cod-webhook] automation engine threw", err);
    }
    if (created) {
      safeFireFlows(
        fireOrderCreatedFlows(orderRow.id),
        `ORDER_CREATED flow for order ${orderRow.id}`
      ).catch(() => {});
    } else if (statusChanged) {
      safeFireFlows(
        fireOrderStatusChangedFlows(
          orderRow.id,
          existing?.status ?? null,
          orderRow.status
        ),
        `ORDER_STATUS_CHANGED flow for order ${orderRow.id}`
      ).catch(() => {});
    }
    if (trackingJustAssigned) {
      safeFireFlows(
        fireOrderTrackingAssignedFlows(orderRow.id),
        `ORDER_TRACKING_ASSIGNED flow for order ${orderRow.id}`
      ).catch(() => {});
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
