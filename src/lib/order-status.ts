import { OrderStatus } from "@prisma/client";

/**
 * Derive an effective OrderStatus from the raw COD Network signal — which
 * may arrive via the seller orders endpoint, a lead webhook, or an order
 * status webhook. The user explicitly asked for this behavior:
 *
 *   "if the tracking number was added it need the orders to moved
 *    automatically to OUT_FOR_DELIVERY pipeline, and if delivered move
 *    it to DELIVERED, if returned move it to RETURNED pipeline"
 *
 * Inputs are intentionally generous — most fields are optional and we
 * fall back to the previously-known status when no signal is strong
 * enough.
 *
 * Signal strength order (strongest first):
 *   1. Explicit terminal status string ("delivered", "returned", "cancelled")
 *   2. Explicit "out for delivery" status string
 *   3. Tracking number present + previous status ≤ SHIPPED → OUT_FOR_DELIVERY
 *   4. Mapped status from the per-status integer code map
 *   5. Previous status (no-op)
 */
export function deriveOrderStatus(input: {
  rawStatusLabel?: string | null;
  trackingStatus?: string | null;
  trackingNumber?: string | null;
  mappedFromCode?: OrderStatus | null;
  previousStatus?: OrderStatus | null;
}): OrderStatus {
  const previous = input.previousStatus ?? null;
  const label = (input.rawStatusLabel ?? "").trim().toLowerCase();
  const trackingStatus = (input.trackingStatus ?? "").trim().toLowerCase();
  const trackingNumber = (input.trackingNumber ?? "").trim();

  // 1. Terminal status takes priority over anything else.
  if (
    label === "delivered" ||
    trackingStatus === "delivered" ||
    label === "completed" ||
    label === "complete"
  ) {
    return OrderStatus.DELIVERED;
  }
  if (
    label === "returned" ||
    label === "return" ||
    trackingStatus === "returned" ||
    trackingStatus.includes("return")
  ) {
    return OrderStatus.RETURNED;
  }
  if (label === "cancelled" || label === "canceled" || label === "cancel") {
    return OrderStatus.CANCELLED;
  }

  // 2. Explicit out-for-delivery signal.
  if (
    label.includes("out for delivery") ||
    label === "out_for_delivery" ||
    trackingStatus.includes("out for delivery") ||
    (trackingStatus.includes("out") && trackingStatus.includes("delivery"))
  ) {
    return OrderStatus.OUT_FOR_DELIVERY;
  }

  // 3. Tracking-number-triggered transition. Once a courier picks up the
  //    package, the order becomes OUT_FOR_DELIVERY — but only if the
  //    previous status was earlier in the pipeline (don't downgrade from
  //    DELIVERED back to OUT_FOR_DELIVERY just because the tracking number
  //    field is still populated).
  if (trackingNumber.length > 0) {
    const earlierThanOFD =
      previous === null ||
      previous === OrderStatus.PENDING ||
      previous === OrderStatus.CONFIRMED ||
      previous === OrderStatus.PROCESSING ||
      previous === OrderStatus.SHIPPED ||
      previous === OrderStatus.UNKNOWN;
    if (earlierThanOFD) {
      return OrderStatus.OUT_FOR_DELIVERY;
    }
  }

  // 4. Generic status mapping from the integer code map (already done
  //    upstream in `mapCodStatus`).
  if (input.mappedFromCode) {
    return input.mappedFromCode;
  }

  // 5. Don't churn — keep the previous status.
  return previous ?? OrderStatus.UNKNOWN;
}
