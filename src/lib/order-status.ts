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
/**
 * Forward progression of the pipeline. A generic COD Network status code may
 * move an order up this ladder but never down (see rule 4). Lead-stage
 * statuses all share rank 0 so leads can still move freely between them
 * before they're promoted into the order pipeline. Statuses absent from the
 * map (terminal ones) are always applied.
 */
const PIPELINE_RANK: Partial<Record<OrderStatus, number>> = {
  [OrderStatus.UNKNOWN]: 0,
  [OrderStatus.NEW]: 0,
  [OrderStatus.NO_REPLY]: 0,
  [OrderStatus.WRONG]: 0,
  [OrderStatus.EXPIRED]: 0,
  [OrderStatus.CALL_LATER]: 0,
  [OrderStatus.CALL_LATER_SCHEDULED]: 0,
  [OrderStatus.BLACK_LISTED]: 0,
  [OrderStatus.DELAYED]: 0,
  [OrderStatus.OUT_OF_STOCK]: 0,
  [OrderStatus.PENDING]: 1,
  [OrderStatus.CONFIRMED]: 2,
  [OrderStatus.PROCESSING]: 3,
  [OrderStatus.ASSIGNED]: 4,
  [OrderStatus.SHIPPED]: 5,
  [OrderStatus.OUT_FOR_DELIVERY]: 6,
};

const TERMINAL_STATUSES = new Set<OrderStatus>([
  OrderStatus.DELIVERED,
  OrderStatus.RETURNED,
  OrderStatus.CANCELLED,
  OrderStatus.CANCELLED_PRICE,
]);

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
  if (
    label === "cancelled price" ||
    label === "cancelled_price" ||
    label === "canceled price"
  ) {
    return OrderStatus.CANCELLED_PRICE;
  }

  // 1b. Lead-specific statuses from COD Network dashboard.
  if (label === "new" || label === "new lead" || label === "new_lead") {
    return OrderStatus.NEW;
  }
  if (
    label === "no reply" ||
    label === "no_reply" ||
    label === "noreply" ||
    label === "unanswered"
  ) {
    return OrderStatus.NO_REPLY;
  }
  if (label === "wrong" || label === "wrong lead" || label === "wrong number") {
    return OrderStatus.WRONG;
  }
  if (label === "expired" || label === "expire") {
    return OrderStatus.EXPIRED;
  }
  if (label === "call later" || label === "call_later" || label === "callback") {
    return OrderStatus.CALL_LATER;
  }
  if (
    label === "call later scheduled" ||
    label === "call_later_scheduled" ||
    label === "scheduled"
  ) {
    return OrderStatus.CALL_LATER_SCHEDULED;
  }
  if (label === "delayed") {
    return OrderStatus.DELAYED;
  }
  if (
    label === "black listed" ||
    label === "black_listed" ||
    label === "blacklisted"
  ) {
    return OrderStatus.BLACK_LISTED;
  }
  // 1c. Order-specific statuses.
  if (label === "assigned") {
    return OrderStatus.ASSIGNED;
  }
  if (label === "out of stock" || label === "out_of_stock") {
    return OrderStatus.OUT_OF_STOCK;
  }
  if (
    label === "return on process" ||
    label === "return_on_process"
  ) {
    return OrderStatus.RETURN_ON_PROCESS;
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
  //    upstream in `mapCodStatus`), but never walking the pipeline
  //    backwards. COD Network keeps reporting the pre-shipping label
  //    ("Pending") long after a courier picked the parcel up, so applying
  //    it verbatim made the row oscillate on every sync tick: rule 3 lifts
  //    it to OUT_FOR_DELIVERY, the next tick maps it back to PENDING, and
  //    every flip re-fires ORDER_STATUS_CHANGED automations. A generic code
  //    may only advance the order (or move it to a terminal state).
  if (input.mappedFromCode) {
    const mapped = input.mappedFromCode;
    if (previous && mapped !== previous) {
      if (TERMINAL_STATUSES.has(previous) && !TERMINAL_STATUSES.has(mapped)) {
        return previous;
      }
      const previousRank = PIPELINE_RANK[previous];
      const mappedRank = PIPELINE_RANK[mapped];
      if (
        previousRank !== undefined &&
        mappedRank !== undefined &&
        mappedRank < previousRank
      ) {
        return previous;
      }
    }
    return mapped;
  }

  // 5. Don't churn — keep the previous status.
  return previous ?? OrderStatus.UNKNOWN;
}
