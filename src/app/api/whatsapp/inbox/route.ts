import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * Returns one row per contact (both inbound and outbound-only), with their
 * most recent activity. Used by the Inbox conversation list.
 *
 * Merges:
 * 1. Inbound conversations (from inbound_messages)
 * 2. Outbound-only conversations (from whatsapp_messages where the phone has
 *    no inbound messages) — so every sent WhatsApp message is visible.
 *
 * Accepts optional `?phoneNumberId=` to filter by which WhatsApp number.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const phoneNumberId = request.nextUrl.searchParams.get("phoneNumberId");

  // Build optional WHERE clause fragments for phone number filtering
  const inboundFilter = phoneNumberId
    ? Prisma.sql`WHERE to_phone_number_id = ${phoneNumberId}`
    : Prisma.empty;
  const inboundCountFilter = phoneNumberId
    ? Prisma.sql`AND im2.to_phone_number_id = ${phoneNumberId}`
    : Prisma.empty;

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
        ${inboundCountFilter}
      ) AS total_messages,
      text AS last_text,
      type AS last_type,
      contact_name,
      order_id
    FROM inbound_messages
    ${inboundFilter}
    ORDER BY from_phone_number, received_at DESC
  `;

  // 2. Outbound-only conversations
  const outboundFilter = phoneNumberId
    ? Prisma.sql`AND wm.from_phone_number_id = ${phoneNumberId}`
    : Prisma.empty;
  const outboundCountFilter = phoneNumberId
    ? Prisma.sql`AND wm2.from_phone_number_id = ${phoneNumberId}`
    : Prisma.empty;
  const outboundInboundFilter = phoneNumberId
    ? Prisma.sql`AND im.to_phone_number_id = ${phoneNumberId}`
    : Prisma.empty;

  const outboundRows = await prisma.$queryRaw<
    Array<{
      phone_number: string;
      last_sent_at: Date;
      total_messages: bigint;
      last_template: string;
      last_status: string;
      order_id: string | null;
    }>
  >`
    SELECT DISTINCT ON (wm.phone_number)
      wm.phone_number,
      COALESCE(wm.sent_at, wm.created_at) AS last_sent_at,
      (
        SELECT COUNT(*) FROM whatsapp_messages wm2
        WHERE wm2.phone_number = wm.phone_number
        ${outboundCountFilter}
      ) AS total_messages,
      wm.template_name AS last_template,
      wm.status AS last_status,
      wm.order_id
    FROM whatsapp_messages wm
    WHERE NOT EXISTS (
      SELECT 1 FROM inbound_messages im
      WHERE REGEXP_REPLACE(im.from_phone_number, '\\D', '', 'g')
          = REGEXP_REPLACE(wm.phone_number, '\\D', '', 'g')
      ${outboundInboundFilter}
    )
    ${outboundFilter}
    ORDER BY wm.phone_number, COALESCE(wm.sent_at, wm.created_at) DESC
  `;

  // Normalize to digits-only for comparison
  const inboundDigits = new Set(
    inboundRows.map((r) => r.from_phone_number.replace(/\D/g, ""))
  );

  // For inbound conversations, also look up their latest outbound status
  const inboundPhones = inboundRows.map((r) => r.from_phone_number);
  const inboundDigitsList = inboundRows.map((r) =>
    r.from_phone_number.replace(/\D/g, "")
  );
  const allPhoneVariants = [
    ...inboundPhones,
    ...inboundDigitsList,
    ...inboundDigitsList.map((d) => `+${d}`),
  ];

  // Fetch latest outbound message status for inbound conversations
  const latestOutboundStatuses = new Map<string, string>();
  if (allPhoneVariants.length > 0) {
    const outboundStatusRows = await prisma.whatsappMessage.findMany({
      where: {
        phoneNumber: { in: [...new Set(allPhoneVariants)] },
        ...(phoneNumberId ? { fromPhoneNumberId: phoneNumberId } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { phoneNumber: true, status: true },
    });
    for (const row of outboundStatusRows) {
      const digits = row.phoneNumber.replace(/\D/g, "");
      if (!latestOutboundStatuses.has(digits)) {
        latestOutboundStatuses.set(digits, row.status);
      }
    }
  }

  const conversations = await Promise.all([
    ...inboundRows.map(async (row) => {
      const order = row.order_id
        ? await prisma.order.findUnique({
            where: { id: row.order_id },
            select: {
              id: true,
              codNetworkOrderId: true,
              customerName: true,
              customerPhone: true,
              productName: true,
              status: true,
            },
          })
        : null;
      const digits = row.from_phone_number.replace(/\D/g, "");
      return {
        phoneNumber: row.from_phone_number,
        contactName: row.contact_name,
        lastReceivedAt: row.last_received_at,
        lastText: row.last_text,
        lastType: row.last_type,
        totalMessages: Number(row.total_messages),
        order,
        isOutboundOnly: false,
        deliveryStatus: latestOutboundStatuses.get(digits) ?? undefined,
      };
    }),
    ...outboundRows
      .filter((r) => !inboundDigits.has(r.phone_number.replace(/\D/g, "")))
      .map(async (row) => {
        let order = row.order_id
          ? await prisma.order.findUnique({
              where: { id: row.order_id },
              select: {
                id: true,
                codNetworkOrderId: true,
                customerName: true,
                customerPhone: true,
                productName: true,
                status: true,
              },
            })
          : null;
        // For outbound-only, also try to find order by phone number
        if (!order) {
          const digits = row.phone_number.replace(/\D/g, "");
          const phoneVariants = [row.phone_number, digits, `+${digits}`];
          const orderByPhone = await prisma.order.findFirst({
            where: { customerPhone: { in: phoneVariants } },
            orderBy: { codCreatedAt: "desc" },
            select: {
              id: true,
              codNetworkOrderId: true,
              customerName: true,
              customerPhone: true,
              productName: true,
              status: true,
            },
          });
          if (orderByPhone) order = orderByPhone;
        }
        return {
          phoneNumber: row.phone_number,
          contactName: order?.customerName ?? null,
          lastReceivedAt: row.last_sent_at,
          lastText: `Template: ${row.last_template}`,
          lastType: "template",
          totalMessages: Number(row.total_messages),
          order,
          isOutboundOnly: true,
          deliveryStatus: row.last_status,
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
