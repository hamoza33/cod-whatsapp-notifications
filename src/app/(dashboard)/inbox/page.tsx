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
  Search,
  Phone,
  Paperclip,
  Sparkles,
  Clock,
  Film,
  Mic,
  FileText,
  Download,
} from "lucide-react";

interface Conversation {
  phoneNumber: string;
  contactName: string | null;
  lastReceivedAt: string;
  lastText: string | null;
  lastType: string;
  totalMessages: number;
  isOutboundOnly?: boolean;
  deliveryStatus?: string;
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
      renderedText: string | null;
      headerImageUrl: string | null;
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

function DeliveryStatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  switch (status) {
    case "DELIVERED":
      return (
        <span className="flex items-center gap-1 text-[11px] text-green-600">
          <CheckCheck size={12} /> Delivered
        </span>
      );
    case "READ":
      return (
        <span className="flex items-center gap-1 text-[11px] text-[#53BDEB]">
          <CheckCheck size={12} /> Read
        </span>
      );
    case "SENT":
      return (
        <span className="flex items-center gap-1 text-[11px] text-[#667781]">
          <Check size={12} /> Sent
        </span>
      );
    case "FAILED":
      return (
        <span className="flex items-center gap-1 text-[11px] text-red-500 font-medium">
          <X size={12} /> Not Delivered
        </span>
      );
    case "PENDING":
      return (
        <span className="flex items-center gap-1 text-[11px] text-[#667781]">
          <Clock size={12} /> Pending
        </span>
      );
    default:
      return null;
  }
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
  const [searchQuery, setSearchQuery] = useState("");
  const [whatsappNumbers, setWhatsappNumbers] = useState<WhatsappNumberOption[]>([]);
  const [selectedNumberId, setSelectedNumberId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const prevThreadLength = useRef(0);

  // Suggestions state (Feature 3)
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [customContext, setCustomContext] = useState("");
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [showContextInput, setShowContextInput] = useState(false);

  // Media attachment state (Feature 6)
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachedPreview, setAttachedPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((kind: "error" | "success", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // Get the phoneNumberId for the currently selected WhatsApp number
  const selectedPhoneNumberId = whatsappNumbers.find(
    (n) => n.id === selectedNumberId
  )?.phoneNumberId;

  const fetchConversations = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (selectedPhoneNumberId) params.phoneNumberId = selectedPhoneNumberId;
      const data = await api.get<{ conversations: Conversation[] }>(
        "/whatsapp/inbox",
        params
      );
      setConversations(data.conversations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedPhoneNumberId]);

  const fetchThread = useCallback(
    async (phone: string) => {
      try {
        const params: Record<string, string> = {};
        if (selectedPhoneNumberId) params.phoneNumberId = selectedPhoneNumberId;
        const data = await api.get<ThreadResponse>(
          `/whatsapp/inbox/${encodeURIComponent(phone)}`,
          params
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
    [selectedPhoneNumberId]
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

  // When selected number changes, reset conversation list and thread
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setSelectedPhone(null);
    setThread(null);
    prevThreadLength.current = 0;
    setSuggestions([]);
    fetchConversations();
  }, [selectedPhoneNumberId, fetchConversations]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchConversations();
      if (selectedPhone) fetchThread(selectedPhone);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchConversations, fetchThread, selectedPhone]);

  useEffect(() => {
    if (selectedPhone) {
      prevThreadLength.current = 0;
      userScrolledUp.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSuggestions([]);
      setCustomContext("");
      setShowContextInput(false);
      setAttachedFile(null);
      setAttachedPreview(null);
      fetchThread(selectedPhone);
    } else {
      setThread(null);
      prevThreadLength.current = 0;
    }
  }, [selectedPhone, fetchThread]);

  const handleReply = async () => {
    if (!selectedPhone) return;
    if (!attachedFile && !replyText.trim()) return;
    setSending(true);
    try {
      const bodyData: Record<string, unknown> = {};
      if (replyText.trim()) bodyData.text = replyText;
      if (selectedPhoneNumberId)
        bodyData.phoneNumberId = selectedPhoneNumberId;

      if (attachedFile) {
        const arrayBuffer = await attachedFile.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ""
          )
        );
        bodyData.mediaFile = base64;
        bodyData.mediaMimeType = attachedFile.type;
        bodyData.mediaFilename = attachedFile.name;
        // Determine media type from MIME
        if (attachedFile.type.startsWith("image/")) bodyData.mediaType = "image";
        else if (attachedFile.type.startsWith("video/")) bodyData.mediaType = "video";
        else if (attachedFile.type.startsWith("audio/")) bodyData.mediaType = "audio";
        else bodyData.mediaType = "document";
      }

      const response = await fetch(
        `/api/whatsapp/inbox/${encodeURIComponent(selectedPhone)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyData),
        }
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setReplyText("");
      setAttachedFile(null);
      setAttachedPreview(null);
      showToast("success", "Reply sent");
      fetchThread(selectedPhone);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Reply failed");
    } finally {
      setSending(false);
    }
  };

  const handleGenerateSuggestions = async () => {
    if (!selectedPhone) return;
    setLoadingSuggestions(true);
    try {
      const response = await fetch(
        `/api/whatsapp/inbox/${encodeURIComponent(selectedPhone)}/suggestions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customContext: customContext.trim() || undefined,
          }),
        }
      );
      const data = (await response.json()) as {
        suggestions?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setSuggestions(data.suggestions || []);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to generate suggestions"
      );
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachedFile(file);
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => setAttachedPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setAttachedPreview(null);
    }
  };

  const removeAttachment = () => {
    setAttachedFile(null);
    setAttachedPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const refresh = () => {
    setRefreshing(true);
    fetchConversations();
    if (selectedPhone) fetchThread(selectedPhone);
  };

  const filteredConversations = conversations.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      (c.contactName?.toLowerCase().includes(q)) ||
      c.phoneNumber.includes(q) ||
      (c.order?.customerName?.toLowerCase().includes(q)) ||
      (c.lastText?.toLowerCase().includes(q))
    );
  });

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
        <div className="px-4 py-3 bg-[#008069] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#DFE5E7] flex items-center justify-center">
              <MessageSquare size={20} className="text-[#54656F]" />
            </div>
            <h2 className="text-white font-semibold text-lg">Chats</h2>
          </div>
          <div className="flex items-center gap-2">
            {whatsappNumbers.length > 1 && (
              <select
                value={selectedNumberId || ""}
                onChange={(e) => setSelectedNumberId(e.target.value)}
                className="bg-white/20 text-white text-xs border border-white/30 rounded-md px-2 py-1 outline-none max-w-[140px]"
              >
                {whatsappNumbers.map((n) => (
                  <option key={n.id} value={n.id} className="text-gray-900">
                    {n.label}
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

        {/* Search */}
        <div className="px-3 py-2 bg-[#F0F2F5]">
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
              <button
                key={c.phoneNumber}
                onClick={() => setSelectedPhone(c.phoneNumber)}
                className={`w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-[#F0F2F5] transition-colors border-b border-[#E9EDEF] ${
                  active ? "bg-[#F0F2F5]" : ""
                }`}
              >
                {/* Avatar */}
                <div className="w-12 h-12 rounded-full bg-[#DFE5E7] flex items-center justify-center shrink-0">
                  <Phone size={20} className="text-[#54656F]" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[#111B21] text-[15px] truncate">
                      {c.contactName || c.order?.customerName || c.phoneNumber}
                    </span>
                    <span className="text-xs text-[#667781] shrink-0">
                      {formatTime(c.lastReceivedAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-sm text-[#667781] truncate">
                      {c.lastType !== "text" ? `📎 ${c.lastType}` : ""}
                      {c.lastText || ""}
                    </span>
                    {c.totalMessages > 1 && (
                      <span className="bg-[#25D366] text-white text-[11px] font-medium rounded-full min-w-[20px] h-5 flex items-center justify-center px-1.5 shrink-0">
                        {c.totalMessages}
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
                  {c.deliveryStatus && (
                    <div className="mt-0.5">
                      <DeliveryStatusBadge status={c.deliveryStatus} />
                    </div>
                  )}
                </div>
              </button>
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
              {thread?.thread.map((m) =>
                m.kind === "inbound" ? (
                  <InboundBubble key={m.id} msg={m} />
                ) : (
                  <OutboundBubble key={m.id} msg={m} />
                )
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Reply input area */}
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

              {/* Suggestions row */}
              {suggestions.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => setReplyText(s)}
                      className="text-xs bg-white border border-[#E9EDEF] rounded-lg px-3 py-2 text-[#111B21] hover:bg-[#E9EDEF] transition-colors text-left max-w-[250px] truncate"
                      title={s}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {/* Context input + generate button */}
              <div className="mb-2 flex items-center gap-2">
                {showContextInput && (
                  <input
                    type="text"
                    value={customContext}
                    onChange={(e) => setCustomContext(e.target.value)}
                    placeholder="Add context for AI suggestions..."
                    className="flex-1 px-3 py-1.5 bg-white rounded-lg text-xs outline-none text-[#111B21] placeholder-[#667781] border border-[#E9EDEF]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleGenerateSuggestions();
                      }
                    }}
                  />
                )}
                <button
                  onClick={() => {
                    if (!showContextInput) {
                      setShowContextInput(true);
                    } else {
                      handleGenerateSuggestions();
                    }
                  }}
                  disabled={loadingSuggestions}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 transition-colors disabled:opacity-50 shrink-0"
                  title="Generate AI suggested replies"
                >
                  <Sparkles size={13} className={loadingSuggestions ? "animate-spin" : ""} />
                  {suggestions.length > 0 ? "Regenerate" : "Generate Replies"}
                </button>
                {showContextInput && (
                  <button
                    onClick={() => {
                      setShowContextInput(false);
                      setCustomContext("");
                    }}
                    className="text-[#667781] hover:text-[#111B21] p-1"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* Attached file preview */}
              {attachedFile && (
                <div className="mb-2 flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-[#E9EDEF]">
                  {attachedPreview ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={attachedPreview}
                      alt="Preview"
                      className="w-12 h-12 object-cover rounded"
                    />
                  ) : attachedFile.type.startsWith("video/") ? (
                    <Film size={20} className="text-[#667781]" />
                  ) : attachedFile.type.startsWith("audio/") ? (
                    <Mic size={20} className="text-[#667781]" />
                  ) : (
                    <FileText size={20} className="text-[#667781]" />
                  )}
                  <span className="text-xs text-[#111B21] truncate flex-1">
                    {attachedFile.name}
                  </span>
                  <button
                    onClick={removeAttachment}
                    className="text-[#667781] hover:text-red-500 p-1"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                {/* File attachment button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-10 h-10 rounded-full text-[#54656F] flex items-center justify-center hover:bg-[#E9EDEF] transition-colors shrink-0"
                  title="Attach file"
                >
                  <Paperclip size={20} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/mp4,audio/ogg,audio/mp3,audio/m4a,audio/mpeg"
                  onChange={handleFileSelect}
                  className="hidden"
                />
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
                      : attachedFile
                        ? "Add a caption..."
                        : "Type a message"
                  }
                  className="flex-1 px-4 py-2.5 bg-white rounded-lg text-sm outline-none text-[#111B21] placeholder-[#667781]"
                />
                <button
                  onClick={handleReply}
                  disabled={sending || (!replyText.trim() && !attachedFile)}
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

function InboundBubble({
  msg,
}: {
  msg: Extract<ThreadEntry, { kind: "inbound" }>;
}) {
  const [fullscreen, setFullscreen] = useState(false);

  const renderMedia = () => {
    if (!msg.mediaId) return null;

    const mediaUrl = `/api/whatsapp/media/${msg.mediaId}`;

    switch (msg.type) {
      case "image":
        return (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl}
              alt="Image"
              className="max-w-full rounded-lg cursor-pointer mb-1"
              style={{ maxHeight: 300 }}
              onClick={() => setFullscreen(true)}
            />
            {fullscreen && (
              <div
                className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
                onClick={() => setFullscreen(false)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaUrl}
                  alt="Full size"
                  className="max-w-[90vw] max-h-[90vh] object-contain"
                />
              </div>
            )}
          </>
        );
      case "video":
        return (
          <video
            controls
            src={mediaUrl}
            className="max-w-full rounded-lg mb-1"
            style={{ maxHeight: 300 }}
          />
        );
      case "audio":
        return <audio controls src={mediaUrl} className="max-w-full mb-1" />;
      case "document":
        return (
          <a
            href={mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-[#008069] underline mb-1"
          >
            <Download size={14} />
            Download document
          </a>
        );
      case "sticker":
        return (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={mediaUrl}
            alt="Sticker"
            className="max-w-[150px] mb-1"
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[65%] bg-white rounded-lg rounded-tl-none px-3 py-2 shadow-sm relative">
        {msg.contactName && (
          <p className="text-[13px] font-medium text-[#1FA855] mb-0.5">
            {msg.contactName}
          </p>
        )}
        {renderMedia()}
        {!msg.mediaId && msg.type !== "text" && (
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
        ) : !msg.mediaId ? (
          <p className="text-sm text-[#8696A0] italic">
            ({msg.type} attachment)
          </p>
        ) : null}
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
  const isMediaMessage = ["<image>", "<video>", "<audio>", "<document>"].includes(msg.templateName);
  const isAiAgent = msg.sentBy === "ai_agent";
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
          ) : isMediaMessage ? (
            <span className="flex items-center gap-1">
              <Paperclip size={10} />
              {msg.templateName.replace(/[<>]/g, "")}
            </span>
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
        {displayText ? (
          <p
            className="text-sm text-[#111B21] whitespace-pre-wrap break-words leading-[19px]"
            dir={hasArabic(displayText) ? "rtl" : "ltr"}
          >
            {displayText}
          </p>
        ) : !isText && !isMediaMessage ? (
          <p className="text-sm text-[#111B21] italic">
            [Template sent with variables]
          </p>
        ) : null}
        {msg.status === "FAILED" && (
          <p className="text-xs text-red-600 mt-1 font-medium flex items-center gap-1">
            <X size={12} />
            Not Delivered
            {msg.errorMessage && (
              <span className="font-normal"> — {msg.errorMessage}</span>
            )}
          </p>
        )}
        {msg.status !== "FAILED" && msg.errorMessage && (
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
