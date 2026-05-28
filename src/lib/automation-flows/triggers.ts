/**
 * Convenience wrappers around `runFlowsForTrigger`, used by the existing
 * trigger emission points (sync, COD webhook, tracking refresh, WhatsApp
 * webhook). Each wrapper is fire-and-forget — failures are logged but do
 * not propagate to the caller, mirroring the existing
 * `runAutomationsForOrder` semantics.
 */

import { OrderStatus } from "@prisma/client";
import {
  runFlowsForTrigger,
  buildContextForOrder,
  buildContextForInboundMessage,
} from "./engine";

export async function fireOrderCreatedFlows(orderId: string): Promise<void> {
  await runFlowsForTrigger(
    "ORDER_CREATED",
    () =>
      buildContextForOrder(orderId, {
        type: "ORDER_CREATED",
        firedAt: new Date(),
      })
  );
}

/**
 * Fires when an order is observed to have a tracking number for the first
 * time — either at creation (if tracking is already present) or on the
 * first sync/webhook update that fills in a previously-empty tracking
 * field. Use this when an automation depends on `order.trackingNumber`
 * being non-empty (e.g. "send the courier-tracking link to the customer").
 *
 * The `ORDER_CREATED` trigger fires unconditionally on every newly-synced
 * order, so for orders where tracking arrives in a later sync the
 * tracking-number condition would otherwise evaluate `false` at fire time
 * and the flow would silently skip the action. Wiring a separate trigger
 * keeps `ORDER_CREATED` semantics intact while still letting the operator
 * react to the "tracking just appeared" moment.
 */
export async function fireOrderTrackingAssignedFlows(
  orderId: string
): Promise<void> {
  await runFlowsForTrigger(
    "ORDER_TRACKING_ASSIGNED",
    () =>
      buildContextForOrder(orderId, {
        type: "ORDER_TRACKING_ASSIGNED",
        firedAt: new Date(),
      })
  );
}

export async function fireOrderStatusChangedFlows(
  orderId: string,
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus
): Promise<void> {
  await runFlowsForTrigger(
    "ORDER_STATUS_CHANGED",
    () =>
      buildContextForOrder(orderId, {
        type: "ORDER_STATUS_CHANGED",
        firedAt: new Date(),
        payload: { fromStatus, toStatus },
      }),
    { fromStatus, toStatus }
  );
}

export async function fireTrackingStatusChangedFlows(
  orderId: string,
  fromStatus: string | null,
  toStatus: string
): Promise<void> {
  await runFlowsForTrigger(
    "TRACKING_STATUS_CHANGED",
    () =>
      buildContextForOrder(orderId, {
        type: "TRACKING_STATUS_CHANGED",
        firedAt: new Date(),
        payload: { fromStatus, toStatus },
      }),
    { trackingFromStatus: fromStatus, trackingToStatus: toStatus }
  );
}

export async function fireMessageReceivedFlows(args: {
  fromPhone: string;
  text: string | null;
  messageType: string | null;
  matchedOrderId: string | null;
}): Promise<void> {
  await runFlowsForTrigger("MESSAGE_RECEIVED", async () =>
    buildContextForInboundMessage(
      args.fromPhone,
      args.text,
      args.messageType,
      args.matchedOrderId,
      { type: "MESSAGE_RECEIVED", firedAt: new Date(), payload: { fromPhone: args.fromPhone } }
    )
  );
}

/**
 * Safe wrapper used by call sites — wraps the call in a try/catch and
 * logs (never throws). Returns a promise that resolves on completion.
 */
export function safeFireFlows(
  promise: Promise<void>,
  label: string
): Promise<void> {
  return promise.catch((err) => {
    console.error(
      `[automation-flow] ${label} failed:`,
      err instanceof Error ? err.message : err
    );
  });
}
