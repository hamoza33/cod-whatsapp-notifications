"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { RefreshCw } from "lucide-react";

interface MessageLog {
  id: string;
  phoneNumber: string;
  templateName: string;
  status: string;
  errorMessage: string | null;
  sentBy: string;
  sentAt: string | null;
  createdAt: string;
  order: {
    codNetworkOrderId: string;
    customerName: string | null;
    status: string;
  };
}

const STATUS_OPTIONS = ["ALL", "PENDING", "SENT", "DELIVERED", "READ", "FAILED"];

export default function MessagesPage() {
  const [messages, setMessages] = useState<MessageLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState("ALL");

  useEffect(() => {
    let cancelled = false;
    async function fetchMessages() {
      setLoading(true);
      try {
        const params: Record<string, string> = {
          page: String(page),
          pageSize: "20",
        };
        if (statusFilter !== "ALL") params.status = statusFilter;

        const data = await api.get<{
          messages: MessageLog[];
          pagination: { totalPages: number };
        }>("/messages", params);
        if (!cancelled) {
          setMessages(data.messages);
          setTotalPages(data.pagination.totalPages);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchMessages();
    return () => { cancelled = true; };
  }, [page, statusFilter]);

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      SENT: "bg-green-100 text-green-700",
      DELIVERED: "bg-blue-100 text-blue-700",
      FAILED: "bg-red-100 text-red-700",
      PENDING: "bg-yellow-100 text-yellow-700",
      READ: "bg-purple-100 text-purple-700",
    };
    return (
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || "bg-gray-100 text-gray-700"}`}
      >
        {status}
      </span>
    );
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Message Logs</h1>

      <div className="mb-4">
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
              {s}
            </option>
          ))}
        </select>
      </div>

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
                  Template
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Status
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Sent By
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Sent At
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="text-center py-8">
                    <RefreshCw
                      className="animate-spin text-gray-400 mx-auto"
                      size={20}
                    />
                  </td>
                </tr>
              ) : messages.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="text-center py-8 text-gray-500"
                  >
                    No messages found.
                  </td>
                </tr>
              ) : (
                messages.map((msg) => (
                  <tr
                    key={msg.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      {msg.order.codNetworkOrderId}
                    </td>
                    <td className="px-4 py-3">
                      {msg.order.customerName || "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {msg.phoneNumber}
                    </td>
                    <td className="px-4 py-3">{msg.templateName}</td>
                    <td className="px-4 py-3">
                      {getStatusBadge(msg.status)}
                    </td>
                    <td className="px-4 py-3">{msg.sentBy}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {msg.sentAt
                        ? new Date(msg.sentAt).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-red-600 max-w-[200px] truncate">
                      {msg.errorMessage || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

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
    </div>
  );
}
