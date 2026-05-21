/**
 * The new flow-builder list view. Shows every saved AutomationFlow with
 * its enable toggle, run counter, and quick links to the canvas editor
 * and per-run history.
 *
 * The previous CRUD-style automations editor still works and lives at
 * `/automations/classic` — surfaced as a tab here so the operator can
 * switch between paradigms without losing the rules they already wired
 * up before the revamp.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus,
  Zap,
  History,
  Trash2,
  Copy,
  Play,
  Pencil,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api-client";

type FlowTriggerType =
  | "ORDER_CREATED"
  | "ORDER_STATUS_CHANGED"
  | "TRACKING_STATUS_CHANGED"
  | "MESSAGE_RECEIVED"
  | "MANUAL";

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  triggerType: FlowTriggerType;
  lastFiredAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

const TRIGGER_LABELS: Record<FlowTriggerType, string> = {
  ORDER_CREATED: "Order created",
  ORDER_STATUS_CHANGED: "Order status changed",
  TRACKING_STATUS_CHANGED: "Tracking status changed",
  MESSAGE_RECEIVED: "Customer reply received",
  MANUAL: "Manual trigger",
};

const TRIGGER_OPTIONS: FlowTriggerType[] = [
  "ORDER_STATUS_CHANGED",
  "TRACKING_STATUS_CHANGED",
  "ORDER_CREATED",
  "MESSAGE_RECEIVED",
  "MANUAL",
];

export default function AutomationFlowsPage() {
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTrigger, setNewTrigger] = useState<FlowTriggerType>(
    "ORDER_STATUS_CHANGED"
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ flows: FlowRow[] }>("/api/automation-flows");
      setFlows(res.flows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) {
      setError("Name is required");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await api.post<{ flow: FlowRow }>("/api/automation-flows", {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        triggerType: newTrigger,
      });
      // After creating, jump straight into the canvas editor so the user
      // doesn't have to take an extra click to start building.
      window.location.href = `/automations/${res.flow.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create flow");
      setCreating(false);
    }
  };

  const handleToggle = async (flow: FlowRow) => {
    const next = !flow.isEnabled;
    setFlows((prev) =>
      prev.map((f) => (f.id === flow.id ? { ...f, isEnabled: next } : f))
    );
    try {
      await api.patch(`/api/automation-flows/${flow.id}`, { isEnabled: next });
    } catch (err) {
      setFlows((prev) =>
        prev.map((f) => (f.id === flow.id ? { ...f, isEnabled: flow.isEnabled } : f))
      );
      setError(err instanceof Error ? err.message : "Toggle failed");
    }
  };

  const handleDuplicate = async (flowId: string) => {
    try {
      await api.post(`/api/automation-flows/${flowId}/duplicate`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Duplicate failed");
    }
  };

  const handleDelete = async (flow: FlowRow) => {
    if (!confirm(`Delete flow "${flow.name}"? This cannot be undone.`)) return;
    try {
      await api.del(`/api/automation-flows/${flow.id}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Zap size={20} className="text-yellow-500" /> Automations
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Visual flow builder — drag blocks, wire conditions, and watch flows
            run automatically when the trigger fires.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/automations/classic"
            className="text-[13px] text-gray-600 hover:text-gray-900 border border-gray-200 px-3 py-1.5 rounded-md"
          >
            Classic rules
          </Link>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md text-[13px] font-medium"
          >
            <Plus size={15} /> New flow
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[13px] text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="mb-4 border border-gray-200 rounded-lg bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Create a flow</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-[13px] text-gray-700 flex flex-col gap-1">
              Name
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Out-for-delivery → send template"
                className="border border-gray-200 rounded-md px-2 py-1.5 text-[13px]"
              />
            </label>
            <label className="text-[13px] text-gray-700 flex flex-col gap-1">
              Trigger
              <select
                value={newTrigger}
                onChange={(e) => setNewTrigger(e.target.value as FlowTriggerType)}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-[13px]"
              >
                {TRIGGER_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[13px] text-gray-700 flex flex-col gap-1 md:col-span-2">
              Description (optional)
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What does this flow do?"
                className="border border-gray-200 rounded-md px-2 py-1.5 text-[13px]"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              disabled={creating}
              onClick={handleCreate}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-[13px] font-medium"
            >
              {creating ? "Creating…" : "Create and open editor"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setNewName("");
                setNewDescription("");
              }}
              className="text-[13px] text-gray-600 hover:text-gray-900 px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-[13px] text-gray-500 py-12 text-center">Loading flows…</div>
      ) : flows.length === 0 ? (
        <div className="border border-dashed border-gray-200 rounded-lg py-12 text-center">
          <div className="text-sm text-gray-700 font-medium">No flows yet</div>
          <div className="text-[12px] text-gray-500 mt-1 mb-3">
            Build a visual automation by dragging trigger → condition → action
            blocks onto a canvas. Flows run automatically end-to-end when the
            trigger fires.
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md text-[13px] font-medium"
          >
            <Plus size={15} /> Create your first flow
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {flows.map((flow) => (
            <div
              key={flow.id}
              className="border border-gray-200 rounded-lg bg-white p-4 flex items-center gap-4"
            >
              <button
                type="button"
                onClick={() => handleToggle(flow)}
                className={`shrink-0 w-10 h-6 rounded-full relative transition-colors ${
                  flow.isEnabled ? "bg-green-500" : "bg-gray-300"
                }`}
                title={flow.isEnabled ? "Disable" : "Enable"}
              >
                <span
                  className={`absolute top-0.5 ${
                    flow.isEnabled ? "left-4" : "left-0.5"
                  } w-5 h-5 rounded-full bg-white transition-all shadow`}
                />
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/automations/${flow.id}`}
                    className="text-[14px] font-semibold text-gray-900 hover:text-blue-600 truncate"
                  >
                    {flow.name}
                  </Link>
                  <span className="inline-block text-[11px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                    {TRIGGER_LABELS[flow.triggerType] ?? flow.triggerType}
                  </span>
                  {!flow.isEnabled && (
                    <span className="inline-block text-[11px] font-medium px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800">
                      paused
                    </span>
                  )}
                </div>
                {flow.description && (
                  <div className="text-[12px] text-gray-500 mt-0.5 truncate">
                    {flow.description}
                  </div>
                )}
                <div className="text-[11px] text-gray-400 mt-1 flex items-center gap-3">
                  <span>{flow.runCount} runs</span>
                  {flow.lastFiredAt && (
                    <span>last fired {new Date(flow.lastFiredAt).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Link
                  href={`/automations/${flow.id}/runs`}
                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-900"
                  title="Run history"
                >
                  <History size={15} />
                </Link>
                <button
                  type="button"
                  onClick={() => handleDuplicate(flow.id)}
                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-900"
                  title="Duplicate"
                >
                  <Copy size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(flow)}
                  className="p-1.5 rounded hover:bg-red-50 text-gray-500 hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 size={15} />
                </button>
                <Link
                  href={`/automations/${flow.id}`}
                  className="ml-1 inline-flex items-center gap-1 bg-gray-900 hover:bg-black text-white text-[12px] font-medium px-2.5 py-1 rounded"
                >
                  <Pencil size={13} /> Edit
                  <ChevronRight size={13} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 text-[11px] text-gray-400 leading-relaxed">
        <strong className="text-gray-500">Auto-run</strong>: flows fire
        automatically end-to-end whenever their trigger event happens — no
        manual click required. Toggle off with the green switch above to pause
        a flow without deleting it. Test runs are available from the editor.
        Use the <Play size={11} className="inline" />{" "}
        <Link href="/automations/classic" className="underline">classic rules</Link>{" "}
        view to see legacy automations that were created before the flow
        builder existed.
      </div>
    </div>
  );
}
