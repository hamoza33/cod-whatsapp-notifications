import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Returns one row per inbound contact, with their most recent inbound +
 * outbound activity. Used by the Inbox conversation list.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Group inbound messages by phone — Postgres doesn't expose `groupBy +
  // include` cleanly through Prisma so we do a raw query, then a follow-up
  // join to load contact name / last message / matching order.
  const rows = await prisma.$queryRaw<
    Array<{
      from_phone_number: string;
      last_received_at: Date;
      total_messages: bigint;
      last_text: string | null;
      last_type: string;
      contact_name: string | null;
      order_id: string | null;
    }>
  >`
    SELECT DISTINCT ON (from_phone_number)
      from_phone_number,
      received_at AS last_received_at,
      (
        SELECT COUNT(*) FROM inbound_messages im2
        WHERE im2.from_phone_number = inbound_messages.from_phone_number
      ) AS total_messages,
      text AS last_text,
      type AS last_type,
      contact_name,
      order_id
    FROM inbound_messages
    ORDER BY from_phone_number, received_at DESC
  `;

  const conversations = await Promise.all(
    rows.map(async (row) => {
      const order = row.order_id
        ? await prisma.order.findUnique({
            where: { id: row.order_id },
            select: {
              id: true,
              codNetworkOrderId: true,
              customerName: true,
              productName: true,
              status: true,
            },
          })
        : null;
      return {
        phoneNumber: row.from_phone_number,
        contactName: row.contact_name,
        lastReceivedAt: row.last_received_at,
        lastText: row.last_text,
        lastType: row.last_type,
        totalMessages: Number(row.total_messages),
        order,
      };
    })
  );

  // Newest-first conversation list.
  conversations.sort(
    (a, b) =>
      new Date(b.lastReceivedAt).getTime() -
      new Date(a.lastReceivedAt).getTime()
  );

  return NextResponse.json({ conversations });
}
