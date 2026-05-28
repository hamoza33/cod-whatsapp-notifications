/**
 * Type definitions for the visual flow-builder automations.
 *
 * A flow is a directed graph of {@link FlowNode}s connected by
 * {@link FlowEdge}s. The graph itself is stored as JSON on
 * `AutomationFlow.graphJson` so the schema can evolve without migrations.
 *
 * The engine starts at the single Trigger node and walks the graph
 * forward, evaluating Condition nodes (which branch to one of two outgoing
 * edges based on truthiness) and executing Action nodes.
 */

import { OrderStatus, TrackingStatus } from "@prisma/client";

/** Top-level trigger event that causes a flow to fire. */
export type FlowTriggerType =
  | "ORDER_CREATED"
  | "ORDER_TRACKING_ASSIGNED"
  | "ORDER_STATUS_CHANGED"
  | "TRACKING_STATUS_CHANGED"
  | "MESSAGE_RECEIVED"
  | "MANUAL";

export const FLOW_TRIGGER_TYPES: ReadonlyArray<FlowTriggerType> = [
  "ORDER_CREATED",
  "ORDER_TRACKING_ASSIGNED",
  "ORDER_STATUS_CHANGED",
  "TRACKING_STATUS_CHANGED",
  "MESSAGE_RECEIVED",
  "MANUAL",
] as const;

/** Node shape stored inside `AutomationFlow.graphJson.nodes`. */
export interface FlowNode {
  id: string;
  /**
   * `nodeType` is the engine-level discriminator and lives inside `data`
   * (not the react-flow `type`, which is the visual variant — "trigger" /
   * "condition" / "action").
   */
  type: "trigger" | "condition" | "action";
  position: { x: number; y: number };
  data: FlowNodeData;
}

export type FlowNodeData =
  | TriggerNodeData
  | ConditionNodeData
  | ActionNodeData;

export interface TriggerNodeData {
  kind: "trigger";
  triggerType: FlowTriggerType;
  label?: string;
  /** Optional scope filters, e.g. only fire when status changes from→to. */
  fromStatus?: OrderStatus | null;
  toStatus?: OrderStatus | null;
  trackingFromStatus?: TrackingStatus | null;
  trackingToStatus?: TrackingStatus | null;
}

/**
 * Condition operators applied to the value of a data-point on the live
 * context. Operands beyond the field's stored value are taken from
 * {@link ConditionNodeData.value}.
 */
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "exists"
  | "not_exists"
  | "is_empty"
  | "is_not_empty";

export const CONDITION_OPERATORS: ReadonlyArray<ConditionOperator> = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "exists",
  "not_exists",
  "is_empty",
  "is_not_empty",
] as const;

export interface ConditionNodeData {
  kind: "condition";
  label?: string;
  /** Dot-path into the runtime context — see DATA_POINTS in data-points.ts. */
  field: string;
  operator: ConditionOperator;
  /**
   * Right-hand operand. String for most operators, comma-separated list for
   * `in` / `not_in`. Ignored by `exists` / `not_exists` / `is_empty` /
   * `is_not_empty`.
   */
  value?: string;
  /** Case sensitivity for string comparisons (default: insensitive). */
  caseSensitive?: boolean;
}

/** Action kind discriminator. */
export type ActionKind =
  | "send_template"
  | "send_text_message"
  | "change_order_status"
  | "add_pipeline_note"
  | "pin_conversation"
  | "queue_call_agent"
  | "wait"
  | "webhook"
  | "stop";

export const ACTION_KINDS: ReadonlyArray<ActionKind> = [
  "send_template",
  "send_text_message",
  "change_order_status",
  "add_pipeline_note",
  "pin_conversation",
  "queue_call_agent",
  "wait",
  "webhook",
  "stop",
] as const;

export interface ActionNodeData {
  kind: "action";
  action: ActionKind;
  label?: string;
  // send_template
  templateName?: string | null;
  templateLanguage?: string | null;
  templateVariables?: string[] | null;
  templateHeaderImageUrl?: string | null;
  // send_text_message
  text?: string | null;
  // change_order_status
  targetStatus?: OrderStatus | null;
  // add_pipeline_note
  note?: string | null;
  // wait
  waitSeconds?: number | null;
  // webhook
  webhookUrl?: string | null;
  webhookMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | null;
  webhookHeadersJson?: string | null;
  webhookBodyTemplate?: string | null;
}

/** Edge shape stored inside `AutomationFlow.graphJson.edges`. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Condition nodes have two output handles: `"true"` (taken when the
   * condition evaluates truthy) and `"false"` (otherwise). All other node
   * types have a single unnamed output handle.
   */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
}

/** Persisted shape of `AutomationFlow.graphJson`. */
export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

/**
 * Runtime context passed to every node during execution. Built from the
 * trigger payload + live DB lookups (latest tracking, message body, etc.).
 * Mutations to `context.order` during the run are persisted at the action
 * level (e.g. `change_order_status` updates `prisma.order` and refreshes
 * `context.order`).
 */
export interface FlowExecutionContext {
  trigger: {
    type: FlowTriggerType;
    /** When the trigger fired. */
    firedAt: Date;
    /** Optional structured payload for debugging. */
    payload?: Record<string, unknown>;
  };
  order: FlowOrderSnapshot | null;
  tracking: FlowTrackingSnapshot | null;
  customer: FlowCustomerSnapshot | null;
  message: FlowMessageSnapshot | null;
  time: {
    now: Date;
    hour: number;
    dayOfWeek: number; // 0=Sun, 6=Sat
  };
  /** Bag of variables set/read by action nodes via `set variable` (future). */
  vars: Record<string, string>;
}

export interface FlowOrderSnapshot {
  id: string;
  codNetworkOrderId: string;
  codNetworkLeadId: string | null;
  status: OrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  customerCity: string | null;
  customerAddress: string | null;
  productName: string | null;
  productPrice: string | null;
  productQuantity: string | null;
  trackingNumber: string | null;
  deliveryCompany: string | null;
  codDeliveryStatus: string | null;
  whatsappSentAt: Date | null;
  isManual: boolean;
  createdAt: Date;
  codCreatedAt: Date | null;
  pipelineNote: string | null;
  callAgentQueued: boolean;
}

export interface FlowTrackingSnapshot {
  trackingNumber: string;
  carrier: string;
  status: TrackingStatus;
  latestEvent: string | null;
  latestEventAt: Date | null;
}

export interface FlowCustomerSnapshot {
  phone: string;
  /** Total number of orders this customer has placed (across all statuses). */
  orderCount: number;
  /** Status of the customer's most recent order before the one that fired this trigger. */
  lastOrderStatus: OrderStatus | null;
  /** Total number of delivered orders. */
  deliveredCount: number;
}

export interface FlowMessageSnapshot {
  /** Inbound message text (if the trigger is MESSAGE_RECEIVED). */
  text: string | null;
  /** Inbound message type — `text`, `image`, `audio`, `video`, etc. */
  type: string | null;
  /** Customer phone number the message came from (normalized). */
  fromPhone: string | null;
}

/** One entry in `AutomationFlowRun.stepsJson`. */
export interface FlowRunStep {
  nodeId: string;
  nodeType: "trigger" | "condition" | "action";
  nodeKind: string;
  status: "success" | "failed" | "skipped";
  /** For condition nodes: which branch was taken. */
  branch?: "true" | "false";
  /** Human-readable summary of what the node did. */
  output?: string;
  error?: string;
  ranAt: string; // ISO date
}
