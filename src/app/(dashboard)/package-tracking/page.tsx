"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Download,
  Search,
  Settings,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Trash2,
  Clock,
  Package as PackageIcon,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  X,
} from "lucide-react";

interface TrackingOrder {
  id: string;
  codNetworkOrderId: string;
  customerName: string | null;
  customerPhone: string | null;
  productName: string | null;
  productImageUrl: string | null;
  trackingNumber: string | null;
  deliveryCompany: string | null;
  status: string;
  codDeliveryStatus: string | null;
  codCreatedAt: string | null;
  updatedAt: string;
}

interface StatusCounts {
  pending: number;
  inTransit: number;
  outForDelivery: number;
  delivered: number;
  returned: number;
  exception: number;
  unknown: number;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  CONFIRMED: "Pending",
  PROCESSING: "Pending",
  SHIPPED: "In Transit",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Exception",
  UNKNOWN: "Unknown",
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-gray-100 text-gray-700",
  CONFIRMED: "bg-blue-100 text-blue-700",
  PROCESSING: "bg-indigo-100 text-indigo-700",
  SHIPPED: "bg-blue-100 text-blue-700",
  OUT_FOR_DELIVERY: "bg-orange-100 text-orange-700",
  DELIVERED: "bg-green-100 text-green-700",
  RETURNED: "bg-red-100 text-red-700",
  CANCELLED: "bg-red-100 text-red-700",
  UNKNOWN: "bg-gray-100 text-gray-600",
};

export default function PackageTrackingPage() {
  const [orders, setOrders] = useState<TrackingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [counts, setCounts] = useState<StatusCounts>({
    pending: 0,
    inTransit: 0,
    outForDelivery: 0,
    delivered: 0,
    returned: 0,
    exception: 0,
    unknown: 0,
  });
  const [carriers, setCarriers] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [carrierFilter, setCarrierFilter] = useState("all");
  const [productFilter, setProductFilter] = useState("all");
  const [productSearch, setProductSearch] = useState("");
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [quickRange, setQuickRange] = useState("");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const productDropdownRef = useRef<HTMLDivElement>(null);

  // Close product dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        productDropdownRef.current &&
        !productDropdownRef.current.contains(e.target as Node)
      ) {
        setShowProductDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        page: String(page),
        pageSize: "50",
      };
      if (search) params.search = search;
      if (carrierFilter !== "all") params.carrier = carrierFilter;
      if (productFilter !== "all") params.product = productFilter;
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate;
      if (quickRange) params.range = quickRange;

      const data = await api.get<{
        orders: TrackingOrder[];
        pagination: { total: number; totalPages: number };
        counts: StatusCounts;
        carriers: string[];
        products: string[];
      }>("/package-tracking", params);
      setOrders(data.orders);
      setTotalPages(data.pagination.totalPages);
      setTotalCount(data.pagination.total);
      setCounts(data.counts);
      setCarriers(data.carriers);
      setProducts(data.products);
    } catch {
      setNotification({ type: "error", message: "Failed to load tracking data" });
    } finally {
      setLoading(false);
    }
  }, [page, search, carrierFilter, productFilter, fromDate, toDate, quickRange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  const handleSyncAll = async () => {
    setSyncing(true);
    setNotification(null);
    try {
      const result = await api.post<{
        success: boolean;
        result: {
          ordersFound: number;
          ordersCreated: number;
          ordersUpdated: number;
          errors: string[];
        };
      }>("/orders/sync");
      setNotification({
        type: "success",
        message: `Sync complete — found ${result.result.ordersFound} orders, ${result.result.ordersCreated} new, ${result.result.ordersUpdated} updated.${result.result.errors.length > 0 ? ` (${result.result.errors.length} errors)` : ""}`,
      });
      fetchData();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    setNotification(null);
    try {
      await fetchData();
      setNotification({ type: "success", message: "Data refreshed from database." });
    } catch {
      setNotification({ type: "error", message: "Refresh failed" });
    } finally {
      setRefreshing(false);
    }
  };

  const handleExport = () => {
    const headers = [
      "Tracking Number",
      "Status",
      "Carrier",
      "Customer",
      "Product",
      "COD Order ID",
      "COD Created",
      "Last Updated",
    ];
    const rows = orders.map((o) => [
      o.trackingNumber || "",
      STATUS_LABELS[o.status] || o.status,
      o.deliveryCompany || "",
      o.customerName || "",
      o.productName || "",
      o.codNetworkOrderId,
      o.codCreatedAt ? new Date(o.codCreatedAt).toLocaleDateString() : "",
      new Date(o.updatedAt).toLocaleString(),
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `package-tracking-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleApplyFilters = () => {
    setPage(1);
    setQuickRange("");
    fetchData();
  };

  const handleQuickRange = (range: string) => {
    setQuickRange(range);
    setFromDate("");
    setToDate("");
    setPage(1);
  };

  const filteredProducts = products.filter((p) =>
    p.toLowerCase().includes(productSearch.toLowerCase())
  );

  const getLatestUpdate = (order: TrackingOrder): string => {
    if (order.codDeliveryStatus) return order.codDeliveryStatus;
    return "No updates yet";
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <PackageIcon size={24} className="text-gray-700" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Package Tracking
            </h1>
            <p className="text-sm text-gray-500">
              Tracks pending &amp; in-transit orders automatically. Delivered/returned orders are skipped.
            </p>
          </div>
          <span className="text-sm text-gray-400 ml-2">
            {totalCount} orders
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button className="p-2 text-gray-400 hover:text-gray-600">
            <Settings size={18} />
          </button>
          <button
            onClick={handleSyncAll}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            <Clipboard size={14} />
            {syncing ? "Syncing..." : "Sync All"}
          </button>
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "animate-spin" : ""}
            />
            {refreshing ? "Refreshing..." : "Refresh All"}
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 bg-red-600 text-white rounded-md text-sm hover:bg-red-700"
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </div>

      {/* Notification */}
      {notification && (
        <div
          className={`mb-4 p-3 rounded-md text-sm border flex items-center justify-between ${
            notification.type === "success"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {notification.message}
          <button onClick={() => setNotification(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Status summary cards */}
      <div className="grid grid-cols-7 gap-3 mb-5">
        {[
          {
            label: "Pending",
            count: counts.pending,
            color: "text-blue-700",
          },
          {
            label: "In Transit",
            count: counts.inTransit,
            color: "text-blue-600",
          },
          {
            label: "Out for Delivery",
            count: counts.outForDelivery,
            color: "text-orange-600",
          },
          {
            label: "Delivered",
            count: counts.delivered,
            color: "text-green-600",
          },
          {
            label: "Returned",
            count: counts.returned,
            color: "text-red-600",
          },
          {
            label: "Exception",
            count: counts.exception,
            color: "text-red-700",
          },
          {
            label: "Unknown",
            count: counts.unknown,
            color: "text-gray-500",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white border border-gray-200 rounded-lg p-3 text-center"
          >
            <div className={`text-2xl font-bold ${stat.color}`}>
              {stat.count}
            </div>
            <div className="text-xs text-gray-500">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                placeholder="Search tracking number or customer..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setSearch(searchInput);
                    setPage(1);
                  }
                }}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
          </div>

          {/* Carrier filter */}
          <div>
            <select
              value={carrierFilter}
              onChange={(e) => {
                setCarrierFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
            >
              <option value="all">All Carriers</option>
              {carriers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Product filter with search */}
          <div className="relative" ref={productDropdownRef}>
            <button
              onClick={() => setShowProductDropdown(!showProductDropdown)}
              className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white min-w-[160px]"
            >
              <span className="truncate max-w-[150px]">
                {productFilter === "all"
                  ? "All Products"
                  : productFilter}
              </span>
              <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
            </button>
            {showProductDropdown && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-md shadow-lg z-50 max-h-64 overflow-hidden flex flex-col">
                <div className="p-2 border-b border-gray-100">
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
                    />
                    <input
                      type="text"
                      placeholder="Search products..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="w-full pl-7 pr-2 py-1.5 border border-gray-200 rounded text-xs"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="overflow-y-auto max-h-48">
                  <button
                    onClick={() => {
                      setProductFilter("all");
                      setShowProductDropdown(false);
                      setProductSearch("");
                      setPage(1);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                      productFilter === "all" ? "bg-blue-50 text-blue-700" : ""
                    }`}
                  >
                    All Products
                  </button>
                  {filteredProducts.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setProductFilter(p);
                        setShowProductDropdown(false);
                        setProductSearch("");
                        setPage(1);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 truncate ${
                        productFilter === p ? "bg-blue-50 text-blue-700" : ""
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  {filteredProducts.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-400">
                      No products found
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Date range */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">From:</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setQuickRange("");
              }}
              className="px-2 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">To:</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setQuickRange("");
              }}
              className="px-2 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>

          <button
            onClick={handleApplyFilters}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-md text-sm hover:bg-red-700"
          >
            <Search size={14} />
            Apply
          </button>
        </div>

        {/* Quick date range buttons */}
        <div className="flex gap-2 mt-3">
          {[
            { label: "Last 7 days", value: "7d" },
            { label: "Last 30 days", value: "30d" },
            { label: "Last 90 days", value: "90d" },
            { label: "This year", value: "year" },
          ].map((r) => (
            <button
              key={r.value}
              onClick={() => handleQuickRange(r.value)}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                quickRange === r.value
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results count and pagination */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-500">
          Showing {(page - 1) * 50 + 1}–{Math.min(page * 50, totalCount)} of
          page {page}/{totalPages}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
            let pageNum: number;
            if (totalPages <= 7) {
              pageNum = i + 1;
            } else if (page <= 4) {
              pageNum = i + 1;
            } else if (page >= totalPages - 3) {
              pageNum = totalPages - 6 + i;
            } else {
              pageNum = page - 3 + i;
            }
            return (
              <button
                key={pageNum}
                onClick={() => setPage(pageNum)}
                className={`w-8 h-8 rounded text-sm ${
                  page === pageNum
                    ? "bg-blue-600 text-white"
                    : "hover:bg-gray-100 text-gray-600"
                }`}
              >
                {pageNum}
              </button>
            );
          })}
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Orders list */}
      {loading ? (
        <div className="text-center py-12">
          <RefreshCw className="animate-spin text-gray-400 mx-auto" size={24} />
          <p className="mt-2 text-sm text-gray-500">Loading tracking data...</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center">
          <PackageIcon className="mx-auto text-gray-400 mb-3" size={32} />
          <p className="text-gray-700 font-medium">No trackable orders found.</p>
          <p className="text-gray-500 text-sm mt-1">
            Try adjusting your filters or click Sync All to fetch latest orders.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => (
            <div
              key={order.id}
              className="bg-white border border-gray-200 rounded-lg overflow-hidden"
            >
              <div className="flex items-center px-4 py-3 gap-4">
                {/* Icon */}
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                    <PackageIcon size={20} className="text-blue-600" />
                  </div>
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-mono font-semibold text-gray-900 text-sm">
                      {order.trackingNumber || order.codNetworkOrderId}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        STATUS_COLORS[order.status] || "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {STATUS_LABELS[order.status] || order.status}
                    </span>
                    {order.deliveryCompany && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600">
                        {order.deliveryCompany}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {getLatestUpdate(order)}
                    {order.customerName && (
                      <span>
                        {" "}
                        — {order.customerName}
                        {order.productName && ` (${order.productName})`}
                      </span>
                    )}
                  </div>
                  {order.codCreatedAt && (
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      COD Created: {new Date(order.codCreatedAt).toLocaleDateString()}
                    </div>
                  )}
                </div>

                {/* Timestamp */}
                <div className="flex-shrink-0 text-xs text-gray-400 flex items-center gap-1">
                  <Clock size={12} />
                  {new Date(order.updatedAt).toLocaleString()}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                    title="Open in Orders"
                  >
                    <ExternalLink size={14} />
                  </button>
                  <button
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                    title="Remove from tracking"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    onClick={() =>
                      setExpandedId(
                        expandedId === order.id ? null : order.id
                      )
                    }
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                  >
                    {expandedId === order.id ? (
                      <ChevronUp size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              {expandedId === order.id && (
                <div className="px-4 pb-3 border-t border-gray-100 bg-gray-50">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 py-3 text-xs">
                    <div>
                      <span className="text-gray-400 block">Order ID</span>
                      <span className="text-gray-700 font-mono">
                        {order.codNetworkOrderId}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Tracking #</span>
                      <span className="text-gray-700 font-mono">
                        {order.trackingNumber || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Carrier</span>
                      <span className="text-gray-700">
                        {order.deliveryCompany || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Customer</span>
                      <span className="text-gray-700">
                        {order.customerName || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Phone</span>
                      <span className="text-gray-700">
                        {order.customerPhone || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Product</span>
                      <span className="text-gray-700">
                        {order.productName || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">
                        Delivery Status
                      </span>
                      <span className="text-gray-700">
                        {order.codDeliveryStatus || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Last Updated</span>
                      <span className="text-gray-700">
                        {new Date(order.updatedAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Bottom info */}
      <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-700">
        <strong>Sync All</strong> fetches the latest order data from COD Network
        and updates tracking statuses. <strong>Refresh All</strong> reloads the
        current data from the local database without contacting COD Network.
      </div>
    </div>
  );
}
