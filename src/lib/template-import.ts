import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";

/**
 * Talks to Meta's Graph API to pull every approved/pending/rejected template
 * for the configured WABA and upserts a row per `(name, language)` into the
 * `whatsapp_templates` table. Used by:
 *   • the `/api/whatsapp/templates/import` HTTP route (manual "Sync now")
 *   • the auto-import cron in `src/lib/auto-sync.ts` (every 6 h)
 *
 * Keeping the network + DB work in a plain function (rather than only in the
 * route handler) makes it directly callable from the cron without an extra
 * HTTP hop.
 */

interface MetaTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  text?: string;
}

interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  components: MetaTemplateComponent[];
}

interface MetaTemplatesResponse {
  data?: MetaTemplate[];
  error?: { message?: string; code?: number };
  paging?: { next?: string };
}

export interface TemplateImportResult {
  imported: number;
  total: number;
  statusCounts: Record<string, number>;
  lastImportAt: string;
}

export class TemplateImportError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export function countBodyParameters(text: string | undefined): number {
  if (!text) return 0;
  const matches = text.match(/{{\s*\d+\s*}}/g);
  return matches ? matches.length : 0;
}

export async function importTemplatesFromMeta(): Promise<TemplateImportResult> {
  const wabaId =
    (await getSetting(SETTING_KEYS.WHATSAPP_BUSINESS_ACCOUNT_ID)) ||
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const accessToken =
    (await getSetting(SETTING_KEYS.WHATSAPP_ACCESS_TOKEN)) ||
    process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion =
    (await getSetting(SETTING_KEYS.WHATSAPP_API_VERSION)) ||
    process.env.WHATSAPP_API_VERSION ||
    "v17.0";

  if (!wabaId) {
    throw new TemplateImportError(
      "WhatsApp Business Account ID not configured. Set it in Settings → WhatsApp Cloud API.",
      400
    );
  }
  if (!accessToken) {
    throw new TemplateImportError(
      "WhatsApp access token not configured.",
      400
    );
  }

  let nextUrl: string | null = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates?limit=200`;
  const all: MetaTemplate[] = [];
  while (nextUrl) {
    let response: Response;
    try {
      response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      throw new TemplateImportError(`Network error: ${msg}`, 502);
    }
    const bodyText = await response.text();
    let parsed: MetaTemplatesResponse;
    try {
      parsed = JSON.parse(bodyText) as MetaTemplatesResponse;
    } catch {
      throw new TemplateImportError(
        `Non-JSON response from Meta (${response.status})`,
        502
      );
    }
    if (!response.ok) {
      throw new TemplateImportError(
        parsed.error?.message ?? `Meta API error (${response.status})`,
        response.status
      );
    }
    all.push(...(parsed.data ?? []));
    nextUrl = parsed.paging?.next ?? null;
  }

  let upserted = 0;
  const statusCounts: Record<string, number> = {};
  for (const t of all) {
    const body = t.components.find((c) => c.type === "BODY");
    const header = t.components.find((c) => c.type === "HEADER");
    const bodyParamCount = countBodyParameters(body?.text);
    const headerType = header?.format ?? null;
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    try {
      await prisma.whatsappTemplate.upsert({
        where: { name_language: { name: t.name, language: t.language } },
        update: {
          status: t.status,
          category: t.category,
          bodyParamCount,
          bodyText: body?.text ?? null,
          headerType,
          components: t.components as unknown as Prisma.InputJsonValue,
          lastFetchedAt: new Date(),
        },
        create: {
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          bodyParamCount,
          bodyText: body?.text ?? null,
          headerType,
          components: t.components as unknown as Prisma.InputJsonValue,
        },
      });
      upserted++;
    } catch (err) {
      console.error(
        "[templates/import] failed to upsert",
        t.name,
        t.language,
        err
      );
    }
  }

  const lastImportAt = new Date().toISOString();
  await setSetting(
    SETTING_KEYS.WHATSAPP_TEMPLATES_LAST_IMPORT_AT,
    lastImportAt
  );

  return {
    imported: upserted,
    total: all.length,
    statusCounts,
    lastImportAt,
  };
}
