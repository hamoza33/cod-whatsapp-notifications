/**
 * The flow execution engine. Walks the graph forward from the trigger,
 * evaluates Condition nodes (branching on the boolean result), executes
 * Action nodes, and records a per-node timeline on
 * `AutomationFlowRun.stepsJson`.
 *
 * Termination conditions:
 *   1. Reach a node with no outgoing edge → finish (`SUCCESS`).
 *   2. Hit an `action.stop` node → finish (`STOPPED`).
 *   3. An action throws → finish (`FAILED`) and record the error.
 *   4. Hit a `wait_for_reply` action → park the run (`WAITING`). A row
 *      is inserted into `automation_flow_waits` keyed by the customer's
 *      phone; the WhatsApp webhook resumes the run from the matched
 *      branch when the next inbound message arrives.
 *
 * For `action.wait`, the engine sleeps in-process using `setTimeout` and
 * then continues. The runner is in-process (same model as the existing
 * automations + bulk-messaging), so very long waits are best avoided —
 * but waits up to a few minutes survive fine.
 */

import { prisma } from "../prisma";
import type { AutomationFlow } from "@prisma/client";
import { OrderStatus, Prisma } from "@prisma/client";
import {
  FlowGraph,
  FlowNode,
  FlowEdge,
  FlowExecutionContext,
  FlowRunStep,
  FlowTriggerType,
  ConditionNodeData,
  ActionNodeData,
  TriggerNodeData,
} from "./types";
import { evaluateCondition } from "./conditions";
import { executeAction } from "./actions";
import { getSetting, SETTING_KEYS } from "../settings";
import {
  collectProductKeys,
  matchCatalogProducts,
} from "../product-matching";

/**
 * SKUs for an order: those spelled out in the COD Network payload plus the
 * SKUs of catalog products the order's product string matches (COD Network
 * often sends only names, and bundles several products into one string).
 */
async function resolveProductSkus(
  productName: string | null,
  rawOrderJson: unknown
): Promise<string | null> {
  const skus = new Set(collectProductKeys(productName, rawOrderJson).skus);
  const catalog = await prisma.product.findMany({
    select: { name: true, nameArabic: true, sku: true },
  });
  for (const product of matchCatalogProducts(catalog, productName, rawOrderJson)) {
    if (product.sku && product.sku.trim()) skus.add(product.sku.trim());
  }
  return skus.size > 0 ? Array.from(skus).join(", ") : null;
}

/**
 * Current time broken down in the configured automation timezone
 * (Settings → Automation → Timezone, default UTC). Used so `time.hour` /
 * `time.minute` conditions match the operator's local wall clock rather than
 * the server's UTC clock.
 */
async function timeSnapshot(): Promise<{
  now: Date;
  hour: number;
  minute: number;
  dayOfWeek: number;
}> {
  const now = new Date();
  const tz = (await getSetting(SETTING_KEYS.AUTOMATION_TIMEZONE)) || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    let hour = parseInt(get("hour") ?? "", 10);
    if (hour === 24) hour = 0;
    const minute = parseInt(get("minute") ?? "", 10);
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const wd = get("weekday");
    return {
      now,
      hour: Number.isFinite(hour) ? hour : now.getUTCHours(),
      minute: Number.isFinite(minute) ? minute : now.getUTCMinutes(),
      dayOfWeek: wd && wd in weekdayMap ? weekdayMap[wd] : now.getUTCDay(),
    };
  } catch {
    return {
      now,
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      dayOfWeek: now.getUTCDay(),
    };
  }
}

function parseGraph(raw: unknown): FlowGraph {
  if (!raw || typeof raw !== "object") return { nodes: [], edges: [] };
  const g = raw as Partial<FlowGraph>;
  return {
    nodes: Array.isArray(g.nodes) ? (g.nodes as FlowNode[]) : [],
    edges: Array.isArray(g.edges) ? (g.edges as FlowEdge[]) : [],
    viewport: g.viewport,
  };
}

function findTriggerNode(graph: FlowGraph): FlowNode | null {
  return graph.nodes.find((n) => n.type === "trigger") ?? null;
}

function outgoingEdges(graph: FlowGraph, nodeId: string): FlowEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

function nodeById(graph: FlowGraph, id: string): FlowNode | null {
  return graph.nodes.find((n) => n.id === id) ?? null;
}

/**
 * Build the runtime context from the order (and tracking + customer
 * history) at the moment a trigger fires. Used as the initial snapshot
 * for every node. Each action mutates `context.order` locally after a
 * successful DB write so downstream conditions see the new value.
 */
export async function buildContextForOrder(
  orderId: string,
  trigger: FlowExecutionContext["trigger"]
): Promise<FlowExecutionContext | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return null;

  // Latest tracking row for this order (if any)
  const trackingRow = await prisma.trackingOrder.findFirst({
    where: { orderId },
    orderBy: { updatedAt: "desc" },
  });

  // Customer history: count by phone, last status, delivered count.
  let customer: FlowExecutionContext["customer"] = null;
  if (order.customerPhone) {
    const [orderCount, deliveredCount, prevOrder] = await Promise.all([
      prisma.order.count({ where: { customerPhone: order.customerPhone } }),
      prisma.order.count({
        where: {
          customerPhone: order.customerPhone,
          status: OrderStatus.DELIVERED,
        },
      }),
      prisma.order.findFirst({
        where: {
          customerPhone: order.customerPhone,
          NOT: { id: order.id },
        },
        orderBy: { createdAt: "desc" },
        select: { status: true },
      }),
    ]);
    customer = {
      phone: order.customerPhone,
      orderCount,
      deliveredCount,
      lastOrderStatus: prevOrder?.status ?? null,
    };
  }

  return {
    trigger,
    order: {
      id: order.id,
      codNetworkOrderId: order.codNetworkOrderId,
      codNetworkLeadId: order.codNetworkLeadId,
      status: order.status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerCity: order.customerCity,
      customerAddress: order.customerAddress,
      productName: order.productName,
      productSku: await resolveProductSkus(
        order.productName,
        order.rawOrderJson
      ),
      productPrice: order.productPrice,
      productQuantity: order.productQuantity,
      trackingNumber: order.trackingNumber,
      deliveryCompany: order.deliveryCompany,
      codDeliveryStatus: order.codDeliveryStatus,
      whatsappSentAt: order.whatsappSentAt,
      isManual: order.isManual,
      createdAt: order.createdAt,
      codCreatedAt: order.codCreatedAt,
      ageDays: (() => {
        const ref = order.codCreatedAt ?? order.createdAt;
        return ref
          ? Math.floor((Date.now() - ref.getTime()) / 86_400_000)
          : null;
      })(),
      pipelineNote: order.pipelineNote,
      callAgentQueued: order.callAgentQueued,
      imileScheduledDate: order.imileScheduledDate,
      imileScheduledAt: order.imileScheduledAt,
    },
    tracking: trackingRow
      ? {
          trackingNumber: trackingRow.trackingNumber,
          carrier: trackingRow.carrier,
          status: trackingRow.status,
          latestEvent: trackingRow.latestEvent,
          latestEventAt: trackingRow.latestEventAt,
        }
      : null,
    customer,
    message: null,
    time: await timeSnapshot(),
    vars: {},
  };
}

/**
 * Build the runtime context for a `MESSAGE_RECEIVED` trigger. If the
 * inbound phone matches a known order, we lean on `buildContextForOrder`
 * and then attach the inbound message metadata.
 */
export async function buildContextForInboundMessage(
  fromPhone: string,
  text: string | null,
  messageType: string | null,
  matchedOrderId: string | null,
  trigger: FlowExecutionContext["trigger"]
): Promise<FlowExecutionContext> {
  let context: FlowExecutionContext;
  if (matchedOrderId) {
    const ctx = await buildContextForOrder(matchedOrderId, trigger);
    if (ctx) {
      context = ctx;
    } else {
      context = await bareContext(trigger);
    }
  } else {
    context = await bareContext(trigger);
  }
  context.message = {
    text,
    type: messageType,
    fromPhone,
  };
  if (!context.customer && fromPhone) {
    const orderCount = await prisma.order.count({ where: { customerPhone: fromPhone } });
    context.customer = {
      phone: fromPhone,
      orderCount,
      deliveredCount: 0,
      lastOrderStatus: null,
    };
  }
  return context;
}

async function bareContext(
  trigger: FlowExecutionContext["trigger"]
): Promise<FlowExecutionContext> {
  return {
    trigger,
    order: null,
    tracking: null,
    customer: null,
    message: null,
    time: await timeSnapshot(),
    vars: {},
  };
}

/**
 * Check whether the flow's trigger filters match the given event. For
 * `ORDER_STATUS_CHANGED` and `TRACKING_STATUS_CHANGED`, the trigger node
 * can constrain to specific from/to statuses.
 */
function triggerFiltersMatch(
  triggerNode: TriggerNodeData,
  context: FlowExecutionContext,
  eventDetail?: {
    fromStatus?: OrderStatus | null;
    toStatus?: OrderStatus | null;
    trackingFromStatus?: string | null;
    trackingToStatus?: string | null;
  }
): boolean {
  if (triggerNode.triggerType !== context.trigger.type) return false;

  if (triggerNode.triggerType === "ORDER_STATUS_CHANGED") {
    if (triggerNode.fromStatus && eventDetail?.fromStatus && triggerNode.fromStatus !== eventDetail.fromStatus) {
      return false;
    }
    if (triggerNode.toStatus && eventDetail?.toStatus && triggerNode.toStatus !== eventDetail.toStatus) {
      return false;
    }
  }
  if (triggerNode.triggerType === "TRACKING_STATUS_CHANGED") {
    if (
      triggerNode.trackingFromStatus &&
      eventDetail?.trackingFromStatus &&
      triggerNode.trackingFromStatus !== eventDetail.trackingFromStatus
    ) {
      return false;
    }
    if (
      triggerNode.trackingToStatus &&
      eventDetail?.trackingToStatus &&
      triggerNode.trackingToStatus !== eventDetail.trackingToStatus
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Internal node-walk loop. Used by both `executeFlow` (fresh runs) and
 * `resumeFlow` (parked runs that the webhook is waking back up). The
 * caller is responsible for creating the AutomationFlowRun row and
 * appending the trigger step (if any); we just walk the graph from
 * `startNodeId` and accumulate `steps`.
 */
async function walkFromNode(
  graph: FlowGraph,
  startNodeIds: string[],
  context: FlowExecutionContext,
  steps: FlowRunStep[]
): Promise<
  | { status: "SUCCESS" | "STOPPED" | "FAILED"; errorMessage?: string }
  | {
      status: "WAITING";
      wait: {
        waitingNodeId: string;
        yesKeywords: string[];
        noKeywords: string[];
        timeoutHours: number;
      };
    }
> {
  // Breadth-first over every outgoing edge so a node fanning out into
  // several branches (e.g. one trigger feeding three alternative product
  // conditions that all lead to the same action = an OR) runs them all
  // instead of only the first edge. `visited` makes a fan-in node run
  // exactly once no matter how many branches reach it.
  const queue: string[] = [...startNodeIds];
  const visited = new Set<string>();
  const MAX_NODES = 500;
  let processed = 0;

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    if (visited.has(currentNodeId)) continue;
    visited.add(currentNodeId);
    if (++processed > MAX_NODES) {
      const last = steps[steps.length - 1];
      if (last) last.error = (last.error ?? "") + " | aborted: cycle detected";
      return { status: "FAILED", errorMessage: `Cycle detected at node ${currentNodeId}` };
    }
    const node: FlowNode | null = nodeById(graph, currentNodeId);
    if (!node) {
      return { status: "FAILED", errorMessage: `Missing node ${currentNodeId}` };
    }

    if (node.data.kind === "condition") {
      const condData = node.data as ConditionNodeData;
      let branch: "true" | "false";
      try {
        branch = evaluateCondition(condData, context) ? "true" : "false";
        steps.push({
          nodeId: node.id,
          nodeType: "condition",
          nodeKind: "condition",
          status: "success",
          branch,
          output: `Condition (${condData.field} ${condData.operator} ${condData.value ?? ""}) → ${branch}`,
          ranAt: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({
          nodeId: node.id,
          nodeType: "condition",
          nodeKind: "condition",
          status: "failed",
          error: msg,
          ranAt: new Date().toISOString(),
        });
        return { status: "FAILED", errorMessage: msg };
      }
      queue.push(...nextNodesAfter(graph, node.id, branch));
      continue;
    }

    if (node.data.kind === "action") {
      const actionData = node.data as ActionNodeData;

      // `wait_for_reply` is special: park the entire run state so the
      // webhook can resume it later. We don't call `executeAction` here
      // because the action handler can't terminate the engine on its
      // own.
      if (actionData.action === "wait_for_reply") {
        const yesKeywords = (actionData.waitForReplyYesKeywords ?? []).filter(
          (k) => k.trim() !== ""
        );
        const noKeywords = (actionData.waitForReplyNoKeywords ?? []).filter(
          (k) => k.trim() !== ""
        );
        const timeoutHours = Math.max(
          0.05,
          actionData.waitForReplyTimeoutHours ?? 24
        );
        steps.push({
          nodeId: node.id,
          nodeType: "action",
          nodeKind: "wait_for_reply",
          status: "success",
          output: `Waiting for customer reply (timeout ${timeoutHours}h)`,
          ranAt: new Date().toISOString(),
        });
        return {
          status: "WAITING",
          wait: {
            waitingNodeId: node.id,
            yesKeywords,
            noKeywords,
            timeoutHours,
          },
        };
      }

      try {
        const result = await executeAction(actionData, context);
        steps.push({
          nodeId: node.id,
          nodeType: "action",
          nodeKind: actionData.action,
          status: result.skipped ? "skipped" : "success",
          output: result.output,
          ranAt: new Date().toISOString(),
        });
        if (result.stop) {
          return { status: "STOPPED" };
        }
        if (result.delayMs && result.delayMs > 0) {
          await sleep(result.delayMs);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({
          nodeId: node.id,
          nodeType: "action",
          nodeKind: actionData.action,
          status: "failed",
          error: msg,
          ranAt: new Date().toISOString(),
        });
        return { status: "FAILED", errorMessage: msg };
      }
      queue.push(...nextNodesAfter(graph, node.id));
      continue;
    }

    return { status: "FAILED", errorMessage: `Unknown node kind at ${node.id}` };
  }

  return { status: "SUCCESS" };
}

/**
 * Whether repeat runs for the same order are suppressed by default for a
 * trigger type. The lifecycle triggers describe a one-shot moment ("the
 * order was created", "tracking appeared", "it reached this status"), so
 * acting on the same order twice is virtually always a bug — most often a
 * status flap: an action sets status X, the next COD Network sync derives
 * status Y again, which re-fires ORDER_STATUS_CHANGED and re-sends the
 * template every sync tick. `SCHEDULED` and `MESSAGE_RECEIVED` are
 * genuinely recurring, so they default to off.
 */
function dedupeDefaultForTrigger(triggerType: FlowTriggerType): boolean {
  return (
    triggerType === "ORDER_CREATED" ||
    triggerType === "ORDER_STATUS_CHANGED" ||
    triggerType === "ORDER_TRACKING_ASSIGNED" ||
    triggerType === "TRACKING_STATUS_CHANGED"
  );
}

/**
 * Key that identifies "this flow already acted on this order for this
 * event". `ORDER_STATUS_CHANGED` / `TRACKING_STATUS_CHANGED` include the
 * resulting status so a flow can still act again when the order genuinely
 * reaches a *different* status, while a flap back to a status already
 * handled is suppressed.
 */
function dedupeKeyFor(
  triggerType: FlowTriggerType,
  context: FlowExecutionContext
): string {
  const payload = context.trigger.payload ?? {};
  if (
    triggerType === "ORDER_STATUS_CHANGED" ||
    triggerType === "TRACKING_STATUS_CHANGED"
  ) {
    return `${triggerType}:${String(payload.toStatus ?? "")}`;
  }
  return triggerType;
}

/** Did this run actually do something to the customer/order? */
function runPerformedAction(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return (steps as FlowRunStep[]).some(
    (s) =>
      s &&
      s.nodeType === "action" &&
      s.status === "success" &&
      s.nodeKind !== "stop" &&
      s.nodeKind !== "wait"
  );
}

/**
 * True when this flow already executed at least one action for this order
 * under the same dedupe key. Runs whose conditions all evaluated false
 * don't count, so a flow still fires later when the order finally matches.
 */
async function alreadyActedOnOrder(
  flow: AutomationFlow,
  triggerType: FlowTriggerType,
  context: FlowExecutionContext
): Promise<boolean> {
  const orderId = context.order?.id;
  if (!orderId) return false;
  const key = dedupeKeyFor(triggerType, context);
  const previous = await prisma.automationFlowRun.findMany({
    where: {
      flowId: flow.id,
      orderId,
      status: { in: ["SUCCESS", "STOPPED", "WAITING", "FAILED"] },
    },
    orderBy: { startedAt: "desc" },
    take: 25,
    select: { stepsJson: true, contextJson: true },
  });
  return previous.some((run) => {
    if (!runPerformedAction(run.stepsJson)) return false;
    const ctx = run.contextJson as unknown as FlowExecutionContext | null;
    if (!ctx) return false;
    return dedupeKeyFor(triggerType, ctx) === key;
  });
}

/**
 * Move an order into the `SCHEDULED` pipeline stage once a run both re-booked
 * its iMile delivery and told the customer about the new date. Operators need
 * a column holding exactly the parcels a new delivery day was promised for, so
 * this is applied by the engine rather than requiring a manual
 * `change_order_status` node after every reschedule.
 */
async function moveRescheduledOrderToScheduled(
  context: FlowExecutionContext,
  steps: FlowRunStep[]
): Promise<void> {
  const order = context.order;
  if (!order || order.status === OrderStatus.SCHEDULED) return;
  const rescheduled = steps.some(
    (s) => s.nodeKind === "reschedule_imile" && s.status === "success"
  );
  if (!rescheduled) return;
  const notified = steps.some(
    (s) =>
      (s.nodeKind === "send_template" || s.nodeKind === "send_text_message") &&
      s.status === "success"
  );
  if (!notified) return;

  await prisma.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.SCHEDULED },
  });
  order.status = OrderStatus.SCHEDULED;
  steps.push({
    nodeId: "auto-scheduled",
    nodeType: "action",
    nodeKind: "change_order_status",
    status: "success",
    output: `Moved order to the Scheduled pipeline (delivery re-booked for ${
      context.imile?.scheduledDate ?? order.imileScheduledDate ?? "a later day"
    })`,
    ranAt: new Date().toISOString(),
  });
}

/**
 * Run a single flow against the given context, recording a step-by-step
 * timeline on `AutomationFlowRun.stepsJson`. If the flow hits a
 * `wait_for_reply` action, returns with status `WAITING` and the run row
 * stays in that state until the WhatsApp webhook resumes it.
 */
export async function executeFlow(
  flow: AutomationFlow,
  context: FlowExecutionContext,
  eventDetail?: {
    fromStatus?: OrderStatus | null;
    toStatus?: OrderStatus | null;
    trackingFromStatus?: string | null;
    trackingToStatus?: string | null;
  },
  options?: { ignoreDedupe?: boolean }
): Promise<{
  runId: string;
  status: "SUCCESS" | "FAILED" | "STOPPED" | "WAITING";
  steps: FlowRunStep[];
  skipped?: boolean;
}> {
  const graph = parseGraph(flow.graphJson);
  const triggerNode = findTriggerNode(graph);

  if (triggerNode && triggerNode.data.kind === "trigger" && !options?.ignoreDedupe) {
    const triggerData = triggerNode.data as TriggerNodeData;
    const oncePerOrder =
      triggerData.runOncePerOrder ??
      dedupeDefaultForTrigger(triggerData.triggerType);
    if (oncePerOrder && (await alreadyActedOnOrder(flow, triggerData.triggerType, context))) {
      console.log(
        `[automation-flow] skipping flow "${flow.name}" (${flow.id}) for order ` +
          `${context.order?.id}: already acted on this order for ` +
          `${dedupeKeyFor(triggerData.triggerType, context)}`
      );
      return { runId: "", status: "SUCCESS", steps: [], skipped: true };
    }
  }

  // Create the run row up-front so the UI can show "RUNNING" status if the
  // process dies mid-execution. Final state is patched on completion.
  const run = await prisma.automationFlowRun.create({
    data: {
      flowId: flow.id,
      orderId: context.order?.id ?? null,
      contextJson: serializeContext(context) as unknown as Prisma.InputJsonValue,
      status: "RUNNING",
      stepsJson: [] as unknown as Prisma.InputJsonValue,
    },
  });

  const steps: FlowRunStep[] = [];

  if (!triggerNode || triggerNode.data.kind !== "trigger") {
    return finishRun(run.id, "FAILED", steps, "Flow has no trigger node");
  }

  // Verify trigger filters (e.g. ORDER_STATUS_CHANGED only fires for the
  // specific from→to pair).
  if (!triggerFiltersMatch(triggerNode.data, context, eventDetail)) {
    steps.push({
      nodeId: triggerNode.id,
      nodeType: "trigger",
      nodeKind: triggerNode.data.triggerType,
      status: "skipped",
      output: "Trigger filters did not match event",
      ranAt: new Date().toISOString(),
    });
    return finishRun(run.id, "SUCCESS", steps);
  }

  steps.push({
    nodeId: triggerNode.id,
    nodeType: "trigger",
    nodeKind: triggerNode.data.triggerType,
    status: "success",
    output: `Trigger ${triggerNode.data.triggerType} matched`,
    ranAt: new Date().toISOString(),
  });

  const result = await walkFromNode(
    graph,
    nextNodesAfter(graph, triggerNode.id),
    context,
    steps
  );

  await moveRescheduledOrderToScheduled(context, steps);

  if (result.status === "WAITING") {
    await parkRunForReply(run.id, flow.id, context, steps, result.wait);
    return { runId: run.id, status: "WAITING", steps };
  }
  return finishRun(run.id, result.status, steps, result.errorMessage);
}

/**
 * Persist a paused run + a matching `automation_flow_waits` row, so the
 * WhatsApp webhook can route the customer's next inbound message back
 * into the flow.
 */
async function parkRunForReply(
  runId: string,
  flowId: string,
  context: FlowExecutionContext,
  steps: FlowRunStep[],
  wait: {
    waitingNodeId: string;
    yesKeywords: string[];
    noKeywords: string[];
    timeoutHours: number;
  }
): Promise<void> {
  const fromPhone =
    context.order?.customerPhone ?? context.message?.fromPhone ?? null;
  if (!fromPhone) {
    // Nothing to wait on — fail the run with a clear message rather than
    // creating an orphan wait row.
    await prisma.automationFlowRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        stepsJson: steps as unknown as Prisma.InputJsonValue,
        errorMessage:
          "wait_for_reply: no customer phone in context — cannot wait for a reply",
        finishedAt: new Date(),
      },
    });
    return;
  }
  const expiresAt = new Date(Date.now() + wait.timeoutHours * 3600 * 1000);
  await prisma.automationFlowRun.update({
    where: { id: runId },
    data: {
      status: "WAITING",
      stepsJson: steps as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.automationFlowWait.create({
    data: {
      runId,
      flowId,
      orderId: context.order?.id ?? null,
      fromPhone,
      waitingNodeId: wait.waitingNodeId,
      contextJson: serializeContext(context) as unknown as Prisma.InputJsonValue,
      stepsJson: steps as unknown as Prisma.InputJsonValue,
      yesKeywords: wait.yesKeywords.join(","),
      noKeywords: wait.noKeywords.join(","),
      expiresAt,
      status: "WAITING",
    },
  });
}

/**
 * Resume a parked run after the customer replied (or the wait timed
 * out). Walks the graph from the matched output handle of the
 * `wait_for_reply` node and continues until completion / next pause.
 */
export async function resumeFlow(
  waitId: string,
  matchedHandle: "yes" | "no" | "timeout",
  inboundMessageText: string | null
): Promise<{
  runId: string;
  status: "SUCCESS" | "FAILED" | "STOPPED" | "WAITING";
  steps: FlowRunStep[];
} | null> {
  const wait = await prisma.automationFlowWait.findUnique({
    where: { id: waitId },
  });
  if (!wait) return null;
  if (wait.status !== "WAITING") return null;

  const flow = await prisma.automationFlow.findUnique({
    where: { id: wait.flowId },
  });
  if (!flow) return null;
  const graph = parseGraph(flow.graphJson);

  // Mark the wait row as MATCHED first so concurrent webhook deliveries
  // can't double-resume.
  await prisma.automationFlowWait.update({
    where: { id: waitId },
    data: {
      status: matchedHandle === "timeout" ? "EXPIRED" : "MATCHED",
      matchedHandle,
      matchedAt: new Date(),
      matchedMessageText: inboundMessageText,
    },
  });

  // Rehydrate context. Attach the inbound message so condition nodes can
  // inspect `message.text` if the operator wants extra branching after
  // the wait.
  const context = wait.contextJson as unknown as FlowExecutionContext;
  context.message = {
    fromPhone: wait.fromPhone,
    text: inboundMessageText,
    type: "text",
  };

  const steps: FlowRunStep[] = Array.isArray(wait.stepsJson)
    ? (wait.stepsJson as unknown as FlowRunStep[])
    : [];

  steps.push({
    nodeId: wait.waitingNodeId,
    nodeType: "action",
    nodeKind: "wait_for_reply",
    status: "success",
    branch: matchedHandle,
    output:
      matchedHandle === "timeout"
        ? `Wait expired — taking "timeout" branch`
        : `Customer replied → taking "${matchedHandle}" branch`,
    ranAt: new Date().toISOString(),
  });

  const result = await walkFromNode(
    graph,
    nextNodesAfter(graph, wait.waitingNodeId, matchedHandle),
    context,
    steps
  );

  if (result.status === "WAITING") {
    // Chained wait — park again on the new node.
    await parkRunForReply(wait.runId, wait.flowId, context, steps, result.wait);
    return { runId: wait.runId, status: "WAITING", steps };
  }
  return finishRun(wait.runId, result.status, steps, result.errorMessage);
}

/**
 * Sweep `WAITING` rows whose `expires_at` has passed and resume them
 * down the "timeout" branch. Called opportunistically from the webhook
 * + run-listing endpoints — keeps the table tidy without a dedicated
 * cron.
 */
export async function sweepExpiredWaits(): Promise<number> {
  const now = new Date();
  const overdue = await prisma.automationFlowWait.findMany({
    where: { status: "WAITING", expiresAt: { lt: now } },
    select: { id: true },
  });
  let resumed = 0;
  for (const row of overdue) {
    try {
      await resumeFlow(row.id, "timeout", null);
      resumed++;
    } catch (err) {
      console.error(
        `[automation-flow] failed to expire wait ${row.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return resumed;
}

/**
 * Every node reachable from `nodeId`. For branching nodes only the edges
 * whose `sourceHandle` matches `handle` are followed; a branch with no
 * matching edge terminates silently.
 */
function nextNodesAfter(
  graph: FlowGraph,
  nodeId: string,
  handle?: string
): string[] {
  const edges = outgoingEdges(graph, nodeId);
  if (edges.length === 0) return [];
  if (handle) {
    return edges
      .filter((e) => (e.sourceHandle ?? "") === handle)
      .map((e) => e.target);
  }
  // Unhandled outputs: an action node's plain output edge(s). Ignore edges
  // that carry a branch handle so a condition's true/false wiring can't be
  // walked from a non-branching node.
  return edges.map((e) => e.target);
}

async function finishRun(
  runId: string,
  status: "SUCCESS" | "FAILED" | "STOPPED",
  steps: FlowRunStep[],
  errorMessage?: string
): Promise<{ runId: string; status: "SUCCESS" | "FAILED" | "STOPPED"; steps: FlowRunStep[] }> {
  await prisma.automationFlowRun.update({
    where: { id: runId },
    data: {
      status,
      stepsJson: steps as unknown as Prisma.InputJsonValue,
      errorMessage: errorMessage ?? null,
      finishedAt: new Date(),
    },
  });
  return { runId, status, steps };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strip non-serializable fields (Date → ISO string) so contextJson stores
 * cleanly. Dates inside `order.createdAt`, etc. are converted via JSON
 * round-trip semantics automatically by Prisma, but we do it explicitly
 * for clarity in the run log.
 */
function serializeContext(ctx: FlowExecutionContext): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ctx)) as Record<string, unknown>;
}

/**
 * Top-level entry point: find every enabled flow whose trigger type matches
 * `triggerType` and execute them in sequence. Caller passes the trigger
 * payload (orderId for order/tracking triggers, message metadata for
 * MESSAGE_RECEIVED).
 *
 * Sequential execution mirrors the existing `runAutomationsForOrder` —
 * keeps DB load predictable and lets the UI feed back accurate per-flow
 * status. Each flow's run is isolated; one flow failing doesn't stop the
 * next one from firing.
 */
export async function runFlowsForTrigger(
  triggerType: FlowTriggerType,
  contextBuilder: () => Promise<FlowExecutionContext | null>,
  eventDetail?: {
    fromStatus?: OrderStatus | null;
    toStatus?: OrderStatus | null;
    trackingFromStatus?: string | null;
    trackingToStatus?: string | null;
  }
): Promise<void> {
  const flows = await prisma.automationFlow.findMany({
    where: { isEnabled: true, triggerType },
  });
  if (flows.length === 0) return;

  const context = await contextBuilder();
  if (!context) return;

  for (const flow of flows) {
    try {
      const result = await executeFlow(flow, context, eventDetail);
      if (result.skipped) continue;
      await prisma.automationFlow.update({
        where: { id: flow.id },
        data: {
          lastFiredAt: new Date(),
          runCount: { increment: 1 },
        },
      });
    } catch (err) {
      console.error(
        `[automation-flow] flow "${flow.name}" (${flow.id}) errored:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

/** Default run-history retention, overridable via Settings → Automation. */
const DEFAULT_RUN_RETENTION_DAYS = 7;
/** Upper bound on rows deleted per prune call, to keep the sync tick short. */
const PRUNE_BATCH = 20_000;

/**
 * Delete run history older than the retention window. Every trigger fire
 * writes a row (including runs whose conditions all evaluated false), so on
 * a busy store this table dwarfs the rest of the database and slows every
 * query — and therefore every page — down. Called from the sync loop.
 */
export async function pruneFlowRunHistory(): Promise<number> {
  const configured = parseInt(
    (await getSetting(SETTING_KEYS.AUTOMATION_RUN_RETENTION_DAYS)) ?? "",
    10
  );
  const days = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RUN_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const stale = await prisma.automationFlowRun.findMany({
    where: { startedAt: { lt: cutoff }, status: { not: "WAITING" } },
    select: { id: true },
    take: PRUNE_BATCH,
  });
  if (stale.length === 0) return 0;
  const { count } = await prisma.automationFlowRun.deleteMany({
    where: { id: { in: stale.map((r) => r.id) } },
  });
  return count;
}

/** Local calendar-day key (YYYY-MM-DD) for `date` in the given timezone. */
function localDayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Scheduled sweep for `SCHEDULED`-trigger flows. Runs on the auto-sync cadence.
 * For each enabled scheduled flow whose daily time (in the configured
 * timezone) has arrived and which hasn't already fired today, evaluate the
 * flow against every order — optionally bounded to a chosen status — so all
 * matching orders are acted on at the scheduled time.
 *
 * Fires at-or-after the target time (not exactly on the minute) so a 5-minute
 * cron never misses it, and de-dupes to once per local day via `lastFiredAt`.
 */
export async function runScheduledFlows(): Promise<void> {
  const flows = await prisma.automationFlow.findMany({
    where: { isEnabled: true, triggerType: "SCHEDULED" },
  });
  if (flows.length === 0) return;

  const tz = (await getSetting(SETTING_KEYS.AUTOMATION_TIMEZONE)) || "UTC";
  const snap = await timeSnapshot();
  const nowMinutes = snap.hour * 60 + snap.minute;
  const todayKey = localDayKey(snap.now, tz);

  for (const flow of flows) {
    try {
      const graph = parseGraph(flow.graphJson);
      const triggerNode = graph.nodes.find((n) => n.type === "trigger");
      const data = triggerNode?.data as TriggerNodeData | undefined;
      if (!data) continue;

      const schedHour = Math.min(23, Math.max(0, data.scheduleHour ?? 0));
      const schedMinute = Math.min(59, Math.max(0, data.scheduleMinute ?? 0));
      const schedMinutes = schedHour * 60 + schedMinute;

      // Window not open yet today.
      if (nowMinutes < schedMinutes) continue;
      // Already fired today (same local calendar day).
      if (flow.lastFiredAt && localDayKey(flow.lastFiredAt, tz) === todayKey) {
        continue;
      }

      const where: Prisma.OrderWhereInput = data.scheduleStatus
        ? { status: data.scheduleStatus }
        : {};
      const orders = await prisma.order.findMany({
        where,
        select: { id: true },
      });

      for (const order of orders) {
        const ctx = await buildContextForOrder(order.id, {
          type: "SCHEDULED",
          firedAt: snap.now,
          payload: { scheduled: true },
        });
        if (!ctx) continue;
        try {
          await executeFlow(flow, ctx);
        } catch (err) {
          console.error(
            `[automation-flow] scheduled flow "${flow.name}" order ${order.id} errored:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      await prisma.automationFlow.update({
        where: { id: flow.id },
        data: { lastFiredAt: new Date(), runCount: { increment: 1 } },
      });
    } catch (err) {
      console.error(
        `[automation-flow] scheduled flow "${flow.name}" (${flow.id}) errored:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
