import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Download the campaign as a CSV report — one row per recipient with the
 *  full status, error, and provider message id so the operator can
 *  reconcile against their original sheet.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const campaign = await prisma.bulkCampaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const recipients = await prisma.bulkRecipient.findMany({
    where: { campaignId: id },
    orderBy: { rowIndex: "asc" },
  });

  const headers = [
    "row_index",
    "name",
    "phone_raw",
    "phone_normalized",
    "status",
    "variables",
    "header_value",
    "provider_message_id",
    "attempts",
    "sent_at",
    "delivered_at",
    "read_at",
    "failed_at",
    "error_code",
    "error_message",
  ];

  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines: string[] = [headers.join(",")];
  for (const r of recipients) {
    const variables = Array.isArray(r.variablesJson)
      ? (r.variablesJson as unknown[]).map((v) => (v == null ? "" : String(v))).join(" | ")
      : "";
    lines.push(
      [
        r.rowIndex,
        r.displayName ?? "",
        r.phoneNumberRaw ?? "",
        r.phoneNumber,
        r.status,
        variables,
        r.headerValue ?? "",
        r.providerMessageId ?? "",
        r.attemptCount,
        r.sentAt?.toISOString() ?? "",
        r.deliveredAt?.toISOString() ?? "",
        r.readAt?.toISOString() ?? "",
        r.failedAt?.toISOString() ?? "",
        r.errorCode ?? "",
        r.errorMessage ?? "",
      ]
        .map(escape)
        .join(",")
    );
  }

  const csv = lines.join("\r\n") + "\r\n";
  const safeName = campaign.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "campaign";
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}-report.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
