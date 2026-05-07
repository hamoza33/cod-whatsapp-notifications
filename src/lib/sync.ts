import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { CodNetworkClient, CodNetworkOrder, mapCodStatus } from "./cod-network";
import { WhatsAppClient, buildTemplateVariables } from "./whatsapp";
import { getSetting, SETTING_KEYS } from "./settings";
import { normalizePhoneNumber } from "./phone";
import { OrderStatus } from "@prisma/client";

interface SyncResult {
  ordersFound: number;
  ordersCreated: number;
  ordersUpdated: number;
  messagesSent: number;
  errors: string[];
}

export async function syncOrders(): Promise<SyncResult> {
  const startTime = Date.now();
  const result: SyncResult = {
    ordersFound: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    messagesSent: 0,
    errors: [],
  };

  try {
    const client = await CodNetworkClient.fromSettings();
    const orders = await client.getAllOrders();
    result.ordersFound = orders.length;

    for (const order of orders) {
      try {
        await upsertOrder(order, result);
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
}

async function upsertOrder(
  codOrder: CodNetworkOrder,
  result: SyncResult
): Promise<void> {
  const codOrderId = String(codOrder.id);
  const status = mapCodStatus(codOrder.status) as OrderStatus;
  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

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

  if (existing) {
    const statusChanged = existing.status !== status;
    await prisma.order.update({
      where: { codNetworkOrderId: codOrderId },
      data: {
        customerName: codOrder.customer_name ?? existing.customerName,
        customerPhone: normalizedPhone ?? existing.customerPhone,
        customerCity: codOrder.customer_city ?? existing.customerCity,
        customerAddress: codOrder.customer_address ?? existing.customerAddress,
        productName: codOrder.product_name ?? existing.productName,
        trackingNumber: codOrder.tracking_number ?? existing.trackingNumber,
        deliveryCompany: codOrder.delivery_company ?? existing.deliveryCompany,
        status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
        rawOrderJson: JSON.parse(JSON.stringify(codOrder)) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    });
    result.ordersUpdated++;
  } else {
    await prisma.order.create({
      data: {
        codNetworkOrderId: codOrderId,
        customerName: codOrder.customer_name ?? null,
        customerPhone: normalizedPhone,
        customerCity: codOrder.customer_city ?? null,
        customerAddress: codOrder.customer_address ?? null,
        productName: codOrder.product_name ?? null,
        trackingNumber: codOrder.tracking_number ?? null,
        deliveryCompany: codOrder.delivery_company ?? null,
        status,
        statusChangedAt: new Date(),
        rawOrderJson: JSON.parse(JSON.stringify(codOrder)) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    });
    result.ordersCreated++;
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

      const defaultCountryCode =
        (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
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
