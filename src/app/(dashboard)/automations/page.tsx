"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import {
  Plus,
  Trash2,
  PlayCircle,
  Zap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Pencil,
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

// Tokens an operator can drop into a template variable slot. Each token gets
// replaced with the matching field on the order being processed by the
// automation engine. Keep this list in sync with `ORDER_VARIABLE_TOKENS` in
// `src/lib/automations.ts`.
const VARIABLE_TOKENS = [
  { token: "{customer_name}", label: "Customer name" },
  { token: "{phone}", label: "Phone" },
  { token: "{city}", label: "City" },
  { token: "{product}", label: "Product" },
  { token: "{price}", label: "Price" },
  { token: "{quantity}", label: "Quantity" },
  { token: "{tracking}", label: "Tracking #" },
  { token: "{order_id}", label: "Order ID" },
  { token: "{lead_id}", label: "Lead ID" },
  { token: "{delivery_company}", label: "Carrier" },
] as const;

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
  thenSendTemplateVariables: string[] | null;
  thenSendHeaderImageUrl: string | null;
  thenSendOnce: boolean;
  createdAt: string;
  _count?: { runs: number };
}

interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  bodyParamCount: number;
  bodyText: string | null;
  headerType: string | null;
}

interface ProductInfo {
  id: string;
  name: string;
  sku: string | null;
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
  const [products, setProducts] = useState<ProductInfo[]>([]);
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

  const fetchProducts = useCallback(async () => {
    try {
      const data = await api.get<{ products: ProductInfo[] }>("/products?pageSize=500");
      setProducts(data.products);
    } catch {
      // Product catalog is optional — operators can still type substrings.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAutomations();
    fetchTemplates();
    fetchProducts();
  }, [fetchAutomations, fetchTemplates, fetchProducts]);

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
        <AutomationForm
          mode="create"
          templates={templates}
          products={products}
          onCancel={() => setShowCreate(false)}
          onSaved={() => {
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
              products={products}
              onChange={fetchAutomations}
              onToast={showToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FormState {
  name: string;
  whenStatus: string;
  andProduct: string;
  andNotProduct: string;
  thenMoveTo: string;
  thenSendTemplate: string;
  thenSendTemplateLanguage: string;
  thenSendOnce: boolean;
  templateVariables: string[];
  headerImageUrl: string;
}

function buildInitialState(automation?: Automation): FormState {
  return {
    name: automation?.name ?? "",
    whenStatus: automation?.whenStatusEquals ?? "",
    andProduct: automation?.andProductContains ?? "",
    andNotProduct: automation?.andProductDoesNotContain ?? "",
    thenMoveTo: automation?.thenMoveToStatus ?? "",
    thenSendTemplate: automation?.thenSendTemplateName ?? "",
    thenSendTemplateLanguage: automation?.thenSendTemplateLanguage ?? "",
    thenSendOnce: automation?.thenSendOnce ?? true,
    templateVariables: Array.isArray(automation?.thenSendTemplateVariables)
      ? [...automation.thenSendTemplateVariables]
      : [],
    headerImageUrl: automation?.thenSendHeaderImageUrl ?? "",
  };
}

function AutomationForm({
  mode,
  automation,
  templates,
  products,
  onCancel,
  onSaved,
  onError,
}: {
  mode: "create" | "edit";
  automation?: Automation;
  templates: TemplateInfo[];
  products: ProductInfo[];
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [state, setState] = useState<FormState>(() => buildInitialState(automation));
  const [submitting, setSubmitting] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.name === state.thenSendTemplate) ?? null,
    [templates, state.thenSendTemplate]
  );
  const paramCount = selectedTemplate?.bodyParamCount ?? 0;

  // Keep the variable slot array length in sync with the template's body
  // param count. Preserves any tokens the operator already picked when the
  // template has the same arity. This is a syncing-React-state-with-derived-
  // data effect; setState() in the body is intentional.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => {
      const current = s.templateVariables;
      if (current.length === paramCount) return s;
      const next = Array.from(
        { length: paramCount },
        (_, i) => current[i] ?? ""
      );
      return { ...s, templateVariables: next };
    });
  }, [paramCount]);

  // Auto-fill the template language when an operator picks a template.
  useEffect(() => {
    if (selectedTemplate && !state.thenSendTemplateLanguage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState((s) => ({
        ...s,
        thenSendTemplateLanguage: selectedTemplate.language,
      }));
    }
  }, [selectedTemplate, state.thenSendTemplateLanguage]);

  const submit = async () => {
    if (!state.name.trim()) {
      onError("Name is required");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        name: state.name.trim(),
        whenStatusEquals: state.whenStatus || null,
        andProductContains: state.andProduct.trim() || null,
        andProductDoesNotContain: state.andNotProduct.trim() || null,
        thenMoveToStatus: state.thenMoveTo || null,
        thenSendTemplateName: state.thenSendTemplate || null,
        thenSendTemplateLanguage:
          state.thenSendTemplateLanguage ||
          selectedTemplate?.language ||
          null,
        thenSendTemplateVariables: state.templateVariables.slice(0, paramCount),
        thenSendHeaderImageUrl: state.headerImageUrl.trim() || null,
        thenSendOnce: state.thenSendOnce,
        ...(mode === "create" ? { isEnabled: false } : {}),
      };
      if (mode === "create") {
        await api.post("/automations", body);
      } else if (automation) {
        await api.patch(`/automations/${automation.id}`, body);
      }
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        {mode === "create" ? "New Automation" : "Edit Automation"}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <input
            type="text"
            value={state.name}
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
            placeholder="e.g. Shipping notice for Eczema cream"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </Field>
        <Field label="When status equals">
          <select
            value={state.whenStatus}
            onChange={(e) => setState((s) => ({ ...s, whenStatus: e.target.value }))}
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
        <Field
          label="...and product contains"
          help="Pick from your imported catalog or type any substring (case-insensitive)."
        >
          <ProductPicker
            value={state.andProduct}
            products={products}
            onChange={(v) => setState((s) => ({ ...s, andProduct: v }))}
          />
        </Field>
        <Field label="...and product does NOT contain">
          <input
            type="text"
            value={state.andNotProduct}
            onChange={(e) =>
              setState((s) => ({ ...s, andNotProduct: e.target.value }))
            }
            placeholder="optional"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </Field>
        <Field label="Then move order to status">
          <select
            value={state.thenMoveTo}
            onChange={(e) => setState((s) => ({ ...s, thenMoveTo: e.target.value }))}
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
            value={state.thenSendTemplate}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                thenSendTemplate: e.target.value,
                // Clear variables when switching template — they're slotted
                // differently across templates.
                templateVariables: [],
                thenSendTemplateLanguage:
                  templates.find((t) => t.name === e.target.value)?.language ||
                  "",
              }))
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="">— don&apos;t send a message —</option>
            {templates.map((t) => (
              <option key={`${t.name}_${t.language}`} value={t.name}>
                {t.name} ({t.language}) · {t.bodyParamCount} params
                {t.headerType === "IMAGE" ? " · IMAGE header" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {selectedTemplate && (
        <TemplatePreview
          template={selectedTemplate}
          variables={state.templateVariables}
          onVariableChange={(idx, value) =>
            setState((s) => {
              const next = [...s.templateVariables];
              next[idx] = value;
              return { ...s, templateVariables: next };
            })
          }
          headerImageUrl={state.headerImageUrl}
          onHeaderImageChange={(v) =>
            setState((s) => ({ ...s, headerImageUrl: v }))
          }
        />
      )}

      <div className="flex items-center gap-2 mt-4">
        <input
          id={`sendOnce-${automation?.id ?? "new"}`}
          type="checkbox"
          checked={state.thenSendOnce}
          onChange={(e) =>
            setState((s) => ({ ...s, thenSendOnce: e.target.checked }))
          }
          className="rounded border-gray-300"
        />
        <label
          htmlFor={`sendOnce-${automation?.id ?? "new"}`}
          className="text-sm text-gray-700"
        >
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
          {submitting
            ? "Saving…"
            : mode === "create"
              ? "Create (disabled by default)"
              : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function ProductPicker({
  value,
  products,
  onChange,
}: {
  value: string;
  products: ProductInfo[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return products.slice(0, 8);
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku && p.sku.toLowerCase().includes(q))
      )
      .slice(0, 8);
  }, [products, value]);

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={
          products.length > 0
            ? `Pick from your ${products.length} imported products, or type a substring`
            : "Type a product name substring (or import products first)"
        }
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-64 overflow-y-auto">
          {filtered.map((p) => (
            <li
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(p.name);
                setOpen(false);
              }}
              className="px-3 py-2 text-sm cursor-pointer hover:bg-blue-50"
            >
              <div className="font-medium text-gray-900 line-clamp-1">{p.name}</div>
              {p.sku && (
                <div className="text-xs text-gray-500 font-mono">{p.sku}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplatePreview({
  template,
  variables,
  onVariableChange,
  headerImageUrl,
  onHeaderImageChange,
}: {
  template: TemplateInfo;
  variables: string[];
  onVariableChange: (idx: number, v: string) => void;
  headerImageUrl: string;
  onHeaderImageChange: (v: string) => void;
}) {
  // Render the body text with each {{N}} placeholder either replaced by the
  // current variable mapping (so the operator can see exactly what will be
  // sent) or styled as a highlighted chip if not yet mapped.
  const segments = useMemo(
    () => splitTemplateBody(template.bodyText ?? "(no body text)"),
    [template.bodyText]
  );

  return (
    <div className="mt-4 border-t border-gray-200 pt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-gray-700">
          Template preview
        </div>
        <div className="text-xs text-gray-500">
          <code className="px-1 py-0.5 bg-gray-100 rounded">{template.name}</code>{" "}
          · {template.language} · {template.bodyParamCount} body params
          {template.headerType ? ` · ${template.headerType} header` : ""}
        </div>
      </div>

      <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-900 whitespace-pre-wrap">
        {segments.map((seg, i) =>
          seg.kind === "literal" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <span
              key={i}
              className={`inline-block px-1.5 py-0.5 rounded font-mono text-xs ${
                variables[seg.index - 1]
                  ? "bg-green-200 text-green-900"
                  : "bg-amber-200 text-amber-900"
              }`}
            >
              {variables[seg.index - 1] || `{{${seg.index}}}`}
            </span>
          )
        )}
      </div>

      {template.bodyParamCount > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium text-gray-700">
            Map each body parameter:
          </div>
          {Array.from({ length: template.bodyParamCount }, (_, i) => (
            <VariableSlotRow
              key={i}
              index={i + 1}
              value={variables[i] ?? ""}
              onChange={(v) => onVariableChange(i, v)}
            />
          ))}
        </div>
      )}

      {template.headerType === "IMAGE" && (
        <div className="mt-3">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Header image URL (required by this template)
          </label>
          <input
            type="url"
            value={headerImageUrl}
            onChange={(e) => onHeaderImageChange(e.target.value)}
            placeholder="https://example.com/product.jpg"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            Must be a publicly-reachable https URL — Meta downloads the image
            when the template is sent. Falls back to Settings → WhatsApp Cloud
            API → Default Header Image URL when empty.
          </p>
        </div>
      )}
    </div>
  );
}

function VariableSlotRow({
  index,
  value,
  onChange,
}: {
  index: number;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="font-mono text-xs text-gray-500 mt-2 w-12 shrink-0">
        {`{{${index}}}`}
      </div>
      <div className="flex-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Pick a variable or type a literal value for {{${index}}}`}
          className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm"
        />
        <div className="mt-1 flex flex-wrap gap-1">
          {VARIABLE_TOKENS.map((t) => (
            <button
              key={t.token}
              type="button"
              onClick={() => onChange(t.token)}
              className={`text-[11px] px-1.5 py-0.5 rounded border ${
                value === t.token
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
              }`}
              title={t.label}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type Segment =
  | { kind: "literal"; text: string }
  | { kind: "placeholder"; index: number };

function splitTemplateBody(body: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /\{\{(\d+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "literal", text: body.slice(lastIndex, match.index) });
    }
    segments.push({ kind: "placeholder", index: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    segments.push({ kind: "literal", text: body.slice(lastIndex) });
  }
  if (segments.length === 0) {
    segments.push({ kind: "literal", text: body });
  }
  return segments;
}

function AutomationCard({
  automation,
  templates,
  products,
  onChange,
  onToast,
}: {
  automation: Automation;
  templates: TemplateInfo[];
  products: ProductInfo[];
  onChange: () => void;
  onToast: (kind: "success" | "error", text: string) => void;
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [editing, setEditing] = useState(false);

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

  if (editing) {
    return (
      <AutomationForm
        mode="edit"
        automation={automation}
        templates={templates}
        products={products}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChange();
          onToast("success", "Automation updated");
        }}
        onError={(msg) => onToast("error", msg)}
      />
    );
  }

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
                  {Array.isArray(automation.thenSendTemplateVariables) &&
                    automation.thenSendTemplateVariables.length > 0 && (
                      <span className="ml-1 text-xs text-gray-500">
                        with [{automation.thenSendTemplateVariables.join(", ")}]
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
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition-colors"
            title="Edit automation"
          >
            <Pencil size={14} />
            Edit
          </button>
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
