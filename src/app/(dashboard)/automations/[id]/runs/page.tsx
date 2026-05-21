/**
 * Per-flow run history view. Lists every execution attempt with a
 * collapsible step-by-step timeline so the operator can debug why a flow
 * stopped at a particular node.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  StopCircle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api-client";

interface FlowRunStep {
  nodeId: string;
  nodeType: "trigger" | "condition" | "action";
  nodeKind: string;
  status: "success" | "failed" | "skipped";
  branch?: "true" | "false";
  output?: string;
  error?: string;
  ranAt: string;
}

interface FlowRun {
  id: string;
  flowId: string;
  orderId: string | null;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "STOPPED";
  stepsJson: FlowRunStep[];
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface FlowDto {
  id: string;
  name: string;
}

export default function FlowRunsPage() {
  const params = useParams<{ id: string }>();
  const flowId = params.id;
  const [flow, setFlow] = useState<FlowDto | null>(null);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, r] = await Promise.all([
        api.get<{ flow: FlowDto }>(`/api/automation-flows/${flowId}`),
        api.get<{ runs: FlowRun[] }>(`/api/automation-flows/${flowId}/runs?limit=100`),
      ]);
      setFlow(f.flow);
      setRuns(r.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <Link
          href={`/automations/${flowId}`}
          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-[16px] font-semibold text-gray-900">
          {flow?.name ?? "Flow"} — Run history
        </h1>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto text-[12px] text-gray-600 hover:text-gray-900 flex items-center gap-1 border border-gray-200 px-2 py-1 rounded-md"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 text-[13px] text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-[13px] text-gray-500">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-gray-500 border border-dashed border-gray-200 rounded-lg">
          No runs yet — this flow hasn&apos;t fired or hasn&apos;t been enabled.
        </div>
      ) : (
        <div className="space-y-1">
          {runs.map((run) => {
            const open = expanded[run.id] ?? false;
            return (
              <div key={run.id} className="border border-gray-200 rounded-lg bg-white">
                <button
                  type="button"
                  onClick={() => setExpanded({ ...expanded, [run.id]: !open })}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left"
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <StatusIcon status={run.status} />
                  <span className="text-[12px] font-medium text-gray-900">
                    {run.status}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                  <span className="text-[11px] text-gray-400 ml-2">
                    {run.stepsJson.length} step{run.stepsJson.length === 1 ? "" : "s"}
                  </span>
                  {run.errorMessage && (
                    <span className="text-[11px] text-red-600 ml-2 truncate">
                      {run.errorMessage}
                    </span>
                  )}
                  {run.orderId && (
                    <Link
                      href={`/pipeline?orderId=${run.orderId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[11px] text-blue-600 hover:underline ml-auto"
                    >
                      view order
                    </Link>
                  )}
                </button>
                {open && (
                  <div className="border-t border-gray-100 px-3 py-2 space-y-1.5">
                    {run.stepsJson.map((step, i) => (
                      <div key={i} className="flex items-start gap-2 text-[12px]">
                        <StepBadge step={step} />
                        <div className="flex-1 min-w-0">
                          <div className="text-gray-900">
                            <span className="font-medium">{step.nodeType}</span>{" "}
                            <span className="text-gray-500">{step.nodeKind}</span>
                            {step.branch && (
                              <span
                                className={`ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  step.branch === "true"
                                    ? "bg-green-100 text-green-700"
                                    : "bg-red-100 text-red-700"
                                }`}
                              >
                                {step.branch}
                              </span>
                            )}
                          </div>
                          {step.output && (
                            <div className="text-[11px] text-gray-600 mt-0.5 break-all">
                              {step.output}
                            </div>
                          )}
                          {step.error && (
                            <div className="text-[11px] text-red-600 mt-0.5 break-all">
                              {step.error}
                            </div>
                          )}
                        </div>
                        <div className="text-[10px] text-gray-400 shrink-0">
                          {new Date(step.ranAt).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "SUCCESS") return <CheckCircle2 size={14} className="text-green-500" />;
  if (status === "FAILED") return <XCircle size={14} className="text-red-500" />;
  if (status === "STOPPED") return <StopCircle size={14} className="text-yellow-500" />;
  return <Loader2 size={14} className="text-blue-500 animate-spin" />;
}

function StepBadge({ step }: { step: FlowRunStep }) {
  if (step.status === "success")
    return <CheckCircle2 size={13} className="text-green-500 mt-0.5" />;
  if (step.status === "failed")
    return <XCircle size={13} className="text-red-500 mt-0.5" />;
  return <span className="w-3 h-3 rounded-full bg-gray-300 mt-1" />;
}
