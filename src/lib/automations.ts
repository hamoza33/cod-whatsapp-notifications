import { Prisma, OrderStatus, Automation, Order } from "@prisma/client";
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
    | "isEnabled"
  >,
  order: Pick<Order, "status" | "productName">
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
  return true;
}

/**
 * Build the body variables for a template send triggered by an automation.
 * Uses positional `{{1}}`, `{{2}}` style — Meta templates have no named
 * params at the API layer. The defaults mirror the variable chips exposed
 * in the Pipeline → Send dialog so operators can match the order of values
 * to their template's body text.
 */
function buildVariablesForOrder(order: Order): string[] {
  // Defaults to "customer name, order id" which fits most operator templates
  // (including the `kuwait_ezihear_no_reply` we tested with).
  return [
    order.customerName || "Customer",
    order.codNetworkOrderId,
  ];
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

  const automations = await prisma.automation.findMany({
    where: {
      isEnabled: true,
      ...(options.automationIds && options.automationIds.length > 0
        ? { id: { in: options.automationIds } }
        : {}),
    },
  });

  const summaries: AutomationRunSummary[] = [];

  for (const automation of automations) {
    if (!matchesAutomation(automation, order)) {
      summaries.push({
        automationId: automation.id,
        automationName: automation.name,
        orderId: order.id,
        status: "skipped",
        reason: "filters do not match",
      });
      continue;
    }

    // De-dupe: if `thenSendOnce` is on and we already have a successful run
    // for this (automation, order) pair, skip silently.
    if (automation.thenSendOnce) {
      const existingRun = await prisma.automationRun.findUnique({
        where: {
          automationId_orderId: {
            automationId: automation.id,
            orderId: order.id,
          },
        },
      });
      if (existingRun) {
        summaries.push({
          automationId: automation.id,
          automationName: automation.name,
          orderId: order.id,
          status: "skipped",
          reason: `already ran on ${existingRun.createdAt.toISOString()}`,
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
          await sendAutomationTemplate(automation, order);
        }
        sentMessage = true;
      }

      if (!options.dryRun) {
        await prisma.automationRun.create({
          data: {
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
      if (!options.dryRun) {
        // Record the failed attempt so we don't infinitely retry on the next
        // status flip. `thenSendOnce` will treat any existing row as "ran".
        try {
          await prisma.automationRun.create({
            data: {
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
          // P2002 unique violation = a previous failed run already exists.
          // That's fine — fall through.
          if (
            !(
              logErr instanceof Prisma.PrismaClientKnownRequestError &&
              logErr.code === "P2002"
            )
          ) {
            console.error("[automations] failed to record run", logErr);
          }
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
  order: Order
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
  const variables = buildVariablesForOrder(order);
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhoneNumber(order.customerPhone, defaultCountryCode);
  } catch {
    normalizedPhone = order.customerPhone;
  }

  // Optional default header image — same setting used by the Test Message
  // UI. Operators with IMAGE-header templates set this once globally and
  // every automation send picks it up.
  const defaultHeaderImage = await getSetting(
    SETTING_KEYS.WHATSAPP_DEFAULT_TEMPLATE_HEADER_IMAGE_URL
  );

  const result = await client.sendTemplate(
    normalizedPhone,
    automation.thenSendTemplateName,
    templateLanguage,
    variables,
    defaultHeaderImage
      ? { type: "image", value: defaultHeaderImage, imageKind: "url" }
      : undefined
  );

  await prisma.whatsappMessage.create({
    data: {
      orderId: order.id,
      phoneNumber: normalizedPhone,
      templateName: automation.thenSendTemplateName,
      templateLanguage,
      templateVariablesJson: variables,
      providerMessageId: result.messages?.[0]?.id ?? null,
      status: "SENT",
      sentBy: `automation:${automation.id}`,
      sentAt: new Date(),
    },
  });
}
