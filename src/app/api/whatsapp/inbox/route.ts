import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Returns one row per contact (inbound + outbound-only), with their most
 * recent activity. Used by the Inbox conversation list.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Inbound conversations
  const inboundRows = await prisma.$queryRaw<
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

  // Outbound-only conversations (manual replies & templates sent to contacts
  // who never messaged us back). These won't appear in inbound_messages.
  const outboundRows = await prisma.$queryRaw<
    Array<{
      phone_number: string;
      last_sent_at: Date;
      total_messages: bigint;
      last_template: string;
      order_id: string | null;
    }>
  >`
    SELECT DISTINCT ON (phone_number)
      phone_number,
      COALESCE(sent_at, created_at) AS last_sent_at,
      (
        SELECT COUNT(*) FROM whatsapp_messages wm2
        WHERE wm2.phone_number = whatsapp_messages.phone_number
      ) AS total_messages,
      template_name AS last_template,
      order_id
    FROM whatsapp_messages
    WHERE phone_number NOT IN (SELECT DISTINCT from_phone_number FROM inbound_messages)
    ORDER BY phone_number, COALESCE(sent_at, created_at) DESC
  `;

  const conversations = await Promise.all([
    ...inboundRows.map(async (row) => {
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
    }),
    ...outboundRows.map(async (row) => {
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
      const isTextReply = row.last_template === "<text>";
      return {
        phoneNumber: row.phone_number,
        contactName: order?.customerName ?? null,
        lastReceivedAt: row.last_sent_at,
        lastText: isTextReply ? "(sent reply)" : `Template: ${row.last_template}`,
        lastType: "text",
        totalMessages: Number(row.total_messages),
        order,
      };
    }),
  ]);

  // Newest-first conversation list.
  conversations.sort(
    (a, b) =>
      new Date(b.lastReceivedAt).getTime() -
      new Date(a.lastReceivedAt).getTime()
  );

  return NextResponse.json({ conversations });
}
