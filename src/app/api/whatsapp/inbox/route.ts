import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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

  // Optional account filter: `?numberId=<whatsappNumber.id>` restricts the
  // conversation list to the rows associated with that WhatsApp account
  // (matched against Meta Phone Number ID).
  //
  // Isolation rule: each WhatsApp account has its own thread. The DEFAULT
  // account additionally inherits all pre-migration legacy rows (which have
  // a null `phone_number_id`) so old conversations stay visible there. Any
  // non-default account sees ONLY its own PNI rows — switching to a newly
  // added account therefore starts with an empty inbox.
  const url = new URL(request.url);
  const numberIdParam = url.searchParams.get("numberId");
  let pniFilter: string | null = null;
  let includeLegacy = false;
  if (numberIdParam) {
    const row = await prisma.whatsappNumber.findUnique({
      where: { id: numberIdParam },
    });
    if (row) {
      pniFilter = row.phoneNumberId;
      includeLegacy = row.isDefault;
    } else if (/^\d{6,20}$/.test(numberIdParam)) {
      pniFilter = numberIdParam;
      // Raw PNI passed without a DB row — check whether it's the default.
      const defaultRow = await prisma.whatsappNumber.findFirst({
        where: { isDefault: true },
      });
      includeLegacy = defaultRow?.phoneNumberId === pniFilter;
    }
  }

  // Reusable WHERE-fragment that limits a query to the selected account.
  // For the default account we OR in the legacy null rows; for any other
  // account we strictly match the PNI so the inbox is truly isolated.
  const inboundAccountFilter = pniFilter
    ? includeLegacy
      ? Prisma.sql`(phone_number_id IS NULL OR phone_number_id = ${pniFilter})`
      : Prisma.sql`phone_number_id = ${pniFilter}`
    : null;
  const outboundAccountFilter = pniFilter
    ? includeLegacy
      ? Prisma.sql`(wm.phone_number_id IS NULL OR wm.phone_number_id = ${pniFilter})`
      : Prisma.sql`wm.phone_number_id = ${pniFilter}`
    : null;

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
      ) + (
        SELECT COUNT(*) FROM whatsapp_messages wm2
        WHERE REGEXP_REPLACE(wm2.phone_number, '\\D', '', 'g')
            = REGEXP_REPLACE(inbound_messages.from_phone_number, '\\D', '', 'g')
      ) AS total_messages,
      text AS last_text,
      type AS last_type,
      contact_name,
      order_id
    FROM inbound_messages
    ${inboundAccountFilter ? Prisma.sql`WHERE ${inboundAccountFilter}` : Prisma.empty}
    ORDER BY from_phone_number, received_at DESC
  `;

  // 2. Outbound-only conversations: phones that have outbound messages
  //    but NO inbound messages. Same isolation rule as inbound — default
  //    account inherits legacy null rows; non-default sees only its own.
  const outboundRows = await prisma.$queryRaw<
    Array<{
      phone_number: string;
      last_sent_at: Date;
      total_messages: bigint;
      last_template: string;
      order_id: string | null;
      last_status: string;
      last_error_message: string | null;
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
      wm.order_id,
      wm.status::text AS last_status,
      wm.error_message AS last_error_message
    FROM whatsapp_messages wm
    WHERE NOT EXISTS (
      SELECT 1 FROM inbound_messages im
      WHERE REGEXP_REPLACE(im.from_phone_number, '\\D', '', 'g')
          = REGEXP_REPLACE(wm.phone_number, '\\D', '', 'g')
    )
    ${outboundAccountFilter ? Prisma.sql`AND ${outboundAccountFilter}` : Prisma.empty}
    ORDER BY wm.phone_number, COALESCE(wm.sent_at, wm.created_at) DESC
  `;

  // Normalize to digits-only for comparison (webhook stores +prefix, outbound may not)
  const inboundDigits = new Set(
    inboundRows.map((r) => r.from_phone_number.replace(/\D/g, ""))
  );

  // 3. Latest outbound message per phone (for conversations that also have
  //    inbound messages). Used to show the most recent activity regardless of
  //    direction — so automation-sent templates appear as the last message.
  const inboundPhoneDigits = inboundRows.map((r) =>
    r.from_phone_number.replace(/\D/g, "")
  );
  const latestOutboundPerPhone =
    inboundPhoneDigits.length > 0
      ? await prisma.$queryRaw<
          Array<{
            phone_digits: string;
            last_sent_at: Date;
            template_name: string;
            order_id: string | null;
            last_status: string;
            last_error_message: string | null;
          }>
        >`
          SELECT DISTINCT ON (REGEXP_REPLACE(wm.phone_number, '\\D', '', 'g'))
            REGEXP_REPLACE(wm.phone_number, '\\D', '', 'g') AS phone_digits,
            COALESCE(wm.sent_at, wm.created_at) AS last_sent_at,
            wm.template_name,
            wm.order_id,
            wm.status::text AS last_status,
            wm.error_message AS last_error_message
          FROM whatsapp_messages wm
          WHERE REGEXP_REPLACE(wm.phone_number, '\\D', '', 'g') = ANY(${inboundPhoneDigits})
            ${outboundAccountFilter ? Prisma.sql`AND ${outboundAccountFilter}` : Prisma.empty}
          ORDER BY REGEXP_REPLACE(wm.phone_number, '\\D', '', 'g'),
                   COALESCE(wm.sent_at, wm.created_at) DESC
        `
      : [];
  const outboundByDigits = new Map(
    latestOutboundPerPhone.map((r) => [r.phone_digits, r])
  );

  // Load pinned conversations
  const pinnedRows = await prisma.pinnedConversation.findMany();
  const pinnedSet = new Set(pinnedRows.map((p) => p.phoneNumber));

  // Count unread inbound messages (messages received after lastReadAt).
  // If no read state exists, all inbound messages are unread.
  const unreadCounts = await prisma.$queryRaw<
    Array<{ from_phone_number: string; unread_count: bigint }>
  >`
    SELECT im.from_phone_number, COUNT(*) AS unread_count
    FROM inbound_messages im
    WHERE im.received_at > COALESCE(
      (SELECT crs.last_read_at
       FROM conversation_read_states crs
       WHERE crs.phone_number = im.from_phone_number),
      '1970-01-01'::timestamp
    )
    GROUP BY im.from_phone_number
  `;
  const unreadMap = new Map(
    unreadCounts.map((r) => [r.from_phone_number, Number(r.unread_count)])
  );

  const conversations = await Promise.all([
    ...inboundRows.map(async (row) => {
      const digits = row.from_phone_number.replace(/\D/g, "");
      const latestOut = outboundByDigits.get(digits);
      const outboundIsNewer =
        latestOut &&
        new Date(latestOut.last_sent_at).getTime() >
          new Date(row.last_received_at).getTime();

      const effectiveOrderId = outboundIsNewer
        ? latestOut.order_id ?? row.order_id
        : row.order_id;
      const order = effectiveOrderId
        ? await prisma.order.findUnique({
            where: { id: effectiveOrderId },
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
        lastReceivedAt: outboundIsNewer
          ? latestOut.last_sent_at
          : row.last_received_at,
        lastText: outboundIsNewer
          ? latestOut.template_name === "<text>"
            ? "You: (text message)"
            : `You: Template ${latestOut.template_name}`
          : row.last_text,
        lastType: outboundIsNewer ? "template" : row.last_type,
        totalMessages: Number(row.total_messages),
        unreadCount: unreadMap.get(row.from_phone_number) ?? 0,
        isPinned: pinnedSet.has(row.from_phone_number),
        lastOutboundStatus: latestOut?.last_status ?? null,
        lastOutboundError: latestOut?.last_error_message ?? null,
        order,
        isOutboundOnly: false,
      };
    }),
    ...outboundRows
      .filter((r) => !inboundDigits.has(r.phone_number.replace(/\D/g, "")))
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
          lastText: `Template: ${row.last_template}`,
          lastType: "template",
          totalMessages: Number(row.total_messages),
          unreadCount: 0,
          isPinned: pinnedSet.has(row.phone_number),
          lastOutboundStatus: row.last_status ?? null,
          lastOutboundError: row.last_error_message ?? null,
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
