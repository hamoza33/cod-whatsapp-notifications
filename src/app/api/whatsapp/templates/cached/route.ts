import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * Returns the locally-cached list of WhatsApp templates pulled from Meta
 * (via `/api/whatsapp/templates/import`). Cheap to call — no network round
 * trip — so the `/templates` UI and the Automations builder can poll it
 * freely.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  const templates = await prisma.whatsappTemplate.findMany({
    where: statusFilter ? { status: statusFilter } : undefined,
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });

  const lastImportAt = await getSetting(
    SETTING_KEYS.WHATSAPP_TEMPLATES_LAST_IMPORT_AT
  );

  return NextResponse.json({
    templates,
    lastImportAt,
  });
}
