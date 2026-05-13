"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Send,
  Image as ImageIcon,
  Phone,
  PhoneCall,
  MapPin,
  Package as PackageIcon,
  Hash,
  CheckCircle2,
  X,
  AlertCircle,
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
  callAgentQueued: boolean;
  productImages: string[];
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
  // Mirror `draggingId` into a ref so `handleDrop` can read the current value
  // synchronously even if React has not yet flushed the state update from
  // `handleDragStart`. We also stash the id in `dataTransfer` for browsers
  // (and programmatic drivers) that drop events when state is stale.
  const draggingIdRef = useRef<string | null>(null);
  const [hoverColumn, setHoverColumn] = useState<string | null>(null);
  const [sendDialogOrder, setSendDialogOrder] = useState<PipelineOrder | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    // Fetch on mount. The setState calls inside `fetchOrders` are the whole
    // point of this effect (sync external API state into local state), so the
    // `set-state-in-effect` rule is opted-out here intentionally.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchOrders();
  }, [fetchOrders]);

  const grouped = useMemo(() => {
    const groups: Record<string, PipelineOrder[]> = { __SENT__: [], __CALL_AGENT__: [] };
    REAL_STATUSES.forEach((s) => (groups[s] = []));
    for (const o of orders) {
      if (o.callAgentQueued) groups.__CALL_AGENT__.push(o);
      else if (o.whatsappSentAt) groups.__SENT__.push(o);
      else groups[o.status]?.push(o);
    }
    // Sort each column oldest-first (first created → last created)
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

  const handleDragEnter = (e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (hoverColumn !== columnKey) setHoverColumn(columnKey);
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
    // Prefer the id from dataTransfer (set in dragStart) over the ref/state
    // — some browsers null out the ref before the drop event fires.
    const idFromData = e.dataTransfer?.getData("text/plain") || null;
    const id = idFromData || draggingIdRef.current || draggingId;
    draggingIdRef.current = null;
    setDraggingId(null);
    setHoverColumn(null);
    if (!id) return;
    const order = orders.find((o) => o.id === id);
    if (!order) return;

    if (columnKey === "__CALL_AGENT__") {
      // Trigger the AI voice agent call for this order
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
        showToast("success", "Call Agent triggered — AI will call the customer");
      } catch (err) {
        setOrders((prev) =>
          prev.map((o) => (o.id === id ? { ...o, callAgentQueued: false } : o))
        );
        showToast("error", err instanceof Error ? err.message : "Failed to trigger call agent");
      }
      return;
    }

    if (columnKey === "__SENT__") {
      setSendDialogOrder(order);
      return;
    }

    if (columnKey === order.status) return;

    // Optimistic update
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
      // Roll back on error
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
            Drag cards between columns to update status. Drop on the
            <span className="font-medium text-green-700"> WhatsApp Sent </span>
            column to send a templated message.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          Refresh
        </button>
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
              onDragEnter={(e) => handleDragEnter(e, s)}
              onDragOver={(e) => handleDragOver(e, s)}
              onDragLeave={() => handleDragLeave(s)}
              onDrop={(e) => handleDrop(e, s)}
              onCardDragStart={handleDragStart}
              onCardDragEnd={handleDragEnd}
              onCardClick={setSendDialogOrder}
            />
          ))}
          {/* Call Agent column */}
          <Column
            columnKey="__CALL_AGENT__"
            title="Call Agent"
            callAgentColumn
            orders={grouped.__CALL_AGENT__ || []}
            isHover={hoverColumn === "__CALL_AGENT__"}
            onDragEnter={(e) => handleDragEnter(e, "__CALL_AGENT__")}
            onDragOver={(e) => handleDragOver(e, "__CALL_AGENT__")}
            onDragLeave={() => handleDragLeave("__CALL_AGENT__")}
            onDrop={(e) => handleDrop(e, "__CALL_AGENT__")}
            onCardDragStart={handleDragStart}
            onCardDragEnd={handleDragEnd}
            onCardClick={setSendDialogOrder}
          />
          <Column
            columnKey="__SENT__"
            title="WhatsApp Sent"
            sentColumn
            orders={grouped.__SENT__ || []}
            isHover={hoverColumn === "__SENT__"}
            onDragEnter={(e) => handleDragEnter(e, "__SENT__")}
            onDragOver={(e) => handleDragOver(e, "__SENT__")}
            onDragLeave={() => handleDragLeave("__SENT__")}
            onDrop={(e) => handleDrop(e, "__SENT__")}
            onCardDragStart={handleDragStart}
            onCardDragEnd={handleDragEnd}
            onCardClick={setSendDialogOrder}
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

      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-md shadow-lg border text-sm flex items-start gap-2 max-w-md ${
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
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onCardClick,
}: {
  title: string;
  columnKey: string;
  orders: PipelineOrder[];
  colorClass?: string;
  sentColumn?: boolean;
  callAgentColumn?: boolean;
  isHover: boolean;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onCardDragStart: (id: string) => void;
  onCardDragEnd: () => void;
  onCardClick: (o: PipelineOrder) => void;
}) {
  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(e); }}
      className={`w-80 flex flex-col rounded-md border ${
        sentColumn
          ? "border-green-300 bg-green-50/30"
          : callAgentColumn
          ? "border-purple-300 bg-purple-50/30"
          : "border-gray-200 bg-gray-50"
      } ${isHover ? "ring-2 ring-blue-400" : ""}`}
    >
      <div
        className={`px-3 py-2 border-b rounded-t-md flex items-center justify-between ${
          sentColumn
            ? "bg-green-100 border-green-200"
            : callAgentColumn
            ? "bg-purple-100 border-purple-200 text-purple-700"
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
              : callAgentColumn
              ? "Drop a card here to trigger AI voice call"
              : "No orders"}
          </p>
        )}
        {orders.map((o) => (
          <Card
            key={o.id}
            order={o}
            sentColumn={sentColumn}
            callAgentColumn={callAgentColumn}
            onDragStart={() => onCardDragStart(o.id)}
            onDragEnd={onCardDragEnd}
            onClick={() => onCardClick(o)}
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
  onDragStart,
  onDragEnd,
  onClick,
}: {
  order: PipelineOrder;
  sentColumn?: boolean;
  callAgentColumn?: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const sentAt = order.whatsappSentAt
    ? new Date(order.whatsappSentAt).toLocaleString()
    : null;
  const createdAt = order.codCreatedAt
    ? new Date(order.codCreatedAt).toLocaleDateString()
    : null;
  return (
    <div
      draggable
      onDragStart={(e) => {
        // setData is required by several browsers (Firefox, mobile WebKit)
        // for the subsequent drop to fire. We use text/plain so the drop
        // handler can read the order id back synchronously, sidestepping any
        // stale React state.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", order.id);
        onDragStart(e);
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        // Only trigger click if user wasn't selecting text
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        onClick();
      }}
      className={`bg-white rounded-md border p-3 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow text-xs space-y-1 select-text ${
        sentColumn ? "border-green-200" : callAgentColumn ? "border-purple-200" : "border-gray-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-gray-900 truncate">
          {order.customerName || "Unknown"}
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
      {order.productImages && order.productImages.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {order.productImages.map((img, i) => (
            <div key={i} className="w-8 h-8 rounded overflow-hidden bg-gray-100 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt="Product" className="w-full h-full object-cover" />
            </div>
          ))}
        </div>
      )}
      {order.productName && (
        <div className="flex items-center gap-1.5 text-gray-700">
          <PackageIcon size={11} className="shrink-0 text-gray-400" />
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
          {order.productQuantity && <span>×{order.productQuantity}</span>}
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
      {order.callAgentQueued && (
        <div className="flex items-center gap-1.5 text-purple-700 pt-1 border-t border-purple-100">
          <PhoneCall size={11} className="shrink-0" />
          <span className="truncate">Call Agent queued</span>
        </div>
      )}
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

  // Auto-load template metadata using configured Settings template (or override)
  useEffect(() => {
    const run = async () => {
      setDetecting(true);
      setTemplateError(null);
      try {
        const params = new URLSearchParams();
        if (templateName.trim()) params.set("name", templateName.trim());
        if (templateLanguage.trim()) params.set("language", templateLanguage.trim());
        // If neither override is set, also pass nothing — the endpoint will
        // need a name; fall back silently. We let the user click "Detect"
        // explicitly when they don't have it saved in Settings either.
        const settingsLookup = await fetch("/api/settings");
        if (!settingsLookup.ok) {
          setDetecting(false);
          return;
        }
        const sd = (await settingsLookup.json()) as {
          settings: Record<string, string | null>;
        };
        const fallbackName = sd.settings?.whatsapp_template_name;
        const fallbackLang = sd.settings?.whatsapp_template_language;
        if (!params.get("name") && fallbackName) {
          params.set("name", fallbackName);
        }
        if (!params.get("language") && fallbackLang) {
          params.set("language", fallbackLang);
        }
        if (!params.get("name")) {
          setDetecting(false);
          return;
        }
        const data = await api.get<{ template: TemplateInfo }>(
          `/whatsapp/templates?${params.toString()}`
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
