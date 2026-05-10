import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

interface MetaTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  text?: string;
  example?: {
    header_handle?: string[];
    header_text?: string[];
    body_text?: string[][];
  };
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
}

interface ResolvedTemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  bodyParameterCount: number;
  bodyText: string | null;
  header: { format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION" } | null;
  hasFooter: boolean;
  buttons: number;
  raw: MetaTemplate;
}

function countBodyParameters(text: string | undefined): number {
  if (!text) return 0;
  // Meta uses `{{1}}`, `{{2}}` etc. for positional body params.
  const matches = text.match(/{{\s*\d+\s*}}/g);
  return matches ? matches.length : 0;
}

function summarize(t: MetaTemplate): ResolvedTemplateInfo {
  const body = t.components.find((c) => c.type === "BODY");
  const header = t.components.find((c) => c.type === "HEADER");
  const footer = t.components.find((c) => c.type === "FOOTER");
  const buttons = t.components.find((c) => c.type === "BUTTONS");

  return {
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    bodyParameterCount: countBodyParameters(body?.text),
    bodyText: body?.text ?? null,
    header:
      header && header.format && header.format !== "LOCATION"
        ? { format: header.format }
        : header?.format
          ? { format: header.format }
          : null,
    hasFooter: !!footer,
    buttons: buttons ? 1 : 0,
    raw: t,
  };
}

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");
  const language = searchParams.get("language");

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
    return NextResponse.json(
      {
        error:
          "WhatsApp Business Account ID not configured. Set 'whatsapp_business_account_id' in Settings → WhatsApp Cloud API. It's a separate ID from your Phone Number ID — find it in WhatsApp Manager → API Setup → Business Account.",
      },
      { status: 400 }
    );
  }
  if (!accessToken) {
    return NextResponse.json(
      { error: "WhatsApp access token not configured." },
      { status: 400 }
    );
  }

  // Meta returns ALL templates on the WABA. Filtering by `name` server-side
  // would require listing every page anyway, so just fetch the list and
  // filter locally.
  const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates?limit=200`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return NextResponse.json({ error: `Network error: ${msg}` }, { status: 502 });
  }

  const bodyText = await response.text();
  let parsed: MetaTemplatesResponse;
  try {
    parsed = JSON.parse(bodyText) as MetaTemplatesResponse;
  } catch {
    return NextResponse.json(
      { error: `Non-JSON response from Meta (${response.status}): ${bodyText.slice(0, 300)}` },
      { status: 502 }
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: parsed.error?.message ?? `Meta API error (${response.status})` },
      { status: response.status }
    );
  }

  const templates = parsed.data ?? [];

  if (name) {
    const candidates = templates.filter((t) => t.name === name);
    const match = language
      ? candidates.find((t) => t.language === language)
      : candidates.find((t) => t.status === "APPROVED") ?? candidates[0];
    if (!match) {
      const available = templates
        .filter((t) => t.status === "APPROVED")
        .map((t) => `${t.name} (${t.language})`)
        .slice(0, 20);
      return NextResponse.json(
        {
          error: `No template named '${name}'${language ? ` in language '${language}'` : ""} found on this WABA.`,
          availableTemplates: available,
        },
        { status: 404 }
      );
    }
    return NextResponse.json({ template: summarize(match) });
  }

  return NextResponse.json({
    templates: templates.map(summarize),
  });
}
