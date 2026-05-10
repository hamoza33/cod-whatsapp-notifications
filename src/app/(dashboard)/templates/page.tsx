"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import { RefreshCw, CheckCircle2, AlertCircle, FileText } from "lucide-react";

interface TemplateRow {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  bodyParamCount: number;
  bodyText: string | null;
  headerType: string | null;
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
    // Sync cached templates from the API into local state on mount.
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
            Approved templates from your WhatsApp Business Account. Auto-imported
            every 6 hours, or click <strong>Sync now</strong> to refresh.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Last imported: <strong>{lastImportAt ? `${timeSince(lastImportAt)} (${new Date(lastImportAt).toLocaleString()})` : "never"}</strong>
          </p>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing..." : "Sync now"}
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
            then click <strong>Sync now</strong>.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {approved.length > 0 && (
            <TemplateTable
              title={`Approved (${approved.length})`}
              templates={approved}
              approved
            />
          )}
          {other.length > 0 && (
            <TemplateTable
              title={`Other (${other.length})`}
              templates={other}
              approved={false}
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
}: {
  title: string;
  templates: TemplateRow[];
  approved: boolean;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      </div>
      <div className="divide-y divide-gray-100">
        {templates.map((t) => (
          <div key={t.id} className="px-4 py-3 grid grid-cols-12 gap-3 items-start text-sm">
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
            <div className="col-span-5 text-xs text-gray-600 font-mono truncate">
              {t.bodyText ?? "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
