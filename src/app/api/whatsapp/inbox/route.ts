import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Returns one row per contact (both inbound and outbound-only), with their
 * most recent activity. Used by the Inbox conversation list.
 *
 * Merges:
 * 1. Inbound conversations (from inbound_messages)
 * 2. Outbound-only conversations (from whatsapp_messages where the phone has
 *    no inbound messages) — so every sent WhatsApp message is visible.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Inbound conversations grouped by phone
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

  // 2. Outbound-only conversations: phones that have outbound messages
  //    but NO inbound messages
  const outboundRows = await prisma.$queryRaw<
    Array<{
      phone_number: string;
      last_sent_at: Date;
      total_messages: bigint;
      last_template: string;
      order_id: string | null;
    }>
  >`
    SELECT DISTINCT ON (wm.phone_number)
      wm.phone_number,
      COALESCE(wm.sent_at, wm.created_at) AS last_sent_at,
      (
        SELECT COUNT(*) FROM whatsapp_messages wm2
        WHERE wm2.phone_number = wm.phone_number
      ) AS total_messages,
      wm.template_name AS last_template,
      wm.order_id
    FROM whatsapp_messages wm
    WHERE NOT EXISTS (
      SELECT 1 FROM inbound_messages im
      WHERE im.from_phone_number = wm.phone_number
    )
    ORDER BY wm.phone_number, COALESCE(wm.sent_at, wm.created_at) DESC
  `;

  const inboundPhones = new Set(inboundRows.map((r) => r.from_phone_number));

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
        isOutboundOnly: false,
      };
    }),
    ...outboundRows
      .filter((r) => !inboundPhones.has(r.phone_number))
      .map(async (row) => {
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
          phoneNumber: row.phone_number,
          contactName: order?.customerName ?? null,
          lastReceivedAt: row.last_sent_at,
          lastText: row.last_template === "<text>" ? "(sent reply)" : `Template: ${row.last_template}`,
          lastType: row.last_template === "<text>" ? "text" : "template",
          totalMessages: Number(row.total_messages),
          order,
          isOutboundOnly: true,
        };
      }),
  ]);

  conversations.sort(
    (a, b) =>
      new Date(b.lastReceivedAt).getTime() -
      new Date(a.lastReceivedAt).getTime()
  );

  return NextResponse.json({ conversations });
}
