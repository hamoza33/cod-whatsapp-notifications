"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { RefreshCw, Send, Eye, Search, Plus } from "lucide-react";
import ManualOrderModal from "@/components/manual-order-modal";

interface OrderMessage {
  id: string;
  status: string;
  sentAt: string | null;
}

interface Order {
  id: string;
  codNetworkOrderId: string;
  customerName: string | null;
  customerPhone: string | null;
  customerCity: string | null;
  productName: string | null;
  trackingNumber: string | null;
  status: string;
  updatedAt: string;
  whatsappMessages: OrderMessage[];
}

interface MessagePreview {
  templateName: string;
  variables: string[];
  phoneNumber: string | null;
  message: string;
  order: {
    id: string;
    codNetworkOrderId: string;
    customerName: string | null;
    status: string;
  };
}

const STATUS_OPTIONS = [
  "ALL",
  "ELIGIBLE",
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "SCHEDULED",
];

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);
  const [showManualOrder, setShowManualOrder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchOrders() {
      setLoading(true);
      try {
        const params: Record<string, string> = {
          page: String(page),
          pageSize: "20",
        };
        if (statusFilter !== "ALL") params.status = statusFilter;
        if (search) params.search = search;

        const data = await api.get<{
          orders: Order[];
          pagination: { totalPages: number };
        }>("/orders", params);
        if (!cancelled) {
          setOrders(data.orders);
          setTotalPages(data.pagination.totalPages);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchOrders();
    return () => { cancelled = true; };
  }, [page, statusFilter, search, refreshKey]);

  const handlePreview = async (orderId: string) => {
    try {
      const data = await api.post<{ preview: MessagePreview }>(
        "/whatsapp/preview",
        { orderId }
      );
      setPreview(data.preview);
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Preview failed",
      });
    }
  };

  const handleSend = async (orderId: string) => {
    setSendingId(orderId);
    setNotification(null);
    try {
      await api.post("/whatsapp/send", { orderId });
      setNotification({ type: "success", message: "WhatsApp message sent!" });
      setPreview(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Send failed",
      });
    } finally {
      setSendingId(null);
    }
  };

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput);
  };

  const getMessageBadge = (order: Order) => {
    const lastMsg = order.whatsappMessages[0];
    if (!lastMsg) return null;

    const colors: Record<string, string> = {
      SENT: "bg-green-100 text-green-700",
      DELIVERED: "bg-blue-100 text-blue-700",
      FAILED: "bg-red-100 text-red-700",
      PENDING: "bg-yellow-100 text-yellow-700",
      READ: "bg-purple-100 text-purple-700",
    };

    return (
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[lastMsg.status] || "bg-gray-100 text-gray-700"}`}
      >
        {lastMsg.status}
      </span>
    );
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      SHIPPED: "bg-yellow-100 text-yellow-700",
      OUT_FOR_DELIVERY: "bg-orange-100 text-orange-700",
      SCHEDULED: "bg-purple-100 text-purple-700",
      DELIVERED: "bg-green-100 text-green-700",
      PENDING: "bg-gray-100 text-gray-700",
      CONFIRMED: "bg-blue-100 text-blue-700",
      PROCESSING: "bg-indigo-100 text-indigo-700",
      RETURNED: "bg-red-100 text-red-700",
      CANCELLED: "bg-red-100 text-red-700",
    };

    return (
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || "bg-gray-100 text-gray-700"}`}
      >
        {status.replace(/_/g, " ")}
      </span>
    );
  };

  const isEligible = (status: string) =>
    status === "SHIPPED" || status === "OUT_FOR_DELIVERY";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
        <button
          onClick={() => setShowManualOrder(true)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={16} />
          New manual order
        </button>
      </div>

      {notification && (
        <div
          className={`mb-4 p-3 rounded-md text-sm border ${
            notification.type === "success"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {notification.message}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "ELIGIBLE"
                ? "Shipped / Out for Delivery"
                : s.replace(/_/g, " ")}
            </option>
          ))}
        </select>

        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Search orders..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm w-64"
          />
          <button
            onClick={handleSearch}
            className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
          >
            <Search size={16} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Order ID
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Customer
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Phone
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  City
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Product
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Status
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Tracking
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Updated
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  WhatsApp
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} className="text-center py-8">
                    <RefreshCw
                      className="animate-spin text-gray-400 mx-auto"
                      size={20}
                    />
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center py-8 text-gray-500"
                  >
                    No orders found. Sync orders from COD Network first.
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      {order.codNetworkOrderId}
                    </td>
                    <td className="px-4 py-3">
                      {order.customerName || "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {order.customerPhone || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {order.customerCity || "—"}
                    </td>
                    <td className="px-4 py-3 max-w-[150px] truncate">
                      {order.productName || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {getStatusBadge(order.status)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {order.trackingNumber || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(order.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">{getMessageBadge(order)}</td>
                    <td className="px-4 py-3">
                      {isEligible(order.status) && order.customerPhone && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handlePreview(order.id)}
                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                            title="Preview message"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={() => handleSend(order.id)}
                            disabled={sendingId === order.id}
                            className="p-1.5 text-green-600 hover:bg-green-50 rounded disabled:opacity-50 transition-colors"
                            title="Send WhatsApp"
                          >
                            <Send size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 border rounded text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 border rounded text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}

      {showManualOrder && (
        <ManualOrderModal
          onClose={() => setShowManualOrder(false)}
          onCreated={() => {
            setShowManualOrder(false);
            setNotification({
              type: "success",
              message: "Manual order created",
            });
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {/* Preview Modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 p-6">
            <h2 className="text-lg font-bold mb-4">Message Preview</h2>

            <div className="space-y-3 text-sm">
              <div>
                <span className="font-medium text-gray-600">To:</span>{" "}
                {preview.phoneNumber || "N/A"}
              </div>
              <div>
                <span className="font-medium text-gray-600">Template:</span>{" "}
                {preview.templateName}
              </div>
              <div>
                <span className="font-medium text-gray-600">Order:</span>{" "}
                {preview.order.codNetworkOrderId} ({preview.order.status})
              </div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mt-3">
                <p className="text-green-800">{preview.message}</p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => handleSend(preview.order.id)}
                disabled={sendingId === preview.order.id}
                className="flex-1 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {sendingId === preview.order.id ? "Sending..." : "Send Now"}
              </button>
              <button
                onClick={() => setPreview(null)}
                className="flex-1 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
