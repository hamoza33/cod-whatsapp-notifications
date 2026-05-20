import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  CodNetworkClient,
  CodNetworkOrder,
  mapCodStatus,
  extractProductName,
} from "./cod-network";
import { WhatsAppClient, buildTemplateVariables } from "./whatsapp";
import { getSetting, SETTING_KEYS } from "./settings";
import { normalizePhoneNumber } from "./phone";
import { OrderStatus } from "@prisma/client";
import { deriveOrderStatus } from "./order-status";
import { runAutomationsForOrder } from "./automations";

function extractLeadId(codOrder: CodNetworkOrder): string | null {
  // COD Network exposes the lead-id under various keys depending on which
  // endpoint returns the order. Try the most common shapes and fall back
  // to null when none are present.
  const candidates: unknown[] = [
    (codOrder as { lead_id?: unknown }).lead_id,
    (codOrder as { leadId?: unknown }).leadId,
    ((codOrder as { lead?: { id?: unknown } }).lead || {}).id,
  ];
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = typeof c === "string" ? c : String(c);
    if (s.length > 0) return s;
  }
  return null;
}

interface SyncResult {
  ordersFound: number;
  ordersCreated: number;
  ordersUpdated: number;
  messagesSent: number;
  errors: string[];
}

let syncInProgress = false;

export function isSyncInProgress(): boolean {
  return syncInProgress;
}

export async function syncOrders(
  options: { skipAutomations?: boolean } = {}
): Promise<SyncResult> {
  const startTime = Date.now();
  const result: SyncResult = {
    ordersFound: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    messagesSent: 0,
    errors: [],
  };

  if (syncInProgress) {
    result.errors.push("Sync already in progress");
    return result;
  }
  syncInProgress = true;

  try {
    try {
      const client = await CodNetworkClient.fromSettings();

      const daysBackSetting = await getSetting(SETTING_KEYS.SYNC_DAYS_BACK);
      const daysBack = daysBackSetting ? parseInt(daysBackSetting, 10) : 30;
      const sinceDate = Number.isFinite(daysBack) && daysBack > 0
        ? new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
        : undefined;

      const orders = await client.getAllOrders({}, { sinceDate });
      result.ordersFound = orders.length;

      const defaultCountryCode =
        (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

      const shouldSkipAutomations = !!options.skipAutomations;

      for (const order of orders) {
        try {
          await upsertOrder(order, result, defaultCountryCode, shouldSkipAutomations);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown error upserting order";
          result.errors.push(`Order ${order.id}: ${msg}`);
        }
      }

      // Auto-send messages if automation is enabled
      const automationEnabled = await getSetting(SETTING_KEYS.AUTOMATION_ENABLED);
      if (automationEnabled === "true") {
        const sent = await autoSendMessages();
        result.messagesSent = sent;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown sync error";
      result.errors.push(msg);
    }

    const duration = Date.now() - startTime;

    try {
      await prisma.syncLog.create({
        data: {
          syncType: "full",
          status: result.errors.length > 0 ? "partial_error" : "success",
          ordersFound: result.ordersFound,
          ordersCreated: result.ordersCreated,
          ordersUpdated: result.ordersUpdated,
          messagesSent: result.messagesSent,
          errorMessage:
            result.errors.length > 0 ? result.errors.join("; ") : null,
          duration,
        },
      });
    } catch (logErr) {
      const msg = logErr instanceof Error ? logErr.message : "Failed to write sync log";
      result.errors.push(msg);
    }

    return result;
  } finally {
    syncInProgress = false;
  }
}

function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

function extractProductPriceAndQuantity(
  order: CodNetworkOrder
): { price: string | null; quantity: string | null } {
  const itemsRaw = order.items;
  let items: { price?: string | number; quantity?: string | number }[] = [];
  if (Array.isArray(itemsRaw)) items = itemsRaw;
  else if (
    itemsRaw &&
    typeof itemsRaw === "object" &&
    Array.isArray((itemsRaw as { data?: unknown }).data)
  ) {
    items = (itemsRaw as { data: typeof items }).data;
  }

  const totalQty = items.reduce((acc, it) => {
    const q = Number(it.quantity ?? 0);
    return acc + (Number.isFinite(q) ? q : 0);
  }, 0);

  let price: string | null = null;
  if (order.total_price !== undefined) price = String(order.total_price);
  else if (order.total !== undefined) price = String(order.total);
  else if (order.amount !== undefined) price = String(order.amount);
  else if (order.product_price !== undefined) price = String(order.product_price);
  else if (items.length > 0 && items[0].price !== undefined) {
    price = String(items[0].price);
  }

  let quantity: string | null = null;
  if (totalQty > 0) quantity = String(totalQty);
  else if (order.product_quantity !== undefined) quantity = String(order.product_quantity);
  else if (order.quantity !== undefined) quantity = String(order.quantity);

  return { price, quantity };
}

async function upsertOrder(
  codOrder: CodNetworkOrder,
  result: SyncResult,
  defaultCountryCode: string,
  skipAutomations = false
): Promise<void> {
  const codOrderId = String(codOrder.id);
  const codLeadId = extractLeadId(codOrder);
  const trackingNumber = codOrder.tracking_number ?? null;
  const trackingStatus = codOrder.tracking_status ?? null;
  const rawStatusLabel =
    typeof codOrder.status === "string"
      ? codOrder.status
      : typeof codOrder.status === "object" && codOrder.status
        ? codOrder.status.label ?? null
        : null;

  const productName = extractProductName(codOrder);
  const { price: productPrice, quantity: productQuantity } =
    extractProductPriceAndQuantity(codOrder);
  const codCreatedAt = parseDate(codOrder.created_at);
  const codUpdatedAt = parseDate(codOrder.updated_at);

  let normalizedPhone: string | null = null;
  if (codOrder.customer_phone) {
    try {
      normalizedPhone = normalizePhoneNumber(
        codOrder.customer_phone,
        defaultCountryCode
      );
    } catch {
      normalizedPhone = codOrder.customer_phone;
    }
  }

  const existing = await prisma.order.findUnique({
    where: { codNetworkOrderId: codOrderId },
  });

  // Apply the auto-status logic: tracking number → OUT_FOR_DELIVERY,
  // explicit delivered/returned signals → final state, etc. Falls back to
  // the previously-computed `mapCodStatus` result.
  const mappedFromCode = mapCodStatus(
    codOrder.status,
    trackingStatus
  ) as OrderStatus;
  const status = deriveOrderStatus({
    rawStatusLabel,
    trackingStatus,
    trackingNumber,
    mappedFromCode,
    previousStatus: existing?.status ?? null,
  });

  if (existing) {
    const statusChanged = existing.status !== status;
    const trackingChanged =
      (trackingNumber && trackingNumber !== existing.trackingNumber) ||
      (rawStatusLabel && rawStatusLabel !== existing.codDeliveryStatus);
    await prisma.order.update({
      where: { codNetworkOrderId: codOrderId },
      data: {
        codNetworkLeadId: codLeadId ?? existing.codNetworkLeadId,
        customerName: codOrder.customer_name ?? existing.customerName,
        customerPhone: normalizedPhone ?? existing.customerPhone,
        customerCity: codOrder.customer_city ?? existing.customerCity,
        customerAddress: codOrder.customer_address ?? existing.customerAddress,
        productName: productName ?? existing.productName,
        productPrice: productPrice ?? existing.productPrice,
        productQuantity: productQuantity ?? existing.productQuantity,
        trackingNumber: trackingNumber ?? existing.trackingNumber,
        deliveryCompany: codOrder.delivery_company ?? existing.deliveryCompany,
        status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
        codDeliveryStatus: rawStatusLabel ?? existing.codDeliveryStatus,
        codCreatedAt: codCreatedAt ?? existing.codCreatedAt,
        codUpdatedAt: codUpdatedAt ?? existing.codUpdatedAt,
        rawOrderJson: JSON.parse(JSON.stringify(codOrder)) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    });
    result.ordersUpdated++;

    if ((statusChanged || trackingChanged) && !skipAutomations) {
      try {
        await runAutomationsForOrder(existing.id, { autoTriggered: true });
      } catch (err) {
        console.error("[sync] automation engine threw", err);
      }
    }
  } else {
    const created = await prisma.order.create({
      data: {
        codNetworkOrderId: codOrderId,
        codNetworkLeadId: codLeadId,
        customerName: codOrder.customer_name ?? null,
        customerPhone: normalizedPhone,
        customerCity: codOrder.customer_city ?? null,
        customerAddress: codOrder.customer_address ?? null,
        productName,
        productPrice,
        productQuantity,
        trackingNumber,
        deliveryCompany: codOrder.delivery_company ?? null,
        status,
        statusChangedAt: new Date(),
        codDeliveryStatus: rawStatusLabel,
        codCreatedAt,
        codUpdatedAt,
        rawOrderJson: JSON.parse(JSON.stringify(codOrder)) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    });
    result.ordersCreated++;

    if (!skipAutomations) {
      try {
        await runAutomationsForOrder(created.id, { autoTriggered: true });
      } catch (err) {
        console.error("[sync] automation engine threw on new order", err);
      }
    }
  }
}

async function autoSendMessages(): Promise<number> {
  const triggerStatusSetting = await getSetting(
    SETTING_KEYS.AUTOMATION_TRIGGER_STATUS
  );
  const triggerStatuses = triggerStatusSetting
    ? triggerStatusSetting.split(",").map((s) => s.trim() as OrderStatus)
    : [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY];

  const sendOnce =
    (await getSetting(SETTING_KEYS.AUTOMATION_SEND_ONCE)) !== "false";

  const delaySetting = await getSetting(SETTING_KEYS.AUTOMATION_DELAY_SECONDS);
  const delaySeconds = delaySetting ? parseInt(delaySetting, 10) : 0;

  const templateName =
    (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME)) ||
    "order_out_for_delivery";
  const templateLanguage =
    (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE)) || "en";
  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

  const orders = await prisma.order.findMany({
    where: {
      status: { in: triggerStatuses },
      customerPhone: { not: null },
    },
    include: {
      whatsappMessages: true,
    },
  });

  let sent = 0;
  const whatsappClient = await WhatsAppClient.fromSettings();

  for (const order of orders) {
    if (sendOnce && order.whatsappMessages.some(m => m.status === "SENT" || m.status === "DELIVERED" || m.status === "READ")) {
      continue;
    }

    const failedCount = order.whatsappMessages.filter(m => m.status === "FAILED").length;
    if (failedCount >= 3) continue;

    if (!order.customerPhone) continue;

    if (delaySeconds > 0) {
      const referenceTime = order.statusChangedAt ?? order.updatedAt;
      const timeSinceStatusChange =
        (Date.now() - referenceTime.getTime()) / 1000;
      if (timeSinceStatusChange < delaySeconds) continue;
    }

    try {
      const variables = buildTemplateVariables(
        order.customerName || "Customer",
        order.codNetworkOrderId
      );

      const normalizedPhone = normalizePhoneNumber(
        order.customerPhone,
        defaultCountryCode
      );

      const result = await whatsappClient.sendTemplate(
        normalizedPhone,
        templateName,
        templateLanguage,
        variables
      );

      await prisma.whatsappMessage.create({
        data: {
          orderId: order.id,
          phoneNumber: normalizedPhone,
          templateName,
          templateLanguage,
          templateVariablesJson: variables,
          providerMessageId: result.messages?.[0]?.id ?? null,
          status: "SENT",
          sentBy: "automation",
          sentAt: new Date(),
        },
      });

      sent++;
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown WhatsApp error";
      try {
        await prisma.whatsappMessage.create({
          data: {
            orderId: order.id,
            phoneNumber: order.customerPhone,
            templateName,
            templateLanguage,
            templateVariablesJson: [],
            status: "FAILED",
            errorMessage: errorMsg,
            sentBy: "automation",
          },
        });
      } catch {
        // ignore logging failure to avoid terminating the loop
      }
    }
  }

  return sent;
}
