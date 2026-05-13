"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Trash2,
  Package,
  Truck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Search,
  Clock,
  Download,
  Database,
} from "lucide-react";

type TrackingCarrier = "IMILE" | "INJAZ" | "OTHER";
type TrackingStatus =
  | "PENDING"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "RETURNED"
  | "EXCEPTION"
  | "UNKNOWN";

interface TrackingEvent {
  id: string;
  status: string;
  description: string;
  location: string | null;
  occurredAt: string;
}

interface TrackingOrder {
  id: string;
  trackingNumber: string;
  carrier: TrackingCarrier;
  carrierName: string | null;
  status: TrackingStatus;
  latestEvent: string | null;
  latestEventAt: string | null;
  customerName: string | null;
  customerPhone: string | null;
  productName: string | null;
  codCreatedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  events: TrackingEvent[];
  order: {
    id: string;
    codNetworkOrderId: string;
    customerName: string | null;
    productName: string | null;
  } | null;
}

const STATUS_COLORS: Record<TrackingStatus, { bg: string; text: string }> = {
  PENDING: { bg: "bg-gray-100", text: "text-gray-700" },
  IN_TRANSIT: { bg: "bg-blue-100", text: "text-blue-700" },
  OUT_FOR_DELIVERY: { bg: "bg-amber-100", text: "text-amber-700" },
  DELIVERED: { bg: "bg-green-100", text: "text-green-700" },
  RETURNED: { bg: "bg-red-100", text: "text-red-700" },
  EXCEPTION: { bg: "bg-orange-100", text: "text-orange-700" },
  UNKNOWN: { bg: "bg-gray-100", text: "text-gray-500" },
};

const STATUS_LABELS: Record<TrackingStatus, string> = {
  PENDING: "Pending",
  IN_TRANSIT: "In Transit",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  EXCEPTION: "Exception",
  UNKNOWN: "Unknown",
};

function carrierLabel(order: TrackingOrder): string {
  if (order.carrierName) return order.carrierName;
  if (order.carrier === "IMILE") return "iMile";
  if (order.carrier === "INJAZ") return "Injaz Express";
  return "Other";
}

function trackingUrl(
  carrier: TrackingCarrier,
  trackingNumber: string
): string | null {
  if (carrier === "IMILE") {
    return `https://www.imile.com/AE-en/track?waybillNo=${trackingNumber}`;
  }
  if (carrier === "INJAZ") {
    return "https://injaz-express.com/track_order.php";
  }
  return null;
}

function carrierIcon(carrier: TrackingCarrier): string {
  if (carrier === "IMILE") return "bg-blue-100 text-blue-600";
  if (carrier === "INJAZ") return "bg-orange-100 text-orange-600";
  return "bg-gray-100 text-gray-600";
}

export default function TrackingPage() {
  const [orders, setOrders] = useState<TrackingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [imported, setImported] = useState(0);
  const [search, setSearch] = useState("");
  const [filterCarrier, setFilterCarrier] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const showToast = useCallback(
    (kind: "success" | "error", text: string) => {
      setToast({ kind, text });
      setTimeout(() => setToast(null), 4000);
    },
    []
  );

  const fetchOrders = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (filterCarrier) params.carrier = filterCarrier;
      if (filterStatus) params.status = filterStatus;
      if (search) params.search = search;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      const data = await api.get<{
        orders: TrackingOrder[];
        imported: number;
      }>("/tracking", params);
      setOrders(data.orders);
      if (data.imported > 0) {
        setImported(data.imported);
        showToast(
          "success",
          `Auto-imported ${data.imported} new order(s) for tracking`
        );
      }
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to load"
      );
    } finally {
      setLoading(false);
    }
  }, [filterCarrier, filterStatus, search, dateFrom, dateTo, showToast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchOrders();
  }, [fetchOrders]);

  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      await api.post("/tracking/refresh");
      await fetchOrders();
      showToast("success", "All tracking data refreshed");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Refresh failed"
      );
    } finally {
      setRefreshing(false);
    }
  };

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const result = await api.post<{
        ordersFound: number;
        ordersCreated: number;
        trackingImported: number;
      }>("/tracking/sync");
      await fetchOrders();
      showToast(
        "success",
        `Synced ${result.ordersFound} orders from COD Network, ${result.trackingImported} new tracking entries`
      );
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Full sync failed"
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleRefreshOne = async (id: string) => {
    try {
      await api.post(`/tracking/${id}/refresh`);
      await fetchOrders();
      showToast("success", "Tracking updated");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Refresh failed"
      );
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this tracking number?")) return;
    try {
      await api.del(`/tracking/${id}`);
      setOrders((prev) => prev.filter((o) => o.id !== id));
      showToast("success", "Tracking removed");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Delete failed"
      );
    }
  };

  const handleExport = () => {
    const params = new URLSearchParams();
    if (filterCarrier) params.set("carrier", filterCarrier);
    if (filterStatus) params.set("status", filterStatus);
    if (search) params.set("search", search);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    window.open(`/api/tracking/export?${params.toString()}`, "_blank");
  };

  const statusCounts = orders.reduce(
    (acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  // Unique carrier names for the filter dropdown
  const carrierNames = Array.from(
    new Set(orders.map((o) => o.carrierName || o.carrier))
  ).sort();

  return (
    <div className="max-w-6xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Truck className="text-blue-600" size={24} />
            Package Tracking
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Automatically tracks all orders with tracking numbers. iMile and
            Injaz Express get live status updates every 30 minutes.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSyncAll}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
            title="Import all orders from Jan 2025"
          >
            <Database
              size={16}
              className={syncing ? "animate-pulse" : ""}
            />
            {syncing ? "Syncing..." : "Sync All Orders"}
          </button>
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
          >
            <RefreshCw
              size={16}
              className={refreshing ? "animate-spin" : ""}
            />
            Refresh All
          </button>
          <button
            onClick={handleExport}
            disabled={orders.length === 0}
            className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            <Download size={16} />
            Export Excel
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

      {imported > 0 && !toast && (
        <div className="mb-4 p-3 rounded-md text-sm border bg-blue-50 text-blue-700 border-blue-200">
          Auto-imported {imported} new order(s) from your dashboard for
          tracking.
        </div>
      )}

      {/* Status summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        {(Object.keys(STATUS_LABELS) as TrackingStatus[]).map((s) => {
          const c = STATUS_COLORS[s];
          const count = statusCounts[s] || 0;
          return (
            <button
              key={s}
              onClick={() =>
                setFilterStatus(filterStatus === s ? "" : s)
              }
              className={`p-3 rounded-lg border text-center transition-all ${
                filterStatus === s
                  ? "ring-2 ring-blue-500 border-blue-300"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div className={`text-2xl font-bold ${c.text}`}>
                {count}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {STATUS_LABELS[s]}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            placeholder="Search tracking number or customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={filterCarrier}
          onChange={(e) => setFilterCarrier(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          <option value="">All Carriers</option>
          <option value="IMILE">iMile</option>
          <option value="INJAZ">Injaz Express</option>
          <option value="OTHER">Other</option>
        </select>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">From:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">To:</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
          />
        </div>
        {(dateFrom || dateTo || filterCarrier || filterStatus) && (
          <button
            onClick={() => {
              setDateFrom("");
              setDateTo("");
              setFilterCarrier("");
              setFilterStatus("");
            }}
            className="px-3 py-2 text-sm text-red-600 hover:text-red-700"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Quick date shortcuts */}
      <div className="flex gap-2 mb-4">
        {[
          { label: "Last 7 days", days: 7 },
          { label: "Last 30 days", days: 30 },
          { label: "Last 90 days", days: 90 },
          { label: "This year", days: 0 },
        ].map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              if (preset.days === 0) {
                setDateFrom("2025-01-01");
              } else {
                const d = new Date();
                d.setDate(d.getDate() - preset.days);
                setDateFrom(d.toISOString().slice(0, 10));
              }
              setDateTo(new Date().toISOString().slice(0, 10));
            }}
            className="px-3 py-1 text-xs border border-gray-200 rounded-full hover:bg-gray-50 text-gray-600"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="animate-spin text-gray-400" size={24} />
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <Package className="mx-auto text-gray-300" size={32} />
          <p className="text-gray-500 mt-2 text-sm">
            {filterCarrier || filterStatus || dateFrom || dateTo || search
              ? "No orders match your current filters."
              : 'No orders with tracking numbers found. Click "Sync All Orders" to import all orders from COD Network since January 2025.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-400 mb-2">
            {orders.length} order{orders.length !== 1 ? "s" : ""}
          </p>
          <div className="space-y-3">
            {orders.map((order) => (
              <TrackingCard
                key={order.id}
                order={order}
                expanded={expandedId === order.id}
                onToggle={() =>
                  setExpandedId(
                    expandedId === order.id ? null : order.id
                  )
                }
                onRefresh={() => handleRefreshOne(order.id)}
                onDelete={() => handleDelete(order.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tracking card
// ---------------------------------------------------------------------------

function TrackingCard({
  order,
  expanded,
  onToggle,
  onRefresh,
  onDelete,
}: {
  order: TrackingOrder;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const c = STATUS_COLORS[order.status];
  const [refreshing, setRefreshing] = useState(false);
  const url = trackingUrl(order.carrier, order.trackingNumber);
  const canRefresh = order.carrier !== "OTHER";

  const handleRefresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-50"
        onClick={onToggle}
      >
        {/* Carrier icon */}
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center ${carrierIcon(order.carrier)}`}
        >
          <Truck size={20} />
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-semibold text-sm text-gray-900">
              {order.trackingNumber}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}
            >
              {STATUS_LABELS[order.status]}
            </span>
            <span className="text-xs text-gray-400">
              {carrierLabel(order)}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate">
            {order.latestEvent || "No updates yet"}
            {(order.customerName || order.order?.customerName) && (
              <span className="ml-2 text-gray-400">
                —{" "}
                {order.customerName || order.order?.customerName}
              </span>
            )}
            {(order.productName || order.order?.productName) && (
              <span className="ml-1 text-gray-400">
                ({order.productName || order.order?.productName})
              </span>
            )}
          </div>
          {order.codCreatedAt && (
            <div className="text-xs text-gray-400 mt-0.5">
              COD Created:{" "}
              {new Date(order.codCreatedAt).toLocaleDateString()}
            </div>
          )}
        </div>

        {/* Last checked */}
        <div className="hidden sm:flex items-center gap-1 text-xs text-gray-400">
          <Clock size={12} />
          {order.lastCheckedAt
            ? new Date(order.lastCheckedAt).toLocaleString()
            : "Never"}
        </div>

        {/* Actions */}
        <div
          className="flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-600"
              title="View on carrier site"
            >
              <ExternalLink size={15} />
            </a>
          )}
          {canRefresh && (
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-600 disabled:opacity-50"
              title="Refresh tracking"
            >
              <RefreshCw
                size={15}
                className={refreshing ? "animate-spin" : ""}
              />
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-600"
            title="Remove tracking"
          >
            <Trash2 size={15} />
          </button>
        </div>

        {expanded ? (
          <ChevronUp size={16} className="text-gray-400" />
        ) : (
          <ChevronDown size={16} className="text-gray-400" />
        )}
      </div>

      {/* Timeline */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-4 bg-gray-50">
          {order.events.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">
              {canRefresh
                ? "No tracking events yet. Click refresh to fetch the latest status."
                : "Live tracking is not available for this carrier. Visit the carrier website for status updates."}
            </p>
          ) : (
            <div className="relative pl-6">
              {order.events.map((evt, i) => {
                const isFirst = i === 0;
                return (
                  <div
                    key={evt.id}
                    className="relative pb-5 last:pb-0"
                  >
                    {i < order.events.length - 1 && (
                      <div className="absolute left-[-17px] top-[10px] bottom-0 w-0.5 bg-gray-200" />
                    )}
                    <div
                      className={`absolute left-[-21px] top-[5px] w-[9px] h-[9px] rounded-full border-2 ${
                        isFirst
                          ? "bg-blue-500 border-blue-500"
                          : "bg-white border-gray-300"
                      }`}
                    />
                    <div>
                      <p
                        className={`text-sm ${
                          isFirst
                            ? "font-semibold text-gray-900"
                            : "text-gray-700"
                        }`}
                      >
                        {evt.description}
                      </p>
                      <div className="flex gap-3 mt-0.5 text-xs text-gray-400">
                        <span>
                          {new Date(
                            evt.occurredAt
                          ).toLocaleString()}
                        </span>
                        {evt.location && (
                          <span>{evt.location}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
