import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * Returns metadata about the configured WhatsApp template (name, language,
 * body parameter count, header format, etc.) so the Pipeline Send dialog
 * can show variable hints and header-image prompts without a round-trip to
 * Meta's API.
 *
 * Resolution order:
 *   1. Locally-cached `WhatsappTemplate` record (fast, no network).
 *   2. If nothing is cached yet, returns what we know from Settings alone.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const templateName =
    (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME)) ||
    "order_out_for_delivery";
  const templateLanguage =
    (await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE)) || "en";

  // Try the local cache first (populated by /api/whatsapp/templates/import).
  const cached = await prisma.whatsappTemplate.findFirst({
    where: { name: templateName },
  });

  if (cached) {
    const bodyParameterCount = cached.bodyText
      ? (cached.bodyText.match(/{{\s*\d+\s*}}/g) ?? []).length
      : 0;

    return NextResponse.json({
      template: {
        name: cached.name,
        language: cached.language,
        status: cached.status,
        category: cached.category ?? "UTILITY",
        bodyParameterCount,
        bodyText: cached.bodyText,
        header:
          cached.headerType && cached.headerType !== "NONE"
            ? { format: cached.headerType }
            : null,
      },
    });
  }

  // Nothing cached — return a minimal stub from Settings so the dialog
  // still renders (the user can still type variables manually).
  return NextResponse.json({
    template: {
      name: templateName,
      language: templateLanguage,
      status: "UNKNOWN",
      category: "UTILITY",
      bodyParameterCount: 0,
      bodyText: null,
      header: null,
    },
  });
}
