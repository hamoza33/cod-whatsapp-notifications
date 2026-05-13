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
  | "UNKNOWN";

const REAL_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
];

const STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
  UNKNOWN: "Unknown",
};

const STATUS_COLORS: Record<OrderStatus, string> = {
  PENDING: "bg-gray-100 text-gray-700 border-gray-300",
  CONFIRMED: "bg-blue-100 text-blue-700 border-blue-300",
  PROCESSING: "bg-indigo-100 text-indigo-700 border-indigo-300",
  SHIPPED: "bg-amber-100 text-amber-700 border-amber-300",
  OUT_FOR_DELIVERY: "bg-orange-100 text-orange-700 border-orange-300",
  DELIVERED: "bg-green-100 text-green-700 border-green-300",
  RETURNED: "bg-rose-100 text-rose-700 border-rose-300",
  CANCELLED: "bg-red-100 text-red-700 border-red-300",
  UNKNOWN: "bg-slate-100 text-slate-700 border-slate-300",
};

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

  const grouped = useMemo(() => {
    const groups: Record<string, PipelineOrder[]> = { __SENT__: [] };
    REAL_STATUSES.forEach((s) => (groups[s] = []));
    for (const o of orders) {
      if (o.whatsappSentAt) groups.__SENT__.push(o);
      else groups[o.status]?.push(o);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const aDate = a.codCreatedAt ? new Date(a.codCreatedAt).getTime() : 0;
        const bDate = b.codCreatedAt ? new Date(b.codCreatedAt).getTime() : 0;
        return aDate - bDate;
      });
    }
    return groups;
  }, [orders]);

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
          {REAL_STATUSES.map((s) => (
            <Column
              key={s}
              columnKey={s}
              title={STATUS_LABELS[s]}
              colorClass={STATUS_COLORS[s]}
              orders={grouped[s] || []}
              isHover={hoverColumn === s}
              selectedIds={selectedIds}
              onDragOver={(e) => handleDragOver(e, s)}
              onDragLeave={() => handleDragLeave(s)}
              onDrop={(e) => handleDrop(e, s)}
              onCardDragStart={handleDragStart}
              onCardDragEnd={handleDragEnd}
              onCardClick={setSendDialogOrder}
              onToggleSelect={toggleSelect}
            />
          ))}
          <Column
            columnKey="__SENT__"
            title="WhatsApp Sent"
            sentColumn
            orders={grouped.__SENT__ || []}
            isHover={hoverColumn === "__SENT__"}
            selectedIds={selectedIds}
            onDragOver={(e) => handleDragOver(e, "__SENT__")}
            onDragLeave={() => handleDragLeave("__SENT__")}
            onDrop={(e) => handleDrop(e, "__SENT__")}
            onCardDragStart={handleDragStart}
            onCardDragEnd={handleDragEnd}
            onCardClick={setSendDialogOrder}
            onToggleSelect={toggleSelect}
          />
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
  isHover,
  selectedIds,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onCardClick,
  onToggleSelect,
}: {
  title: string;
  columnKey: string;
  orders: PipelineOrder[];
  colorClass?: string;
  sentColumn?: boolean;
  isHover: boolean;
  selectedIds: Set<string>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onCardDragStart: (id: string) => void;
  onCardDragEnd: () => void;
  onCardClick: (o: PipelineOrder) => void;
  onToggleSelect: (id: string) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e)}
      className={`w-80 flex flex-col rounded-md border ${
        sentColumn ? "border-green-300 bg-green-50/30" : "border-gray-200 bg-gray-50"
      } ${isHover ? "ring-2 ring-blue-400" : ""}`}
    >
      <div
        className={`px-3 py-2 border-b rounded-t-md flex items-center justify-between ${
          sentColumn
            ? "bg-green-100 border-green-200"
            : `${colorClass || "bg-gray-100 border-gray-200"}`
        }`}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
        <span className="text-xs font-medium opacity-70">{orders.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {orders.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6">
            {sentColumn
              ? "Drop a card here to send the WhatsApp message"
              : "No orders"}
          </p>
        )}
        {orders.map((o) => (
          <Card
            key={o.id}
            order={o}
            sentColumn={sentColumn}
            isSelected={selectedIds.has(o.id)}
            onDragStart={() => onCardDragStart(o.id)}
            onDragEnd={onCardDragEnd}
            onClick={() => onCardClick(o)}
            onToggleSelect={() => onToggleSelect(o.id)}
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
  isSelected,
  onDragStart,
  onDragEnd,
  onClick,
  onToggleSelect,
}: {
  order: PipelineOrder;
  sentColumn?: boolean;
  isSelected: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onClick: () => void;
  onToggleSelect: () => void;
}) {
  const sentAt = order.whatsappSentAt
    ? new Date(order.whatsappSentAt).toLocaleString()
    : null;
  const createdAt = order.codCreatedAt
    ? new Date(order.codCreatedAt).toLocaleDateString()
    : null;

  return (
    <div
      className={`bg-white rounded-md border p-0 shadow-sm hover:shadow-md transition-shadow text-xs ${
        sentColumn ? "border-green-200" : "border-gray-200"
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
                  lead #{order.codNetworkLeadId.slice(-6)}
                </span>
              )}
            </div>
          )}
          {order.productName && (
            <div className="flex items-center gap-1.5 text-gray-700">
              {order.productImageUrl ? (
                <img
                  src={order.productImageUrl}
                  alt=""
                  className="w-6 h-6 rounded object-cover shrink-0 border border-gray-200"
                />
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
            </div>
          )}
          {sentAt && (
            <div className="flex items-center gap-1.5 text-green-700 pt-1 border-t border-green-100">
              <CheckCircle2 size={11} className="shrink-0" />
              <span className="truncate">Sent {sentAt}</span>
            </div>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            className="mt-1 text-[10px] text-blue-600 hover:text-blue-800 hover:underline"
          >
            Send WhatsApp
          </button>
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
