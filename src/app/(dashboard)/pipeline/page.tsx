"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import ManualOrderModal from "@/components/manual-order-modal";
import {
  RefreshCw,
  Send,
  Image as ImageIcon,
  Phone,
  MapPin,
  Package as PackageIcon,
  Hash,
  CheckCircle2,
  X,
  AlertCircle,
  GripVertical,
  Plus,
  CheckSquare,
  ArrowRightLeft,
  Search,
  GripHorizontal,
  Copy,
  Check,
  Trash2,
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
  | "UNKNOWN"
  | "NEW"
  | "NO_REPLY"
  | "WRONG"
  | "EXPIRED"
  | "CALL_LATER"
  | "CANCELLED_PRICE";

const DEFAULT_COLUMN_ORDER: string[] = [
  "NEW",
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "CALL_LATER",
  "NO_REPLY",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "CANCELLED_PRICE",
  "WRONG",
  "EXPIRED",
  "UNKNOWN",
  "__SENT__",
  "__CALL_AGENT__",
];

const REAL_STATUSES: OrderStatus[] = [
  "NEW",
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "CALL_LATER",
  "NO_REPLY",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "CANCELLED_PRICE",
  "WRONG",
  "EXPIRED",
  "UNKNOWN",
];

const STATUS_LABELS: Record<OrderStatus | "__SENT__" | "__CALL_AGENT__", string> = {
  NEW: "New Leads",
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  CALL_LATER: "Call Later",
  NO_REPLY: "No Reply",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
  CANCELLED_PRICE: "Cancelled Price",
  WRONG: "Wrong Leads",
  EXPIRED: "Expired",
  UNKNOWN: "Unknown",
  __SENT__: "WhatsApp Sent",
  __CALL_AGENT__: "Call Agent",
};

const STATUS_COLORS: Record<OrderStatus, string> = {
  NEW: "bg-emerald-100 text-emerald-700 border-emerald-300",
  PENDING: "bg-gray-100 text-gray-700 border-gray-300",
  CONFIRMED: "bg-blue-100 text-blue-700 border-blue-300",
  PROCESSING: "bg-indigo-100 text-indigo-700 border-indigo-300",
  CALL_LATER: "bg-cyan-100 text-cyan-700 border-cyan-300",
  NO_REPLY: "bg-yellow-100 text-yellow-700 border-yellow-300",
  SHIPPED: "bg-amber-100 text-amber-700 border-amber-300",
  OUT_FOR_DELIVERY: "bg-orange-100 text-orange-700 border-orange-300",
  DELIVERED: "bg-green-100 text-green-700 border-green-300",
  RETURNED: "bg-rose-100 text-rose-700 border-rose-300",
  CANCELLED: "bg-red-100 text-red-700 border-red-300",
  CANCELLED_PRICE: "bg-pink-100 text-pink-700 border-pink-300",
  WRONG: "bg-red-200 text-red-800 border-red-400",
  EXPIRED: "bg-stone-100 text-stone-700 border-stone-300",
  UNKNOWN: "bg-slate-100 text-slate-700 border-slate-300",
};

function loadColumnOrder(): string[] {
  if (typeof window === "undefined") return DEFAULT_COLUMN_ORDER;
  try {
    const stored = localStorage.getItem("pipeline_column_order");
    if (stored) {
      const parsed = JSON.parse(stored) as string[];
      // Merge: ensure all statuses are present (new ones go at end)
      const set = new Set(parsed);
      const merged = [...parsed];
      for (const s of DEFAULT_COLUMN_ORDER) {
        if (!set.has(s)) merged.push(s);
      }
      return merged;
    }
  } catch { /* ignore */ }
  return DEFAULT_COLUMN_ORDER;
}

function saveColumnOrder(order: string[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("pipeline_column_order", JSON.stringify(order));
  } catch { /* ignore */ }
}

interface PipelineOrder {
  id: string;
  codNetworkOrderId: string;
  codNetworkLeadId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerCity: string | null;
  customerAddress: string | null;
  productName: string | null;
  productPrice: string | null;
  productQuantity: string | null;
  trackingNumber: string | null;
  deliveryCompany: string | null;
  status: OrderStatus;
  codCreatedAt: string | null;
  whatsappSentAt: string | null;
  productImageUrl: string | null;
  productImages: string[];
  callAgentQueued: boolean;
}

interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  bodyParameterCount: number;
  bodyText: string | null;
  header: { format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION" } | null;
}

const VARIABLES: Array<{ key: string; label: string; resolve: (o: PipelineOrder) => string }> = [
  { key: "customer_name", label: "Customer Name", resolve: (o) => o.customerName || "" },
  { key: "phone", label: "Phone", resolve: (o) => o.customerPhone || "" },
  { key: "city", label: "City", resolve: (o) => o.customerCity || "" },
  { key: "product", label: "Product", resolve: (o) => o.productName || "" },
  { key: "price", label: "Price", resolve: (o) => o.productPrice || "" },
  { key: "quantity", label: "Quantity", resolve: (o) => o.productQuantity || "" },
  { key: "tracking", label: "Tracking #", resolve: (o) => o.trackingNumber || "" },
  { key: "order_id", label: "Order ID", resolve: (o) => o.codNetworkOrderId },
  { key: "delivery_company", label: "Delivery Co.", resolve: (o) => o.deliveryCompany || "" },
];

export default function PipelinePage() {
  const [orders, setOrders] = useState<PipelineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const [hoverColumn, setHoverColumn] = useState<string | null>(null);
  const [sendDialogOrder, setSendDialogOrder] = useState<PipelineOrder | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState<string | null>(null);
  const [showManualOrder, setShowManualOrder] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [columnOrder, setColumnOrder] = useState<string[]>(loadColumnOrder);
  const [dragColumnKey, setDragColumnKey] = useState<string | null>(null);

  const showToast = useCallback((kind: "success" | "error", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await api.get<{ orders: PipelineOrder[] }>(
        "/orders?pageSize=500"
      );
      setOrders(data.orders);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchOrders();
  }, [fetchOrders]);

  const filteredOrders = useMemo(() => {
    if (!searchQuery.trim()) return orders;
    const q = searchQuery.toLowerCase();
    return orders.filter((o) =>
      (o.customerName?.toLowerCase().includes(q)) ||
      (o.customerPhone?.includes(q)) ||
      (o.trackingNumber?.toLowerCase().includes(q)) ||
      (o.codNetworkOrderId?.toLowerCase().includes(q)) ||
      (o.codNetworkLeadId?.toLowerCase().includes(q)) ||
      (o.productName?.toLowerCase().includes(q)) ||
      (o.customerCity?.toLowerCase().includes(q))
    );
  }, [orders, searchQuery]);

  const grouped = useMemo(() => {
    const groups: Record<string, PipelineOrder[]> = { __SENT__: [], __CALL_AGENT__: [] };
    REAL_STATUSES.forEach((s) => (groups[s] = []));
    for (const o of filteredOrders) {
      if (o.callAgentQueued) groups.__CALL_AGENT__.push(o);
      else if (o.whatsappSentAt) groups.__SENT__.push(o);
      else groups[o.status]?.push(o);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const aDate = a.codCreatedAt ? new Date(a.codCreatedAt).getTime() : 0;
        const bDate = b.codCreatedAt ? new Date(b.codCreatedAt).getTime() : 0;
        return bDate - aDate;
      });
    }
    return groups;
  }, [filteredOrders]);

  const handleDragStart = (orderId: string) => {
    draggingIdRef.current = orderId;
    setDraggingId(orderId);
  };

  const handleDragEnd = () => {
    draggingIdRef.current = null;
    setDraggingId(null);
    setHoverColumn(null);
  };

  const handleDragOver = (e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (hoverColumn !== columnKey) setHoverColumn(columnKey);
  };

  const handleDragEnter = (e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverColumn(columnKey);
  };

  const handleDragLeave = (columnKey: string) => {
    if (hoverColumn === columnKey) setHoverColumn(null);
  };

  const handleDrop = async (e: React.DragEvent, columnKey: string) => {
    const idFromData = e.dataTransfer?.getData("text/plain") || null;
    const id = idFromData || draggingIdRef.current || draggingId;
    draggingIdRef.current = null;
    setDraggingId(null);
    setHoverColumn(null);
    if (!id) return;
    const order = orders.find((o) => o.id === id);
    if (!order) return;

    if (columnKey === "__SENT__") {
      setSendDialogOrder(order);
      return;
    }

    if (columnKey === "__CALL_AGENT__") {
      setOrders((prev) =>
        prev.map((o) => (o.id === id ? { ...o, callAgentQueued: true } : o))
      );
      try {
        await fetch(`/api/orders/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callAgentQueued: true }),
        }).then(async (r) => {
          if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        });
        fetch("/api/voice-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: id }),
        }).then(async (r) => {
          const data = (await r.json()) as { error?: string };
          if (!r.ok) {
            showToast("error", data.error || "Voice agent call failed");
          } else {
            showToast("success", "Voice agent call initiated");
          }
        }).catch(() => showToast("error", "Voice agent call failed"));
      } catch {
        setOrders((prev) =>
          prev.map((o) => (o.id === id ? { ...o, callAgentQueued: false } : o))
        );
        showToast("error", "Failed to queue call agent");
      }
      return;
    }

    if (columnKey === order.status) return;

    const previousStatus = order.status;
    setOrders((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: columnKey as OrderStatus } : o))
    );
    try {
      await fetch(`/api/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: columnKey }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      });
      showToast("success", `Moved to ${STATUS_LABELS[columnKey as OrderStatus]}`);
    } catch (err) {
      setOrders((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: previousStatus } : o))
      );
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to update status"
      );
    }
  };

  const handleAfterSend = (orderId: string, sentAt: string) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, whatsappSentAt: sentAt } : o))
    );
    setSendDialogOrder(null);
    showToast("success", "WhatsApp message sent");
  };

  const handleDeleteOrder = async (orderId: string) => {
    try {
      await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
    } catch {
      showToast("error", "Failed to delete order");
    }
  };

  const toggleSelect = (orderId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const handleBulkMove = async (targetStatus: string) => {
    setBulkMoveTarget(null);
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const previousOrders = [...orders];
    setOrders((prev) =>
      prev.map((o) =>
        selectedIds.has(o.id) ? { ...o, status: targetStatus as OrderStatus } : o
      )
    );

    let successCount = 0;
    let failCount = 0;
    for (const id of ids) {
      try {
        const r = await fetch(`/api/orders/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: targetStatus }),
        });
        if (!r.ok) throw new Error("failed");
        successCount++;
      } catch {
        failCount++;
      }
    }

    if (failCount > 0) {
      setOrders(previousOrders);
      showToast("error", `${failCount} of ${ids.length} moves failed`);
    } else {
      showToast("success", `Moved ${successCount} orders to ${STATUS_LABELS[targetStatus as OrderStatus] || targetStatus}`);
    }
    setSelectedIds(new Set());
  };

  const refresh = () => {
    setRefreshing(true);
    fetchOrders();
  };

  const handleColumnDragStart = (key: string) => {
    setDragColumnKey(key);
  };

  const handleColumnDragOver = (e: React.DragEvent, overKey: string) => {
    e.preventDefault();
    if (!dragColumnKey || dragColumnKey === overKey) return;
    setColumnOrder((prev) => {
      const from = prev.indexOf(dragColumnKey);
      const to = prev.indexOf(overKey);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, dragColumnKey);
      return next;
    });
  };

  const handleColumnDragEnd = () => {
    setDragColumnKey(null);
    saveColumnOrder(columnOrder);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline</h1>
          <p className="text-sm text-gray-500">
            Drag cards between columns to update status. Use the grip handle to drag; click card text to select it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search clients, tracking #, orders..."
              className="pl-9 pr-3 py-1.5 border border-gray-300 rounded-md text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {selectedIds.size > 0 && (
            <div className="relative">
              <button
                onClick={() => setBulkMoveTarget(bulkMoveTarget ? null : "open")}
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700"
              >
                <ArrowRightLeft size={14} />
                Move {selectedIds.size} selected
              </button>
              {bulkMoveTarget === "open" && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-30 w-56 py-1">
                  {REAL_STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleBulkMove(s)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 text-gray-700"
                    >
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {selectedIds.size > 0 && (
            <button
              onClick={() => setSelectedIds(new Set())}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-md"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setShowManualOrder(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >
            <Plus size={14} />
            New Order
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-x-auto pb-2">
        <div className="flex gap-3 h-full min-w-max">
          {columnOrder.map((colKey) => {
            const isSent = colKey === "__SENT__";
            const isCallAgent = colKey === "__CALL_AGENT__";
            const s = colKey as OrderStatus;
            return (
              <Column
                key={colKey}
                columnKey={colKey}
                title={STATUS_LABELS[isSent ? "__SENT__" : isCallAgent ? "__CALL_AGENT__" : s] || colKey}
                colorClass={isSent || isCallAgent ? undefined : STATUS_COLORS[s]}
                sentColumn={isSent}
                callAgentColumn={isCallAgent}
                orders={grouped[colKey] || []}
                isHover={hoverColumn === colKey}
                selectedIds={selectedIds}
                onDragOver={(e) => handleDragOver(e, colKey)}
                onDragEnter={(e) => handleDragEnter(e, colKey)}
                onDragLeave={() => handleDragLeave(colKey)}
                onDrop={(e) => handleDrop(e, colKey)}
                onCardDragStart={handleDragStart}
                onCardDragEnd={handleDragEnd}
                onCardClick={setSendDialogOrder}
                onToggleSelect={toggleSelect}
                onDeleteOrder={handleDeleteOrder}
                isDragColumn={dragColumnKey === colKey}
                onColumnDragStart={() => handleColumnDragStart(colKey)}
                onColumnDragOver={(e) => handleColumnDragOver(e, colKey)}
                onColumnDragEnd={handleColumnDragEnd}
              />
            );
          })}
        </div>
      </div>

      {sendDialogOrder && (
        <SendDialog
          order={sendDialogOrder}
          onClose={() => setSendDialogOrder(null)}
          onSent={handleAfterSend}
          onError={(msg) => showToast("error", msg)}
        />
      )}

      {showManualOrder && (
        <ManualOrderModal
          onClose={() => setShowManualOrder(false)}
          onCreated={() => {
            setShowManualOrder(false);
            fetchOrders();
            showToast("success", "Order created");
          }}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-md shadow-lg border text-sm flex items-start gap-2 max-w-md z-50 ${
            toast.kind === "success"
              ? "bg-green-50 text-green-800 border-green-200"
              : "bg-red-50 text-red-800 border-red-200"
          }`}
        >
          {toast.kind === "success" ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
          )}
          <span>{toast.text}</span>
          <button
            onClick={() => setToast(null)}
            className="ml-2 opacity-60 hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Column({
  title,
  orders,
  colorClass,
  sentColumn,
  callAgentColumn,
  isHover,
  selectedIds,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onCardClick,
  onToggleSelect,
  onDeleteOrder,
  isDragColumn,
  onColumnDragStart,
  onColumnDragOver,
  onColumnDragEnd,
}: {
  title: string;
  columnKey: string;
  orders: PipelineOrder[];
  colorClass?: string;
  sentColumn?: boolean;
  callAgentColumn?: boolean;
  isHover: boolean;
  selectedIds: Set<string>;
  isDragColumn?: boolean;
  onColumnDragStart?: () => void;
  onColumnDragOver?: (e: React.DragEvent) => void;
  onColumnDragEnd?: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onCardDragStart: (id: string) => void;
  onCardDragEnd: () => void;
  onCardClick: (o: PipelineOrder) => void;
  onToggleSelect: (id: string) => void;
  onDeleteOrder: (id: string) => void;
}) {
  const borderClass = callAgentColumn
    ? "border-purple-300 bg-purple-50/30"
    : sentColumn
      ? "border-green-300 bg-green-50/30"
      : "border-gray-200 bg-gray-50";
  const headerClass = callAgentColumn
    ? "bg-purple-100 border-purple-200"
    : sentColumn
      ? "bg-green-100 border-green-200"
      : `${colorClass || "bg-gray-100 border-gray-200"}`;
  const emptyText = callAgentColumn
    ? "Drop a card here to trigger a voice call"
    : sentColumn
      ? "Drop a card here to send the WhatsApp message"
      : "No orders";

  return (
    <div
      onDragOver={(e) => {
        onDragOver(e);
        onColumnDragOver?.(e);
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e)}
      className={`w-80 flex flex-col rounded-md border transition-opacity ${borderClass} ${isHover ? "ring-2 ring-blue-400" : ""} ${isDragColumn ? "opacity-50" : ""}`}
    >
      <div
        className={`px-3 py-2 border-b rounded-t-md flex items-center justify-between ${headerClass}`}
      >
        <div className="flex items-center gap-1.5">
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-column", "true");
              onColumnDragStart?.();
            }}
            onDragEnd={onColumnDragEnd}
            className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600"
            title="Drag to reorder column"
          >
            <GripHorizontal size={14} />
          </div>
          <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
        </div>
        <span className="text-xs font-medium opacity-70">{orders.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {orders.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6">{emptyText}</p>
        )}
        {orders.map((o) => (
          <Card
            key={o.id}
            order={o}
            sentColumn={sentColumn}
            callAgentColumn={callAgentColumn}
            isSelected={selectedIds.has(o.id)}
            onDragStart={() => onCardDragStart(o.id)}
            onDragEnd={onCardDragEnd}
            onClick={() => onCardClick(o)}
            onToggleSelect={() => onToggleSelect(o.id)}
            onDelete={() => onDeleteOrder(o.id)}
          />
        ))}
        <div className="h-12 shrink-0" />
      </div>
    </div>
  );
}

function Card({
  order,
  sentColumn,
  callAgentColumn,
  isSelected,
  onDragStart,
  onDragEnd,
  onClick,
  onToggleSelect,
  onDelete,
}: {
  order: PipelineOrder;
  sentColumn?: boolean;
  callAgentColumn?: boolean;
  isSelected: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onClick: () => void;
  onToggleSelect: () => void;
  onDelete: () => void;
}) {
  const [copiedTracking, setCopiedTracking] = useState(false);
  const sentAt = order.whatsappSentAt
    ? new Date(order.whatsappSentAt).toLocaleString()
    : null;
  const createdAt = order.codCreatedAt
    ? new Date(order.codCreatedAt).toLocaleDateString()
    : null;
  const images = order.productImages?.length > 0 ? order.productImages : (order.productImageUrl ? [order.productImageUrl] : []);

  return (
    <div
      className={`bg-white rounded-md border p-0 shadow-sm hover:shadow-md transition-shadow text-xs ${
        callAgentColumn ? "border-purple-200" : sentColumn ? "border-green-200" : "border-gray-200"
      } ${isSelected ? "ring-2 ring-indigo-400 border-indigo-300" : ""}`}
    >
      <div className="flex">
        {/* Drag handle */}
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", order.id);
            onDragStart(e);
          }}
          onDragEnd={onDragEnd}
          className="flex items-center justify-center w-7 shrink-0 cursor-grab active:cursor-grabbing bg-gray-50 rounded-l-md border-r border-gray-100 hover:bg-gray-100 transition-colors"
          title="Drag to move"
        >
          <GripVertical size={14} className="text-gray-400" />
        </div>

        {/* Card content - text selectable */}
        <div className="flex-1 p-2.5 space-y-1 select-text cursor-default">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect();
                }}
                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  isSelected
                    ? "bg-indigo-600 border-indigo-600 text-white"
                    : "border-gray-300 hover:border-indigo-400"
                }`}
              >
                {isSelected && <CheckSquare size={10} />}
              </button>
              <span className="font-medium text-gray-900 truncate">
                {order.customerName || "Unknown"}
              </span>
            </div>
            <span className="text-[10px] font-mono text-gray-400 shrink-0">
              #{order.codNetworkOrderId.slice(-6)}
            </span>
          </div>
          {(createdAt || order.codNetworkLeadId) && (
            <div className="flex items-center gap-2 text-[10px] text-gray-500">
              {createdAt && <span>{createdAt}</span>}
              {order.codNetworkLeadId && (
                <span className="font-mono" title={`Lead ID ${order.codNetworkLeadId}`}>
                  lead #{order.codNetworkLeadId}
                </span>
              )}
            </div>
          )}
          {order.productName && (
            <div className="flex items-center gap-1.5 text-gray-700">
              {images.length > 0 ? (
                <div className="flex -space-x-1">
                  {images.slice(0, 4).map((img, i) => (
                    <img
                      key={i}
                      src={img}
                      alt=""
                      className="w-6 h-6 rounded object-cover shrink-0 border border-gray-200"
                    />
                  ))}
                  {images.length > 4 && (
                    <span className="w-6 h-6 rounded bg-gray-100 border border-gray-200 flex items-center justify-center text-[9px] font-medium text-gray-500">+{images.length - 4}</span>
                  )}
                </div>
              ) : (
                <PackageIcon size={11} className="shrink-0 text-gray-400" />
              )}
              <span className="truncate">{order.productName}</span>
            </div>
          )}
          {(order.productPrice || order.productQuantity) && (
            <div className="flex items-center gap-3 text-gray-600">
              {order.productPrice && (
                <span>
                  <strong>{order.productPrice}</strong>
                </span>
              )}
              {order.productQuantity && <span>&times;{order.productQuantity}</span>}
            </div>
          )}
          {order.customerPhone && (
            <div className="flex items-center gap-1.5 text-gray-600">
              <Phone size={11} className="shrink-0 text-gray-400" />
              <span className="truncate">{order.customerPhone}</span>
            </div>
          )}
          {order.customerCity && (
            <div className="flex items-center gap-1.5 text-gray-600">
              <MapPin size={11} className="shrink-0 text-gray-400" />
              <span className="truncate">{order.customerCity}</span>
            </div>
          )}
          {order.trackingNumber && (
            <div className="flex items-center gap-1.5 text-gray-600">
              <Hash size={11} className="shrink-0 text-gray-400" />
              <span className="truncate font-mono">{order.trackingNumber}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(order.trackingNumber!).catch(() => {});
                  setCopiedTracking(true);
                  setTimeout(() => setCopiedTracking(false), 1500);
                }}
                className="p-0.5 rounded hover:bg-gray-200 transition-colors shrink-0"
                title="Copy tracking number"
              >
                {copiedTracking ? (
                  <Check size={10} className="text-green-600" />
                ) : (
                  <Copy size={10} className="text-gray-400" />
                )}
              </button>
            </div>
          )}
          {sentAt && (
            <div className="flex items-center gap-1.5 text-green-700 pt-1 border-t border-green-100">
              <CheckCircle2 size={11} className="shrink-0" />
              <span className="truncate">Sent {sentAt}</span>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              className="text-[10px] text-blue-600 hover:text-blue-800 hover:underline"
            >
              Send WhatsApp
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm("Delete this order permanently?")) onDelete();
              }}
              className="text-[10px] text-red-400 hover:text-red-600"
              title="Delete order"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SendDialog({
  order,
  onClose,
  onSent,
  onError,
}: {
  order: PipelineOrder;
  onClose: () => void;
  onSent: (orderId: string, sentAt: string) => void;
  onError: (msg: string) => void;
}) {
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("");
  const [variableInput, setVariableInput] = useState("");
  const [headerImageUrl, setHeaderImageUrl] = useState("");
  const [headerImageId, setHeaderImageId] = useState("");
  const [headerImageFileName, setHeaderImageFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [forceResend, setForceResend] = useState(false);
  const [templateInfo, setTemplateInfo] = useState<TemplateInfo | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [imageLibrary, setImageLibrary] = useState<Array<{ id: string; url: string; name: string; mediaId: string | null }>>([]);
  const [showImageLibrary, setShowImageLibrary] = useState(false);
  const variableInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const run = async () => {
      setDetecting(true);
      setTemplateError(null);
      try {
        const data = await api.get<{ template: TemplateInfo }>(
          "/whatsapp/templates/detect"
        );
        setTemplateInfo(data.template);
      } catch (err) {
        setTemplateError(
          err instanceof Error ? err.message : "Failed to fetch template metadata"
        );
      } finally {
        setDetecting(false);
      }
    };
    run();

    // Load image library
    fetch("/api/images")
      .then((r) => r.json())
      .then((data: { images?: Array<{ id: string; url: string; name: string; mediaId: string | null }> }) => {
        if (data.images) setImageLibrary(data.images);
      })
      .catch(() => {});
  }, []);

  const insertVariable = (key: string) => {
    const value = VARIABLES.find((v) => v.key === key)?.resolve(order) ?? "";
    if (!value) return;
    setVariableInput((prev) => {
      if (!prev.trim()) return value;
      return `${prev}, ${value}`;
    });
    variableInputRef.current?.focus();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setHeaderImageId("");
    setHeaderImageFileName("");
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/whatsapp/media", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as { mediaId?: string; error?: string };
      if (!response.ok || !data.mediaId) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setHeaderImageId(data.mediaId);
      setHeaderImageFileName(file.name);
      setHeaderImageUrl("");
      // Save to image library
      fetch("/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "", name: file.name, mediaId: data.mediaId }),
      }).catch(() => {});
    } catch (err) {
      onError(err instanceof Error ? err.message : "Image upload failed");
    } finally {
      setUploading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const variables = variableInput
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      const payload: Record<string, unknown> = {};
      if (templateName.trim()) payload.templateName = templateName.trim();
      if (templateLanguage.trim()) payload.templateLanguage = templateLanguage.trim();
      if (variables.length > 0) payload.templateVariables = variables;
      if (headerImageId) payload.templateHeaderImageId = headerImageId;
      else if (headerImageUrl.trim())
        payload.templateHeaderImage = headerImageUrl.trim();
      if (forceResend) payload.force = true;

      const response = await fetch(`/api/orders/${order.id}/send-whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      onSent(order.id, new Date().toISOString());
    } catch (err) {
      onError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const expectedCount = templateInfo?.bodyParameterCount ?? null;
  const currentCount = variableInput
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0).length;
  const headerNeeds = templateInfo?.header?.format ?? null;

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">
              Send WhatsApp — {order.customerName || "Unknown"}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Order #{order.codNetworkOrderId} · {order.customerPhone}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {order.whatsappSentAt && (
            <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p>
                  A WhatsApp message was already sent for this order on{" "}
                  {new Date(order.whatsappSentAt).toLocaleString()}.
                </p>
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forceResend}
                    onChange={(e) => setForceResend(e.target.checked)}
                  />
                  <span>Send anyway</span>
                </label>
              </div>
            </div>
          )}

          {detecting && (
            <p className="text-xs text-gray-500 flex items-center gap-1.5">
              <RefreshCw size={11} className="animate-spin" />
              Looking up template…
            </p>
          )}
          {templateError && (
            <p className="text-xs text-red-600">{templateError}</p>
          )}
          {templateInfo && (
            <div className="p-3 rounded-md bg-blue-50 border border-blue-200 text-xs text-blue-900 space-y-1">
              <p>
                <strong>{templateInfo.name}</strong> ({templateInfo.language})
                · status <code>{templateInfo.status}</code>
              </p>
              <p>
                Body needs <strong>{templateInfo.bodyParameterCount}</strong>{" "}
                variable{templateInfo.bodyParameterCount === 1 ? "" : "s"}.
                {headerNeeds && headerNeeds !== "TEXT" && (
                  <>
                    {" "}Header is <strong>{headerNeeds}</strong>.
                  </>
                )}
              </p>
              {templateInfo.bodyText && (
                <p className="font-mono whitespace-pre-wrap text-blue-900/80 leading-snug">
                  {templateInfo.bodyText}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Body Variables (comma-separated)
              {expectedCount !== null && (
                <span
                  className={`ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    currentCount === expectedCount
                      ? "bg-green-100 text-green-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {currentCount} / {expectedCount}
                </span>
              )}
            </label>
            <input
              ref={variableInputRef}
              type="text"
              value={variableInput}
              onChange={(e) => setVariableInput(e.target.value)}
              placeholder={
                expectedCount
                  ? `${expectedCount} comma-separated values`
                  : "e.g. Customer, ORDER-12345"
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              {VARIABLES.map((v) => {
                const value = v.resolve(order);
                const disabled = !value;
                return (
                  <button
                    key={v.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => insertVariable(v.key)}
                    className={`px-2 py-0.5 rounded-full text-[11px] border ${
                      disabled
                        ? "bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed"
                        : "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                    }`}
                    title={disabled ? "no value" : value}
                  >
                    {`{${v.key}}`}
                    {value && (
                      <span className="ml-1 text-blue-900/60 font-mono">
                        {value.length > 18 ? `${value.slice(0, 18)}…` : value}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-medium text-gray-700 mb-2">
              Header Image (if template has IMAGE header)
            </p>
            <div className="flex items-center gap-2 mb-2">
              <label className="cursor-pointer flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md text-xs font-medium text-gray-700 hover:bg-gray-50">
                <ImageIcon size={12} />
                {uploading ? "Uploading…" : "Upload Image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleUpload}
                  disabled={uploading}
                />
              </label>
              {headerImageId && (
                <span className="text-[11px] text-green-700 truncate">
                  Uploaded: {headerImageFileName} (id {headerImageId.slice(0, 12)}…)
                </span>
              )}
            </div>
            {imageLibrary.length > 0 && (
              <div className="mb-2">
                <button
                  type="button"
                  onClick={() => setShowImageLibrary((v) => !v)}
                  className="text-[11px] text-blue-600 hover:text-blue-800 hover:underline"
                >
                  {showImageLibrary ? "Hide image library" : "Pick from image library"}
                </button>
                {showImageLibrary && (
                  <div className="mt-1.5 grid grid-cols-4 gap-1.5 max-h-32 overflow-y-auto border border-gray-200 rounded-md p-1.5">
                    {imageLibrary.map((img) => (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => {
                          if (img.mediaId) {
                            setHeaderImageId(img.mediaId);
                            setHeaderImageFileName(img.name);
                            setHeaderImageUrl("");
                          } else {
                            setHeaderImageUrl(img.url);
                            setHeaderImageId("");
                            setHeaderImageFileName("");
                          }
                          setShowImageLibrary(false);
                        }}
                        className="relative group rounded overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors"
                        title={img.name}
                      >
                        <img src={img.url} alt={img.name} className="w-full h-16 object-cover" />
                        <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] px-1 truncate">
                          {img.name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="text-[11px] text-gray-400 mb-1">…or paste a public image URL</p>
            <input
              type="url"
              value={headerImageUrl}
              onChange={(e) => {
                setHeaderImageUrl(e.target.value);
                if (e.target.value) {
                  setHeaderImageId("");
                  setHeaderImageFileName("");
                }
              }}
              placeholder="https://example.com/image.jpg"
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
              Advanced: override template name / language
            </summary>
            <div className="mt-2 space-y-2 pl-1">
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Template name (overrides Settings)"
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                value={templateLanguage}
                onChange={(e) => setTemplateLanguage(e.target.value)}
                placeholder="Language (e.g. en or en_US)"
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </details>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2 bg-gray-50 rounded-b-lg">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 hover:text-gray-900"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || uploading}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded-md text-xs font-medium hover:bg-green-700 disabled:opacity-50"
          >
            <Send size={12} />
            {sending ? "Sending…" : "Send WhatsApp"}
          </button>
        </div>
      </div>
    </div>
  );
}
