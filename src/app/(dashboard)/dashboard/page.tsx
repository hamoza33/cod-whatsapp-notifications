"use client";

import { useEffect, useState } from "react";
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

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing..." : "Sync Orders"}
        </button>
      </div>

      {syncResult && (
        <div className="mb-4 p-3 bg-blue-50 text-blue-700 rounded-md text-sm border border-blue-200">
          {syncResult}
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
    <div className="bg-white rounded-lg shadow-sm p-4 border border-gray-200">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1">{label}</p>
          <p className="text-xl font-bold text-gray-900">{value}</p>
        </div>
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center ${
            colorMap[color] || colorMap.blue
          }`}
        >
          <Icon size={20} />
        </div>
      </div>
    </div>
  );
}
