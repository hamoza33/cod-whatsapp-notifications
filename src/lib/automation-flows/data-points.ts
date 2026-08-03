/**
 * The single source of truth for every data point an operator can use
 * inside Condition nodes and as `{{token}}` substitutions inside template
 * variables, message bodies, webhook bodies, and notes.
 *
 * Each entry declares:
 *   - `path`: dot-notation key into `FlowExecutionContext` (e.g.
 *     `order.customerPhone`). The path doubles as the unique id used in
 *     `ConditionNodeData.field` and as the `{{token}}` name.
 *   - `label`: human-readable name for the UI dropdowns.
 *   - `group`: UI grouping ("Order", "Tracking", "Customer", "Message",
 *     "Time").
 *   - `type`: tells the inspector which operators to offer and how to
 *     parse the right-hand operand.
 *   - `sampleOptions`: optional enum-style choices the UI surfaces as a
 *     dropdown instead of a free-text input.
 */

import { OrderStatus, TrackingStatus } from "@prisma/client";
import type { FlowExecutionContext } from "./types";

export type DataPointType = "string" | "number" | "boolean" | "date" | "enum";

export interface DataPoint {
  path: string;
  label: string;
  group: "Order" | "Tracking" | "Customer" | "Message" | "Time";
  type: DataPointType;
  sampleOptions?: string[];
  /**
   * Description shown as helper text under the field selector. Kept
   * intentionally short.
   */
  description?: string;
}

const ORDER_STATUS_OPTIONS = Object.values(OrderStatus);
const TRACKING_STATUS_OPTIONS = Object.values(TrackingStatus);

export const DATA_POINTS: ReadonlyArray<DataPoint> = [
  // -------------------- Order --------------------
  {
    path: "order.status",
    label: "Order status",
    group: "Order",
    type: "enum",
    sampleOptions: ORDER_STATUS_OPTIONS,
  },
  {
    path: "order.customerPhone",
    label: "Customer phone",
    group: "Order",
    type: "string",
    description: "Normalized E.164 string (e.g. +21261…).",
  },
  {
    path: "order.customerName",
    label: "Customer name",
    group: "Order",
    type: "string",
  },
  {
    path: "order.customerCity",
    label: "Customer city",
    group: "Order",
    type: "string",
  },
  {
    path: "order.customerAddress",
    label: "Customer address",
    group: "Order",
    type: "string",
  },
  {
    path: "order.productName",
    label: "Product name",
    group: "Order",
    type: "string",
  },
  {
    path: "order.productPrice",
    label: "Product price",
    group: "Order",
    type: "number",
    description: "Stored as string by COD Network — coerced for gt/lt comparisons.",
  },
  {
    path: "order.productQuantity",
    label: "Product quantity",
    group: "Order",
    type: "number",
  },
  {
    path: "order.trackingNumber",
    label: "Tracking number",
    group: "Order",
    type: "string",
  },
  {
    path: "order.deliveryCompany",
    label: "Delivery company",
    group: "Order",
    type: "string",
    sampleOptions: ["IMILE", "INJAZ", "JTE", "JDW", "NAQEL", "OTHER"],
  },
  {
    path: "order.codDeliveryStatus",
    label: "Raw COD delivery status",
    group: "Order",
    type: "string",
    description: "The exact string COD Network returned (e.g. 'out for delivery').",
  },
  {
    path: "order.codNetworkOrderId",
    label: "Order ID",
    group: "Order",
    type: "string",
  },
  {
    path: "order.codNetworkLeadId",
    label: "Lead ID",
    group: "Order",
    type: "string",
  },
  {
    path: "order.isManual",
    label: "Is manual order",
    group: "Order",
    type: "boolean",
  },
  {
    path: "order.ageDays",
    label: "Order age (days)",
    group: "Order",
    type: "number",
    description:
      "Whole days since the order was created. Use with lte/lt, e.g. \"order age ≤ 2\" targets orders made within the last 2 days.",
  },
  {
    path: "order.whatsappSentAt",
    label: "WhatsApp message sent",
    group: "Order",
    type: "date",
    description: "Null if no message has ever been sent for this order.",
  },
  {
    path: "order.pipelineNote",
    label: "Pipeline note",
    group: "Order",
    type: "string",
  },
  {
    path: "order.callAgentQueued",
    label: "Call agent queued",
    group: "Order",
    type: "boolean",
  },
  // -------------------- Tracking --------------------
  {
    path: "tracking.status",
    label: "Tracking status",
    group: "Tracking",
    type: "enum",
    sampleOptions: TRACKING_STATUS_OPTIONS,
  },
  {
    path: "tracking.latestEvent",
    label: "Tracking latest event",
    group: "Tracking",
    type: "string",
    description: "Free-text description of the most recent tracking event.",
  },
  {
    path: "tracking.carrier",
    label: "Tracking carrier",
    group: "Tracking",
    type: "enum",
    sampleOptions: ["IMILE", "INJAZ", "JTE", "JDW", "NAQEL", "OTHER"],
  },
  {
    path: "tracking.trackingNumber",
    label: "Tracking number (carrier)",
    group: "Tracking",
    type: "string",
  },
  // -------------------- Customer --------------------
  {
    path: "customer.orderCount",
    label: "Customer total orders",
    group: "Customer",
    type: "number",
    description: "Lifetime number of orders this phone has placed.",
  },
  {
    path: "customer.deliveredCount",
    label: "Customer delivered orders",
    group: "Customer",
    type: "number",
  },
  {
    path: "customer.lastOrderStatus",
    label: "Customer last order status",
    group: "Customer",
    type: "enum",
    sampleOptions: ORDER_STATUS_OPTIONS,
    description: "Status of the customer's previous order (not the one that triggered this flow).",
  },
  // -------------------- Message --------------------
  {
    path: "message.text",
    label: "Incoming message text",
    group: "Message",
    type: "string",
    description: "Body of the inbound WhatsApp message that fired the trigger.",
  },
  {
    path: "message.type",
    label: "Incoming message type",
    group: "Message",
    type: "enum",
    sampleOptions: ["text", "image", "video", "audio", "document", "sticker"],
  },
  {
    path: "message.fromPhone",
    label: "Incoming message from phone",
    group: "Message",
    type: "string",
  },
  // -------------------- Time --------------------
  {
    path: "time.hour",
    label: "Hour of day (0–23)",
    group: "Time",
    type: "number",
  },
  {
    path: "time.minute",
    label: "Minute of hour (0–59)",
    group: "Time",
    type: "number",
  },
  {
    path: "time.dayOfWeek",
    label: "Day of week (0=Sun..6=Sat)",
    group: "Time",
    type: "number",
  },
];

/**
 * Resolve a dot-path against the live execution context. Returns `null`
 * when any segment is missing/null. Numbers stored as strings (e.g.
 * `order.productPrice`) are returned as-is — the operator implementation
 * coerces when needed.
 */
export function resolveDataPoint(
  context: FlowExecutionContext,
  path: string
): unknown {
  const segments = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let value: any = context;
  for (const seg of segments) {
    if (value === null || value === undefined) return null;
    value = value[seg];
  }
  return value ?? null;
}

/** Look up a DataPoint by its dot-path. */
export function getDataPoint(path: string): DataPoint | undefined {
  return DATA_POINTS.find((dp) => dp.path === path);
}

/** Group data points by their UI group for the inspector dropdown. */
export function groupDataPoints(): Record<string, DataPoint[]> {
  const groups: Record<string, DataPoint[]> = {};
  for (const dp of DATA_POINTS) {
    if (!groups[dp.group]) groups[dp.group] = [];
    groups[dp.group].push(dp);
  }
  return groups;
}

/**
 * Replace every `{{path}}` token in `template` with the resolved value
 * from `context`. Missing/null tokens become an empty string (mirrors the
 * "missing variable = empty" semantics in bulk-messaging).
 */
export function renderTemplate(template: string, context: FlowExecutionContext): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_full, path: string) => {
    const value = resolveDataPoint(context, path);
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString();
    return String(value);
  });
}
