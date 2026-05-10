import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  importTemplatesFromMeta,
  TemplateImportError,
} from "@/lib/template-import";

/**
 * Force-refresh the cached `whatsapp_templates` table from the Meta Graph
 * API. Used by:
 *   • the `/templates` UI's "Sync now" button
 *   • the auto-import cron in `src/lib/auto-sync.ts`
 *
 * Delegates to `importTemplatesFromMeta()` so the cron and the HTTP route
 * share a single code path.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await importTemplatesFromMeta();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TemplateImportError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Template import failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  // Allow a manual GET refresh as well, mostly for cron-style callers.
  return POST(request);
}
