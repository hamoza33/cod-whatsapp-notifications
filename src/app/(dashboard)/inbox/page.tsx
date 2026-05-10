"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Send,
  AlertCircle,
  MessageSquare,
  Image as ImageIcon,
  CheckCheck,
  Check,
  X,
} from "lucide-react";

interface Conversation {
  phoneNumber: string;
  contactName: string | null;
  lastReceivedAt: string;
  lastText: string | null;
  lastType: string;
  totalMessages: number;
  order: {
    id: string;
    codNetworkOrderId: string;
    customerName: string | null;
    productName: string | null;
    status: string;
  } | null;
}

type ThreadEntry =
  | {
      kind: "inbound";
      id: string;
      at: string;
      type: string;
      text: string | null;
      mediaId: string | null;
      mediaMimeType: string | null;
      contactName: string | null;
    }
  | {
      kind: "outbound";
      id: string;
      at: string;
      templateName: string;
      templateVariables: unknown;
      status: string;
      providerMessageId: string | null;
      errorMessage: string | null;
    };

interface ThreadResponse {
  phoneNumber: string;
  thread: ThreadEntry[];
  inSession: boolean;
  lastInboundAt: string | null;
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((kind: "error" | "success", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const fetchConversations = useCallback(async () => {
    try {
      const data = await api.get<{ conversations: Conversation[] }>(
        "/whatsapp/inbox"
      );
      setConversations(data.conversations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchThread = useCallback(async (phone: string) => {
    try {
      const data = await api.get<ThreadResponse>(
        `/whatsapp/inbox/${encodeURIComponent(phone)}`
      );
      setThread(data);
      setTimeout(() => {
        threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load thread");
    }
  }, []);

  // Initial load
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConversations();
  }, [fetchConversations]);

  // Poll inbox every 5s while page is open
  useEffect(() => {
    const interval = setInterval(() => {
      fetchConversations();
      if (selectedPhone) fetchThread(selectedPhone);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchConversations, fetchThread, selectedPhone]);

  // Load thread when conversation selected
  useEffect(() => {
    if (selectedPhone) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchThread(selectedPhone);
    } else {
      setThread(null);
    }
  }, [selectedPhone, fetchThread]);

  const handleReply = async () => {
    if (!selectedPhone || !replyText.trim()) return;
    setSending(true);
    try {
      const response = await fetch(
        `/api/whatsapp/inbox/${encodeURIComponent(selectedPhone)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: replyText }),
        }
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setReplyText("");
      showToast("success", "Reply sent");
      fetchThread(selectedPhone);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Reply failed");
    } finally {
      setSending(false);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    fetchConversations();
    if (selectedPhone) fetchThread(selectedPhone);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-2rem)] gap-3">
      {/* Conversation list */}
      <div className="w-80 flex flex-col border border-gray-200 rounded-md bg-white overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <h2 className="text-sm font-semibold">Conversations</h2>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="p-1 text-gray-500 hover:text-gray-900"
            aria-label="Refresh"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "animate-spin" : ""}
            />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <div className="p-6 text-center text-sm text-gray-500">
              <MessageSquare size={36} className="mx-auto text-gray-300 mb-2" />
              No inbound messages yet.
              <p className="mt-2 text-xs text-gray-400">
                Wire up the webhook in Meta App → WhatsApp → Configuration →
                Webhooks pointing at <code>/api/whatsapp/webhook</code> and
                make sure the Verify Token matches your Settings.
              </p>
            </div>
          )}
          {conversations.map((c) => {
            const active = selectedPhone === c.phoneNumber;
            return (
              <button
                key={c.phoneNumber}
                onClick={() => setSelectedPhone(c.phoneNumber)}
                className={`w-full text-left px-3 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                  active ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-sm text-gray-900 truncate">
                    {c.contactName || c.phoneNumber}
                  </div>
                  <div className="text-[10px] text-gray-400 shrink-0">
                    {new Date(c.lastReceivedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
                {c.contactName && (
                  <div className="text-[11px] text-gray-500 font-mono">
                    {c.phoneNumber}
                  </div>
                )}
                <div className="text-xs text-gray-600 truncate mt-1">
                  {c.lastType !== "text" ? `[${c.lastType}] ` : ""}
                  {c.lastText ?? <em className="text-gray-400">(no preview)</em>}
                </div>
                {c.order && (
                  <div className="text-[10px] text-blue-700 mt-1 truncate">
                    Order #{c.order.codNetworkOrderId} · {c.order.status}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Thread */}
      <div className="flex-1 flex flex-col border border-gray-200 rounded-md bg-white overflow-hidden">
        {!selectedPhone ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
            <div className="text-center">
              <MessageSquare size={48} className="mx-auto text-gray-300 mb-2" />
              <p>Select a conversation to view messages</p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">
                  {conversations.find((c) => c.phoneNumber === selectedPhone)
                    ?.contactName || selectedPhone}
                </div>
                <div className="text-[11px] text-gray-500 font-mono">
                  {selectedPhone}
                </div>
              </div>
              {thread && (
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full ${
                    thread.inSession
                      ? "bg-green-100 text-green-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {thread.inSession
                    ? "Inside 24h reply window"
                    : "Outside 24h window — must use template"}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-gray-50">
              {thread?.thread.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">
                  No messages yet.
                </p>
              )}
              {thread?.thread.map((m) =>
                m.kind === "inbound" ? (
                  <InboundBubble key={m.id} msg={m} />
                ) : (
                  <OutboundBubble key={m.id} msg={m} />
                )
              )}
              <div ref={threadEndRef} />
            </div>

            <div className="border-t border-gray-200 p-3 bg-white">
              {thread && !thread.inSession && (
                <p className="text-xs text-amber-700 mb-2 flex items-start gap-1.5">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    The 24-hour reply window has expired. Free-form text will
                    be rejected by Meta. Use the Pipeline → Send WhatsApp
                    dialog to send an approved template instead.
                  </span>
                </p>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleReply();
                    }
                  }}
                  placeholder={
                    thread && !thread.inSession
                      ? "Reply window closed — use a template"
                      : "Type a reply…"
                  }
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleReply}
                  disabled={sending || !replyText.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                >
                  <Send size={14} />
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="fixed top-6 right-6 px-4 py-3 rounded-md shadow-lg border bg-red-50 text-red-800 border-red-200 text-sm flex items-start gap-2 max-w-md">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
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
            <Check size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
          )}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}

function InboundBubble({
  msg,
}: {
  msg: Extract<ThreadEntry, { kind: "inbound" }>;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] bg-white border border-gray-200 rounded-lg rounded-bl-none px-3 py-2 shadow-sm">
        {msg.type !== "text" && (
          <div className="text-[11px] text-gray-500 flex items-center gap-1 mb-1">
            <ImageIcon size={11} />
            {msg.type}
            {msg.mediaMimeType && ` · ${msg.mediaMimeType}`}
          </div>
        )}
        {msg.text ? (
          <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
        ) : (
          <p className="text-sm text-gray-400 italic">
            (no text — {msg.type} attachment)
          </p>
        )}
        <p className="text-[10px] text-gray-400 mt-1">
          {new Date(msg.at).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

function OutboundBubble({
  msg,
}: {
  msg: Extract<ThreadEntry, { kind: "outbound" }>;
}) {
  const isText = msg.templateName === "<text>";
  const variables = Array.isArray(msg.templateVariables)
    ? (msg.templateVariables as string[])
    : msg.templateVariables &&
      typeof msg.templateVariables === "object" &&
      "text" in msg.templateVariables
    ? [(msg.templateVariables as { text: string }).text]
    : [];
  const statusIcon = (() => {
    switch (msg.status) {
      case "READ":
        return (
          <CheckCheck size={12} className="text-blue-500" aria-label="Read" />
        );
      case "DELIVERED":
        return (
          <CheckCheck size={12} className="text-gray-400" aria-label="Delivered" />
        );
      case "SENT":
        return <Check size={12} className="text-gray-400" aria-label="Sent" />;
      case "FAILED":
        return <AlertCircle size={12} className="text-red-500" aria-label="Failed" />;
      default:
        return null;
    }
  })();
  return (
    <div className="flex justify-end">
      <div
        className={`max-w-[70%] rounded-lg rounded-br-none px-3 py-2 shadow-sm ${
          msg.status === "FAILED"
            ? "bg-red-50 border border-red-200"
            : "bg-green-100 border border-green-200"
        }`}
      >
        <div className="text-[11px] text-gray-600 mb-1">
          {isText ? "Text" : `Template: ${msg.templateName}`}
        </div>
        {isText ? (
          <p className="text-sm whitespace-pre-wrap break-words">
            {variables[0] ?? ""}
          </p>
        ) : (
          variables.length > 0 && (
            <p className="text-sm font-mono text-gray-700">
              [{variables.join(", ")}]
            </p>
          )
        )}
        {msg.errorMessage && (
          <p className="text-xs text-red-700 mt-1">{msg.errorMessage}</p>
        )}
        <p className="text-[10px] text-gray-500 mt-1 flex items-center gap-1">
          {new Date(msg.at).toLocaleString()}
          {statusIcon}
        </p>
      </div>
    </div>
  );
}
