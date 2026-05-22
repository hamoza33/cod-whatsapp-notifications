/**
 * Visual flow-builder canvas. Drag nodes from the left palette, wire them
 * together with edges, and click any node to configure it in the right
 * inspector panel.
 *
 * Persistence:
 *   - Every edit (node add/remove, edge change, inspector update) flips
 *     `dirty=true` and queues a debounced PATCH (1.2s).
 *   - The "Save" button forces an immediate save without waiting.
 *
 * Auto-run:
 *   - Enabling the toggle saves `isEnabled=true` to the server. From that
 *     moment forward, the flow fires automatically end-to-end whenever
 *     its trigger event happens.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Play,
  Save,
  Loader2,
  Zap,
  Filter,
  Mail,
  Hash,
  AlertCircle,
  Plus,
  Trash2,
  Clock,
  Webhook,
  StopCircle,
  Phone,
  ShoppingBag,
  Pin,
  StickyNote,
  PhoneCall,
  CheckCircle2,
  Upload,
} from "lucide-react";
import { api } from "@/lib/api-client";

// ----------------------------------------------------------------------------
// Types — kept in sync with src/lib/automation-flows/types.ts on the server
// ----------------------------------------------------------------------------

type FlowTriggerType =
  | "ORDER_CREATED"
  | "ORDER_STATUS_CHANGED"
  | "TRACKING_STATUS_CHANGED"
  | "MESSAGE_RECEIVED"
  | "MANUAL";

type ConditionOperator =
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

type ActionKind =
  | "send_template"
  | "send_text_message"
  | "change_order_status"
  | "add_pipeline_note"
  | "pin_conversation"
  | "queue_call_agent"
  | "wait"
  | "webhook"
  | "stop";

interface TriggerData {
  kind: "trigger";
  triggerType: FlowTriggerType;
  label?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  trackingFromStatus?: string | null;
  trackingToStatus?: string | null;
}
interface ConditionData {
  kind: "condition";
  label?: string;
  field: string;
  operator: ConditionOperator;
  value?: string;
  caseSensitive?: boolean;
}
interface ActionData {
  kind: "action";
  action: ActionKind;
  label?: string;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateVariables?: string[] | null;
  templateHeaderImageUrl?: string | null;
  text?: string | null;
  targetStatus?: string | null;
  note?: string | null;
  waitSeconds?: number | null;
  webhookUrl?: string | null;
  webhookMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | null;
  webhookHeadersJson?: string | null;
  webhookBodyTemplate?: string | null;
}
type FlowNodeData = TriggerData | ConditionData | ActionData;

interface FlowGraph {
  nodes: Array<{
    id: string;
    type: "trigger" | "condition" | "action";
    position: { x: number; y: number };
    data: FlowNodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    label?: string;
  }>;
  viewport?: { x: number; y: number; zoom: number };
}

interface FlowDto {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  triggerType: FlowTriggerType;
  graphJson: FlowGraph;
}

interface DataPoint {
  path: string;
  label: string;
  group: string;
  type: "string" | "number" | "boolean" | "date" | "enum";
  sampleOptions?: string[];
  description?: string;
}

interface DataPointsResponse {
  dataPoints: DataPoint[];
  groups: Record<string, DataPoint[]>;
  operators: ConditionOperator[];
  triggers: FlowTriggerType[];
  actions: ActionKind[];
}

interface TemplateRow {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyText: string | null;
}

// ----------------------------------------------------------------------------
// Static reference data for dropdowns. Kept in lockstep with the server
// enums; if a new ActionKind ships, add an entry here AND a handler in
// src/lib/automation-flows/actions.ts.
// ----------------------------------------------------------------------------

const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
  "NEW",
  "NO_REPLY",
  "WRONG",
  "EXPIRED",
  "CALL_LATER",
  "CANCELLED_PRICE",
];

const TRACKING_STATUSES = [
  "PENDING",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "EXCEPTION",
  "UNKNOWN",
];

const TRIGGER_LABELS: Record<FlowTriggerType, string> = {
  ORDER_CREATED: "Order created",
  ORDER_STATUS_CHANGED: "Order status changed",
  TRACKING_STATUS_CHANGED: "Tracking status changed",
  MESSAGE_RECEIVED: "Customer reply received",
  MANUAL: "Manual trigger",
};

const ACTION_LABELS: Record<ActionKind, string> = {
  send_template: "Send WhatsApp template",
  send_text_message: "Send WhatsApp text",
  change_order_status: "Change order status",
  add_pipeline_note: "Add pipeline note",
  pin_conversation: "Pin conversation",
  queue_call_agent: "Queue call agent",
  wait: "Wait",
  webhook: "Call webhook",
  stop: "Stop flow",
};

const ACTION_ICONS: Record<ActionKind, typeof Mail> = {
  send_template: Mail,
  send_text_message: Mail,
  change_order_status: ShoppingBag,
  add_pipeline_note: StickyNote,
  pin_conversation: Pin,
  queue_call_agent: PhoneCall,
  wait: Clock,
  webhook: Webhook,
  stop: StopCircle,
};

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  regex: "matches regex",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "in (comma list)",
  not_in: "not in (comma list)",
  exists: "exists",
  not_exists: "does not exist",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

// ----------------------------------------------------------------------------
// Custom react-flow node components — the bubble/block visuals the user
// sees on the canvas. Each one declares which handles (input/output) it
// exposes so the engine knows where to wire incoming + outgoing edges.
// ----------------------------------------------------------------------------

const HANDLE_SIZE: React.CSSProperties = { width: 14, height: 14 };

function TriggerNode({ data, selected }: NodeProps) {
  const d = data as unknown as TriggerData;
  return (
    <div
      className={`px-4 py-3 rounded-2xl border-2 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-100 ${
        selected ? "border-blue-500 ring-2 ring-blue-200" : "border-amber-300"
      } min-w-[200px]`}
    >
      <div className="flex items-center gap-2 text-amber-700 font-semibold text-[12px]">
        <Zap size={14} /> TRIGGER
      </div>
      <div className="text-[14px] font-semibold text-gray-900 mt-1">
        {TRIGGER_LABELS[d.triggerType] ?? d.triggerType}
      </div>
      {d.label && <div className="text-[11px] text-gray-500 mt-0.5">{d.label}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500" style={HANDLE_SIZE} />
    </div>
  );
}

function ConditionNode({ data, selected }: NodeProps) {
  const d = data as unknown as ConditionData;
  const fieldLabel = d.field?.split(".").pop() ?? "<field>";
  return (
    <div
      className={`relative rounded-2xl border-2 shadow-sm bg-gradient-to-br from-purple-50 to-fuchsia-100 ${
        selected ? "border-blue-500 ring-2 ring-blue-200" : "border-purple-300"
      } min-w-[220px]`}
    >
      <Handle type="target" position={Position.Top} className="!bg-purple-500" style={HANDLE_SIZE} />
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 text-purple-700 font-semibold text-[12px]">
          <Filter size={14} /> CONDITION
        </div>
        <div className="text-[13px] font-medium text-gray-900 mt-1">
          {fieldLabel}{" "}
          <span className="text-[11px] text-purple-700">
            {OPERATOR_LABELS[d.operator] ?? d.operator}
          </span>{" "}
          <span className="text-[12px] text-gray-600">{d.value ?? ""}</span>
        </div>
        <div className="flex justify-between text-[10px] mt-2">
          <span className="text-green-700">true ↓</span>
          <span className="text-red-700">false ↓</span>
        </div>
      </div>
      <Handle
        id="true"
        type="source"
        position={Position.Bottom}
        style={{ left: "25%", ...HANDLE_SIZE }}
        className="!bg-green-500"
      />
      <Handle
        id="false"
        type="source"
        position={Position.Bottom}
        style={{ left: "75%", ...HANDLE_SIZE }}
        className="!bg-red-500"
      />
    </div>
  );
}

function ActionNode({ data, selected }: NodeProps) {
  const d = data as unknown as ActionData;
  const Icon = ACTION_ICONS[d.action] ?? Mail;
  return (
    <div
      className={`px-4 py-3 rounded-2xl border-2 shadow-sm bg-gradient-to-br from-blue-50 to-sky-100 ${
        selected ? "border-blue-500 ring-2 ring-blue-200" : "border-blue-300"
      } min-w-[220px]`}
    >
      <Handle type="target" position={Position.Top} className="!bg-blue-500" style={HANDLE_SIZE} />
      <div className="flex items-center gap-2 text-blue-700 font-semibold text-[12px]">
        <Icon size={14} /> ACTION
      </div>
      <div className="text-[13px] font-medium text-gray-900 mt-1">
        {ACTION_LABELS[d.action] ?? d.action}
      </div>
      {d.action === "send_template" && d.templateName && (
        <div className="text-[11px] text-gray-500 mt-0.5">
          template: <span className="font-mono">{d.templateName}</span>
        </div>
      )}
      {d.action === "change_order_status" && d.targetStatus && (
        <div className="text-[11px] text-gray-500 mt-0.5">→ {d.targetStatus}</div>
      )}
      {d.action === "wait" && d.waitSeconds !== null && d.waitSeconds !== undefined && (
        <div className="text-[11px] text-gray-500 mt-0.5">{d.waitSeconds}s</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500" style={HANDLE_SIZE} />
    </div>
  );
}

const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
};

// ----------------------------------------------------------------------------
// Page-level container — fetches the flow, wires the canvas, and hosts
// the inspector panel.
// ----------------------------------------------------------------------------

export default function FlowEditorPage() {
  return (
    <ReactFlowProvider>
      <FlowEditorInner />
    </ReactFlowProvider>
  );
}

function FlowEditorInner() {
  const params = useParams<{ id: string }>();
  const flowId = params.id;

  const [flow, setFlow] = useState<FlowDto | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isEnabled, setIsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ---- initial load ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowRes, dpRes, tplRes] = await Promise.all([
          api.get<{ flow: FlowDto }>(`/automation-flows/${flowId}`),
          api.get<DataPointsResponse>("/automation-flows/data-points"),
          api.get<{ templates: TemplateRow[] }>("/whatsapp/templates/cached"),
        ]);
        if (cancelled) return;
        setFlow(flowRes.flow);
        setName(flowRes.flow.name);
        setDescription(flowRes.flow.description ?? "");
        setIsEnabled(flowRes.flow.isEnabled);
        setDataPoints(dpRes.dataPoints);
        setTemplates(tplRes.templates ?? []);
        const graph = flowRes.flow.graphJson || { nodes: [], edges: [] };
        setNodes(
          graph.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data as unknown as Record<string, unknown>,
          }))
        );
        setEdges(
          graph.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? undefined,
            targetHandle: e.targetHandle ?? undefined,
            label: e.label,
            markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
            style: { stroke: "#94a3b8", strokeWidth: 2, cursor: "pointer" },
          }))
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load flow");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  // ---- save (immediate or debounced) -------------------------------------
  const persist = useCallback(async () => {
    if (!flow) return;
    setSaving(true);
    setError(null);
    try {
      const graphJson: FlowGraph = {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.type as "trigger" | "condition" | "action") ?? "action",
          position: n.position,
          data: n.data as unknown as FlowNodeData,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? null,
          targetHandle: e.targetHandle ?? null,
          label: typeof e.label === "string" ? e.label : undefined,
        })),
      };
      await api.patch(`/automation-flows/${flow.id}`, {
        name,
        description,
        isEnabled,
        graphJson,
      });
      setSavedAt(new Date());
      dirtyRef.current = false;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [flow, nodes, edges, name, description, isEnabled]);

  // Keep a stable ref so debounced timers always call the latest version.
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  const queueSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void persistRef.current();
    }, 1200);
  }, []);

  // ---- canvas change handlers --------------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      const significant = changes.some(
        (c) => c.type !== "select" && c.type !== "dimensions"
      );
      if (significant) queueSave();
    },
    [queueSave]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
      const significant = changes.some((c) => c.type !== "select");
      if (significant) queueSave();
    },
    [queueSave]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `e-${connection.source}-${connection.target}-${connection.sourceHandle ?? "n"}`,
            markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
            style: { stroke: "#94a3b8" },
          },
          eds
        )
      );
      queueSave();
    },
    [queueSave]
  );

  const onSelectionChange = useCallback(
    ({ nodes: selNodes }: { nodes: Node[]; edges: Edge[] }) => {
      setSelectedId(selNodes[0]?.id ?? null);
    },
    []
  );

  // ---- node mutations from the inspector --------------------------------
  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<FlowNodeData>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, ...patch } as unknown as Record<string, unknown> }
            : n
        )
      );
      queueSave();
    },
    [queueSave]
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedId(null);
      queueSave();
    },
    [queueSave]
  );

  // ---- add new node ------------------------------------------------------
  const addNode = useCallback(
    (variant: "condition" | "action", action?: ActionKind) => {
      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const position = randomPosition();
      let newNode: Node;
      if (variant === "condition") {
        newNode = {
          id,
          type: "condition",
          position,
          data: {
            kind: "condition",
            field: "order.status",
            operator: "equals",
            value: "",
          } as unknown as Record<string, unknown>,
        };
      } else {
        newNode = {
          id,
          type: "action",
          position,
          data: {
            kind: "action",
            action: action ?? "send_template",
            templateLanguage: "en",
            templateVariables: [],
            webhookMethod: "POST",
          } as unknown as Record<string, unknown>,
        };
      }
      setNodes((nds) => [...nds, newNode]);
      setSelectedId(id);
      queueSave();
    },
    [queueSave]
  );

  // ---- test run ---------------------------------------------------------
  const handleTestRun = async () => {
    if (!flow) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const res = await api.post<{ runId: string; status: string; steps: Array<{ output?: string; error?: string; nodeKind: string; status: string }> }>(
        `/automation-flows/${flow.id}/test`,
        {}
      );
      const summary = res.steps
        .map(
          (s) =>
            `[${s.status === "success" ? "✓" : s.status === "failed" ? "✗" : "·"}] ${s.nodeKind}: ${
              s.output ?? s.error ?? "—"
            }`
        )
        .join("\n");
      setTestResult(`${res.status}\n${summary}`);
    } catch (err) {
      setTestResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTestRunning(false);
    }
  };

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId]
  );

  if (loading) {
    return (
      <div className="px-6 py-12 text-center text-[13px] text-gray-500">
        Loading flow editor…
      </div>
    );
  }
  if (error && !flow) {
    return (
      <div className="px-6 py-12">
        <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
          {error}
        </div>
      </div>
    );
  }
  if (!flow) return null;

  return (
    <div className="h-[calc(100vh-1rem)] flex flex-col">
      {/* Header */}
      <div className="px-4 py-2 border-b border-gray-200 flex items-center gap-3 bg-white">
        <Link
          href="/automations"
          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft size={16} />
        </Link>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            queueSave();
          }}
          className="text-[14px] font-semibold text-gray-900 px-2 py-1 rounded hover:bg-gray-50 focus:bg-gray-50 focus:outline-none border border-transparent focus:border-gray-200 min-w-[240px]"
        />
        <span className="text-[11px] text-gray-500 px-2 py-0.5 bg-gray-100 rounded">
          {TRIGGER_LABELS[flow.triggerType] ?? flow.triggerType}
        </span>

        <div className="ml-auto flex items-center gap-3">
          {saving && (
            <span className="text-[11px] text-gray-500 flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> saving…
            </span>
          )}
          {!saving && savedAt && (
            <span className="text-[11px] text-gray-400 flex items-center gap-1">
              <CheckCircle2 size={12} className="text-green-500" />
              saved {savedAt.toLocaleTimeString()}
            </span>
          )}

          <label className="flex items-center gap-2 text-[13px] text-gray-700 select-none">
            <button
              type="button"
              onClick={() => {
                setIsEnabled((prev) => !prev);
                queueSave();
              }}
              className={`shrink-0 w-10 h-6 rounded-full relative transition-colors ${
                isEnabled ? "bg-green-500" : "bg-gray-300"
              }`}
              title={isEnabled ? "Auto-run on" : "Auto-run off"}
            >
              <span
                className={`absolute top-0.5 ${
                  isEnabled ? "left-4" : "left-0.5"
                } w-5 h-5 rounded-full bg-white transition-all shadow`}
              />
            </button>
            {isEnabled ? "Auto-run ON" : "Paused"}
          </label>

          <button
            type="button"
            onClick={handleTestRun}
            disabled={testRunning}
            className="text-[12px] flex items-center gap-1 text-blue-700 border border-blue-200 hover:bg-blue-50 px-2 py-1 rounded-md"
          >
            {testRunning ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            Test run
          </button>
          <button
            type="button"
            onClick={() => void persist()}
            className="text-[12px] flex items-center gap-1 bg-gray-900 hover:bg-black text-white px-2 py-1 rounded-md"
          >
            <Save size={12} /> Save
          </button>
        </div>
      </div>

      {/* Test result toast */}
      {testResult && (
        <div className="px-4 py-2 bg-gray-900 text-gray-100 text-[12px] font-mono whitespace-pre-wrap relative">
          {testResult}
          <button
            type="button"
            onClick={() => setTestResult(null)}
            className="absolute right-2 top-1 text-gray-300 hover:text-white text-[11px]"
          >
            dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 text-[12px] text-red-700 bg-red-50 border-b border-red-200 flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left palette */}
        <aside className="w-56 border-r border-gray-200 bg-gray-50/50 overflow-y-auto p-3 space-y-4">
          <div>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Logic
            </div>
            <button
              type="button"
              onClick={() => addNode("condition")}
              className="w-full text-left rounded-md border border-purple-200 bg-white hover:bg-purple-50 px-2 py-2 text-[12px] text-purple-700 flex items-center gap-2"
            >
              <Filter size={13} /> Add condition
            </button>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Actions
            </div>
            <div className="space-y-1">
              {(Object.keys(ACTION_LABELS) as ActionKind[]).map((k) => {
                const Icon = ACTION_ICONS[k];
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => addNode("action", k)}
                    className="w-full text-left rounded-md border border-blue-200 bg-white hover:bg-blue-50 px-2 py-1.5 text-[12px] text-blue-700 flex items-center gap-2"
                  >
                    <Icon size={13} /> {ACTION_LABELS[k]}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Help
            </div>
            <div className="text-[11px] text-gray-500 leading-relaxed">
              Drag from the bottom dot of a block onto another block to wire
              them. Conditions have two outputs: <span className="text-green-700">true</span>{" "}
              (left) and <span className="text-red-700">false</span> (right).
            </div>
            <div className="text-[11px] text-gray-500 leading-relaxed mt-2">
              Use <code className="bg-gray-100 px-1 rounded">{"{{path}}"}</code>{" "}
              in template variables, message text, notes, and webhook URLs to
              inject any data point (e.g.{" "}
              <code className="bg-gray-100 px-1 rounded">{"{{order.customerName}}"}</code>).
            </div>
          </div>
        </aside>

        {/* Canvas */}
        <div className="flex-1 min-w-0 bg-[radial-gradient(circle,_#e2e8f0_1px,_transparent_1px)] [background-size:18px_18px] relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            onEdgeClick={(_event, edge) => {
              if (confirm("Delete this connection?")) {
                setEdges((eds) => eds.filter((e) => e.id !== edge.id));
                queueSave();
              }
            }}
            nodeTypes={nodeTypes}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
              style: { stroke: "#94a3b8", strokeWidth: 2, cursor: "pointer" },
            }}
          >
            <Background gap={18} size={1} />
            <Controls position="bottom-right" />
            <MiniMap pannable zoomable className="!bg-white !border !border-gray-200" />
          </ReactFlow>
        </div>

        {/* Right inspector */}
        <aside className="w-80 border-l border-gray-200 bg-white overflow-y-auto">
          {!selectedNode ? (
            <EmptyInspector flow={flow} description={description} onDescriptionChange={(d) => {
              setDescription(d);
              queueSave();
            }} />
          ) : (
            <NodeInspector
              node={selectedNode}
              dataPoints={dataPoints}
              templates={templates}
              onChange={(patch) => updateNodeData(selectedNode.id, patch)}
              onDelete={() => deleteNode(selectedNode.id)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Inspector
// ----------------------------------------------------------------------------

function EmptyInspector({
  flow,
  description,
  onDescriptionChange,
}: {
  flow: FlowDto;
  description: string;
  onDescriptionChange: (val: string) => void;
}) {
  return (
    <div className="p-4">
      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Flow settings
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-[12px] text-gray-700">Trigger</label>
          <div className="text-[13px] text-gray-900 mt-0.5">
            {TRIGGER_LABELS[flow.triggerType] ?? flow.triggerType}
          </div>
        </div>
        <label className="block">
          <span className="text-[12px] text-gray-700">Description</span>
          <textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={3}
            placeholder="What this flow does"
            className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
          />
        </label>
      </div>
      <div className="mt-6 text-[11px] text-gray-500 leading-relaxed">
        Click a block on the canvas to configure it here. Add new blocks from
        the left palette and wire them up by dragging from the bottom of one
        block onto the top of another.
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  dataPoints,
  templates,
  onChange,
  onDelete,
}: {
  node: Node;
  dataPoints: DataPoint[];
  templates: TemplateRow[];
  onChange: (patch: Partial<FlowNodeData>) => void;
  onDelete: () => void;
}) {
  const data = node.data as unknown as FlowNodeData;

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
          {data.kind === "trigger"
            ? "Trigger"
            : data.kind === "condition"
              ? "Condition"
              : "Action"}
        </div>
        {data.kind !== "trigger" && (
          <button
            type="button"
            onClick={onDelete}
            className="text-[11px] text-red-600 hover:text-red-800 flex items-center gap-1"
            title="Delete block"
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
      </div>

      {data.kind === "trigger" && <TriggerInspector data={data} onChange={onChange} />}
      {data.kind === "condition" && (
        <ConditionInspector data={data} dataPoints={dataPoints} onChange={onChange} />
      )}
      {data.kind === "action" && (
        <ActionInspector data={data} dataPoints={dataPoints} templates={templates} onChange={onChange} />
      )}

      {data.kind !== "trigger" && (
        <button
          type="button"
          onClick={onDelete}
          className="mt-6 w-full text-[12px] text-red-600 hover:text-white hover:bg-red-600 border border-red-200 rounded-md px-3 py-2 flex items-center justify-center gap-1 transition-colors"
        >
          <Trash2 size={12} /> Delete this step
        </button>
      )}
    </div>
  );
}

function TriggerInspector({
  data,
  onChange,
}: {
  data: TriggerData;
  onChange: (patch: Partial<FlowNodeData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[13px] text-gray-900 font-medium">
        {TRIGGER_LABELS[data.triggerType] ?? data.triggerType}
      </div>
      {data.triggerType === "ORDER_STATUS_CHANGED" && (
        <>
          <LabeledSelect
            label="Fire only when from status"
            value={data.fromStatus ?? ""}
            options={["", ...ORDER_STATUSES]}
            onChange={(v) => onChange({ fromStatus: v || null } as Partial<FlowNodeData>)}
          />
          <LabeledSelect
            label="Fire only when to status"
            value={data.toStatus ?? ""}
            options={["", ...ORDER_STATUSES]}
            onChange={(v) => onChange({ toStatus: v || null } as Partial<FlowNodeData>)}
          />
        </>
      )}
      {data.triggerType === "TRACKING_STATUS_CHANGED" && (
        <>
          <LabeledSelect
            label="Fire only when new tracking status"
            value={data.trackingToStatus ?? ""}
            options={["", ...TRACKING_STATUSES]}
            onChange={(v) =>
              onChange({ trackingToStatus: v || null } as Partial<FlowNodeData>)
            }
          />
        </>
      )}
      <div className="text-[11px] text-gray-500 leading-relaxed pt-2 border-t border-gray-100">
        This trigger fires automatically. Wire it to a Condition or Action
        block to make something happen.
      </div>
    </div>
  );
}

function ConditionInspector({
  data,
  dataPoints,
  onChange,
}: {
  data: ConditionData;
  dataPoints: DataPoint[];
  onChange: (patch: Partial<FlowNodeData>) => void;
}) {
  const currentDp = dataPoints.find((dp) => dp.path === data.field);
  const operatorOpts: ConditionOperator[] =
    currentDp?.type === "number"
      ? [
          "equals",
          "not_equals",
          "gt",
          "gte",
          "lt",
          "lte",
          "exists",
          "not_exists",
          "is_empty",
          "is_not_empty",
        ]
      : currentDp?.type === "boolean"
        ? ["equals", "not_equals"]
        : [
            "equals",
            "not_equals",
            "contains",
            "not_contains",
            "starts_with",
            "ends_with",
            "regex",
            "in",
            "not_in",
            "exists",
            "not_exists",
            "is_empty",
            "is_not_empty",
          ];

  return (
    <div className="space-y-3">
      <div>
        <label className="text-[12px] text-gray-700 block mb-1">Field</label>
        <select
          value={data.field}
          onChange={(e) => onChange({ field: e.target.value } as Partial<FlowNodeData>)}
          className="w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
        >
          {groupBy(dataPoints, (dp) => dp.group).map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((dp) => (
                <option key={dp.path} value={dp.path}>
                  {dp.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {currentDp?.description && (
          <div className="text-[10px] text-gray-500 mt-0.5">{currentDp.description}</div>
        )}
      </div>
      <LabeledSelect
        label="Operator"
        value={data.operator}
        options={operatorOpts}
        labelFor={(o) => OPERATOR_LABELS[o as ConditionOperator] ?? o}
        onChange={(v) => onChange({ operator: v as ConditionOperator } as Partial<FlowNodeData>)}
      />
      {!["exists", "not_exists", "is_empty", "is_not_empty"].includes(data.operator) && (
        <div>
          <label className="text-[12px] text-gray-700 block mb-1">
            Value{" "}
            {(data.operator === "in" || data.operator === "not_in") && (
              <span className="text-gray-400 text-[10px]">(comma-separated)</span>
            )}
          </label>
          {currentDp?.sampleOptions && currentDp.sampleOptions.length > 0 ? (
            <select
              value={data.value ?? ""}
              onChange={(e) => onChange({ value: e.target.value } as Partial<FlowNodeData>)}
              className="w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
            >
              <option value="">(empty)</option>
              {currentDp.sampleOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={data.value ?? ""}
              onChange={(e) => onChange({ value: e.target.value } as Partial<FlowNodeData>)}
              placeholder={
                data.operator === "regex"
                  ? "^\\+212\\d{9}$"
                  : data.operator === "in" || data.operator === "not_in"
                    ? "value1, value2, value3"
                    : "compare against"
              }
              className="w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
            />
          )}
        </div>
      )}
      <label className="text-[12px] text-gray-700 flex items-center gap-2">
        <input
          type="checkbox"
          checked={!!data.caseSensitive}
          onChange={(e) =>
            onChange({ caseSensitive: e.target.checked } as Partial<FlowNodeData>)
          }
        />
        Case sensitive
      </label>
    </div>
  );
}

function ActionInspector({
  data,
  dataPoints,
  templates,
  onChange,
}: {
  data: ActionData;
  dataPoints: DataPoint[];
  templates: TemplateRow[];
  onChange: (patch: Partial<FlowNodeData>) => void;
}) {
  return (
    <div className="space-y-3">
      <LabeledSelect
        label="Action"
        value={data.action}
        options={Object.keys(ACTION_LABELS)}
        labelFor={(a) => ACTION_LABELS[a as ActionKind] ?? a}
        onChange={(v) => onChange({ action: v as ActionKind } as Partial<FlowNodeData>)}
      />

      {data.action === "send_template" && (
        <>
          <div>
            <label className="text-[12px] text-gray-700 block mb-1">Template</label>
            <select
              value={data.templateName ?? ""}
              onChange={(e) => {
                const t = templates.find((tt) => tt.name === e.target.value);
                const varCount = countTemplateVariables(t?.bodyText ?? "");
                const existing = data.templateVariables ?? [];
                const vars =
                  varCount > 0
                    ? Array.from({ length: varCount }, (_, i) => existing[i] ?? "")
                    : existing;
                onChange({
                  templateName: e.target.value || null,
                  templateLanguage: t?.language ?? data.templateLanguage ?? "en",
                  templateVariables: vars,
                } as Partial<FlowNodeData>);
              }}
              className="w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
            >
              <option value="">— pick a template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name} ({t.language})
                </option>
              ))}
            </select>
          </div>
          <TemplateVariablesEditor
            variables={data.templateVariables ?? []}
            dataPoints={dataPoints}
            expectedCount={countTemplateVariables(
              templates.find((tt) => tt.name === data.templateName)?.bodyText ?? ""
            )}
            onChange={(vars) =>
              onChange({ templateVariables: vars } as Partial<FlowNodeData>)
            }
          />
          <HeaderImagePicker
            value={data.templateHeaderImageUrl ?? ""}
            onChange={(v) =>
              onChange({ templateHeaderImageUrl: v || null } as Partial<FlowNodeData>)
            }
          />
        </>
      )}

      {data.action === "send_text_message" && (
        <>
          <label className="text-[12px] text-gray-700 block">
            Message text
            <textarea
              value={data.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value } as Partial<FlowNodeData>)}
              rows={4}
              placeholder="Hi {{order.customerName}}, your order is on its way!"
              className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
            />
          </label>
          <div className="text-[10px] text-gray-500 leading-relaxed">
            Free-form text only delivers if the customer messaged you in the
            last 24 hours (Meta limitation). Use Send Template for cold sends.
          </div>
          <DataPointHelper dataPoints={dataPoints} />
        </>
      )}

      {data.action === "change_order_status" && (
        <LabeledSelect
          label="New status"
          value={data.targetStatus ?? ""}
          options={["", ...ORDER_STATUSES]}
          onChange={(v) =>
            onChange({ targetStatus: v || null } as Partial<FlowNodeData>)
          }
        />
      )}

      {data.action === "add_pipeline_note" && (
        <>
          <label className="text-[12px] text-gray-700 block">
            Note
            <textarea
              value={data.note ?? ""}
              onChange={(e) => onChange({ note: e.target.value } as Partial<FlowNodeData>)}
              rows={3}
              placeholder="Auto-noted: customer in {{order.customerCity}}"
              className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
            />
          </label>
          <DataPointHelper dataPoints={dataPoints} />
        </>
      )}

      {data.action === "wait" && (
        <LabeledInput
          label="Wait seconds"
          type="number"
          value={String(data.waitSeconds ?? 60)}
          onChange={(v) => {
            const n = parseInt(v, 10);
            onChange({
              waitSeconds: Number.isFinite(n) ? n : 0,
            } as Partial<FlowNodeData>);
          }}
        />
      )}

      {data.action === "webhook" && (
        <>
          <LabeledInput
            label="URL"
            value={data.webhookUrl ?? ""}
            placeholder="https://… (supports {{tokens}})"
            onChange={(v) => onChange({ webhookUrl: v || null } as Partial<FlowNodeData>)}
          />
          <LabeledSelect
            label="Method"
            value={data.webhookMethod ?? "POST"}
            options={["GET", "POST", "PUT", "PATCH", "DELETE"]}
            onChange={(v) =>
              onChange({ webhookMethod: v as ActionData["webhookMethod"] } as Partial<FlowNodeData>)
            }
          />
          <label className="text-[12px] text-gray-700 block">
            Headers JSON (optional)
            <textarea
              value={data.webhookHeadersJson ?? ""}
              onChange={(e) =>
                onChange({ webhookHeadersJson: e.target.value || null } as Partial<FlowNodeData>)
              }
              rows={2}
              placeholder='{"x-api-key": "..."}'
              className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px] font-mono"
            />
          </label>
          <label className="text-[12px] text-gray-700 block">
            Body template (optional)
            <textarea
              value={data.webhookBodyTemplate ?? ""}
              onChange={(e) =>
                onChange({ webhookBodyTemplate: e.target.value || null } as Partial<FlowNodeData>)
              }
              rows={4}
              placeholder='{"order": "{{order.codNetworkOrderId}}", "status": "{{order.status}}"}'
              className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px] font-mono"
            />
          </label>
        </>
      )}

      {data.action === "stop" && (
        <div className="text-[12px] text-gray-500 leading-relaxed">
          Stops the flow at this point. Useful inside the <em>false</em>{" "}
          branch of a Condition to bail out without sending anything.
        </div>
      )}
    </div>
  );
}

function TemplateVariablesEditor({
  variables,
  dataPoints,
  expectedCount,
  onChange,
}: {
  variables: string[];
  dataPoints: DataPoint[];
  expectedCount: number;
  onChange: (vars: string[]) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[12px] text-gray-700">
          Template variables
          {expectedCount > 0 && (
            <span className="ml-1 text-[10px] text-gray-500">
              ({expectedCount} required)
            </span>
          )}
        </label>
        <button
          type="button"
          onClick={() => onChange([...variables, ""])}
          className="text-[11px] text-blue-700 hover:text-blue-900 flex items-center gap-1"
        >
          <Plus size={11} /> Add slot
        </button>
      </div>
      {expectedCount > 0 && variables.length !== expectedCount && (
        <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1">
          Template expects {expectedCount} variable{expectedCount !== 1 ? "s" : ""}, but {variables.length} provided.
        </div>
      )}
      {variables.length === 0 && expectedCount === 0 && (
        <div className="text-[10px] text-gray-500">
          No variables — template will be sent with no body params.
        </div>
      )}
      <div className="space-y-1">
        {variables.map((slot, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 w-7">
              <Hash size={10} className="inline" />
              {i + 1}
            </span>
            <input
              value={slot}
              onChange={(e) => {
                const next = [...variables];
                next[i] = e.target.value;
                onChange(next);
              }}
              placeholder="{{order.customerName}} or literal text"
              className="flex-1 border border-gray-200 rounded-md px-2 py-1 text-[11px] font-mono"
            />
            <button
              type="button"
              onClick={() => onChange(variables.filter((_, j) => j !== i))}
              className="text-gray-400 hover:text-red-600 p-1"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      <DataPointHelper dataPoints={dataPoints} />
    </div>
  );
}

function DataPointHelper({ dataPoints }: { dataPoints: DataPoint[] }) {
  return (
    <details className="text-[10px] text-gray-500 mt-1">
      <summary className="cursor-pointer text-[11px] text-gray-600 hover:text-gray-900">
        Available data points ({dataPoints.length})
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-0.5 max-h-48 overflow-y-auto pr-1">
        {dataPoints.map((dp) => (
          <code
            key={dp.path}
            className="bg-gray-50 hover:bg-gray-100 px-1 py-0.5 rounded font-mono text-[10px] text-gray-700 cursor-text select-all"
          >
            {`{{${dp.path}}}`}
          </code>
        ))}
      </div>
    </details>
  );
}

// ----------------------------------------------------------------------------
// Media gallery picker for template header images
// ----------------------------------------------------------------------------

interface MediaAsset {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
  metaMediaId: string | null;
  createdAt: string;
}

function HeaderImagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [gallery, setGallery] = useState<MediaAsset[]>([]);
  const [showGallery, setShowGallery] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showGallery) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ assets: MediaAsset[] }>("/media-assets");
        if (!cancelled) setGallery(res.assets);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [showGallery]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/media-assets", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error((err as { error?: string }).error ?? "Upload failed");
      }
      const data = (await res.json()) as { asset: MediaAsset };
      setGallery((prev) => [data.asset, ...prev]);
      onChange(data.asset.url);
      setShowGallery(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <label className="text-[12px] text-gray-700 block mb-1">
        Header image (optional)
      </label>
      {value && (
        <div className="mb-2 relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="Header"
            className="w-20 h-20 object-cover rounded border border-gray-200"
          />
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] leading-none hover:bg-red-700"
            title="Remove"
          >
            ×
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowGallery(!showGallery)}
          className="text-[11px] text-blue-700 hover:text-blue-900 border border-blue-200 rounded px-2 py-1 flex items-center gap-1"
        >
          <Upload size={11} /> {showGallery ? "Hide gallery" : "Choose image"}
        </button>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="…or paste URL"
          className="flex-1 border border-gray-200 rounded-md px-2 py-1 text-[11px]"
        />
      </div>
      {showGallery && (
        <div className="mt-2 border border-gray-200 rounded-md p-2 bg-gray-50 max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-gray-600">Image gallery</span>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="text-[11px] text-blue-700 hover:text-blue-900 flex items-center gap-1"
            >
              {uploading ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
              Upload new
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = "";
              }}
            />
          </div>
          {uploadError && (
            <div className="text-[10px] text-red-600 mb-1">{uploadError}</div>
          )}
          {gallery.length === 0 && !uploading && (
            <div className="text-[10px] text-gray-500 py-4 text-center">
              No images yet — upload your first one.
            </div>
          )}
          <div className="grid grid-cols-3 gap-1">
            {gallery.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => {
                  onChange(asset.url);
                  setShowGallery(false);
                }}
                className={`relative rounded border-2 overflow-hidden ${
                  value === asset.url ? "border-blue-500" : "border-transparent hover:border-gray-300"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.url}
                  alt={asset.filename}
                  className="w-full aspect-square object-cover"
                />
                <div className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[8px] px-1 py-0.5 truncate">
                  {asset.filename}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function countTemplateVariables(bodyText: string): number {
  if (!bodyText) return 0;
  const matches = bodyText.match(/{{\s*\d+\s*}}/g);
  if (!matches) return 0;
  const nums = matches.map((m) => parseInt(m.replace(/[{}]/g, "").trim(), 10));
  return Math.max(...nums);
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="text-[12px] text-gray-700 block">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
      />
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  onChange,
  labelFor,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  labelFor?: (option: string) => string;
}) {
  return (
    <label className="text-[12px] text-gray-700 block">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1 text-[12px]"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o === "" ? "(any)" : labelFor ? labelFor(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return Array.from(map.entries());
}

function randomPosition(): { x: number; y: number } {
  return {
    x: 300 + Math.floor(Math.random() * 200),
    y: 260 + Math.floor(Math.random() * 200),
  };
}

// Silence Phone import unused warning — keep the import for future
// "send call agent" UI variants.
void Phone;
