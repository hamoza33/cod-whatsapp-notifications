"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { RefreshCw } from "lucide-react";

interface SyncLog {
  id: string;
  syncType: string;
  status: string;
  ordersFound: number;
  ordersCreated: number;
  ordersUpdated: number;
  messagesSent: number;
  errorMessage: string | null;
  duration: number;
  createdAt: string;
}

export default function SyncLogsPage() {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    let cancelled = false;
    async function fetchLogs() {
      setLoading(true);
      try {
        const data = await api.get<{
          logs: SyncLog[];
          pagination: { totalPages: number };
        }>("/sync-logs", { page: String(page), pageSize: "20" });
        if (!cancelled) {
          setLogs(data.logs);
          setTotalPages(data.pagination.totalPages);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchLogs();
    return () => { cancelled = true; };
  }, [page]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Sync Logs</h1>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Date
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Type
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Status
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Found
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Created
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Updated
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Messages
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Duration
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="text-center py-8">
                    <RefreshCw
                      className="animate-spin text-gray-400 mx-auto"
                      size={20}
                    />
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="text-center py-8 text-gray-500"
                  >
                    No sync logs yet.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr
                    key={log.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">{log.syncType}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          log.status === "success"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">{log.ordersFound}</td>
                    <td className="px-4 py-3">{log.ordersCreated}</td>
                    <td className="px-4 py-3">{log.ordersUpdated}</td>
                    <td className="px-4 py-3">{log.messagesSent}</td>
                    <td className="px-4 py-3 text-xs">
                      {(log.duration / 1000).toFixed(1)}s
                    </td>
                    <td className="px-4 py-3 text-xs text-red-600 max-w-[200px] truncate">
                      {log.errorMessage || "—"}
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
