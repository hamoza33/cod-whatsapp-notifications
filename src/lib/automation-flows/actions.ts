/**
 * Implementations of every {@link ActionKind}. Each `executeXxx` returns a
 * short human-readable summary string that the engine stores on the
 * matching `FlowRunStep.output` field — surfaced in the run-detail UI.
 *
 * Mutations to `context` are local; callers (engine) decide whether to
 * persist or refresh. Each handler is responsible for its own DB writes
 * (template send → `whatsapp_messages` row, status change → `orders`).
 */

import { prisma } from "../prisma";
import { WhatsAppClient } from "../whatsapp";
import { normalizePhoneNumber } from "../phone";
import { getSetting, SETTING_KEYS } from "../settings";
import { renderTemplate } from "./data-points";
import { detectCarrier } from "../tracking";
import {
  dateDaysAhead,
  formatDateInTimezone,
  scheduleImileDelivery,
} from "../imile-schedule";
import type { ActionNodeData, FlowExecutionContext } from "./types";
import { OrderStatus, TrackingCarrier, TrackingStatus } from "@prisma/client";

export interface ActionResult {
  output: string;
  /**
   * Returned by `wait`: the engine should pause execution and resume at
   * the action node's outgoing edge after this many milliseconds.
   */
  delayMs?: number;
  /** Returned by `stop`: the engine should stop walking the graph. */
  stop?: boolean;
}

export async function executeAction(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  switch (action.action) {
    case "send_template":
      return executeSendTemplate(action, context);
    case "send_text_message":
      return executeSendText(action, context);
    case "change_order_status":
      return executeChangeStatus(action, context);
    case "add_pipeline_note":
      return executeAddNote(action, context);
    case "pin_conversation":
      return executePin(context);
    case "queue_call_agent":
      return executeQueueCall(context);
    case "reschedule_imile":
      return executeRescheduleImile(action, context);
    case "wait":
      return executeWait(action);
    case "wait_for_reply":
      // The engine intercepts this case before calling executeAction
      // (it has to park the run + persist state across processes), so
      // reaching this branch means a misconfigured caller. Surface a
      // clear error instead of silently no-op-ing.
      throw new Error(
        "wait_for_reply is handled by the engine, not the action executor"
      );
    case "webhook":
      return executeWebhook(action, context);
    case "stop":
      return { output: "Flow stopped", stop: true };
    default:
      throw new Error(`Unknown action kind: ${(action as { action?: string }).action}`);
  }
}

async function executeSendTemplate(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  if (!action.templateName) {
    throw new Error("send_template: templateName is required");
  }
  const phone = context.order?.customerPhone ?? context.message?.fromPhone ?? null;
  if (!phone) {
    throw new Error("send_template: no recipient phone available in context");
  }

  const templateLanguage =
    action.templateLanguage ||
    (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE)) ||
    "en";
  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

  const client = await WhatsAppClient.fromSettings();

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhoneNumber(phone, defaultCountryCode);
  } catch {
    normalizedPhone = phone;
  }

  // Resolve variable slots with `{{token}}` substitution against the context.
  const variables = (action.templateVariables ?? []).map((slot) =>
    renderTemplate(slot ?? "", context)
  );

  const headerImage =
    action.templateHeaderImageUrl ||
    (await getSetting(SETTING_KEYS.WHATSAPP_DEFAULT_TEMPLATE_HEADER_IMAGE_URL));

  const result = await client.sendTemplate(
    normalizedPhone,
    action.templateName,
    templateLanguage,
    variables,
    headerImage
      ? { type: "image", value: headerImage, imageKind: "url" }
      : undefined
  );

  const storedPhone = normalizedPhone.startsWith("+")
    ? normalizedPhone
    : `+${normalizedPhone}`;

  try {
    await prisma.whatsappMessage.create({
      data: {
        orderId: context.order?.id ?? null,
        phoneNumber: storedPhone,
        templateName: action.templateName,
        templateLanguage,
        templateVariablesJson: variables,
        headerImageUrl: headerImage || null,
        providerMessageId: result.messages?.[0]?.id ?? null,
        status: "SENT",
        sentBy: "automation-flow",
        sentAt: new Date(),
      },
    });
    if (context.order) {
      await prisma.order.update({
        where: { id: context.order.id },
        data: { whatsappSentAt: new Date() },
      });
      context.order.whatsappSentAt = new Date();
    }
  } catch (dbErr) {
    console.error(
      "[automation-flow] failed to record outbound template message:",
      dbErr instanceof Error ? dbErr.message : dbErr
    );
  }

  return { output: `Sent template "${action.templateName}" → ${storedPhone}` };
}

async function executeSendText(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  const phone = context.order?.customerPhone ?? context.message?.fromPhone ?? null;
  if (!phone) {
    throw new Error("send_text_message: no recipient phone available in context");
  }
  const text = renderTemplate(action.text ?? "", context);
  if (!text.trim()) {
    throw new Error("send_text_message: text body is empty after rendering");
  }

  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
  const client = await WhatsAppClient.fromSettings();

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhoneNumber(phone, defaultCountryCode);
  } catch {
    normalizedPhone = phone;
  }

  // Free-form text messages only work inside an active 24-hour customer
  // service window (Meta limitation). Surface a clear error otherwise.
  await client.sendText(normalizedPhone, text);

  const storedPhone = normalizedPhone.startsWith("+")
    ? normalizedPhone
    : `+${normalizedPhone}`;

  return { output: `Sent text message → ${storedPhone} (${text.length} chars)` };
}

async function executeChangeStatus(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  if (!action.targetStatus) {
    throw new Error("change_order_status: targetStatus is required");
  }
  if (!context.order) {
    throw new Error("change_order_status: no order in context");
  }
  if (context.order.status === action.targetStatus) {
    return { output: `Order already in status ${action.targetStatus} — no-op` };
  }
  await prisma.order.update({
    where: { id: context.order.id },
    data: {
      status: action.targetStatus as OrderStatus,
      statusChangedAt: new Date(),
    },
  });
  context.order.status = action.targetStatus as OrderStatus;
  return { output: `Order status → ${action.targetStatus}` };
}

async function executeAddNote(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  if (!context.order) {
    throw new Error("add_pipeline_note: no order in context");
  }
  const note = renderTemplate(action.note ?? "", context).trim();
  if (!note) {
    throw new Error("add_pipeline_note: note is empty after rendering");
  }
  const existing = context.order.pipelineNote ?? "";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const next = existing
    ? `${existing}\n[${stamp}] ${note}`
    : `[${stamp}] ${note}`;
  await prisma.order.update({
    where: { id: context.order.id },
    data: { pipelineNote: next },
  });
  context.order.pipelineNote = next;
  return { output: `Appended pipeline note (${note.length} chars)` };
}

async function executePin(context: FlowExecutionContext): Promise<ActionResult> {
  const phone = context.order?.customerPhone ?? context.message?.fromPhone ?? null;
  if (!phone) {
    throw new Error("pin_conversation: no customer phone in context");
  }
  const stored = phone.startsWith("+") ? phone : `+${phone}`;
  await prisma.pinnedConversation.upsert({
    where: { phoneNumber: stored },
    update: {},
    create: { phoneNumber: stored },
  });
  return { output: `Pinned conversation ${stored}` };
}

async function executeQueueCall(context: FlowExecutionContext): Promise<ActionResult> {
  if (!context.order) {
    throw new Error("queue_call_agent: no order in context");
  }
  await prisma.order.update({
    where: { id: context.order.id },
    data: { callAgentQueued: true },
  });
  context.order.callAgentQueued = true;
  return { output: `Queued call agent for order ${context.order.codNetworkOrderId}` };
}

/**
 * Push an undelivered iMile parcel to a later delivery date.
 *
 * Guards, in order — all of them skip (rather than fail) so the action is
 * safe to drop into a flow that also sees non-iMile orders:
 *   1. order must have a tracking number
 *   2. carrier must resolve to iMile
 *   3. tracking status must not be DELIVERED/RETURNED (nothing to reschedule)
 *   4. the parcel must not already have been rescheduled earlier today
 *      — this is what keeps a daily sweep from re-booking on every tick
 */
async function executeRescheduleImile(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  const order = context.order;
  if (!order) {
    throw new Error("reschedule_imile: no order in context");
  }

  const trackingNumber =
    context.tracking?.trackingNumber?.trim() || order.trackingNumber?.trim() || null;
  if (!trackingNumber) {
    return { output: `Skipped: order ${order.codNetworkOrderId} has no tracking number` };
  }

  const carrier =
    context.tracking?.carrier ??
    detectCarrier(trackingNumber, order.deliveryCompany) ??
    null;
  if (carrier !== TrackingCarrier.IMILE) {
    return {
      output: `Skipped: ${trackingNumber} is not an iMile shipment (carrier: ${carrier ?? "unknown"})`,
    };
  }

  const trackingStatus = context.tracking?.status ?? null;
  if (
    trackingStatus === TrackingStatus.DELIVERED ||
    trackingStatus === TrackingStatus.RETURNED
  ) {
    return { output: `Skipped: ${trackingNumber} is already ${trackingStatus}` };
  }

  const timeZone = (await getSetting(SETTING_KEYS.AUTOMATION_TIMEZONE))?.trim() || null;
  const today = formatDateInTimezone(new Date(), timeZone);

  const alreadyToday =
    order.imileScheduledAt !== null &&
    order.imileScheduledAt !== undefined &&
    formatDateInTimezone(new Date(order.imileScheduledAt), timeZone) === today;
  if (alreadyToday) {
    return {
      output: `Skipped: ${trackingNumber} was already rescheduled today (for ${order.imileScheduledDate})`,
    };
  }

  const daysAhead = Math.max(1, Math.floor(action.rescheduleDaysAhead ?? 1));
  const targetDate = dateDaysAhead(daysAhead, timeZone);

  const result = await scheduleImileDelivery(trackingNumber, targetDate);
  if (!result.success) {
    const suggestion = result.suggestedDate
      ? ` (iMile suggested ${result.suggestedDate})`
      : "";
    throw new Error(
      `reschedule_imile: could not reschedule ${trackingNumber} to ${targetDate}: ${result.error}${suggestion}`
    );
  }

  const scheduledAt = new Date();
  await prisma.order.update({
    where: { id: order.id },
    data: { imileScheduledDate: result.scheduledDate, imileScheduledAt: scheduledAt },
  });
  order.imileScheduledDate = result.scheduledDate;
  order.imileScheduledAt = scheduledAt;

  // Expose the booked date to downstream nodes so the follow-up template can
  // interpolate it, e.g. "your parcel will be delivered on {{imile.scheduledDate}}".
  context.imile = {
    scheduledDate: result.scheduledDate,
    requestedDate: result.requestedDate,
    usedSuggestedDate: result.usedSuggestedDate,
    trackingNumber,
  };

  const note = result.usedSuggestedDate
    ? ` (requested ${result.requestedDate}, iMile gave ${result.scheduledDate})`
    : "";
  return {
    output: `Rescheduled iMile ${trackingNumber} to ${result.scheduledDate}${note}`,
  };
}

async function executeWait(action: ActionNodeData): Promise<ActionResult> {
  const secs = Math.max(0, Math.floor(action.waitSeconds ?? 0));
  return {
    output: `Wait ${secs}s`,
    delayMs: secs * 1000,
  };
}

async function executeWebhook(
  action: ActionNodeData,
  context: FlowExecutionContext
): Promise<ActionResult> {
  if (!action.webhookUrl) {
    throw new Error("webhook: webhookUrl is required");
  }
  const url = renderTemplate(action.webhookUrl, context);
  const method = (action.webhookMethod ?? "POST").toUpperCase();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (action.webhookHeadersJson) {
    try {
      const parsed = JSON.parse(action.webhookHeadersJson) as Record<string, string>;
      Object.assign(headers, parsed);
    } catch {
      // ignore malformed headers — log only
      console.warn("[automation-flow] webhook headersJson is not valid JSON, ignoring");
    }
  }
  let body: string | undefined;
  if (method !== "GET" && method !== "DELETE") {
    body = renderTemplate(
      action.webhookBodyTemplate || JSON.stringify({
        flow: true,
        trigger: context.trigger.type,
        orderId: context.order?.codNetworkOrderId ?? null,
        phone: context.order?.customerPhone ?? null,
      }),
      context
    );
  }
  const res = await fetch(url, { method, headers, body });
  return {
    output: `Webhook ${method} ${url} → HTTP ${res.status}`,
  };
}
