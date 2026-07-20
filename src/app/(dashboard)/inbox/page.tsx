"use client";

import { useEffect, useState, useCallback, useRef, useMemo, Fragment } from "react";
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
  Search,
  Phone,
  Sparkles,
  Loader2,
  Pin,
  PinOff,
  Paperclip,
  Wand2,
} from "lucide-react";

interface Conversation {
  phoneNumber: string;
  contactName: string | null;
  lastReceivedAt: string;
  lastText: string | null;
  lastType: string;
  totalMessages: number;
  unreadCount: number;
  isPinned: boolean;
  isOutboundOnly?: boolean;
  /** Status of the most recent outbound message: SENT/DELIVERED/READ/FAILED/PENDING. */
  lastOutboundStatus?: string | null;
  lastOutboundError?: string | null;
  order: {
    id: string;
    codNetworkOrderId: string;
    customerName: string | null;
    productName: string | null;
    status: string;
  } | null;
}

type InboxSort = "recent" | "unread" | "unreplied";
type DeliveryFilter = "all" | "delivered" | "not_delivered";

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
      latitude: number | null;
      longitude: number | null;
      locationName: string | null;
      locationAddress: string | null;
      reactionEmoji: string | null;
      transcription: string | null;
    }
  | {
      kind: "outbound";
      id: string;
      at: string;
      templateName: string;
      templateVariables: unknown;
      renderedText: string | null;
      headerImageUrl: string | null;
      outboundMedia: {
        mediaType: string;
        mediaId: string;
        mime: string | null;
        filename: string | null;
        caption: string | null;
      } | null;
      sentBy: string | null;
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

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * WhatsApp-style date label for a message-group divider: "Today" for messages
 * from the current day, "Yesterday" for the day before, and the full date
 * (day, month, year) for anything older.
 */
function formatDateDivider(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return "Today";
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

interface WhatsappNumberOption {
  id: string;
  label: string;
  phoneNumberId: string;
  displayPhone: string;
  isDefault: boolean;
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem("inbox_selected_phone") || null;
  });
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replyText, setReplyText] = useState(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem("inbox_draft_text") || "";
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [whatsappNumbers, setWhatsappNumbers] = useState<WhatsappNumberOption[]>([]);
  const [selectedNumberId, setSelectedNumberId] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [aiSuggestionsLoading, setAiSuggestionsLoading] = useState(false);
  const [showCustomContext, setShowCustomContext] = useState(false);
  const [customContext, setCustomContext] = useState("");
  const [mediaUploading, setMediaUploading] = useState(false);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const [sortMode, setSortMode] = useState<InboxSort>("recent");
  const [deliveryFilter, setDeliveryFilter] = useState<DeliveryFilter>("all");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const prevThreadLength = useRef(0);

  const showToast = useCallback((kind: "error" | "success", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const fetchConversations = useCallback(async () => {
    try {
      const path = selectedNumberId
        ? `/whatsapp/inbox?numberId=${encodeURIComponent(selectedNumberId)}`
        : "/whatsapp/inbox";
      const data = await api.get<{ conversations: Conversation[] }>(path);
      setConversations(data.conversations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedNumberId]);

  const fetchThread = useCallback(
    async (phone: string) => {
      try {
        const qs = selectedNumberId
          ? `?numberId=${encodeURIComponent(selectedNumberId)}`
          : "";
        const data = await api.get<ThreadResponse>(
          `/whatsapp/inbox/${encodeURIComponent(phone)}${qs}`
        );
        const isNewConversation = prevThreadLength.current === 0;
        const hasNewMessages = data.thread.length > prevThreadLength.current;
        setThread(data);
        prevThreadLength.current = data.thread.length;

        if (isNewConversation || (hasNewMessages && !userScrolledUp.current)) {
          setTimeout(() => {
            threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
          }, 100);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load thread");
      }
    },
    [selectedNumberId]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    async function loadNumbers() {
      try {
        const data = await api.get<{ numbers: WhatsappNumberOption[] }>("/whatsapp/numbers");
        setWhatsappNumbers(data.numbers);
        const def = data.numbers.find((n) => n.isDefault);
        if (def) setSelectedNumberId(def.id);
      } catch {
        // ignore
      }
    }
    loadNumbers();
  }, []);

  // Reset the right pane when the operator switches accounts so we don't keep
  // showing a conversation that belongs to a different WhatsApp number. The
  // very first assignment (initial load → default account) is skipped so the
  // persisted session selection survives a page refresh.
  const initialAccountSetRef = useRef(false);
  useEffect(() => {
    if (!selectedNumberId) return;
    if (!initialAccountSetRef.current) {
      initialAccountSetRef.current = true;
      return;
    }
    setSelectedPhone(null);
    setThread(null);
    prevThreadLength.current = 0;
  }, [selectedNumberId]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchConversations();
      if (selectedPhone) fetchThread(selectedPhone);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchConversations, fetchThread, selectedPhone]);

  // Persist selected phone and draft text to sessionStorage so they survive
  // page refreshes without polluting the URL.
  useEffect(() => {
    if (selectedPhone) {
      sessionStorage.setItem("inbox_selected_phone", selectedPhone);
    } else {
      sessionStorage.removeItem("inbox_selected_phone");
    }
  }, [selectedPhone]);

  useEffect(() => {
    if (replyText) {
      sessionStorage.setItem("inbox_draft_text", replyText);
    } else {
      sessionStorage.removeItem("inbox_draft_text");
    }
  }, [replyText]);

  useEffect(() => {
    if (selectedPhone) {
      prevThreadLength.current = 0;
      userScrolledUp.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchThread(selectedPhone);
    } else {
      setThread(null);
      prevThreadLength.current = 0;
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
          body: JSON.stringify({
            text: replyText,
            ...(selectedNumberId ? { numberId: selectedNumberId } : {}),
          }),
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

  const handleSendMedia = async (file: File) => {
    if (!selectedPhone) return;
    setMediaUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      if (selectedNumberId) form.set("numberId", selectedNumberId);
      const response = await fetch(
        `/api/whatsapp/inbox/${encodeURIComponent(selectedPhone)}/media`,
        { method: "POST", body: form }
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      showToast("success", `Sent ${file.name}`);
      fetchThread(selectedPhone);
      fetchConversations();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Media send failed");
    } finally {
      setMediaUploading(false);
    }
  };

  const fetchAiSuggestions = async (customContext?: string) => {
    if (!selectedPhone) return;
    setAiSuggestionsLoading(true);
    setAiSuggestions([]);
    try {
      const response = await fetch(
        `/api/whatsapp/inbox/${encodeURIComponent(selectedPhone)}/suggestions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            customContext && customContext.trim()
              ? { customContext: customContext.trim() }
              : {}
          ),
        }
      );
      const data = (await response.json()) as {
        suggestions?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setAiSuggestions(data.suggestions || []);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to get AI suggestions"
      );
    } finally {
      setAiSuggestionsLoading(false);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    fetchConversations();
    if (selectedPhone) fetchThread(selectedPhone);
  };

  const togglePin = async (phone: string, currentlyPinned: boolean) => {
    if (currentlyPinned) {
      await fetch(`/api/whatsapp/inbox/pin?phoneNumber=${encodeURIComponent(phone)}`, { method: "DELETE" });
    } else {
      await fetch("/api/whatsapp/inbox/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
    }
    setConversations((prev) =>
      prev.map((c) => c.phoneNumber === phone ? { ...c, isPinned: !currentlyPinned } : c)
    );
  };

  const filteredConversations = useMemo(() => {
    let list = conversations.filter((c) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        (c.contactName?.toLowerCase().includes(q)) ||
        c.phoneNumber.includes(q) ||
        (c.order?.customerName?.toLowerCase().includes(q)) ||
        (c.lastText?.toLowerCase().includes(q))
      );
    });

    if (deliveryFilter === "delivered") {
      list = list.filter(
        (c) =>
          c.lastOutboundStatus === "DELIVERED" ||
          c.lastOutboundStatus === "READ"
      );
    } else if (deliveryFilter === "not_delivered") {
      list = list.filter(
        (c) =>
          c.lastOutboundStatus === "FAILED" ||
          c.lastOutboundStatus === "PENDING" ||
          c.lastOutboundStatus === "SENT"
      );
    }

    // Sort: pinned first, then by sort mode
    list = [...list].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;

      if (sortMode === "unread") {
        if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
        if (a.unreadCount === 0 && b.unreadCount > 0) return 1;
      }
      if (sortMode === "unreplied") {
        const aUnreplied = a.unreadCount > 0 && !a.isOutboundOnly;
        const bUnreplied = b.unreadCount > 0 && !b.isOutboundOnly;
        if (aUnreplied && !bUnreplied) return -1;
        if (!aUnreplied && bUnreplied) return 1;
      }

      return new Date(b.lastReceivedAt).getTime() - new Date(a.lastReceivedAt).getTime();
    });

    return list;
  }, [conversations, searchQuery, sortMode, deliveryFilter]);

  const selectedConvo = conversations.find((c) => c.phoneNumber === selectedPhone);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-[#25D366]" size={24} />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-2rem)] rounded-lg overflow-hidden shadow-lg border border-gray-200">
      {/* Left panel - conversation list */}
      <div className="w-[380px] flex flex-col bg-white border-r border-gray-200">
        {/* Header */}
        <div className="px-4 py-3 bg-[#008069] flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-[#DFE5E7] flex items-center justify-center shrink-0">
              <MessageSquare size={20} className="text-[#54656F]" />
            </div>
            <h2 className="text-white font-semibold text-lg truncate">Chats</h2>
          </div>
          <div className="flex items-center gap-1">
            {whatsappNumbers.length > 0 && (
              <select
                value={selectedNumberId || ""}
                onChange={(e) => setSelectedNumberId(e.target.value || null)}
                className="bg-white/20 text-white text-xs border border-white/30 rounded-md px-2 py-1 outline-none max-w-[140px]"
                title="Switch WhatsApp account"
              >
                <option value="" className="text-gray-900">All accounts</option>
                {whatsappNumbers.map((n) => (
                  <option key={n.id} value={n.id} className="text-gray-900">
                    {n.label} ({n.displayPhone})
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={refresh}
              disabled={refreshing}
              className="p-2 text-white/80 hover:text-white rounded-full hover:bg-white/10 transition-colors"
              aria-label="Refresh"
            >
              <RefreshCw
                size={18}
                className={refreshing ? "animate-spin" : ""}
              />
            </button>
          </div>
        </div>

        {/* Search + Sort */}
        <div className="px-3 py-2 bg-[#F0F2F5] space-y-1.5">
          <div className="flex items-center gap-3 bg-white rounded-lg px-3 py-1.5">
            <Search size={16} className="text-[#54656F]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search or start new chat"
              className="flex-1 text-sm bg-transparent outline-none placeholder-[#667781] text-[#111B21]"
            />
          </div>
          <div className="flex items-center gap-1">
            {(["recent", "unread", "unreplied"] as InboxSort[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  sortMode === mode
                    ? "bg-[#008069] text-white"
                    : "bg-white text-[#54656F] hover:bg-gray-100"
                }`}
              >
                {mode === "recent" ? "Recent" : mode === "unread" ? "Unread" : "Unreplied"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {([
              { value: "all", label: "All" },
              { value: "delivered", label: "Delivered" },
              { value: "not_delivered", label: "Not delivered" },
            ] as Array<{ value: DeliveryFilter; label: string }>).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDeliveryFilter(opt.value)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  deliveryFilter === opt.value
                    ? opt.value === "not_delivered"
                      ? "bg-red-600 text-white"
                      : "bg-[#008069] text-white"
                    : "bg-white text-[#54656F] hover:bg-gray-100"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto bg-white">
          {filteredConversations.length === 0 && (
            <div className="p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-[#25D366]/10 flex items-center justify-center mx-auto mb-3">
                <MessageSquare size={28} className="text-[#25D366]" />
              </div>
              <p className="text-sm text-[#667781]">
                {searchQuery ? "No matching conversations" : "No inbound messages yet"}
              </p>
              {!searchQuery && (
                <p className="mt-2 text-xs text-[#8696A0]">
                  Wire up the webhook in Meta App → WhatsApp → Configuration
                  pointing at <code className="bg-[#F0F2F5] px-1 rounded">/api/whatsapp/webhook</code>
                </p>
              )}
            </div>
          )}
          {filteredConversations.map((c) => {
            const active = selectedPhone === c.phoneNumber;
            return (
              <div
                key={c.phoneNumber}
                className={`w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-[#F0F2F5] transition-colors border-b border-[#E9EDEF] cursor-pointer ${
                  active ? "bg-[#F0F2F5]" : ""
                }`}
                onClick={() => {
                  setSelectedPhone(c.phoneNumber);
                  setAiSuggestions([]);
                  // Mark conversation as read (WhatsApp-style)
                  if (c.unreadCount > 0) {
                    setConversations((prev) =>
                      prev.map((conv) =>
                        conv.phoneNumber === c.phoneNumber
                          ? { ...conv, unreadCount: 0 }
                          : conv
                      )
                    );
                    api.post("/whatsapp/inbox/read", { phoneNumber: c.phoneNumber }).catch(() => {});
                  }
                }}
              >
                {/* Avatar */}
                <div className="w-12 h-12 rounded-full bg-[#DFE5E7] flex items-center justify-center shrink-0 relative">
                  <Phone size={20} className="text-[#54656F]" />
                  {c.isPinned && (
                    <div className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-[#008069] rounded-full flex items-center justify-center">
                      <Pin size={9} className="text-white" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[15px] truncate ${c.unreadCount > 0 ? "font-bold text-[#111B21]" : "font-medium text-[#111B21]"}`}>
                        {c.contactName || c.order?.customerName || c.phoneNumber}
                      </span>
                      {(c.contactName || c.order?.customerName) && (
                        <span className="text-[12px] text-[#667781] font-mono shrink-0">
                          {c.phoneNumber}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-xs ${c.unreadCount > 0 ? "text-[#25D366] font-medium" : "text-[#667781]"}`}>
                        {formatTime(c.lastReceivedAt)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(c.phoneNumber, c.isPinned);
                        }}
                        className="p-0.5 rounded hover:bg-gray-200 transition-colors"
                        title={c.isPinned ? "Unpin" : "Pin"}
                      >
                        {c.isPinned ? (
                          <PinOff size={12} className="text-[#008069]" />
                        ) : (
                          <Pin size={12} className="text-[#8696A0]" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className={`text-sm truncate ${c.unreadCount > 0 ? "text-[#111B21] font-medium" : "text-[#667781]"}`}>
                      {c.lastType !== "text" ? `📎 ${c.lastType}` : ""}
                      {c.lastText || ""}
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="bg-[#25D366] text-white text-[11px] font-medium rounded-full min-w-[20px] h-5 flex items-center justify-center px-1.5 shrink-0">
                        {c.unreadCount}
                      </span>
                    )}
                  </div>
                  {c.order && (
                    <div className="text-[11px] text-[#008069] mt-0.5 truncate font-medium">
                      Order #{c.order.codNetworkOrderId} · {c.order.status}
                    </div>
                  )}
                  {c.isOutboundOnly && !c.order && (
                    <div className="text-[11px] text-[#667781] mt-0.5 flex items-center gap-1">
                      <Send size={9} />
                      Outbound only
                    </div>
                  )}
                  {c.lastOutboundStatus && (
                    <div className="mt-0.5">
                      <DeliveryBadge
                        status={c.lastOutboundStatus}
                        error={c.lastOutboundError ?? null}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel - chat thread */}
      <div className="flex-1 flex flex-col">
        {!selectedPhone ? (
          <div
            className="flex-1 flex items-center justify-center"
            style={{
              background: "linear-gradient(180deg, #008069 127px, #F0F2F5 127px)",
            }}
          >
            <div className="text-center bg-white rounded-lg shadow-sm p-10 max-w-md">
              <div className="w-20 h-20 rounded-full bg-[#25D366]/10 flex items-center justify-center mx-auto mb-4">
                <MessageSquare size={40} className="text-[#25D366]" />
              </div>
              <h3 className="text-2xl font-light text-[#41525D] mb-2">
                WhatsApp Inbox
              </h3>
              <p className="text-sm text-[#667781]">
                Select a conversation to view messages and reply to customers
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="px-4 py-2.5 bg-[#008069] flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#DFE5E7] flex items-center justify-center shrink-0">
                <Phone size={18} className="text-[#54656F]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium text-[15px]">
                  {selectedConvo?.contactName || selectedConvo?.order?.customerName || selectedPhone}
                </div>
                <div className="text-white/70 text-xs font-mono">
                  {selectedPhone}
                </div>
              </div>
              {whatsappNumbers.length > 1 && (
                <select
                  value={selectedNumberId || ""}
                  onChange={(e) => setSelectedNumberId(e.target.value || null)}
                  className="bg-white/20 text-white text-xs border border-white/30 rounded-md px-2 py-1 outline-none"
                  title="Send from WhatsApp account"
                >
                  <option value="" className="text-gray-900">Default account</option>
                  {whatsappNumbers.map((n) => (
                    <option key={n.id} value={n.id} className="text-gray-900">
                      {n.label} ({n.displayPhone})
                    </option>
                  ))}
                </select>
              )}
              {thread && (
                <span
                  className={`text-xs px-3 py-1 rounded-full font-medium ${
                    thread.inSession
                      ? "bg-[#25D366] text-white"
                      : "bg-white/20 text-white"
                  }`}
                >
                  {thread.inSession
                    ? "24h window active"
                    : "Window expired"}
                </span>
              )}
            </div>

            {/* Messages area */}
            <div
              ref={messagesContainerRef}
              onScroll={() => {
                const el = messagesContainerRef.current;
                if (!el) return;
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                userScrolledUp.current = distanceFromBottom > 100;
              }}
              className="flex-1 overflow-y-auto px-16 py-4 space-y-1"
              style={{
                backgroundColor: "#EFEAE2",
                backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23D4CFC6' fill-opacity='0.3'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
              }}
            >
              {thread?.thread.length === 0 && (
                <div className="flex justify-center py-8">
                  <span className="bg-white/90 text-[#54656F] text-xs px-4 py-2 rounded-lg shadow-sm">
                    No messages yet
                  </span>
                </div>
              )}
              {(() => {
                let lastDay: string | null = null;
                return thread?.thread.map((m) => {
                  const day = new Date(m.at).toDateString();
                  const showDivider = day !== lastDay;
                  lastDay = day;
                  return (
                    <Fragment key={m.id}>
                      {showDivider && <DateDivider at={m.at} />}
                      {m.kind === "inbound" ? (
                        <InboundBubble msg={m} />
                      ) : (
                        <OutboundBubble msg={m} />
                      )}
                    </Fragment>
                  );
                });
              })()}
              <div ref={threadEndRef} />
            </div>

            {/* Reply input */}
            <div className="bg-[#F0F2F5] px-4 py-3">
              {thread && !thread.inSession && (
                <p className="text-xs text-amber-700 mb-2 flex items-start gap-1.5 bg-amber-50 rounded-lg px-3 py-2">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    The 24-hour reply window has expired. Use the Pipeline → Send
                    WhatsApp dialog to send an approved template instead.
                  </span>
                </p>
              )}
              {/* AI Suggestions */}
              {aiSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {aiSuggestions.map((suggestion, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setReplyText(suggestion);
                        setAiSuggestions([]);
                      }}
                      className="px-3 py-1.5 bg-white rounded-lg text-sm text-[#111B21] border border-[#25D366]/30 hover:bg-[#25D366]/10 hover:border-[#25D366] transition-colors text-left max-w-full"
                      dir={hasArabic(suggestion) ? "rtl" : "ltr"}
                    >
                      <span className="line-clamp-2">{suggestion}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* Custom-context input — appears when the operator clicks the
                  Wand button. They type extra information (delays, special
                  offers, etc.) and we feed it to the AI so the 3 suggestions
                  are tailored to that situation. */}
              {showCustomContext && (
                <div className="mb-2 bg-white rounded-lg border border-purple-300 p-2 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-purple-700 flex items-center gap-1">
                      <Wand2 size={11} />
                      Generate with custom context
                    </span>
                    <button
                      onClick={() => {
                        setShowCustomContext(false);
                        setCustomContext("");
                      }}
                      className="text-[#667781] hover:text-[#111B21]"
                      title="Close"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <textarea
                    value={customContext}
                    onChange={(e) => setCustomContext(e.target.value)}
                    rows={2}
                    placeholder={`Extra context for the reply, e.g. "The order will be sent tomorrow because of a delay." (Output stays in the customer's language — Saudi dialect when they write in Arabic.)`}
                    className="w-full px-3 py-2 bg-[#F0F2F5] rounded text-sm outline-none text-[#111B21] placeholder-[#667781] resize-none"
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={() => fetchAiSuggestions(customContext)}
                      disabled={aiSuggestionsLoading || !customContext.trim()}
                      className="px-3 py-1.5 bg-purple-600 text-white rounded-md text-xs font-medium hover:bg-purple-700 disabled:opacity-40 inline-flex items-center gap-1.5"
                    >
                      {aiSuggestionsLoading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Wand2 size={12} />
                      )}
                      Generate 3 with context
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fetchAiSuggestions()}
                  disabled={aiSuggestionsLoading}
                  className="w-10 h-10 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center hover:bg-purple-200 disabled:opacity-40 transition-colors shrink-0"
                  title="Get 3 AI reply suggestions"
                >
                  {aiSuggestionsLoading && !showCustomContext ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Sparkles size={18} />
                  )}
                </button>
                <button
                  onClick={() => setShowCustomContext((v) => !v)}
                  disabled={aiSuggestionsLoading}
                  className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors shrink-0 ${
                    showCustomContext
                      ? "bg-purple-600 text-white hover:bg-purple-700"
                      : "bg-purple-50 text-purple-600 hover:bg-purple-100"
                  } disabled:opacity-40`}
                  title="Generate 3 suggestions with custom context"
                >
                  <Wand2 size={18} />
                </button>
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
                      : "Type a message"
                  }
                  className="flex-1 px-4 py-2.5 bg-white rounded-lg text-sm outline-none text-[#111B21] placeholder-[#667781]"
                  dir={hasArabic(replyText) ? "rtl" : "ltr"}
                />
                <input
                  ref={mediaFileInputRef}
                  type="file"
                  accept="image/*,video/*,audio/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleSendMedia(file);
                      e.target.value = "";
                    }
                  }}
                />
                <button
                  onClick={() => mediaFileInputRef.current?.click()}
                  disabled={sending || !thread || !thread.inSession}
                  className="w-10 h-10 rounded-full bg-[#F0F2F5] text-[#54656F] flex items-center justify-center hover:bg-[#E9EDEF] disabled:opacity-40 transition-colors shrink-0"
                  title={
                    thread && !thread.inSession
                      ? "Reply window closed — can't attach media"
                      : "Attach image / video / audio / document"
                  }
                >
                  {mediaUploading ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Paperclip size={18} />
                  )}
                </button>
                <button
                  onClick={handleReply}
                  disabled={sending || !replyText.trim()}
                  className="w-10 h-10 rounded-full bg-[#008069] text-white flex items-center justify-center hover:bg-[#017561] disabled:opacity-40 transition-colors shrink-0"
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="fixed top-6 right-6 px-4 py-3 rounded-lg shadow-lg border bg-red-50 text-red-800 border-red-200 text-sm flex items-start gap-2 max-w-md z-50">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      )}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg border text-sm flex items-start gap-2 max-w-md z-50 ${
            toast.kind === "success"
              ? "bg-[#008069] text-white border-[#008069]"
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

function DeliveryBadge({
  status,
  error,
}: {
  status: string;
  error: string | null;
}) {
  const upper = status.toUpperCase();
  const tone =
    upper === "READ"
      ? "bg-[#53BDEB]/15 text-[#0884b1] border-[#53BDEB]/40"
      : upper === "DELIVERED"
        ? "bg-[#25D366]/15 text-[#017561] border-[#25D366]/40"
        : upper === "FAILED"
          ? "bg-red-100 text-red-700 border-red-300"
          : upper === "SENT"
            ? "bg-gray-100 text-gray-700 border-gray-300"
            : "bg-amber-100 text-amber-800 border-amber-300";
  const label =
    upper === "READ"
      ? "Read"
      : upper === "DELIVERED"
        ? "Delivered"
        : upper === "FAILED"
          ? "Not delivered"
          : upper === "SENT"
            ? "Sent (not yet delivered)"
            : upper === "PENDING"
              ? "Pending"
              : upper;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${tone}`}
      title={error ?? undefined}
    >
      {upper === "READ" || upper === "DELIVERED" ? (
        <CheckCheck size={9} />
      ) : upper === "SENT" ? (
        <Check size={9} />
      ) : upper === "FAILED" ? (
        <AlertCircle size={9} />
      ) : null}
      {label}
    </span>
  );
}

/**
 * WhatsApp-style centered date chip shown above the first message of each
 * day in the conversation thread.
 */
function DateDivider({ at }: { at: string }) {
  return (
    <div className="flex justify-center my-2">
      <span className="bg-white/90 text-[#54656F] text-[11px] font-medium uppercase tracking-wide px-3 py-1 rounded-lg shadow-sm">
        {formatDateDivider(at)}
      </span>
    </div>
  );
}

function InboundBubble({
  msg,
}: {
  msg: Extract<ThreadEntry, { kind: "inbound" }>;
}) {
  const mediaUrl = msg.mediaId
    ? `/api/whatsapp/inbox/media/${encodeURIComponent(msg.mediaId)}`
    : null;
  const mime = msg.mediaMimeType || "";
  const isImage =
    !!mediaUrl && (msg.type === "image" || msg.type === "sticker" || mime.startsWith("image/"));
  const isVideo = !!mediaUrl && (msg.type === "video" || mime.startsWith("video/"));
  const isAudio =
    !!mediaUrl && (msg.type === "audio" || msg.type === "voice" || mime.startsWith("audio/"));
  const isDocument = !!mediaUrl && (msg.type === "document" || (!isImage && !isVideo && !isAudio));

  return (
    <div className="flex justify-start">
      <div className="max-w-[65%] bg-white rounded-lg rounded-tl-none px-3 py-2 shadow-sm relative">
        {msg.contactName && (
          <p className="text-[13px] font-medium text-[#1FA855] mb-0.5">
            {msg.contactName}
          </p>
        )}
        {isImage && mediaUrl && (
          <div className="mb-1.5 -mx-1 rounded overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <a href={mediaUrl} target="_blank" rel="noopener noreferrer">
              <img
                src={mediaUrl}
                alt={msg.type}
                className="max-w-full max-h-[360px] object-contain rounded bg-[#F0F2F5]"
                loading="lazy"
              />
            </a>
          </div>
        )}
        {isVideo && mediaUrl && (
          <div className="mb-1.5 -mx-1 rounded overflow-hidden">
            <video
              src={mediaUrl}
              controls
              playsInline
              className="max-w-full max-h-[360px] rounded bg-black"
            />
          </div>
        )}
        {isAudio && mediaUrl && (
          <div className="mb-1.5">
            <audio src={mediaUrl} controls className="max-w-full" />
          </div>
        )}
        {isDocument && mediaUrl && !isImage && !isVideo && !isAudio && (
          <a
            href={mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            download
            className="mb-1.5 inline-flex items-center gap-2 bg-[#F0F2F5] hover:bg-[#E9EDEF] rounded px-2 py-1 text-xs text-[#111B21]"
          >
            <ImageIcon size={12} />
            Download {mime || msg.type}
          </a>
        )}
        {msg.type === "location" &&
          msg.latitude != null &&
          msg.longitude != null && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${msg.latitude},${msg.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-1.5 block bg-[#F0F2F5] hover:bg-[#E9EDEF] rounded px-2 py-1.5 text-xs text-[#111B21]"
            >
              📍 {msg.locationName || "Shared location"}
              {msg.locationAddress ? (
                <span className="block text-[#667781]">{msg.locationAddress}</span>
              ) : null}
              <span className="block text-[#1FA855] underline">Open in Maps</span>
            </a>
          )}
        {msg.type !== "text" && msg.type !== "location" && !mediaUrl && (
          <div className="text-[11px] text-[#667781] flex items-center gap-1 mb-1">
            <ImageIcon size={11} />
            {msg.type}
            {msg.mediaMimeType && ` · ${msg.mediaMimeType}`}
          </div>
        )}
        {msg.text ? (
          <p
            className="text-sm text-[#111B21] whitespace-pre-wrap break-words leading-[19px]"
            dir={hasArabic(msg.text) ? "rtl" : "ltr"}
          >{msg.text}</p>
        ) : !mediaUrl && msg.type !== "location" ? (
          <p className="text-sm text-[#8696A0] italic">
            ({msg.type} attachment)
          </p>
        ) : null}
        {msg.transcription && (
          <p
            className="mt-1 text-[13px] text-[#111B21] italic border-l-2 border-[#1FA855] pl-2 whitespace-pre-wrap break-words"
            dir={hasArabic(msg.transcription) ? "rtl" : "ltr"}
          >
            🎙️ {msg.transcription}
          </p>
        )}
        <p className="text-[11px] text-[#667781] mt-1 text-right">
          {formatMessageTime(msg.at)}
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
  const isMedia = msg.templateName === "<media>" && !!msg.outboundMedia;
  const isAiAgent = msg.sentBy === "ai_agent";
  const outboundMediaUrl = msg.outboundMedia
    ? `/api/whatsapp/inbox/media/${encodeURIComponent(msg.outboundMedia.mediaId)}`
    : null;
  const statusIcon = (() => {
    switch (msg.status) {
      case "READ":
        return (
          <CheckCheck size={16} className="text-[#53BDEB]" aria-label="Read" />
        );
      case "DELIVERED":
        return (
          <CheckCheck size={16} className="text-[#667781]" aria-label="Delivered" />
        );
      case "SENT":
        return <Check size={16} className="text-[#667781]" aria-label="Sent" />;
      case "FAILED":
        return <AlertCircle size={14} className="text-red-500" aria-label="Failed" />;
      default:
        return null;
    }
  })();

  const displayText = msg.renderedText;

  return (
    <div className="flex justify-end">
      <div
        className={`max-w-[65%] rounded-lg rounded-tr-none px-3 py-2 shadow-sm ${
          msg.status === "FAILED"
            ? "bg-red-50 border border-red-200"
            : "bg-[#D9FDD3]"
        }`}
      >
        <div className="text-[11px] text-[#667781] mb-0.5 flex items-center gap-1">
          {isAiAgent ? (
            <span className="text-purple-600 font-medium">AI Agent</span>
          ) : isText ? (
            <span>You</span>
          ) : isMedia ? (
            <span>You · {msg.outboundMedia?.mediaType ?? "media"}</span>
          ) : (
            <span>Template: {msg.templateName}</span>
          )}
        </div>
        {msg.headerImageUrl && (
          <div className="mb-1.5 -mx-1 rounded overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={msg.headerImageUrl}
              alt="Template header"
              className="w-full max-h-48 object-cover rounded"
            />
          </div>
        )}
        {isMedia && outboundMediaUrl && msg.outboundMedia && (
          <div className="mb-1.5 -mx-1 rounded overflow-hidden">
            {msg.outboundMedia.mediaType === "image" ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <a href={outboundMediaUrl} target="_blank" rel="noopener noreferrer">
                <img
                  src={outboundMediaUrl}
                  alt="sent image"
                  className="max-w-full max-h-[320px] object-contain rounded bg-white/40"
                  loading="lazy"
                />
              </a>
            ) : msg.outboundMedia.mediaType === "video" ? (
              <video
                src={outboundMediaUrl}
                controls
                playsInline
                className="max-w-full max-h-[320px] rounded bg-black"
              />
            ) : msg.outboundMedia.mediaType === "audio" ? (
              <audio src={outboundMediaUrl} controls className="max-w-full" />
            ) : (
              <a
                href={outboundMediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                download={msg.outboundMedia.filename ?? undefined}
                className="inline-flex items-center gap-2 bg-white/60 hover:bg-white rounded px-2 py-1 text-xs text-[#111B21]"
              >
                <ImageIcon size={12} />
                {msg.outboundMedia.filename || "Document"}
              </a>
            )}
          </div>
        )}
        {displayText ? (
          <p
            className="text-sm text-[#111B21] whitespace-pre-wrap break-words leading-[19px]"
            dir={hasArabic(displayText) ? "rtl" : "ltr"}
          >
            {displayText}
          </p>
        ) : !isText && !isMedia ? (
          <p className="text-sm text-[#111B21] italic">
            [Template sent with variables]
          </p>
        ) : null}
        {msg.errorMessage && (
          <p className="text-xs text-red-600 mt-1">{msg.errorMessage}</p>
        )}
        <p className="text-[11px] text-[#667781] mt-1 flex items-center justify-end gap-1">
          {formatMessageTime(msg.at)}
          {statusIcon}
        </p>
      </div>
    </div>
  );
}
