"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileText,
  Eye,
  ChevronDown,
  ChevronUp,
  Plus,
  X,
} from "lucide-react";

interface TemplateRow {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  bodyParamCount: number;
  bodyText: string | null;
  headerType: string | null;
  components: unknown;
  lastFetchedAt: string;
}

interface CachedTemplatesResponse {
  templates: TemplateRow[];
  lastImportAt: string | null;
}

function timeSince(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [lastImportAt, setLastImportAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const showToast = useCallback((kind: "success" | "error", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchCached = useCallback(async () => {
    try {
      const data = await api.get<CachedTemplatesResponse>(
        "/whatsapp/templates/cached"
      );
      setTemplates(data.templates);
      setLastImportAt(data.lastImportAt);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCached();
  }, [fetchCached]);

  const sync = async () => {
    setSyncing(true);
    try {
      const data = await api.post<{
        imported: number;
        total: number;
        statusCounts: Record<string, number>;
      }>("/whatsapp/templates/import", {});
      const breakdown = Object.entries(data.statusCounts)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      showToast(
        "success",
        `Imported ${data.imported} template${data.imported === 1 ? "" : "s"}${breakdown ? ` (${breakdown})` : ""}`
      );
      await fetchCached();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const approved = templates.filter((t) => t.status === "APPROVED");
  const other = templates.filter((t) => t.status !== "APPROVED");

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FileText className="text-blue-500" size={24} />
            WhatsApp Templates
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Manage your WhatsApp Business message templates. View format, variables, and details.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Last imported: <strong>{lastImportAt ? `${timeSince(lastImportAt)} (${new Date(lastImportAt).toLocaleString()})` : "never"}</strong>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
          >
            <Plus size={16} />
            Create Template
          </button>
          <button
            onClick={sync}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing..." : "Sync from Meta"}
          </button>
        </div>
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

      {showCreateForm && (
        <CreateTemplateForm
          onClose={() => setShowCreateForm(false)}
          onCreated={() => {
            setShowCreateForm(false);
            fetchCached();
            showToast("success", "Template created locally. Sync from Meta to update status.");
          }}
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="animate-spin text-gray-400" size={24} />
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <FileText className="mx-auto text-gray-300" size={32} />
          <p className="text-gray-500 mt-2 text-sm">
            No templates imported yet. Make sure your{" "}
            <strong>WhatsApp Business Account ID</strong> is set in Settings,
            then click <strong>Sync from Meta</strong>.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {approved.length > 0 && (
            <TemplateTable
              title={`Approved (${approved.length})`}
              templates={approved}
              approved
              expandedId={expandedId}
              onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
            />
          )}
          {other.length > 0 && (
            <TemplateTable
              title={`Other (${other.length})`}
              templates={other}
              approved={false}
              expandedId={expandedId}
              onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TemplateTable({
  title,
  templates,
  approved,
  expandedId,
  onToggle,
}: {
  title: string;
  templates: TemplateRow[];
  approved: boolean;
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      </div>
      <div className="divide-y divide-gray-100">
        {templates.map((t) => (
          <div key={t.id}>
            <div className="px-4 py-3 grid grid-cols-12 gap-3 items-center text-sm">
              <div className="col-span-3">
                <div className="font-medium text-gray-900">{t.name}</div>
                <div className="text-xs text-gray-500">
                  {t.language} · {t.category}
                </div>
              </div>
              <div className="col-span-2">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${
                    approved
                      ? "bg-green-100 text-green-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {approved ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                  {t.status}
                </span>
              </div>
              <div className="col-span-2 text-xs text-gray-600">
                <div>
                  <strong>Body params:</strong> {t.bodyParamCount}
                </div>
                {t.headerType && (
                  <div>
                    <strong>Header:</strong> {t.headerType}
                  </div>
                )}
              </div>
              <div className="col-span-4 text-xs text-gray-600 font-mono truncate">
                {t.bodyText ?? "—"}
              </div>
              <div className="col-span-1 flex justify-end">
                <button
                  onClick={() => onToggle(t.id)}
                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                  title="View details"
                >
                  {expandedId === t.id ? <ChevronUp size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {expandedId === t.id && <TemplateDetails template={t} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateDetails({ template }: { template: TemplateRow }) {
  const components = Array.isArray(template.components)
    ? (template.components as Array<{
        type?: string;
        text?: string;
        format?: string;
        parameters?: Array<{ type?: string; text?: string }>;
        buttons?: Array<{ type?: string; text?: string; url?: string }>;
      }>)
    : [];

  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  const footer = components.find((c) => c.type === "FOOTER");
  const buttons = components.find((c) => c.type === "BUTTONS");

  return (
    <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100">
      <div className="grid grid-cols-2 gap-4 mt-3">
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Template Structure
          </h4>
          <div className="space-y-2 text-xs">
            {header && (
              <div className="p-2 bg-white border border-gray-200 rounded">
                <span className="text-[10px] uppercase text-gray-400 font-semibold">
                  Header ({header.format || "TEXT"})
                </span>
                {header.text && (
                  <p className="mt-1 text-gray-700">{header.text}</p>
                )}
              </div>
            )}
            {body && (
              <div className="p-2 bg-white border border-gray-200 rounded">
                <span className="text-[10px] uppercase text-gray-400 font-semibold">
                  Body
                </span>
                <p className="mt-1 text-gray-700 whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                  {body.text || template.bodyText || "—"}
                </p>
              </div>
            )}
            {footer && (
              <div className="p-2 bg-white border border-gray-200 rounded">
                <span className="text-[10px] uppercase text-gray-400 font-semibold">
                  Footer
                </span>
                <p className="mt-1 text-gray-500">{footer.text}</p>
              </div>
            )}
            {buttons?.buttons && buttons.buttons.length > 0 && (
              <div className="p-2 bg-white border border-gray-200 rounded">
                <span className="text-[10px] uppercase text-gray-400 font-semibold">
                  Buttons
                </span>
                <div className="mt-1 space-y-1">
                  {buttons.buttons.map((b, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px]">
                        {b.type}
                      </span>
                      <span className="text-gray-700">{b.text}</span>
                      {b.url && (
                        <span className="text-gray-400 font-mono truncate">
                          → {b.url}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
            Variables & Info
          </h4>
          <div className="text-xs space-y-2">
            <div className="p-2 bg-white border border-gray-200 rounded">
              <div className="flex justify-between">
                <span className="text-gray-500">Body Parameters:</span>
                <span className="font-medium">{template.bodyParamCount}</span>
              </div>
              {template.bodyParamCount > 0 && (
                <div className="mt-2 space-y-1">
                  {Array.from({ length: template.bodyParamCount }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <code className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px]">
                        {`{{${i + 1}}}`}
                      </code>
                      <span className="text-gray-500">Parameter {i + 1}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-2 bg-white border border-gray-200 rounded space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Category:</span>
                <span className="font-medium">{template.category}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Language:</span>
                <span className="font-medium">{template.language}</span>
              </div>
              {template.headerType && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Header Type:</span>
                  <span className="font-medium">{template.headerType}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Last Fetched:</span>
                <span className="font-medium">
                  {timeSince(template.lastFetchedAt)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateTemplateForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en");
  const [category, setCategory] = useState("UTILITY");
  const [bodyText, setBodyText] = useState("");
  const [headerType, setHeaderType] = useState("NONE");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bodyParamCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;

  const submit = async () => {
    if (!name.trim()) {
      setError("Template name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const components: Array<Record<string, unknown>> = [];
      if (headerType !== "NONE") {
        components.push({ type: "HEADER", format: headerType });
      }
      components.push({ type: "BODY", text: bodyText });

      await api.post("/whatsapp/templates/create", {
        name: name.trim(),
        language,
        category,
        bodyText,
        bodyParamCount,
        headerType: headerType === "NONE" ? null : headerType,
        components,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Create New Template</h3>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-md">
          <X size={18} />
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Create a local template record. To submit it to Meta for approval,
        use the{" "}
        <a
          href="https://business.facebook.com/wa/manage/message-templates/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 underline"
        >
          WhatsApp Manager
        </a>
        , then sync back here.
      </p>

      {error && (
        <div className="mb-3 p-2 rounded bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Template Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. order_update"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Language
          </label>
          <input
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="UTILITY">Utility</option>
            <option value="MARKETING">Marketing</option>
            <option value="AUTHENTICATION">Authentication</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Header Type
          </label>
          <select
            value={headerType}
            onChange={(e) => setHeaderType(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="NONE">None</option>
            <option value="TEXT">Text</option>
            <option value="IMAGE">Image</option>
            <option value="VIDEO">Video</option>
            <option value="DOCUMENT">Document</option>
          </select>
        </div>
      </div>

      <div className="mt-4">
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Body Text
          <span className="ml-2 text-gray-400">
            Use {"{{1}}"}, {"{{2}}"}, etc. for variables
          </span>
        </label>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={4}
          placeholder={`Hello {{1}}, your order {{2}} is on the way! Tracking: {{3}}`}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {bodyParamCount > 0 && (
          <p className="mt-1 text-xs text-blue-600">
            Detected {bodyParamCount} variable{bodyParamCount > 1 ? "s" : ""}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm text-gray-700 hover:text-gray-900"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting}
          className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create Template"}
        </button>
      </div>
    </div>
  );
}
