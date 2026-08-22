"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { api } from "@/lib/api-client";

interface CodTokenStatus {
  hasStaticToken: boolean;
  expiresAt: string | null;
  expiresInMs: number | null;
  expired: boolean;
  expiringSoon: boolean;
}

// Re-check periodically so a long-lived tab still surfaces the warning as the
// token nears expiry without needing a reload.
const POLL_INTERVAL_MS = 30 * 60 * 1000;

function formatRemaining(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.floor(ms / (60 * 1000)));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function CodTokenWarning() {
  const [status, setStatus] = useState<CodTokenStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const s = await api.get<CodTokenStatus>("/cod-network/token-status");
        if (!cancelled) setStatus(s);
      } catch {
        // Non-critical: never block the dashboard on this check.
      }
    }
    check();
    const timer = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status || dismissed) return null;
  if (!status.expired && !status.expiringSoon) return null;

  const title = status.expired
    ? "API token expired. Please replace it."
    : "API token is about to expire. Please replace it.";

  const detail = status.expired
    ? "Your COD Network API token has expired, so orders, leads, and product syncs will stop until you add a new token."
    : `Your COD Network API token expires in ${
        status.expiresInMs !== null ? formatRemaining(status.expiresInMs) : "less than a day"
      }. Replace it now to avoid an interruption to order, lead, and product syncing.`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl border border-red-200">
        <div className="flex items-start gap-3 p-5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle size={18} className="text-red-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
              {detail}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-gray-400 hover:text-gray-600"
            title="Dismiss"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded-md px-3 py-1.5 text-[13px] font-medium text-gray-600 hover:bg-gray-100"
          >
            Later
          </button>
          <Link
            href="/settings#cod"
            onClick={() => setDismissed(true)}
            className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-red-700"
          >
            Update API key
          </Link>
        </div>
      </div>
    </div>
  );
}
