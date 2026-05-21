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

  const now = new Date();
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
      productPrice: order.productPrice,
      productQuantity: order.productQuantity,
      trackingNumber: order.trackingNumber,
      deliveryCompany: order.deliveryCompany,
      codDeliveryStatus: order.codDeliveryStatus,
      whatsappSentAt: order.whatsappSentAt,
      isManual: order.isManual,
      createdAt: order.createdAt,
      codCreatedAt: order.codCreatedAt,
      pipelineNote: order.pipelineNote,
      callAgentQueued: order.callAgentQueued,
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
    time: {
      now,
      hour: now.getHours(),
      dayOfWeek: now.getDay(),
    },
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
      context = bareContext(trigger);
    }
  } else {
    context = bareContext(trigger);
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

function bareContext(trigger: FlowExecutionContext["trigger"]): FlowExecutionContext {
  const now = new Date();
  return {
    trigger,
    order: null,
    tracking: null,
    customer: null,
    message: null,
    time: {
      now,
      hour: now.getHours(),
      dayOfWeek: now.getDay(),
    },
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
 * Run a single flow against the given context, recording a step-by-step
 * timeline on `AutomationFlowRun.stepsJson`.
 */
export async function executeFlow(
  flow: AutomationFlow,
  context: FlowExecutionContext,
  eventDetail?: {
    fromStatus?: OrderStatus | null;
    toStatus?: OrderStatus | null;
    trackingFromStatus?: string | null;
    trackingToStatus?: string | null;
  }
): Promise<{ runId: string; status: "SUCCESS" | "FAILED" | "STOPPED"; steps: FlowRunStep[] }> {
  const graph = parseGraph(flow.graphJson);
  const triggerNode = findTriggerNode(graph);

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

  // Walk from the trigger forward.
  let currentNodeId: string | null = nextNodeAfter(graph, triggerNode.id);
  // Safety: avoid infinite loops if the user wires a cycle.
  const visitCount: Record<string, number> = {};
  const MAX_VISITS = 200;

  while (currentNodeId) {
    visitCount[currentNodeId] = (visitCount[currentNodeId] ?? 0) + 1;
    if (visitCount[currentNodeId] > MAX_VISITS) {
      const last = steps[steps.length - 1];
      if (last) last.error = (last.error ?? "") + " | aborted: cycle detected";
      return finishRun(
        run.id,
        "FAILED",
        steps,
        `Cycle detected at node ${currentNodeId}`
      );
    }
    const node: FlowNode | null = nodeById(graph, currentNodeId);
    if (!node) {
      return finishRun(run.id, "FAILED", steps, `Missing node ${currentNodeId}`);
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
        return finishRun(run.id, "FAILED", steps, msg);
      }
      currentNodeId = nextNodeAfter(graph, node.id, branch);
      continue;
    }

    if (node.data.kind === "action") {
      const actionData = node.data as ActionNodeData;
      try {
        const result = await executeAction(actionData, context);
        steps.push({
          nodeId: node.id,
          nodeType: "action",
          nodeKind: actionData.action,
          status: "success",
          output: result.output,
          ranAt: new Date().toISOString(),
        });
        if (result.stop) {
          return finishRun(run.id, "STOPPED", steps);
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
        return finishRun(run.id, "FAILED", steps, msg);
      }
      currentNodeId = nextNodeAfter(graph, node.id);
      continue;
    }

    return finishRun(run.id, "FAILED", steps, `Unknown node kind at ${node.id}`);
  }

  return finishRun(run.id, "SUCCESS", steps);
}

function nextNodeAfter(
  graph: FlowGraph,
  nodeId: string,
  handle?: string
): string | null {
  const edges = outgoingEdges(graph, nodeId);
  if (edges.length === 0) return null;
  if (handle) {
    const match = edges.find((e) => (e.sourceHandle ?? "") === handle);
    if (match) return match.target;
    // Condition with no matching handle → terminate that branch silently.
    return null;
  }
  return edges[0].target;
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
      await executeFlow(flow, context, eventDetail);
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
