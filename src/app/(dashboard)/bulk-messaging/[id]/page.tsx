"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { use } from "react";
import { api } from "@/lib/api-client";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Send,
  Eye,
  Truck,
  Download,
  RefreshCw,
  StopCircle,
  AlertTriangle,
  Megaphone,
  CircleDashed,
  RotateCw,
} from "lucide-react";

interface Campaign {
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
  throttleMs: number;
  maxAttempts: number;
  phoneNumberId: string | null;
}

interface Recipient {
  id: string;
  rowIndex: number;
  phoneNumber: string;
  phoneNumberRaw: string | null;
  displayName: string | null;
  variablesJson: string[];
  status:
    | "PENDING"
    | "SENT"
    | "DELIVERED"
    | "READ"
    | "FAILED"
    | "SKIPPED"
    | "CANCELLED";
  providerMessageId: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  attemptCount: number;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
}

const STATUS_BADGE: Record<Recipient["status"], string> = {
  PENDING: "bg-gray-100 text-gray-700 border-gray-200",
  SENT: "bg-blue-50 text-blue-700 border-blue-200",
  DELIVERED: "bg-green-50 text-green-700 border-green-200",
  READ: "bg-emerald-100 text-emerald-800 border-emerald-300",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  SKIPPED: "bg-orange-50 text-orange-700 border-orange-200",
  CANCELLED: "bg-gray-100 text-gray-500 border-gray-200",
};

function StatusIcon({ status }: { status: Recipient["status"] }) {
  switch (status) {
    case "PENDING":
      return <CircleDashed size={12} />;
    case "SENT":
      return <Send size={12} />;
    case "DELIVERED":
      return <Truck size={12} />;
    case "READ":
      return <Eye size={12} />;
    case "FAILED":
      return <XCircle size={12} />;
    case "SKIPPED":
      return <CircleDashed size={12} />;
    case "CANCELLED":
      return <StopCircle size={12} />;
  }
}

export default function BulkCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number>(0);

  const refresh = async () => {
    try {
      const [c, r] = await Promise.all([
        api.get<{
          campaign: Campaign;
          counts: Record<string, number>;
          running: boolean;
        }>(`/bulk-messaging/campaigns/${id}`),
        api.get<{ recipients: Recipient[] }>(
          `/bulk-messaging/campaigns/${id}/recipients${
            statusFilter ? `?status=${statusFilter}` : ""
          }`
        ),
      ]);
      setCampaign(c.campaign);
      setCounts(c.counts);
      setRunning(c.running);
      setRecipients(r.recipients);
      setError(null);
      setLastLoadedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaign");
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // Faster poll while the campaign is still running.
    const interval = setInterval(() => {
      void refresh();
    }, campaign?.status === "SENDING" ? 2_000 : 6_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, statusFilter, campaign?.status]);

  const cancel = async () => {
    if (!confirm("Cancel the campaign? Pending rows will be skipped.")) return;
    setActionPending(true);
    try {
      await api.post(`/bulk-messaging/campaigns/${id}/cancel`);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActionPending(false);
    }
  };

  const retryFailed = async () => {
    setActionPending(true);
    try {
      await api.post(`/bulk-messaging/campaigns/${id}/retry-failed`);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setActionPending(false);
    }
  };

  const totalRecipients = campaign?.totalRecipients ?? 0;
  const pending = counts.PENDING ?? 0;
  const sent = counts.SENT ?? 0;
  const delivered = counts.DELIVERED ?? 0;
  const read = counts.READ ?? 0;
  const failed = counts.FAILED ?? 0;
  const skipped = counts.SKIPPED ?? 0;
  const cancelled = counts.CANCELLED ?? 0;

  const progressPct = useMemo(() => {
    if (totalRecipients === 0) return 0;
    const done = totalRecipients - pending;
    return Math.round((done / totalRecipients) * 100);
  }, [pending, totalRecipients]);

  if (!campaign) {
    return (
      <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
        <RefreshCw size={14} className="animate-spin" />
        Loading campaign…
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <Link
            href="/bulk-messaging"
            className="text-xs text-gray-500 hover:text-gray-900"
          >
            ← All campaigns
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mt-1">
            <Megaphone size={22} className="text-blue-600" />
            {campaign.name}
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Template <code className="text-gray-700">{campaign.templateName}</code>{" "}
            ({campaign.templateLanguage}) · Started{" "}
            {campaign.startedAt
              ? new Date(campaign.startedAt).toLocaleString()
              : "—"}
            {campaign.completedAt && (
              <>
                {" "}
                · Finished{" "}
                {new Date(campaign.completedAt).toLocaleString()}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/bulk-messaging/campaigns/${id}/export`}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            <Download size={12} />
            Download report
          </a>
          {failed > 0 && (
            <button
              type="button"
              disabled={actionPending}
              onClick={retryFailed}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-md hover:bg-orange-100 disabled:opacity-50"
            >
              <RotateCw size={12} />
              Retry {failed} failed
            </button>
          )}
          {(campaign.status === "SENDING" || campaign.status === "DRAFT") && (
            <button
              type="button"
              disabled={actionPending}
              onClick={cancel}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 disabled:opacity-50"
            >
              <StopCircle size={12} />
              Cancel
            </button>
          )}
        </div>
      </div>

      {campaign.errorMessage && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{campaign.errorMessage}</span>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Progress + per-status tiles */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-gray-700">
            Progress: {totalRecipients - pending} / {totalRecipients}
            {running && (
              <span className="ml-2 text-xs text-blue-600 inline-flex items-center gap-1">
                <Send size={11} className="animate-pulse" />
                live
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500">
            Last refresh{" "}
            {lastLoadedAt
              ? new Date(lastLoadedAt).toLocaleTimeString()
              : ""}
          </div>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-3">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
          <Tile label="Pending" value={pending} className="bg-gray-50 text-gray-700" icon={<Clock size={12} />} />
          <Tile label="Sent" value={sent} className="bg-blue-50 text-blue-700" icon={<Send size={12} />} />
          <Tile label="Delivered" value={delivered} className="bg-green-50 text-green-700" icon={<Truck size={12} />} />
          <Tile label="Read" value={read} className="bg-emerald-50 text-emerald-700" icon={<Eye size={12} />} />
          <Tile label="Failed" value={failed} className="bg-red-50 text-red-700" icon={<XCircle size={12} />} />
          <Tile label="Skipped" value={skipped} className="bg-orange-50 text-orange-700" icon={<CircleDashed size={12} />} />
          <Tile label="Cancelled" value={cancelled} className="bg-gray-50 text-gray-500" icon={<StopCircle size={12} />} />
        </div>
      </div>

      {/* Recipient table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">Filter:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2 py-1 border border-gray-300 rounded text-xs bg-white"
            >
              <option value="">All ({totalRecipients})</option>
              <option value="PENDING">Pending ({pending})</option>
              <option value="SENT">Sent ({sent})</option>
              <option value="DELIVERED">Delivered ({delivered})</option>
              <option value="READ">Read ({read})</option>
              <option value="FAILED">Failed ({failed})</option>
              <option value="SKIPPED">Skipped ({skipped})</option>
              <option value="CANCELLED">Cancelled ({cancelled})</option>
            </select>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-3 py-2 text-left w-10"></th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {recipients.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-gray-400 text-sm">
                    No recipients to show.
                  </td>
                </tr>
              )}
              {recipients.map((r) => {
                const delivered = r.status === "DELIVERED" || r.status === "READ";
                const failed = r.status === "FAILED";
                return (
                  <tr
                    key={r.id}
                    className="border-t border-gray-100 hover:bg-gray-50/60"
                  >
                    <td className="px-3 py-2">
                      {delivered ? (
                        <CheckCircle2
                          size={16}
                          className="text-green-600"
                          aria-label="Delivered"
                        />
                      ) : r.status === "SENT" ? (
                        <Send size={14} className="text-blue-500" />
                      ) : failed ? (
                        <XCircle size={16} className="text-red-500" />
                      ) : (
                        <Clock size={14} className="text-gray-400" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-800">
                      {r.displayName ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">
                      {r.phoneNumber}
                      {r.phoneNumberRaw && r.phoneNumberRaw !== r.phoneNumber && (
                        <span className="text-gray-400 ml-1">
                          (was {r.phoneNumberRaw})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                          STATUS_BADGE[r.status]
                        }`}
                      >
                        <StatusIcon status={r.status} />
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 max-w-xs">
                      {r.errorMessage ? (
                        <span
                          className="text-red-600 cursor-help"
                          title={`${r.errorCode ? `Code ${r.errorCode} — ` : ""}${r.errorMessage}`}
                        >
                          {r.errorCode && (
                            <code className="text-[10px] bg-red-50 px-1 mr-1 rounded">
                              {r.errorCode}
                            </code>
                          )}
                          {r.errorMessage.length > 80
                            ? r.errorMessage.slice(0, 80) + "…"
                            : r.errorMessage}
                        </span>
                      ) : r.readAt ? (
                        `Read at ${new Date(r.readAt).toLocaleTimeString()}`
                      ) : r.deliveredAt ? (
                        `Delivered at ${new Date(r.deliveredAt).toLocaleTimeString()}`
                      ) : r.sentAt ? (
                        `Sent at ${new Date(r.sentAt).toLocaleTimeString()}`
                      ) : (
                        ""
                      )}
                      {r.attemptCount > 1 && (
                        <span className="ml-1 text-[10px] text-gray-400">
                          ({r.attemptCount} attempts)
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  className,
  icon,
}: {
  label: string;
  value: number;
  className: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={`p-2 rounded border border-current/10 ${className}`}>
      <div className="flex items-center gap-1 text-xs opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-lg font-bold leading-tight">{value}</div>
    </div>
  );
}
