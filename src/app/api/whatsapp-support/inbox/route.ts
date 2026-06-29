import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";

/**
 * WhatsApp Support inbox — lists conversations scoped to the support phone number ID.
 * Mirrors /api/whatsapp/inbox but filters by the wa_support_phone_number_id.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supportPni = await getSetting("wa_support_phone_number_id");
  if (!supportPni) {
    return NextResponse.json({ conversations: [] });
  }

  // Optional source filter: ?source=site1
  const url = new URL(request.url);
  const sourceFilter = url.searchParams.get("source");

  const inboundWhere: Record<string, unknown> = { phoneNumberId: supportPni };
  if (sourceFilter) {
    inboundWhere.source = sourceFilter;
  }

  // Inbound conversations scoped to the support phone number ID
  const inbound = await prisma.inboundMessage.groupBy({
    by: ["fromPhoneNumber"],
    where: inboundWhere,
    _max: { receivedAt: true, text: true, type: true, contactName: true },
    _count: { id: true },
  });

  // Fetch source history for each conversation (ordered chronologically)
  const phoneNumbers = inbound.map((r) => r.fromPhoneNumber);
  const sourceByPhone = new Map<string, string | null>();
  const sourceHistoryByPhone = new Map<string, string[]>();
  if (phoneNumbers.length > 0) {
    const sourceRows = await prisma.inboundMessage.findMany({
      where: {
        fromPhoneNumber: { in: phoneNumbers },
        phoneNumberId: supportPni,
        source: { not: null },
      },
      orderBy: { receivedAt: "asc" },
      select: { fromPhoneNumber: true, source: true },
    });
    for (const r of sourceRows) {
      if (!r.source) continue;
      // Track the ordered source history (deduplicate consecutive duplicates)
      const history = sourceHistoryByPhone.get(r.fromPhoneNumber) ?? [];
      if (history.length === 0 || history[history.length - 1] !== r.source) {
        history.push(r.source);
      }
      sourceHistoryByPhone.set(r.fromPhoneNumber, history);
      // Most recent source
      sourceByPhone.set(r.fromPhoneNumber, r.source);
    }
  }

  const conversations = inbound.map((row) => ({
    phoneNumber: row.fromPhoneNumber,
    contactName: row._max.contactName ?? null,
    lastReceivedAt: row._max.receivedAt?.toISOString() ?? new Date().toISOString(),
    lastText: row._max.text ?? null,
    lastType: row._max.type ?? "text",
    totalMessages: row._count.id,
    unreadCount: 0,
    isPinned: false,
    isOutboundOnly: false,
    lastOutboundStatus: null,
    lastOutboundError: null,
    order: null,
    source: sourceByPhone.get(row.fromPhoneNumber) ?? null,
    sourceHistory: sourceHistoryByPhone.get(row.fromPhoneNumber) ?? [],
  }));

  // Also include outbound-only messages sent from the support PNI
  const outboundOnly = await prisma.whatsappMessage.groupBy({
    by: ["phoneNumber"],
    where: {
      phoneNumberId: supportPni,
      phoneNumber: { notIn: conversations.map((c) => c.phoneNumber) },
    },
    _max: { sentAt: true },
    _count: { id: true },
  });

  for (const row of outboundOnly) {
    conversations.push({
      phoneNumber: row.phoneNumber,
      contactName: null,
      lastReceivedAt: row._max.sentAt?.toISOString() ?? new Date().toISOString(),
      lastText: null,
      lastType: "text",
      totalMessages: row._count.id,
      unreadCount: 0,
      isPinned: false,
      isOutboundOnly: true,
      lastOutboundStatus: null,
      lastOutboundError: null,
      order: null,
      source: null,
      sourceHistory: [],
    });
  }

  // Sort by most recent activity
  conversations.sort(
    (a, b) => new Date(b.lastReceivedAt).getTime() - new Date(a.lastReceivedAt).getTime()
  );

  return NextResponse.json({ conversations });
}
