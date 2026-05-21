import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { resolveRows, type ColumnMapping } from "@/lib/bulk-messaging/mapping";
import { startCampaign } from "@/lib/bulk-messaging/runner";

export const runtime = "nodejs";
export const maxDuration = 120;

/** GET — paginated list of campaigns with computed status counts. */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("pageSize") ?? "20", 10))
  );

  const [campaigns, total] = await Promise.all([
    prisma.bulkCampaign.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.bulkCampaign.count(),
  ]);

  const counts = await prisma.bulkRecipient.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });
  const byCampaign: Record<string, Record<string, number>> = {};
  for (const c of counts) {
    byCampaign[c.campaignId] = byCampaign[c.campaignId] ?? {};
    byCampaign[c.campaignId][c.status] = c._count._all;
  }

  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      ...c,
      counts: byCampaign[c.id] ?? {},
    })),
    page,
    pageSize,
    total,
  });
}

interface CreateBody {
  name?: string;
  templateName?: string;
  templateLanguage?: string;
  bodyParamCount?: number;
  headerType?: "text" | "image" | null;
  headerValue?: string | null;
  headerKind?: "url" | "id" | null;
  phoneNumberId?: string | null;
  columnMapping?: ColumnMapping;
  rows?: Array<Record<string, string>>;
  throttleMs?: number;
  maxAttempts?: number;
  dedupePhones?: boolean;
}

/**
 * POST — create a new campaign and immediately kick off the in-process
 * send-worker. The request payload carries the parsed sheet rows (kept on
 * the client between /parse and /campaigns to avoid server-side storage)
 * plus the operator's column-mapping and template choice.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim() || `Campaign ${new Date().toLocaleString()}`;
  const templateName = (body.templateName ?? "").trim();
  const templateLanguage = (body.templateLanguage ?? "").trim();
  const mapping = body.columnMapping;
  const rows = Array.isArray(body.rows) ? body.rows : [];

  if (!templateName) {
    return NextResponse.json(
      { error: "templateName is required" },
      { status: 400 }
    );
  }
  if (!templateLanguage) {
    return NextResponse.json(
      { error: "templateLanguage is required" },
      { status: 400 }
    );
  }
  if (!mapping || !mapping.phoneColumn) {
    return NextResponse.json(
      { error: "columnMapping.phoneColumn is required" },
      { status: 400 }
    );
  }
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No rows in the uploaded sheet." },
      { status: 400 }
    );
  }
  if (rows.length > 10_000) {
    return NextResponse.json(
      { error: "Maximum 10,000 recipients per campaign." },
      { status: 400 }
    );
  }

  const defaultCountryCode =
    (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";
  const bodyParamCount = Math.max(0, body.bodyParamCount ?? 0);

  const resolved = resolveRows(rows, mapping, bodyParamCount, defaultCountryCode);

  // Dedupe within the campaign upload if the operator asked for it. Even
  // with this off, sending the same template to the same phone twice in
  // quick succession is generally a bad idea — Meta has explicit duplicate
  // suppression on the WABA side.
  const dedupe = body.dedupePhones !== false;
  const seenPhones = new Set<string>();
  const recipientsData: Prisma.BulkRecipientCreateManyInput[] = [];
  for (const r of resolved) {
    if (!r.phoneNormalized) {
      recipientsData.push({
        campaignId: "__placeholder__",
        rowIndex: r.rowIndex,
        phoneNumber: r.phoneRaw || "",
        phoneNumberRaw: r.phoneRaw || null,
        displayName: r.displayName,
        variablesJson: r.variables,
        headerValue: r.headerValue,
        status: "FAILED",
        errorMessage: r.phoneError ?? "Invalid phone number",
        failedAt: new Date(),
      });
      continue;
    }
    if (dedupe && seenPhones.has(r.phoneNormalized)) {
      recipientsData.push({
        campaignId: "__placeholder__",
        rowIndex: r.rowIndex,
        phoneNumber: r.phoneNormalized,
        phoneNumberRaw: r.phoneRaw,
        displayName: r.displayName,
        variablesJson: r.variables,
        headerValue: r.headerValue,
        status: "SKIPPED",
        errorMessage: "Duplicate of an earlier row in this upload",
      });
      continue;
    }
    seenPhones.add(r.phoneNormalized);
    recipientsData.push({
      campaignId: "__placeholder__",
      rowIndex: r.rowIndex,
      phoneNumber: r.phoneNormalized,
      phoneNumberRaw: r.phoneRaw,
      displayName: r.displayName,
      variablesJson: r.variables,
      headerValue: r.headerValue,
      status: "PENDING",
    });
  }

  const campaign = await prisma.bulkCampaign.create({
    data: {
      name,
      templateName,
      templateLanguage,
      bodyParamCount,
      headerType: body.headerType ?? null,
      headerValue: body.headerValue?.trim() || null,
      headerKind: body.headerKind ?? null,
      phoneNumberId: body.phoneNumberId?.trim() || null,
      columnMappingJson: mapping as unknown as Prisma.InputJsonValue,
      status: "DRAFT",
      totalRecipients: recipientsData.length,
      defaultCountryCode,
      throttleMs: clamp(body.throttleMs ?? 200, 0, 5_000),
      maxAttempts: clamp(body.maxAttempts ?? 3, 1, 10),
      createdBy: user.email,
    },
  });

  await prisma.bulkRecipient.createMany({
    data: recipientsData.map((r) => ({ ...r, campaignId: campaign.id })),
  });

  // Fire the worker — it returns immediately and the loop runs in the
  // background.
  startCampaign(campaign.id).catch((err) =>
    console.error("[bulk-messaging] startCampaign failed", campaign.id, err)
  );

  return NextResponse.json({ campaign });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
