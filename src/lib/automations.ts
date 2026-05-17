import { OrderStatus, Automation, Order } from "@prisma/client";
import { prisma } from "./prisma";
import { WhatsAppClient } from "./whatsapp";
import { normalizePhoneNumber } from "./phone";
import { getSetting, SETTING_KEYS } from "./settings";

export interface AutomationTriggerOptions {
  /**
   * `true` skips actually sending WhatsApp messages and updating the order;
   * just records what would have happened. Used by the `/automations` UI's
   * "Preview" button.
   */
  dryRun?: boolean;
  /**
   * When provided, restricts the set of automations evaluated. Mainly used by
   * the dry-run preview to only show the impact of a single rule.
   */
  automationIds?: string[];
  /**
   * When true, only automations with `autoRun=true` will execute. Set to true
   * when triggering from sync/webhook/tracking (automatic triggers). When
   * false (manual "Run now"), all enabled automations run regardless.
   */
  autoTriggered?: boolean;
}

export interface AutomationRunSummary {
  automationId: string;
  automationName: string;
  orderId: string;
  status: "matched" | "skipped" | "applied" | "failed";
  reason?: string;
  movedFromStatus?: OrderStatus;
  movedToStatus?: OrderStatus;
  sentMessage?: boolean;
}

/**
 * Test whether the given Order matches the rule's `whenStatusEquals` +
 * product filters. Pure function — does not touch the database.
 */
export function matchesAutomation(
  automation: Pick<
    Automation,
    | "whenStatusEquals"
    | "andProductContains"
    | "andProductDoesNotContain"
    | "andPhoneStartsWith"
    | "andTrackingCondition"
    | "andCityContains"
    | "andCustomerNameContains"
    | "andMinPrice"
    | "andMaxPrice"
    | "andTrackingStatusContains"
    | "isEnabled"
  >,
  order: Pick<
    Order,
    | "status"
    | "productName"
    | "customerPhone"
    | "trackingNumber"
    | "customerCity"
    | "customerName"
    | "productPrice"
  >,
  context?: { latestTrackingEvent?: string | null }
): boolean {
  if (!automation.isEnabled) return false;

  if (
    automation.whenStatusEquals !== null &&
    automation.whenStatusEquals !== undefined &&
    order.status !== automation.whenStatusEquals
  ) {
    return false;
  }

  const productName = (order.productName ?? "").toLowerCase();
  if (automation.andProductContains) {
    if (!productName.includes(automation.andProductContains.toLowerCase())) {
      return false;
    }
  }
  if (automation.andProductDoesNotContain) {
    if (productName.includes(automation.andProductDoesNotContain.toLowerCase())) {
      return false;
    }
  }

  // Advanced condition: phone starts with
  if (automation.andPhoneStartsWith) {
    const phone = (order.customerPhone ?? "").replace(/\s+/g, "");
    const prefix = automation.andPhoneStartsWith.replace(/\s+/g, "");
    if (!phone.startsWith(prefix) && !phone.replace(/^\+/, "").startsWith(prefix.replace(/^\+/, ""))) {
      return false;
    }
  }

  // Advanced condition: tracking number exists / not exists
  if (automation.andTrackingCondition) {
    const hasTracking = !!(order.trackingNumber && order.trackingNumber.trim());
    if (automation.andTrackingCondition === "exists" && !hasTracking) {
      return false;
    }
    if (automation.andTrackingCondition === "not_exists" && hasTracking) {
      return false;
    }
  }

  // Advanced condition: city contains
  if (automation.andCityContains) {
    const city = (order.customerCity ?? "").toLowerCase();
    if (!city.includes(automation.andCityContains.toLowerCase())) {
      return false;
    }
  }

  // Advanced condition: customer name contains
  if (automation.andCustomerNameContains) {
    const name = (order.customerName ?? "").toLowerCase();
    if (!name.includes(automation.andCustomerNameContains.toLowerCase())) {
      return false;
    }
  }

  // Advanced condition: min price
  if (automation.andMinPrice) {
    const price = parseFloat(order.productPrice ?? "0");
    const min = parseFloat(automation.andMinPrice);
    if (!isNaN(min) && (isNaN(price) || price < min)) {
      return false;
    }
  }

  // Advanced condition: max price
  if (automation.andMaxPrice) {
    const price = parseFloat(order.productPrice ?? "0");
    const max = parseFloat(automation.andMaxPrice);
    if (!isNaN(max) && (isNaN(price) || price > max)) {
      return false;
    }
  }

  // Advanced condition: tracking status contains
  if (automation.andTrackingStatusContains) {
    const trackingEvent = (context?.latestTrackingEvent ?? "").toLowerCase();
    if (!trackingEvent.includes(automation.andTrackingStatusContains.toLowerCase())) {
      return false;
    }
  }

  return true;
}

/**
 * Variable tokens an operator can use in `Automation.thenSendTemplateVariables`.
 * Each token resolves to a value pulled from the Order being processed. Any
 * token not in this map is left literally (so static strings just pass through).
 */
const ORDER_VARIABLE_TOKENS = [
  "{customer_name}",
  "{phone}",
  "{city}",
  "{product}",
  "{price}",
  "{quantity}",
  "{tracking}",
  "{order_id}",
  "{lead_id}",
  "{delivery_company}",
  "{tracking_status}",
] as const;

export type AutomationVariableToken = (typeof ORDER_VARIABLE_TOKENS)[number];

export const AVAILABLE_AUTOMATION_TOKENS: ReadonlyArray<AutomationVariableToken> =
  ORDER_VARIABLE_TOKENS;

function resolveVariableToken(token: string, order: Order, ctx?: { trackingStatus?: string }): string {
  switch (token) {
    case "{customer_name}":
      return order.customerName || "Customer";
    case "{phone}":
      return order.customerPhone || "";
    case "{city}":
      return order.customerCity || "";
    case "{product}":
      return order.productName || "";
    case "{price}":
      return order.productPrice || "";
    case "{quantity}":
      return order.productQuantity || "";
    case "{tracking}":
      return order.trackingNumber || "";
    case "{order_id}":
      return order.codNetworkOrderId;
    case "{lead_id}":
      return order.codNetworkLeadId || "";
    case "{delivery_company}":
      return order.deliveryCompany || "";
    case "{tracking_status}":
      return ctx?.trackingStatus || "";
    default:
      return token;
  }
}

/**
 * Build the body variables for a template send triggered by an automation.
 * Uses positional `{{1}}`, `{{2}}` style — Meta templates have no named
 * params at the API layer. The defaults mirror the variable chips exposed
 * in the Pipeline → Send dialog so operators can match the order of values
 * to their template's body text.
 */
function buildVariablesForOrder(automation: Automation, order: Order, ctx?: { trackingStatus?: string }): string[] {
  // If the operator configured explicit variable slots, resolve any
  // `{token}` placeholders against the order. Each non-token slot is passed
  // through verbatim (operators can mix literals + tokens, e.g.
  // ["Order", "{order_id}"]).
  const configured = automation.thenSendTemplateVariables as
    | string[]
    | null
    | undefined;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((slot) => {
      if (typeof slot !== "string") return "";
      // Replace every known {token} occurrence in the slot — supports both
      // pure-token slots ("{customer_name}") and embedded ("Hello {customer_name}").
      let out = slot;
      for (const t of ORDER_VARIABLE_TOKENS) {
        if (out.includes(t)) {
          out = out.split(t).join(resolveVariableToken(t, order, ctx));
        }
      }
      return out;
    });
  }

  // Legacy default: "customer name, order id" — matches the `kuwait_ezihear_no_reply`
  // template we tested with end-to-end.
  return [order.customerName || "Customer", order.codNetworkOrderId];
}

/**
 * Evaluate every enabled automation against the given order and apply the
 * matching ones (or merely report them when `dryRun` is true).
 *
 * Called from:
 *   1. `PATCH /api/orders/:id` after a manual status change in the Pipeline
 *   2. The sync pipeline whenever a synced order changes status
 *   3. The COD Network webhooks (`/api/cod-network/webhook/{leads,orders}`)
 *
 * Returns a list of summaries the caller can surface to the UI / logs.
 */
export async function runAutomationsForOrder(
  orderId: string,
  options: AutomationTriggerOptions = {}
): Promise<AutomationRunSummary[]> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return [];

  // Fetch the latest tracking event for this order so tracking-status
  // conditions and the {tracking_status} template variable work.
  const latestTracking = await prisma.trackingOrder.findFirst({
    where: { orderId },
    orderBy: { updatedAt: "desc" },
    select: { latestEvent: true },
  });
  const trackingCtx = {
    latestTrackingEvent: latestTracking?.latestEvent ?? null,
    trackingStatus: latestTracking?.latestEvent ?? undefined,
  };

  const automations = await prisma.automation.findMany({
    where: {
      isEnabled: true,
      ...(options.automationIds && options.automationIds.length > 0
        ? { id: { in: options.automationIds } }
        : {}),
      ...(options.autoTriggered ? { autoRun: true } : {}),
    },
  });

  const summaries: AutomationRunSummary[] = [];

  for (const automation of automations) {
    if (!matchesAutomation(automation, order, trackingCtx)) {
      summaries.push({
        automationId: automation.id,
        automationName: automation.name,
        orderId: order.id,
        status: "skipped",
        reason: "filters do not match",
      });
      continue;
    }

    // De-dupe: if `thenSendOnce` is on and we already have a *successful* run
    // for this (automation, order) pair, skip. Failed runs do NOT block retries.
    if (automation.thenSendOnce) {
      const existingRun = await prisma.automationRun.findUnique({
        where: {
          automationId_orderId: {
            automationId: automation.id,
            orderId: order.id,
          },
        },
      });
      if (existingRun && existingRun.status === "success") {
        summaries.push({
          automationId: automation.id,
          automationName: automation.name,
          orderId: order.id,
          status: "skipped",
          reason: `already ran successfully on ${existingRun.createdAt.toISOString()}`,
        });
        continue;
      }
    }

    const movedFromStatus = order.status;
    let movedToStatus: OrderStatus | undefined;
    let sentMessage = false;
    let errorMessage: string | undefined;

    try {
      if (
        automation.thenMoveToStatus &&
        automation.thenMoveToStatus !== order.status
      ) {
        movedToStatus = automation.thenMoveToStatus;
        if (!options.dryRun) {
          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: automation.thenMoveToStatus,
              statusChangedAt: new Date(),
            },
          });
          // Reflect locally so subsequent template sending uses fresh status
          order.status = automation.thenMoveToStatus;
        }
      }

      if (automation.thenSendTemplateName && order.customerPhone) {
        if (!options.dryRun) {
          await sendAutomationTemplate(automation, order, trackingCtx);
        }
        sentMessage = true;
      }

      if (!options.dryRun) {
        await prisma.automationRun.upsert({
          where: {
            automationId_orderId: {
              automationId: automation.id,
              orderId: order.id,
            },
          },
          update: {
            status: "success",
            movedFromStatus,
            movedToStatus: movedToStatus ?? null,
            sentMessage,
            errorMessage: null,
            createdAt: new Date(),
          },
          create: {
            automationId: automation.id,
            orderId: order.id,
            status: "success",
            movedFromStatus,
            movedToStatus: movedToStatus ?? null,
            sentMessage,
          },
        });

        if (sentMessage) {
          await prisma.order.update({
            where: { id: order.id },
            data: { whatsappSentAt: new Date() },
          });
        }
      }

      summaries.push({
        automationId: automation.id,
        automationName: automation.name,
        orderId: order.id,
        status: "applied",
        movedFromStatus,
        movedToStatus,
        sentMessage,
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[automations] automation "${automation.name}" failed for order ${order.codNetworkOrderId}:`,
        errorMessage
      );
      if (!options.dryRun) {
        try {
          await prisma.automationRun.upsert({
            where: {
              automationId_orderId: {
                automationId: automation.id,
                orderId: order.id,
              },
            },
            update: {
              status: "failed",
              movedFromStatus,
              movedToStatus: movedToStatus ?? null,
              sentMessage,
              errorMessage,
              createdAt: new Date(),
            },
            create: {
              automationId: automation.id,
              orderId: order.id,
              status: "failed",
              movedFromStatus,
              movedToStatus: movedToStatus ?? null,
              sentMessage,
              errorMessage,
            },
          });
        } catch (logErr) {
          console.error("[automations] failed to record run", logErr);
        }
      }
      summaries.push({
        automationId: automation.id,
        automationName: automation.name,
        orderId: order.id,
        status: "failed",
        reason: errorMessage,
        movedFromStatus,
        movedToStatus,
        sentMessage,
      });
    }
  }

  return summaries;
}

async function sendAutomationTemplate(
  automation: Automation,
  order: Order,
  ctx?: { trackingStatus?: string }
): Promise<void> {
  if (!automation.thenSendTemplateName) return;
  if (!order.customerPhone) {
    throw new Error("order has no customer phone");
  }

  const templateLanguage =
    automation.thenSendTemplateLanguage ||
    (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE)) ||
    "en";
  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

  const client = await WhatsAppClient.fromSettings();
  const variables = buildVariablesForOrder(automation, order, ctx);
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhoneNumber(order.customerPhone, defaultCountryCode);
  } catch {
    normalizedPhone = order.customerPhone;
  }

  // Header image: per-automation override wins, then the global Settings
  // default. Operators with IMAGE-header templates can pin a default once
  // and each automation can still override.
  const headerImage =
    automation.thenSendHeaderImageUrl ||
    (await getSetting(SETTING_KEYS.WHATSAPP_DEFAULT_TEMPLATE_HEADER_IMAGE_URL));

  const result = await client.sendTemplate(
    normalizedPhone,
    automation.thenSendTemplateName,
    templateLanguage,
    variables,
    headerImage
      ? { type: "image", value: headerImage, imageKind: "url" }
      : undefined
  );

  await prisma.whatsappMessage.create({
    data: {
      orderId: order.id,
      phoneNumber: normalizedPhone,
      templateName: automation.thenSendTemplateName,
      templateLanguage,
      templateVariablesJson: variables,
      headerImageUrl: headerImage || null,
      providerMessageId: result.messages?.[0]?.id ?? null,
      status: "SENT",
      sentBy: `automation:${automation.id}`,
      sentAt: new Date(),
    },
  });
}

/**
 * Auto-expire orders that have been PENDING or in transit for >25 days.
 * Moves them to EXPIRED status. Called periodically (e.g., during sync).
 */
export async function autoExpireOrders(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 25);

  const result = await prisma.order.updateMany({
    where: {
      status: {
        in: [
          OrderStatus.PENDING,
          OrderStatus.CONFIRMED,
          OrderStatus.PROCESSING,
          OrderStatus.SHIPPED,
          OrderStatus.OUT_FOR_DELIVERY,
          OrderStatus.NEW,
          OrderStatus.NO_REPLY,
          OrderStatus.CALL_LATER,
        ],
      },
      codCreatedAt: { lt: cutoff },
    },
    data: { status: OrderStatus.EXPIRED },
  });

  return result.count;
}

/**
 * @deprecated Use per-automation `autoRun` field instead.
 * Kept for backward compatibility — now always returns true so
 * callers fall through to the per-automation filter in
 * runAutomationsForOrder({ autoTriggered: true }).
 */
export async function isAutoRunEnabled(): Promise<boolean> {
  return true;
}
