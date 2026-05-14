"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import {
  Package,
  Truck,
  MessageSquare,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  Clock,
  XCircle,
  RotateCcw,
  Cog,
  Search,
} from "lucide-react";

interface DashboardStats {
  totalOrders: number;
  pendingOrders: number;
  confirmedOrders: number;
  processingOrders: number;
  shippedOrders: number;
  outForDeliveryOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  totalMessages: number;
  sentMessages: number;
  failedMessages: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

interface TrackingJobProgress {
  id: string;
  status: string;
  totalOrders: number;
  processedOrders: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  currentCarrier: string | null;
  percentage: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  recentErrors: Array<{
    trackingNumber: string;
    carrier: string;
    lastError: string | null;
  }>;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Tracking job state
  const [, setTrackingJobId] = useState<string | null>(null);
  const [trackingProgress, setTrackingProgress] = useState<TrackingJobProgress | null>(null);
  const [trackingStarting, setTrackingStarting] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchStats() {
      try {
        const data = await api.get<{ stats: DashboardStats }>("/dashboard");
        if (!cancelled) setStats(data.stats);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchStats();
    return () => { cancelled = true; };
  }, []);

  // Poll tracking job progress
  const pollProgress = useCallback(async (jobId: string) => {
    try {
      const data = await api.get<TrackingJobProgress>(`/tracking/jobs/${jobId}`);
      setTrackingProgress(data);
      if (data.status === "COMPLETED" || data.status === "FAILED" || data.status === "CANCELLED") {
        // Stop polling
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        // Refresh stats
        try {
          const refreshed = await api.get<{ stats: DashboardStats }>("/dashboard");
          setStats(refreshed.stats);
        } catch { /* ignore */ }
      }
    } catch {
      // ignore poll errors
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const data = await api.post<{
        result: {
          ordersFound: number;
          ordersCreated: number;
          ordersUpdated: number;
          messagesSent: number;
          errors: string[];
        };
      }>("/orders/sync");
      setSyncResult(
        `Synced: ${data.result.ordersFound} found, ${data.result.ordersCreated} created, ${data.result.ordersUpdated} updated, ${data.result.messagesSent} messages sent`
      );
      const refreshed = await api.get<{ stats: DashboardStats }>("/dashboard");
      setStats(refreshed.stats);
    } catch (err) {
      setSyncResult(
        err instanceof Error ? err.message : "Sync failed"
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleTrackingSync = async () => {
    setTrackingStarting(true);
    setTrackingError(null);
    setTrackingProgress(null);
    try {
      const data = await api.post<{ jobId: string; totalOrders: number }>(
        "/tracking/sync-all"
      );
      setTrackingJobId(data.jobId);
      // Start polling every 2 seconds
      pollProgress(data.jobId);
      pollRef.current = setInterval(() => pollProgress(data.jobId), 2000);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already in progress")) {
        // Try to pick up the existing job
        try {
          const errData = JSON.parse(err.message.replace(/^[^{]*/, ""));
          if (errData.jobId) {
            setTrackingJobId(errData.jobId);
            pollProgress(errData.jobId);
            pollRef.current = setInterval(() => pollProgress(errData.jobId), 2000);
            return;
          }
        } catch { /* ignore parse error */ }
      }
      setTrackingError(err instanceof Error ? err.message : "Failed to start tracking");
    } finally {
      setTrackingStarting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  const isTrackingActive = trackingProgress && (
    trackingProgress.status === "QUEUED" || trackingProgress.status === "RUNNING"
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex gap-2">
          <button
            onClick={handleTrackingSync}
            disabled={trackingStarting || !!isTrackingActive}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-md text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            <Search size={16} className={isTrackingActive ? "animate-spin" : ""} />
            {isTrackingActive ? "Tracking..." : "Sync All Tracking"}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing..." : "Sync Orders"}
          </button>
        </div>
      </div>

      {syncResult && (
        <div className="mb-4 p-3 bg-blue-50 text-blue-700 rounded-md text-sm border border-blue-200">
          {syncResult}
        </div>
      )}

      {trackingError && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-md text-sm border border-red-200">
          {trackingError}
        </div>
      )}

      {/* Tracking Progress Bar */}
      {trackingProgress && (
        <div className="mb-6 bg-white rounded-xl shadow-sm p-4 border border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">
              Package Tracking {trackingProgress.status === "COMPLETED" ? "Complete" : trackingProgress.status === "FAILED" ? "Failed" : "In Progress"}
            </h3>
            <span className="text-xs text-gray-500">
              {trackingProgress.processedOrders} / {trackingProgress.totalOrders} orders
            </span>
          </div>

          <div className="w-full bg-gray-200 rounded-full h-3 mb-2">
            <div
              className={`h-3 rounded-full transition-all duration-500 ${
                trackingProgress.status === "COMPLETED" ? "bg-green-500" :
                trackingProgress.status === "FAILED" ? "bg-red-500" :
                "bg-purple-500"
              }`}
              style={{ width: `${trackingProgress.percentage}%` }}
            />
          </div>

          <div className="flex gap-4 text-xs text-gray-600">
            <span>{trackingProgress.percentage}%</span>
            {trackingProgress.currentCarrier && (
              <span>Carrier: {trackingProgress.currentCarrier}</span>
            )}
            <span className="text-green-600">{trackingProgress.successCount} success</span>
            {trackingProgress.failedCount > 0 && (
              <span className="text-red-600">{trackingProgress.failedCount} failed</span>
            )}
            {trackingProgress.skippedCount > 0 && (
              <span className="text-yellow-600">{trackingProgress.skippedCount} skipped</span>
            )}
          </div>

          {trackingProgress.recentErrors.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-red-500 cursor-pointer">
                Recent errors ({trackingProgress.recentErrors.length})
              </summary>
              <ul className="mt-1 text-xs text-red-600 space-y-1">
                {trackingProgress.recentErrors.map((e, i) => (
                  <li key={i} className="truncate">
                    {e.carrier} / {e.trackingNumber}: {e.lastError}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Order stages - all statuses */}
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Order Pipeline</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard
          label="Pending"
          value={stats?.pendingOrders ?? 0}
          icon={Clock}
          color="gray"
        />
        <StatCard
          label="Confirmed"
          value={stats?.confirmedOrders ?? 0}
          icon={CheckCircle2}
          color="blue"
        />
        <StatCard
          label="Processing"
          value={stats?.processingOrders ?? 0}
          icon={Cog}
          color="indigo"
        />
        <StatCard
          label="Shipped"
          value={stats?.shippedOrders ?? 0}
          icon={Truck}
          color="yellow"
        />
        <StatCard
          label="Out for Delivery"
          value={stats?.outForDeliveryOrders ?? 0}
          icon={Truck}
          color="orange"
        />
        <StatCard
          label="Delivered"
          value={stats?.deliveredOrders ?? 0}
          icon={CheckCircle2}
          color="green"
        />
        <StatCard
          label="Returned"
          value={stats?.returnedOrders ?? 0}
          icon={RotateCcw}
          color="rose"
        />
        <StatCard
          label="Cancelled"
          value={stats?.cancelledOrders ?? 0}
          icon={XCircle}
          color="red"
        />
        <StatCard
          label="Total Orders"
          value={stats?.totalOrders ?? 0}
          icon={Package}
          color="slate"
        />
      </div>

      {/* Messages */}
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">WhatsApp Messages</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <StatCard
          label="Total Messages"
          value={stats?.totalMessages ?? 0}
          icon={MessageSquare}
          color="blue"
        />
        <StatCard
          label="Sent"
          value={stats?.sentMessages ?? 0}
          icon={CheckCircle2}
          color="green"
        />
        <StatCard
          label="Failed"
          value={stats?.failedMessages ?? 0}
          icon={AlertCircle}
          color="red"
        />
      </div>

      {stats?.lastSyncAt && (
        <div className="text-sm text-gray-500">
          Last sync: {new Date(stats.lastSyncAt).toLocaleString()} (
          {stats.lastSyncStatus})
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-green-50 text-green-600",
    yellow: "bg-yellow-50 text-yellow-600",
    orange: "bg-orange-50 text-orange-600",
    red: "bg-red-50 text-red-600",
    gray: "bg-gray-50 text-gray-600",
    indigo: "bg-indigo-50 text-indigo-600",
    rose: "bg-rose-50 text-rose-600",
    slate: "bg-slate-50 text-slate-600",
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-100 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">{label}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
        </div>
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            colorMap[color] || colorMap.blue
          }`}
        >
          <Icon size={20} />
        </div>
      </div>
    </div>
  );
}
