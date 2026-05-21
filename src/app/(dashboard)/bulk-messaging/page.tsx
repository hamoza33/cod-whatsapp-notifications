"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import {
  Megaphone,
  Plus,
  RefreshCw,
  Send,
  CheckCircle2,
  XCircle,
  Trash2,
  Pause,
} from "lucide-react";

interface CampaignRow {
  id: string;
  name: string;
  templateName: string;
  templateLanguage: string;
  status: "DRAFT" | "SENDING" | "COMPLETED" | "CANCELLED" | "FAILED";
  totalRecipients: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdBy: string;
  errorMessage: string | null;
  counts: Record<string, number>;
}

const STATUS_BADGE: Record<CampaignRow["status"], string> = {
  DRAFT: "bg-gray-100 text-gray-700 border-gray-200",
  SENDING: "bg-blue-50 text-blue-700 border-blue-200",
  COMPLETED: "bg-green-50 text-green-700 border-green-200",
  CANCELLED: "bg-orange-50 text-orange-700 border-orange-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
};

const STATUS_ICON: Record<CampaignRow["status"], React.ReactNode> = {
  DRAFT: <Pause size={12} />,
  SENDING: <Send size={12} />,
  COMPLETED: <CheckCircle2 size={12} />,
  CANCELLED: <Pause size={12} />,
  FAILED: <XCircle size={12} />,
};

export default function BulkMessagingPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api.get<{ campaigns: CampaignRow[] }>(
        "/bulk-messaging/campaigns"
      );
      setCampaigns(data.campaigns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Refresh every 5s while any campaign is in-flight so the dashboard
    // stays roughly live without a websocket setup.
    const interval = setInterval(() => {
      void load();
    }, 5_000);
    return () => clearInterval(interval);
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete campaign "${name}" and all its recipient rows?`)) {
      return;
    }
    try {
      await api.del(`/bulk-messaging/campaigns/${id}`);
      void load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Megaphone size={22} className="text-blue-600" />
            Bulk Messaging
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Upload a sheet of recipients, map columns to template variables,
            and send a WhatsApp template to everyone with live delivery
            tracking.
          </p>
        </div>
        <Link
          href="/bulk-messaging/new"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm"
        >
          <Plus size={16} />
          New Campaign
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin" />
            Loading campaigns…
          </div>
        ) : campaigns.length === 0 ? (
          <div className="p-12 text-center">
            <Megaphone size={32} className="mx-auto text-gray-300 mb-3" />
            <p className="text-sm text-gray-500">
              No campaigns yet. Click <strong>New Campaign</strong> to send
              your first bulk WhatsApp blast.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Template</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Recipients</th>
                <th className="px-4 py-3 text-left">Delivered</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const delivered =
                  (c.counts.DELIVERED ?? 0) + (c.counts.READ ?? 0);
                const sent = c.counts.SENT ?? 0;
                const failed = c.counts.FAILED ?? 0;
                const pending = c.counts.PENDING ?? 0;
                return (
                  <tr
                    key={c.id}
                    className="border-t border-gray-100 hover:bg-gray-50/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/bulk-messaging/${c.id}`}
                        className="font-medium text-gray-900 hover:text-blue-600"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <code className="text-xs">{c.templateName}</code>{" "}
                      <span className="text-xs text-gray-400">
                        ({c.templateLanguage})
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                          STATUS_BADGE[c.status]
                        }`}
                      >
                        {STATUS_ICON[c.status]}
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {c.totalRecipients}
                      {pending > 0 && (
                        <span className="text-xs text-blue-600 ml-1">
                          ({pending} pending)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <span className="text-green-700">
                        {delivered + sent}
                      </span>
                      <span className="text-gray-400"> / {c.totalRecipients}</span>
                      {failed > 0 && (
                        <span className="text-xs text-red-600 ml-2">
                          {failed} failed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(c.createdAt).toLocaleString()}
                      <div className="text-[10px] text-gray-400">
                        {c.createdBy}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(c.id, c.name)}
                        title="Delete campaign"
                        className="text-gray-400 hover:text-red-600 p-1"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
