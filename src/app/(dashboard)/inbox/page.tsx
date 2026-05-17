"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Send,
  AlertCircle,
  MessageSquare,
  Image as ImageIcon,
  Check,
  X,
  Search,
  Phone,
  QrCode,
  Wifi,
  WifiOff,
  Plus,
  Trash2,
  Play,
  Square,
  Users,
} from "lucide-react";

/* Types */

interface OpenWASession {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastActive: string | null;
  createdAt: string;
}

interface OpenWAMessage {
  id: string;
  waMessageId: string | null;
  sessionId: string;
  chatId: string;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  status: string;
  timestamp: number | null;
  createdAt: string;
}

interface OpenWAContact {
  id: string;
  name: string | null;
  pushname: string | null;
  isGroup: boolean;
  isMyContact: boolean;
}

/* Helpers */

function formatMessageTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function chatIdToDisplay(chatId: string): string {
  return chatId.replace(/@c\.us$|@g\.us$/, "");
}

/* Main Component */

export default function InboxPage() {
  const [sessions, setSessions] = useState<OpenWASession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [contacts, setContacts] = useState<OpenWAContact[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [messages, setMessages] = useState<OpenWAMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  const [qrCode, setQrCode] = useState<string | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);

  const [showNewSession, setShowNewSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [configMissing, setConfigMissing] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const prevMsgCount = useRef(0);

  const showToast = useCallback(
    (kind: "error" | "success", text: string) => {
      setToast({ kind, text });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 5000);
    },
    []
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  /* Data Fetching */

  const fetchSessions = useCallback(async () => {
    try {
      const data = await api.get<OpenWASession[]>("/openwa/sessions");
      setSessions(Array.isArray(data) ? data : []);
      setConfigMissing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load sessions";
      if (msg.includes("not configured")) {
        setConfigMissing(true);
      } else {
        setError(msg);
      }
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSessionId || sessions.length === 0) return;
    const ready = sessions.find((s) => s.status === "ready");
    setActiveSessionId(ready ? ready.id : sessions[0].id);
  }, [sessions, activeSessionId]);

  const fetchContacts = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const data = await api.get<OpenWAContact[]>(
        `/openwa/sessions/${activeSessionId}/contacts`
      );
      if (Array.isArray(data)) setContacts(data);
    } catch {
      // Session may not be ready yet
    }
  }, [activeSessionId]);

  const fetchMessages = useCallback(
    async (chatId: string) => {
      if (!activeSessionId) return;
      setMessagesLoading(true);
      try {
        const data = await api.get<{
          messages: OpenWAMessage[];
          total: number;
        }>(`/openwa/sessions/${activeSessionId}/messages`, {
          chatId,
          limit: "100",
        });
        const msgs = data.messages || [];
        msgs.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const isNew = prevMsgCount.current === 0;
        const hasNew = msgs.length > prevMsgCount.current;
        setMessages(msgs);
        prevMsgCount.current = msgs.length;

        if (isNew || (hasNew && !userScrolledUp.current)) {
          setTimeout(() => {
            threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
          }, 100);
        }
      } catch {
        // ignore
      } finally {
        setMessagesLoading(false);
      }
    },
    [activeSessionId]
  );

  /* Effects */

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (activeSessionId && activeSession?.status === "ready") {
      fetchContacts();
    }
  }, [activeSessionId, activeSession?.status, fetchContacts]);

  useEffect(() => {
    if (selectedChatId && activeSessionId) {
      prevMsgCount.current = 0;
      userScrolledUp.current = false;
      fetchMessages(selectedChatId);
    } else {
      setMessages([]);
      prevMsgCount.current = 0;
    }
  }, [selectedChatId, activeSessionId, fetchMessages]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchSessions();
      if (activeSessionId && activeSession?.status === "ready") {
        fetchContacts();
      }
      if (selectedChatId) fetchMessages(selectedChatId);
    }, 5000);
    return () => clearInterval(interval);
  }, [
    fetchSessions,
    fetchContacts,
    fetchMessages,
    activeSessionId,
    activeSession?.status,
    selectedChatId,
  ]);

  /* Actions */

  const handleCreateSession = async () => {
    if (!newSessionName.trim()) return;
    setCreatingSession(true);
    try {
      const session = await api.post<OpenWASession>("/openwa/sessions", {
        name: newSessionName.trim(),
      });
      setSessions((prev) => [...prev, session]);
      setActiveSessionId(session.id);
      setNewSessionName("");
      setShowNewSession(false);
      showToast("success", `Session "${session.name}" created`);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to create session"
      );
    } finally {
      setCreatingSession(false);
    }
  };

  const handleStartSession = async (id: string) => {
    try {
      await api.post(`/openwa/sessions/${id}/start`);
      showToast("success", "Session starting...");
      fetchSessions();
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to start session"
      );
    }
  };

  const handleStopSession = async (id: string) => {
    try {
      await api.post(`/openwa/sessions/${id}/stop`);
      showToast("success", "Session stopped");
      fetchSessions();
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to stop session"
      );
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (!confirm("Delete this session? This cannot be undone.")) return;
    try {
      await api.del(`/openwa/sessions/${id}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setSelectedChatId(null);
      }
      showToast("success", "Session deleted");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to delete session"
      );
    }
  };

  const handleGetQR = async (id: string) => {
    try {
      const data = await api.get<{ qr: string }>(
        `/openwa/sessions/${id}/qr`
      );
      setQrCode(data.qr);
      setShowQrModal(true);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error
          ? err.message
          : "QR not ready. Start the session first."
      );
    }
  };

  const handleSendMessage = async () => {
    if (!selectedChatId || !replyText.trim() || !activeSessionId) return;
    setSending(true);
    try {
      await api.post(
        `/openwa/sessions/${activeSessionId}/messages/send-text`,
        { chatId: selectedChatId, text: replyText.trim() }
      );
      setReplyText("");
      showToast("success", "Message sent");
      fetchMessages(selectedChatId);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Send failed"
      );
    } finally {
      setSending(false);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    fetchSessions();
    if (activeSessionId && activeSession?.status === "ready") fetchContacts();
    if (selectedChatId) fetchMessages(selectedChatId);
    setTimeout(() => setRefreshing(false), 1000);
  };

  /* Filtered contacts */

  const filteredContacts = contacts.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.name?.toLowerCase().includes(q) ||
      c.pushname?.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
    );
  });

  const selectedContact = contacts.find((c) => c.id === selectedChatId);

  /* Config missing */

  if (configMissing) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-2rem)]">
        <div className="text-center max-w-md p-8 bg-white rounded-lg shadow-lg border">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <AlertCircle size={32} className="text-amber-600" />
          </div>
          <h3 className="text-xl font-semibold text-gray-900 mb-2">
            OpenWA Not Configured
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            The OpenWA API URL is not set. Go to{" "}
            <a
              href="/settings#openwa"
              className="text-blue-600 hover:underline font-medium"
            >
              Settings &rarr; OpenWA
            </a>{" "}
            to configure the connection.
          </p>
        </div>
      </div>
    );
  }

  if (sessionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-[#25D366]" size={24} />
      </div>
    );
  }

  /* Render */

  return (
    <div className="flex h-[calc(100vh-2rem)] rounded-lg overflow-hidden shadow-lg border border-gray-200">
      {/* Left panel */}
      <div className="w-[380px] flex flex-col bg-white border-r border-gray-200">
        {/* Header */}
        <div className="px-4 py-3 bg-[#008069] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#DFE5E7] flex items-center justify-center">
              <MessageSquare size={20} className="text-[#54656F]" />
            </div>
            <h2 className="text-white font-semibold text-lg">WhatsApp</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowNewSession(true)}
              className="p-2 text-white/80 hover:text-white rounded-full hover:bg-white/10 transition-colors"
              title="New Session"
            >
              <Plus size={18} />
            </button>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="p-2 text-white/80 hover:text-white rounded-full hover:bg-white/10 transition-colors"
              title="Refresh"
            >
              <RefreshCw
                size={18}
                className={refreshing ? "animate-spin" : ""}
              />
            </button>
          </div>
        </div>

        {/* Session selector */}
        {sessions.length > 0 && (
          <div className="px-3 py-2 bg-[#F0F2F5] border-b border-[#E9EDEF]">
            <div className="flex items-center gap-2">
              <select
                value={activeSessionId || ""}
                onChange={(e) => {
                  setActiveSessionId(e.target.value);
                  setSelectedChatId(null);
                  setContacts([]);
                  setMessages([]);
                }}
                className="flex-1 text-sm bg-white border border-gray-300 rounded-lg px-3 py-1.5 outline-none text-[#111B21]"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status}){s.phone ? ` - ${s.phone}` : ""}
                  </option>
                ))}
              </select>
              {activeSession && (
                <div className="flex items-center gap-1 shrink-0">
                  {activeSession.status === "ready" ? (
                    <Wifi size={16} className="text-[#25D366]" />
                  ) : activeSession.status === "qr_ready" ? (
                    <button
                      onClick={() => handleGetQR(activeSession.id)}
                      className="p-1.5 bg-[#25D366] text-white rounded-md hover:bg-[#1da851] transition-colors"
                      title="Scan QR Code"
                    >
                      <QrCode size={14} />
                    </button>
                  ) : (
                    <WifiOff size={16} className="text-[#667781]" />
                  )}
                  {(activeSession.status === "created" ||
                    activeSession.status === "idle" ||
                    activeSession.status === "disconnected") && (
                    <button
                      onClick={() => handleStartSession(activeSession.id)}
                      className="p-1.5 bg-[#25D366] text-white rounded-md hover:bg-[#1da851] transition-colors"
                      title="Start Session"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  {(activeSession.status === "ready" ||
                    activeSession.status === "connecting" ||
                    activeSession.status === "qr_ready") && (
                    <button
                      onClick={() => handleStopSession(activeSession.id)}
                      className="p-1.5 bg-gray-200 text-gray-600 rounded-md hover:bg-gray-300 transition-colors"
                      title="Stop Session"
                    >
                      <Square size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteSession(activeSession.id)}
                    className="p-1.5 bg-gray-200 text-red-500 rounded-md hover:bg-red-100 transition-colors"
                    title="Delete Session"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="px-3 py-2 bg-[#F0F2F5]">
          <div className="flex items-center gap-3 bg-white rounded-lg px-3 py-1.5">
            <Search size={16} className="text-[#54656F]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search contacts..."
              className="flex-1 text-sm bg-transparent outline-none placeholder-[#667781] text-[#111B21]"
            />
          </div>
        </div>

        {/* Contact list */}
        <div className="flex-1 overflow-y-auto bg-white">
          {sessions.length === 0 && (
            <div className="p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-[#25D366]/10 flex items-center justify-center mx-auto mb-3">
                <Plus size={28} className="text-[#25D366]" />
              </div>
              <p className="text-sm text-[#667781] mb-2">No sessions yet</p>
              <button
                onClick={() => setShowNewSession(true)}
                className="px-4 py-2 bg-[#25D366] text-white rounded-lg text-sm hover:bg-[#1da851] transition-colors"
              >
                Create Session
              </button>
            </div>
          )}

          {activeSession &&
            activeSession.status !== "ready" &&
            sessions.length > 0 && (
              <div className="p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
                  {activeSession.status === "qr_ready" ? (
                    <QrCode size={28} className="text-amber-600" />
                  ) : activeSession.status === "connecting" ||
                    activeSession.status === "initializing" ? (
                    <RefreshCw
                      size={28}
                      className="text-amber-600 animate-spin"
                    />
                  ) : (
                    <WifiOff size={28} className="text-amber-600" />
                  )}
                </div>
                <p className="text-sm font-medium text-[#111B21] mb-1">
                  Session: {activeSession.status}
                </p>
                {activeSession.status === "qr_ready" && (
                  <>
                    <p className="text-xs text-[#667781] mb-3">
                      Scan the QR code with your WhatsApp to connect
                    </p>
                    <button
                      onClick={() => handleGetQR(activeSession.id)}
                      className="px-4 py-2 bg-[#25D366] text-white rounded-lg text-sm hover:bg-[#1da851] transition-colors"
                    >
                      Show QR Code
                    </button>
                  </>
                )}
                {(activeSession.status === "created" ||
                  activeSession.status === "idle" ||
                  activeSession.status === "disconnected") && (
                  <>
                    <p className="text-xs text-[#667781] mb-3">
                      Start the session to connect to WhatsApp
                    </p>
                    <button
                      onClick={() => handleStartSession(activeSession.id)}
                      className="px-4 py-2 bg-[#25D366] text-white rounded-lg text-sm hover:bg-[#1da851] transition-colors"
                    >
                      Start Session
                    </button>
                  </>
                )}
                {(activeSession.status === "connecting" ||
                  activeSession.status === "initializing") && (
                  <p className="text-xs text-[#667781]">
                    Connecting to WhatsApp...
                  </p>
                )}
              </div>
            )}

          {activeSession?.status === "ready" &&
            filteredContacts.length === 0 && (
              <div className="p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-[#25D366]/10 flex items-center justify-center mx-auto mb-3">
                  <MessageSquare size={28} className="text-[#25D366]" />
                </div>
                <p className="text-sm text-[#667781]">
                  {searchQuery
                    ? "No matching contacts"
                    : "No contacts found"}
                </p>
              </div>
            )}

          {activeSession?.status === "ready" &&
            filteredContacts.map((c) => {
              const active = selectedChatId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedChatId(c.id)}
                  className={`w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-[#F0F2F5] transition-colors border-b border-[#E9EDEF] ${
                    active ? "bg-[#F0F2F5]" : ""
                  }`}
                >
                  <div className="w-12 h-12 rounded-full bg-[#DFE5E7] flex items-center justify-center shrink-0">
                    {c.isGroup ? (
                      <Users size={20} className="text-[#54656F]" />
                    ) : (
                      <Phone size={20} className="text-[#54656F]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[#111B21] text-[15px] truncate">
                        {c.name || c.pushname || chatIdToDisplay(c.id)}
                      </span>
                      {c.isGroup && (
                        <span className="text-[10px] bg-[#E7F8E9] text-[#008069] px-1.5 py-0.5 rounded-full shrink-0">
                          Group
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#667781] truncate mt-0.5">
                      {chatIdToDisplay(c.id)}
                    </p>
                  </div>
                </button>
              );
            })}
        </div>
      </div>

      {/* Right panel - chat thread */}
      <div className="flex-1 flex flex-col">
        {!selectedChatId || !activeSession ? (
          <div
            className="flex-1 flex items-center justify-center"
            style={{
              background:
                "linear-gradient(180deg, #008069 127px, #F0F2F5 127px)",
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
                {sessions.length === 0
                  ? "Create a session and scan the QR code to get started"
                  : activeSession?.status !== "ready"
                  ? "Connect your session to start chatting"
                  : "Select a contact to view messages"}
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="px-4 py-2.5 bg-[#008069] flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#DFE5E7] flex items-center justify-center shrink-0">
                {selectedContact?.isGroup ? (
                  <Users size={18} className="text-[#54656F]" />
                ) : (
                  <Phone size={18} className="text-[#54656F]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium text-[15px]">
                  {selectedContact?.name ||
                    selectedContact?.pushname ||
                    chatIdToDisplay(selectedChatId)}
                </div>
                <div className="text-white/70 text-xs font-mono">
                  {chatIdToDisplay(selectedChatId)}
                </div>
              </div>
              <span
                className={`text-xs px-3 py-1 rounded-full font-medium ${
                  activeSession.status === "ready"
                    ? "bg-[#25D366] text-white"
                    : "bg-white/20 text-white"
                }`}
              >
                {activeSession.status === "ready"
                  ? "Connected"
                  : activeSession.status}
              </span>
            </div>

            {/* Messages area */}
            <div
              ref={messagesContainerRef}
              onScroll={() => {
                const el = messagesContainerRef.current;
                if (!el) return;
                const dist =
                  el.scrollHeight - el.scrollTop - el.clientHeight;
                userScrolledUp.current = dist > 100;
              }}
              className="flex-1 overflow-y-auto px-16 py-4 space-y-1"
              style={{
                backgroundColor: "#EFEAE2",
                backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23D4CFC6' fill-opacity='0.3'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
              }}
            >
              {messagesLoading && messages.length === 0 && (
                <div className="flex justify-center py-8">
                  <RefreshCw
                    size={20}
                    className="animate-spin text-[#667781]"
                  />
                </div>
              )}

              {!messagesLoading && messages.length === 0 && (
                <div className="flex justify-center py-8">
                  <span className="bg-white/90 text-[#54656F] text-xs px-4 py-2 rounded-lg shadow-sm">
                    No messages yet &mdash; send the first message below
                  </span>
                </div>
              )}

              {messages.map((m) =>
                m.direction === "incoming" ? (
                  <InboundBubble key={m.id} msg={m} />
                ) : (
                  <OutboundBubble key={m.id} msg={m} />
                )
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Reply input */}
            <div className="bg-[#F0F2F5] px-4 py-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder="Type a message"
                  className="flex-1 px-4 py-2.5 bg-white rounded-lg text-sm outline-none text-[#111B21] placeholder-[#667781]"
                />
                <button
                  onClick={handleSendMessage}
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

      {/* QR Code Modal */}
      {showQrModal && qrCode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[#111B21]">
                Scan QR Code
              </h3>
              <button
                onClick={() => setShowQrModal(false)}
                className="p-1 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X size={20} className="text-[#54656F]" />
              </button>
            </div>
            <div className="bg-white p-4 rounded-lg border flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrCode)}`}
                alt="WhatsApp QR Code"
                className="w-64 h-64"
              />
            </div>
            <p className="text-xs text-[#667781] text-center mt-3">
              Open WhatsApp on your phone &rarr; Settings &rarr; Linked
              Devices &rarr; Link a Device
            </p>
            <button
              onClick={() => handleGetQR(activeSessionId!)}
              className="w-full mt-3 px-4 py-2 bg-[#25D366] text-white rounded-lg text-sm hover:bg-[#1da851] transition-colors"
            >
              Refresh QR Code
            </button>
          </div>
        </div>
      )}

      {/* New Session Modal */}
      {showNewSession && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[#111B21]">
                New Session
              </h3>
              <button
                onClick={() => setShowNewSession(false)}
                className="p-1 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X size={20} className="text-[#54656F]" />
              </button>
            </div>
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateSession();
              }}
              placeholder="Session name (e.g. My WhatsApp)"
              className="w-full px-4 py-2.5 bg-[#F0F2F5] rounded-lg text-sm outline-none text-[#111B21] placeholder-[#667781] mb-4"
              autoFocus
            />
            <button
              onClick={handleCreateSession}
              disabled={creatingSession || !newSessionName.trim()}
              className="w-full px-4 py-2.5 bg-[#25D366] text-white rounded-lg text-sm font-medium hover:bg-[#1da851] disabled:opacity-40 transition-colors"
            >
              {creatingSession ? "Creating..." : "Create Session"}
            </button>
          </div>
        </div>
      )}

      {/* Toasts */}
      {error && (
        <div className="fixed top-6 right-6 px-4 py-3 rounded-lg shadow-lg border bg-red-50 text-red-800 border-red-200 text-sm flex items-start gap-2 max-w-md z-50">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-2 opacity-60 hover:opacity-100"
          >
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

/* Bubble Components */

function InboundBubble({ msg }: { msg: OpenWAMessage }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[65%] bg-white rounded-lg rounded-tl-none px-3 py-2 shadow-sm">
        <p className="text-[13px] font-medium text-[#1FA855] mb-0.5">
          {chatIdToDisplay(msg.from)}
        </p>
        {msg.type !== "text" && msg.type !== "chat" && (
          <div className="text-[11px] text-[#667781] flex items-center gap-1 mb-1">
            <ImageIcon size={11} />
            {msg.type}
          </div>
        )}
        {msg.body ? (
          <p
            className="text-sm text-[#111B21] whitespace-pre-wrap break-words leading-[19px]"
            dir={hasArabic(msg.body) ? "rtl" : "ltr"}
          >
            {msg.body}
          </p>
        ) : (
          <p className="text-sm text-[#8696A0] italic">
            ({msg.type} attachment)
          </p>
        )}
        <p className="text-[11px] text-[#667781] mt-1 text-right">
          {formatMessageTime(msg.createdAt)}
        </p>
      </div>
    </div>
  );
}

function OutboundBubble({ msg }: { msg: OpenWAMessage }) {
  const statusIcon = (() => {
    switch (msg.status) {
      case "read":
        return <Check size={16} className="text-[#53BDEB]" />;
      case "delivered":
        return <Check size={16} className="text-[#667781]" />;
      case "sent":
        return <Check size={16} className="text-[#667781]" />;
      case "failed":
        return <AlertCircle size={14} className="text-red-500" />;
      default:
        return null;
    }
  })();

  return (
    <div className="flex justify-end">
      <div
        className={`max-w-[65%] rounded-lg rounded-tr-none px-3 py-2 shadow-sm ${
          msg.status === "failed"
            ? "bg-red-50 border border-red-200"
            : "bg-[#D9FDD3]"
        }`}
      >
        <div className="text-[11px] text-[#667781] mb-0.5">You</div>
        {msg.body ? (
          <p
            className="text-sm text-[#111B21] whitespace-pre-wrap break-words leading-[19px]"
            dir={hasArabic(msg.body) ? "rtl" : "ltr"}
          >
            {msg.body}
          </p>
        ) : msg.type !== "text" && msg.type !== "chat" ? (
          <p className="text-sm text-[#8696A0] italic">[{msg.type} sent]</p>
        ) : null}
        <p className="text-[11px] text-[#667781] mt-1 flex items-center justify-end gap-1">
          {formatMessageTime(msg.createdAt)}
          {statusIcon}
        </p>
      </div>
    </div>
  );
}
