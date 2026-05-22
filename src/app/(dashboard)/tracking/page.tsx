"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
  ChevronLeft,
  ChevronRight,
  Filter,
  Settings,
  Copy,
  Check,
} from "lucide-react";

type TrackingCarrier = "IMILE" | "INJAZ" | "JTE" | "JDW" | "NAQEL" | "OTHER";
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
  latestError: string | null;
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

function errorPill(
  latestError: string | null
): { label: string; bg: string; text: string } | null {
  if (!latestError) return null;
  switch (latestError) {
    case "not_found_on_injaz":
      return {
        label: "Not in Injaz system",
        bg: "bg-gray-100",
        text: "text-gray-600",
      };
    case "not_found_on_jdw":
      return {
        label: "Not in JD Logistics system",
        bg: "bg-gray-100",
        text: "text-gray-600",
      };
    case "jte_manual_only":
      return {
        label: "Awaiting re-track",
        bg: "bg-amber-50",
        text: "text-amber-700",
      };
    case "not_found_on_courier_api":
      return {
        label: "Not found via courier API",
        bg: "bg-gray-100",
        text: "text-gray-600",
      };
    case "imile_rate_limited":
      return {
        label: "iMile throttling",
        bg: "bg-orange-100",
        text: "text-orange-700",
      };
    case "imile_no_result":
      return {
        label: "No iMile result",
        bg: "bg-gray-100",
        text: "text-gray-600",
      };
    case "captcha_required":
      return {
        label: "Captcha key required",
        bg: "bg-red-100",
        text: "text-red-700",
      };
    case "fourtracking_blocked":
      return {
        label: "Legacy 4tracking error",
        bg: "bg-red-100",
        text: "text-red-700",
      };
    default:
      // Transport-level / parser flakes are persisted as
      // "imile_error:<detail>" / "jdw_error:<code>" / "injaz_error:<detail>"
      // / "fourtracking_fetch_failed:<detail>". Render those with a single
      // operator-friendly "Carrier API error" label; the wrapping span
      // already passes the raw code as its `title` for hover.
      if (
        latestError.startsWith("imile_error:") ||
        latestError.startsWith("jdw_error:") ||
        latestError.startsWith("injaz_error:") ||
        latestError.startsWith("naqel_error:") ||
        latestError.startsWith("courier_api_error:") ||
        latestError.startsWith("courier_api_fetch_failed:") ||
        latestError.startsWith("fourtracking_fetch_failed:")
      ) {
        return {
          label: "Carrier API error",
          bg: "bg-red-100",
          text: "text-red-700",
        };
      }
      return {
        label: `Error: ${latestError}`,
        bg: "bg-red-100",
        text: "text-red-700",
      };
  }
}

function carrierLabel(order: TrackingOrder): string {
  if (order.carrierName) return order.carrierName;
  if (order.carrier === "IMILE") return "iMile";
  if (order.carrier === "INJAZ") return "Injaz Express";
  if (order.carrier === "JTE") return "JT Express";
  if (order.carrier === "JDW") return "JD Logistics";
  if (order.carrier === "NAQEL") return "Naqel Express";
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
  if (carrier === "JTE") {
    return `https://www.jtexpress.me/KSA/trajectoryQuery?waybillNo=${encodeURIComponent(trackingNumber)}&type=0`;
  }
  if (carrier === "NAQEL") {
    return `https://www.naqelexpress.com/en/sa/tracking/?trackingNo=${encodeURIComponent(trackingNumber)}`;
  }
  if (carrier === "JDW") {
    return `https://www.jingdonglogistics.com/Tracking`;
  }
  // OTHER: 4tracking.net is server-side dead (Cloudflare-protected SPA),
  // so don't render a header link that goes nowhere useful.
  return null;
}

function carrierIcon(carrier: TrackingCarrier): string {
  if (carrier === "IMILE") return "bg-blue-100 text-blue-600";
  if (carrier === "INJAZ") return "bg-orange-100 text-orange-600";
  if (carrier === "JTE") return "bg-red-100 text-red-600";
  if (carrier === "JDW") return "bg-purple-100 text-purple-600";
  if (carrier === "NAQEL") return "bg-teal-100 text-teal-600";
  return "bg-gray-100 text-gray-600";
}

const REFRESH_OPTIONS = [
  { label: "Every 30 min", value: "30" },
  { label: "Every 1 hour", value: "60" },
  { label: "Every 6 hours", value: "360" },
  { label: "Every 12 hours", value: "720" },
  { label: "Once a day", value: "1440" },
];

export default function TrackingPage() {
  const [orders, setOrders] = useState<TrackingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [filterCarrier, setFilterCarrier] = useState<string>("");
  const [draftCarrier, setDraftCarrier] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterProduct, setFilterProduct] = useState<string>("");
  const [draftProduct, setDraftProduct] = useState<string>("");
  const [productNames, setProductNames] = useState<string[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const productDropdownRef = useRef<HTMLDivElement>(null);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [draftDateFrom, setDraftDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [draftDateTo, setDraftDateTo] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalOrders, setTotalOrders] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [refreshInterval, setRefreshInterval] = useState("60");
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const initialLoad = useRef(true);

  // Primary product names (first product before comma)
  const primaryProductNames = useMemo(() => {
    const primaries = new Set<string>();
    for (const name of productNames) {
      const primary = name.split(",")[0].trim();
      if (primary) primaries.add(primary);
    }
    return Array.from(primaries).sort();
  }, [productNames]);

  const filteredProducts = primaryProductNames.filter((p) =>
    p.toLowerCase().includes(productSearch.toLowerCase())
  );

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

  const showToast = useCallback(
    (kind: "success" | "error", text: string) => {
      setToast({ kind, text });
      setTimeout(() => setToast(null), 4000);
    },
    []
  );

  const fetchCounts = useCallback(async () => {
    try {
      const data = await api.get<{
        total: number;
        statusCounts: Record<string, number>;
        productNames: string[];
      }>("/tracking", { countsOnly: "true" });
      setStatusCounts(data.statusCounts);
      setProductNames(data.productNames);
      setTotalOrders(
        Object.values(data.statusCounts).reduce((a, b) => a + b, 0)
      );
    } catch {
      // non-critical
    }
  }, []);

  const fetchOrders = useCallback(
    async (p = page) => {
      try {
        const params: Record<string, string> = {
          page: String(p),
          pageSize: "50",
        };
        if (filterCarrier) params.carrier = filterCarrier;
        if (filterStatus) params.status = filterStatus;
        if (filterProduct) params.product = filterProduct;
        if (search) params.search = search;
        if (dateFrom) params.dateFrom = dateFrom;
        if (dateTo) params.dateTo = dateTo;
        const data = await api.get<{
          orders: TrackingOrder[];
          total: number;
          page: number;
          totalPages: number;
        }>("/tracking", params);
        setOrders(data.orders);
        setTotalPages(data.totalPages);
        setPage(data.page);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Failed to load"
        );
      } finally {
        setLoading(false);
      }
    },
    [filterCarrier, filterStatus, filterProduct, search, dateFrom, dateTo, page, showToast]
  );

  // Load counts + settings on mount
  useEffect(() => {
    fetchCounts();
    api
      .get<{ settings: Record<string, string | null> }>("/settings")
      .then((data) => {
        const interval = data.settings?.tracking_refresh_interval_minutes;
        if (interval) setRefreshInterval(interval);
      })
      .catch(() => undefined);
  }, [fetchCounts]);

  // Fetch orders on filter/page change
  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      fetchOrders(1);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch when applied filters change
  useEffect(() => {
    fetchOrders(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCarrier, filterStatus, filterProduct, search, dateFrom, dateTo]);

  const handleApplyFilters = () => {
    setFilterCarrier(draftCarrier);
    setFilterProduct(draftProduct);
    setSearch(draftSearch);
    setDateFrom(draftDateFrom);
    setDateTo(draftDateTo);
    setPage(1);
  };

  const handleClearFilters = () => {
    setDraftCarrier("");
    setDraftProduct("");
    setDraftSearch("");
    setDraftDateFrom("");
    setDraftDateTo("");
    setFilterCarrier("");
    setFilterProduct("");
    setFilterStatus("");
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    type CarrierStats = { processed: number; eventsAdded: number; errors: number };
    const totals: Record<"imile" | "jte" | "jdw" | "injaz" | "naqel", CarrierStats> = {
      imile: { processed: 0, eventsAdded: 0, errors: 0 },
      jte: { processed: 0, eventsAdded: 0, errors: 0 },
      jdw: { processed: 0, eventsAdded: 0, errors: 0 },
      injaz: { processed: 0, eventsAdded: 0, errors: 0 },
      naqel: { processed: 0, eventsAdded: 0, errors: 0 },
    };
    const formatBreakdown = (remaining: number) => {
      const parts: string[] = [];
      const labels: Record<keyof typeof totals, string> = {
        imile: "iMile",
        jte: "JTE",
        jdw: "JDW",
        injaz: "Injaz",
        naqel: "Naqel",
      };
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
        const s = totals[k];
        if (s.processed === 0) continue;
        parts.push(`${labels[k]}: ${s.processed} processed (${s.eventsAdded} updated)`);
      }
      const head = parts.length > 0 ? parts.join(", ") : "No active orders";
      return remaining > 0 ? `${head}. ${remaining} remaining.` : head;
    };
    let totalDone = 0;
    try {
      let hasMore = true;
      while (hasMore) {
        const result = await api.post<{
          totalProcessed: number;
          batches: number;
          remaining: number;
          totalActive: number;
          reclassified: number;
          byCarrier?: Record<keyof typeof totals, CarrierStats>;
        }>("/tracking/refresh?includeFinal=true");
        totalDone += result.totalProcessed;
        if (result.byCarrier) {
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
            const inc = result.byCarrier[k];
            if (!inc) continue;
            totals[k].processed += inc.processed;
            totals[k].eventsAdded += inc.eventsAdded;
            totals[k].errors += inc.errors;
          }
        }
        if (result.reclassified > 0) {
          showToast("success", `Reclassified ${result.reclassified} carriers`);
        }
        hasMore = result.remaining > 0;
        if (hasMore) {
          showToast("success", formatBreakdown(result.remaining));
        }
      }
      await fetchOrders();
      await fetchCounts();
      showToast("success", `Refreshed ${totalDone} orders. ${formatBreakdown(0)}`);
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
        trackingUpdated: number;
        reclassified: number;
      }>("/tracking/sync");
      await fetchOrders();
      await fetchCounts();
      const parts = [`Synced ${result.ordersFound} orders`];
      if (result.trackingImported > 0) parts.push(`${result.trackingImported} new tracking`);
      if (result.reclassified > 0) parts.push(`${result.reclassified} carriers fixed`);
      showToast("success", parts.join(", "));
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Full sync failed"
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleReclassify = async () => {
    setReclassifying(true);
    try {
      const result = await api.post<{
        reclassified: number;
        totalScanned: number;
      }>("/tracking/reclassify");
      await fetchCounts();
      await fetchOrders();
      showToast("success", `Reclassified ${result.reclassified} orders`);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Reclassify failed"
      );
    } finally {
      setReclassifying(false);
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
      await fetchCounts();
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
    if (filterProduct) params.set("product", filterProduct);
    if (search) params.set("search", search);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    window.open(`/api/tracking/export?${params.toString()}`, "_blank");
  };

  const handleSaveRefreshInterval = async (val: string) => {
    setRefreshInterval(val);
    try {
      await api.put("/settings", {
        settings: { tracking_refresh_interval_minutes: val },
      });
      showToast("success", `Refresh interval set to ${REFRESH_OPTIONS.find((o) => o.value === val)?.label}`);
    } catch {
      showToast("error", "Failed to save interval");
    }
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchOrders(newPage);
  };

  const hasFilters =
    draftDateFrom || draftDateTo || draftCarrier || draftProduct || draftSearch;
  const hasAppliedFilters =
    dateFrom || dateTo || filterCarrier || filterStatus || filterProduct || search;

  return (
    <div className="max-w-6xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Truck className="text-blue-600" size={24} />
            Package Tracking
            <span className="text-sm font-normal text-gray-400 ml-2">
              {totalOrders} orders
            </span>
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Background tracking refreshes pending & in-transit orders
            automatically. Click Refresh All to re-check every order, including
            delivered and returned.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200"
            title="Tracking settings"
          >
            <Settings size={16} />
          </button>
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
            {syncing ? "Syncing..." : "Sync All"}
          </button>
          <button
            onClick={handleReclassify}
            disabled={reclassifying}
            className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
            title="Re-detect carriers for OTHER-bucket orders"
          >
            <Filter
              size={16}
              className={reclassifying ? "animate-pulse" : ""}
            />
            {reclassifying ? "Reclassifying..." : "Reclassify"}
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
            disabled={totalOrders === 0}
            className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            <Download size={16} />
            Export
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="mb-4 p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="text-sm font-medium text-gray-700 mb-3">
            Tracking Refresh Interval
          </h3>
          <div className="flex gap-2 flex-wrap">
            {REFRESH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleSaveRefreshInterval(opt.value)}
                className={`px-3 py-1.5 text-sm rounded-md border ${
                  refreshInterval === opt.value
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Auto-refresh covers pending and in-transit orders. Click Refresh
            All to re-check every order, including delivered and returned.
          </p>
        </div>
      )}

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

      {/* Status summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        {(Object.keys(STATUS_LABELS) as TrackingStatus[]).map((s) => {
          const c = STATUS_COLORS[s];
          const count = statusCounts[s] || 0;
          return (
            <button
              key={s}
              onClick={() => {
                const newStatus = filterStatus === s ? "" : s;
                setFilterStatus(newStatus);
                setPage(1);
              }}
              className={`p-3 rounded-lg border text-center transition-all ${
                filterStatus === s
                  ? "ring-2 ring-blue-500 border-blue-300"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div className={`text-2xl font-bold ${c.text}`}>{count}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {STATUS_LABELS[s]}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filters with Apply button */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="relative flex-1 min-w-[200px]">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              placeholder="Search tracking number or customer..."
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleApplyFilters()}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <select
            value={draftCarrier}
            onChange={(e) => setDraftCarrier(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
          >
            <option value="">All Carriers</option>
            <option value="IMILE">iMile</option>
            <option value="INJAZ">Injaz Express</option>
            <option value="JTE">JT Express</option>
            <option value="JDW">JD Logistics</option>
            <option value="OTHER">Other</option>
          </select>
          <div className="relative" ref={productDropdownRef}>
            <button
              onClick={() => setShowProductDropdown(!showProductDropdown)}
              className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white min-w-[160px] max-w-[220px]"
            >
              <span className="truncate">
                {draftProduct || "All Products"}
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
                      setDraftProduct("");
                      setShowProductDropdown(false);
                      setProductSearch("");
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                      !draftProduct ? "bg-blue-50 text-blue-700" : ""
                    }`}
                  >
                    All Products
                  </button>
                  {filteredProducts.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setDraftProduct(p);
                        setShowProductDropdown(false);
                        setProductSearch("");
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 truncate ${
                        draftProduct === p ? "bg-blue-50 text-blue-700" : ""
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
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">From:</label>
            <input
              type="date"
              value={draftDateFrom}
              onChange={(e) => setDraftDateFrom(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">To:</label>
            <input
              type="date"
              value={draftDateTo}
              onChange={(e) => setDraftDateTo(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
            />
          </div>
          <button
            onClick={handleApplyFilters}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            <Filter size={14} />
            Apply
          </button>
          {(hasFilters || hasAppliedFilters) && (
            <button
              onClick={handleClearFilters}
              className="px-3 py-2 text-sm text-red-600 hover:text-red-700"
            >
              Clear
            </button>
          )}
        </div>

        {/* Quick date shortcuts */}
        <div className="flex gap-2 mt-3">
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
                  setDraftDateFrom("2025-01-01");
                } else {
                  const d = new Date();
                  d.setDate(d.getDate() - preset.days);
                  setDraftDateFrom(d.toISOString().slice(0, 10));
                }
                setDraftDateTo(new Date().toISOString().slice(0, 10));
              }}
              className="px-3 py-1 text-xs border border-gray-200 rounded-full hover:bg-gray-50 text-gray-600"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="animate-spin text-gray-400" size={24} />
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <Package className="mx-auto text-gray-300" size={32} />
          <p className="text-gray-500 mt-2 text-sm">
            {hasAppliedFilters
              ? "No orders match your current filters."
              : 'No orders with tracking numbers found. Click "Sync All" to import all orders from COD Network since January 2025.'}
          </p>
        </div>
      ) : (
        <>
          {/* Pagination header */}
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400">
              Showing {(page - 1) * 50 + 1}–
              {Math.min(page * 50, (page - 1) * 50 + orders.length)} of{" "}
              {totalPages > 1
                ? `page ${page}/${totalPages}`
                : `${orders.length} order${orders.length !== 1 ? "s" : ""}`}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1}
                  className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30"
                >
                  <ChevronLeft size={16} />
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
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
                      onClick={() => handlePageChange(pageNum)}
                      className={`min-w-[32px] h-8 rounded text-sm ${
                        pageNum === page
                          ? "bg-blue-600 text-white"
                          : "hover:bg-gray-100 text-gray-600"
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages}
                  className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>

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

          {/* Bottom pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1 mt-4">
              <button
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded text-sm hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <span className="px-3 text-sm text-gray-500">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 rounded text-sm hover:bg-gray-100 disabled:opacity-30"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}
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
  const errorInfo = errorPill(order.latestError);
  const [refreshing, setRefreshing] = useState(false);
  const url = trackingUrl(order.carrier, order.trackingNumber);
  const canRefresh = order.carrier !== "OTHER";
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(order.trackingNumber).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const hasUrl = url !== null;

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
            <button
              onClick={handleCopy}
              className="p-0.5 rounded hover:bg-gray-200 transition-colors"
              title="Copy tracking number"
            >
              {copied ? (
                <Check size={14} className="text-green-600" />
              ) : (
                <Copy size={14} className="text-gray-400" />
              )}
            </button>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}
            >
              {STATUS_LABELS[order.status]}
            </span>
            {errorInfo &&
              (order.latestError === "captcha_required" ? (
                <a
                  href="/settings#tracking"
                  title={order.latestError ?? undefined}
                  onClick={(e) => e.stopPropagation()}
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${errorInfo.bg} ${errorInfo.text} hover:underline`}
                >
                  {errorInfo.label}
                </a>
              ) : (
                <span
                  title={order.latestError ?? undefined}
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${errorInfo.bg} ${errorInfo.text}`}
                >
                  {errorInfo.label}
                </span>
              ))}
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
          {hasUrl && (
            <a
              href={url!}
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
