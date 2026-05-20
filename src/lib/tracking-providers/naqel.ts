import type { ParsedEvent, ProviderResult } from "./types";

/**
 * Naqel Express official tracking via SOAP API.
 *
 * Uses TraceByWaybillNo endpoint at:
 *   https://infotrack.naqelexpress.com/NaqelAPIServices/NaqelAPIDemo/9.0/XMLShippingService.asmx
 *
 * Fallback when 4tracking.net returns errors for Naqel numbers.
 * Also tries the public tracking page as a secondary fallback.
 */

const NAQEL_TRACKING_URL =
  "https://www.naqelexpress.com/api/Tracking/TraceByWaybillNo";

const NAQEL_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function fetchNaqelOfficialTracking(
  trackingNumber: string
): Promise<ProviderResult> {
  // Try the public JSON tracking endpoint first
  try {
    const result = await tryNaqelJsonApi(trackingNumber);
    if (!result.error || result.events.length > 0) return result;
  } catch {
    // Fall through to HTML scraping
  }

  // Fallback: scrape the tracking page HTML
  return tryNaqelHtmlScrape(trackingNumber);
}

async function tryNaqelJsonApi(trackingNumber: string): Promise<ProviderResult> {
  const resp = await fetch(NAQEL_TRACKING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": NAQEL_USER_AGENT,
      Origin: "https://www.naqelexpress.com",
      Referer: "https://www.naqelexpress.com/en/sa/tracking/",
    },
    body: JSON.stringify({ WaybillNo: trackingNumber }),
  });

  if (!resp.ok) {
    return { events: [], rawStatus: null, error: `naqel_api_http_${resp.status}` };
  }

  const data = (await resp.json().catch(() => null)) as NaqelApiResponse | null;
  if (!data) {
    return { events: [], rawStatus: null, error: "naqel_api_invalid_json" };
  }

  return parseNaqelApiResponse(data);
}

interface NaqelCheckpoint {
  Activity?: string;
  ActivityDate?: string;
  ActivityTime?: string;
  Location?: string;
  Details?: string;
  EventDescription?: string;
  EventDate?: string;
  EventTime?: string;
  EventCity?: string;
}

interface NaqelApiResponse {
  WaybillNo?: string;
  CurrentStatus?: string;
  Status?: string;
  CheckPoints?: NaqelCheckpoint[];
  Events?: NaqelCheckpoint[];
  TrackingDetails?: NaqelCheckpoint[];
  ErrorMessage?: string;
  [key: string]: unknown;
}

function parseNaqelApiResponse(data: NaqelApiResponse): ProviderResult {
  if (data.ErrorMessage && !data.CheckPoints?.length && !data.Events?.length) {
    return { events: [], rawStatus: null, error: "not_found_on_naqel" };
  }

  const checkpoints = data.CheckPoints || data.Events || data.TrackingDetails || [];
  const events: ParsedEvent[] = [];

  for (const cp of checkpoints) {
    const description = cp.Activity || cp.EventDescription || cp.Details;
    if (!description) continue;

    const dateStr = cp.ActivityDate || cp.EventDate;
    const timeStr = cp.ActivityTime || cp.EventTime || "00:00";
    if (!dateStr) continue;

    const fullDate = `${dateStr} ${timeStr}`.trim();
    const occurredAt = new Date(fullDate);
    if (isNaN(occurredAt.getTime())) continue;

    events.push({
      status: description,
      description,
      location: cp.Location || cp.EventCity || undefined,
      occurredAt,
    });
  }

  // Sort newest first
  events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  if (events.length === 0) {
    return { events: [], rawStatus: data.CurrentStatus || data.Status || null, error: "not_found_on_naqel" };
  }

  const rawStatus = data.CurrentStatus || data.Status || events[0].description;
  return { events, rawStatus };
}

async function tryNaqelHtmlScrape(trackingNumber: string): Promise<ProviderResult> {
  const url = `https://www.naqelexpress.com/en/sa/tracking/?waybillNo=${encodeURIComponent(trackingNumber)}`;
  let html: string;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": NAQEL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    html = await resp.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "fetch_failed";
    return { events: [], rawStatus: null, error: `naqel_scrape_failed:${detail}` };
  }

  // Look for tracking data embedded in the page
  const events: ParsedEvent[] = [];

  // Try to extract JSON tracking data from script tags
  const jsonMatch = /trackingData['"]\s*:\s*(\{[\s\S]*?\})\s*[,;]/i.exec(html) ||
    /checkPoints['"]\s*:\s*(\[[\s\S]*?\])\s*[,}]/i.exec(html);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const items = Array.isArray(parsed) ? parsed : parsed.CheckPoints || parsed.Events || [];
      for (const item of items as NaqelCheckpoint[]) {
        const desc = item.Activity || item.EventDescription || item.Details;
        const dateStr = item.ActivityDate || item.EventDate;
        if (!desc || !dateStr) continue;
        const occurredAt = new Date(`${dateStr} ${item.ActivityTime || item.EventTime || "00:00"}`);
        if (isNaN(occurredAt.getTime())) continue;
        events.push({
          status: desc,
          description: desc,
          location: item.Location || item.EventCity || undefined,
          occurredAt,
        });
      }
    } catch {
      // JSON parse failed
    }
  }

  // Fallback: HTML timeline parsing
  if (events.length === 0) {
    const itemRegex =
      /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(html)) !== null) {
      const inner = match[1];
      const dateMatch =
        /(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/.exec(inner);
      if (!dateMatch) continue;
      const text = stripTags(inner).replace(dateMatch[1], "").trim().replace(/\s+/g, " ");
      if (!text || text.length < 3) continue;
      events.push({
        status: text,
        description: text.slice(0, 500),
        occurredAt: new Date(dateMatch[1].replace(/\//g, "-")),
      });
    }
  }

  events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  if (events.length === 0) {
    return { events: [], rawStatus: null, error: "not_found_on_naqel" };
  }

  return { events, rawStatus: events[0].description };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}
