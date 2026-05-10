"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import {
  Plus,
  Trash2,
  PlayCircle,
  Zap,
  RefreshCw,
  CheckCircle2,
  XCircle,
} from "lucide-react";

type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "RETURNED"
  | "CANCELLED"
  | "UNKNOWN";

const STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
];

interface Automation {
  id: string;
  name: string;
  isEnabled: boolean;
  whenStatusEquals: OrderStatus | null;
  andProductContains: string | null;
  andProductDoesNotContain: string | null;
  thenMoveToStatus: OrderStatus | null;
  thenSendTemplateName: string | null;
  thenSendTemplateLanguage: string | null;
  thenSendOnce: boolean;
  createdAt: string;
  _count?: { runs: number };
}

interface TemplateInfo {
  name: string;
  language: string;
  status: string;
}

interface PreviewResult {
  candidateOrdersScanned: number;
  matchingCount: number;
  sampleMatches: Array<{
    id: string;
    codNetworkOrderId: string;
    customerName: string | null;
    productName: string | null;
    status: string;
  }>;
}

export default function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const showToast = useCallback((kind: "success" | "error", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchAutomations = useCallback(async () => {
    try {
      const data = await api.get<{ automations: Automation[] }>("/automations");
      setAutomations(data.automations);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to load automations");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const fetchTemplates = useCallback(async () => {
    try {
      const data = await api.get<{ templates: TemplateInfo[] }>(
        "/whatsapp/templates/cached?status=APPROVED"
      );
      setTemplates(data.templates);
    } catch {
      // Templates are optional — automations work without them.
    }
  }, []);

  useEffect(() => {
    // Sync remote automations + templates into local state on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAutomations();
    fetchTemplates();
  }, [fetchAutomations, fetchTemplates]);

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Zap className="text-amber-500" size={24} />
            Automations
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Define rules that move orders between pipeline columns and send
            WhatsApp template messages automatically whenever an order changes
            status — via sync, webhook, or manual drag in the Pipeline.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={16} />
          New Automation
        </button>
      </div>

      {toast && (
        <div
          className={`mb-4 p-3 rounded-md text-sm border ${
            toast.kind === "success"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {toast.text}
        </div>
      )}

      {showCreate && (
        <CreateAutomationForm
          templates={templates}
          onCancel={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            fetchAutomations();
            showToast("success", "Automation created");
          }}
          onError={(msg) => showToast("error", msg)}
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="animate-spin text-gray-400" size={24} />
        </div>
      ) : automations.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <Zap className="mx-auto text-gray-300" size={32} />
          <p className="text-gray-500 mt-2 text-sm">
            No automations yet. Click <strong>New Automation</strong> to create
            your first rule.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              templates={templates}
              onChange={fetchAutomations}
              onToast={showToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateAutomationForm({
  templates,
  onCancel,
  onCreated,
  onError,
}: {
  templates: TemplateInfo[];
  onCancel: () => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [whenStatus, setWhenStatus] = useState<string>("");
  const [andProduct, setAndProduct] = useState("");
  const [andNotProduct, setAndNotProduct] = useState("");
  const [thenMoveTo, setThenMoveTo] = useState<string>("");
  const [thenSendTemplate, setThenSendTemplate] = useState("");
  const [thenSendOnce, setThenSendOnce] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      onError("Name is required");
      return;
    }
    setSubmitting(true);
    try {
      const tpl = templates.find((t) => t.name === thenSendTemplate);
      await api.post("/automations", {
        name: name.trim(),
        isEnabled: false, // safer default — preview first, then enable
        whenStatusEquals: whenStatus || null,
        andProductContains: andProduct || null,
        andProductDoesNotContain: andNotProduct || null,
        thenMoveToStatus: thenMoveTo || null,
        thenSendTemplateName: thenSendTemplate || null,
        thenSendTemplateLanguage: tpl?.language || null,
        thenSendOnce,
      });
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create automation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">New Automation</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Send shipping notice for Eczema cream"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </Field>
        <Field label="When status equals">
          <select
            value={whenStatus}
            onChange={(e) => setWhenStatus(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="">— any status —</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="...and product contains" help="Case-insensitive substring match on the order's product name">
          <input
            type="text"
            value={andProduct}
            onChange={(e) => setAndProduct(e.target.value)}
            placeholder="e.g. Eczema"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </Field>
        <Field label="...and product does NOT contain">
          <input
            type="text"
            value={andNotProduct}
            onChange={(e) => setAndNotProduct(e.target.value)}
            placeholder="optional"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </Field>
        <Field label="Then move order to status">
          <select
            value={thenMoveTo}
            onChange={(e) => setThenMoveTo(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="">— don&apos;t change status —</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Then send WhatsApp template">
          <select
            value={thenSendTemplate}
            onChange={(e) => setThenSendTemplate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="">— don&apos;t send a message —</option>
            {templates.map((t) => (
              <option key={`${t.name}_${t.language}`} value={t.name}>
                {t.name} ({t.language})
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex items-center gap-2 mt-4">
        <input
          id="sendOnce"
          type="checkbox"
          checked={thenSendOnce}
          onChange={(e) => setThenSendOnce(e.target.checked)}
          className="rounded border-gray-300"
        />
        <label htmlFor="sendOnce" className="text-sm text-gray-700">
          Send only once per order (recommended — prevents duplicate messages)
        </label>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onCancel}
          className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting}
          className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create (disabled by default)"}
        </button>
      </div>
    </div>
  );
}

function AutomationCard({
  automation,
  templates,
  onChange,
  onToast,
}: {
  automation: Automation;
  templates: TemplateInfo[];
  onChange: () => void;
  onToast: (kind: "success" | "error", text: string) => void;
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const toggleEnabled = async () => {
    try {
      await api.patch(`/automations/${automation.id}`, {
        isEnabled: !automation.isEnabled,
      });
      onChange();
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : "Toggle failed");
    }
  };

  const remove = async () => {
    if (!confirm(`Delete automation "${automation.name}"?`)) return;
    try {
      await api.del(`/automations/${automation.id}`);
      onToast("success", "Automation deleted");
      onChange();
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : "Delete failed");
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const data = await api.post<PreviewResult>(
        `/automations/${automation.id}?action=preview`,
        {}
      );
      setPreview(data);
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  };

  const runNow = async () => {
    if (
      !confirm(
        `Apply automation "${automation.name}" to all currently-matching orders now? This will move them and send the configured WhatsApp template.`
      )
    )
      return;
    try {
      const data = await api.post<{ applied: number; failed: number; matchingCount: number }>(
        `/automations/${automation.id}?action=run-now`,
        {}
      );
      onToast(
        "success",
        `Applied to ${data.applied} of ${data.matchingCount} matching orders (${data.failed} failed)`
      );
      onChange();
    } catch (err) {
      onToast("error", err instanceof Error ? err.message : "Run-now failed");
    }
  };

  const tpl = templates.find((t) => t.name === automation.thenSendTemplateName);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">{automation.name}</h3>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                automation.isEnabled
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {automation.isEnabled ? "ENABLED" : "Disabled"}
            </span>
            {automation._count && (
              <span className="text-xs text-gray-500">
                {automation._count.runs} runs
              </span>
            )}
          </div>
          <div className="mt-2 text-sm text-gray-700 space-y-1">
            <div>
              <strong>When</strong>{" "}
              {automation.whenStatusEquals ? (
                <code className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">
                  status = {automation.whenStatusEquals}
                </code>
              ) : (
                "any status"
              )}
              {automation.andProductContains && (
                <>
                  {" "}
                  AND product contains{" "}
                  <code className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-xs">
                    {automation.andProductContains}
                  </code>
                </>
              )}
              {automation.andProductDoesNotContain && (
                <>
                  {" "}
                  AND product does NOT contain{" "}
                  <code className="px-1.5 py-0.5 bg-rose-50 text-rose-700 rounded text-xs">
                    {automation.andProductDoesNotContain}
                  </code>
                </>
              )}
            </div>
            <div>
              <strong>Then</strong>{" "}
              {automation.thenMoveToStatus && (
                <>
                  move to{" "}
                  <code className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded text-xs">
                    {automation.thenMoveToStatus}
                  </code>
                </>
              )}
              {automation.thenMoveToStatus && automation.thenSendTemplateName && " and "}
              {automation.thenSendTemplateName && (
                <>
                  send template{" "}
                  <code className="px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-xs">
                    {automation.thenSendTemplateName}
                  </code>
                  {tpl && tpl.status !== "APPROVED" && (
                    <span className="ml-1 text-xs text-amber-700">
                      ({tpl.status})
                    </span>
                  )}
                </>
              )}
              {!automation.thenMoveToStatus && !automation.thenSendTemplateName && "no action"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleEnabled}
            className={`text-xs px-3 py-1.5 rounded-md font-medium border ${
              automation.isEnabled
                ? "bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100"
                : "bg-blue-600 border-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {automation.isEnabled ? "Disable" : "Enable"}
          </button>
          <button
            onClick={remove}
            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
        <button
          onClick={runPreview}
          disabled={previewing}
          className="flex items-center gap-1 text-xs px-2.5 py-1 text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
        >
          <PlayCircle size={14} />
          {previewing ? "Previewing..." : "Preview impact"}
        </button>
        <button
          onClick={runNow}
          className="flex items-center gap-1 text-xs px-2.5 py-1 text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
        >
          <Zap size={14} />
          Run now
        </button>
      </div>

      {preview && (
        <div className="mt-3 text-xs bg-gray-50 border border-gray-200 rounded p-3">
          <div className="font-medium text-gray-700">
            {preview.matchingCount > 0 ? (
              <span className="text-green-700 inline-flex items-center gap-1">
                <CheckCircle2 size={14} />
                Would match {preview.matchingCount} of{" "}
                {preview.candidateOrdersScanned} orders
              </span>
            ) : (
              <span className="text-rose-700 inline-flex items-center gap-1">
                <XCircle size={14} />
                Would match 0 of {preview.candidateOrdersScanned} orders
              </span>
            )}
          </div>
          {preview.sampleMatches.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-gray-500">Sample matches:</div>
              {preview.sampleMatches.slice(0, 5).map((o) => (
                <div key={o.id} className="font-mono text-gray-700">
                  #{o.codNetworkOrderId.slice(-6)} — {o.customerName || "?"} —{" "}
                  {o.productName || "no product"}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        {label}
      </label>
      {children}
      {help && <p className="mt-1 text-[11px] text-gray-500">{help}</p>}
    </div>
  );
}
