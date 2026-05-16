import type { ParsedEvent, ProviderResult } from "./types";

/**
 * JT Express (Middle East) official tracking via the trajectoryQuery page.
 *
 * The public tracking page at:
 *   https://www.jtexpress.me/KSA/trajectoryQuery?waybillNo=<num>&type=0
 * renders the tracking timeline server-side in the HTML response.
 *
 * We scrape the HTML for timeline entries. This is the fallback when
 * 4tracking.net returns errors for JTE numbers.
 */

const JTE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function fetchJteOfficialTracking(
  trackingNumber: string
): Promise<ProviderResult> {
  const url = `https://www.jtexpress.me/KSA/trajectoryQuery?waybillNo=${encodeURIComponent(
    trackingNumber
  )}&type=0`;

  let html: string;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": JTE_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    html = await resp.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "fetch_failed";
    return { events: [], rawStatus: null, error: `jte_official_fetch_failed:${detail}` };
  }

  return parseJteHtml(html);
}

function parseJteHtml(html: string): ProviderResult {
  // Check for "no data" / not found indicators
  if (
    html.includes("No logistics information") ||
    html.includes("no data") ||
    html.includes("No result")
  ) {
    return { events: [], rawStatus: null, error: "not_found_on_jte" };
  }

  const events: ParsedEvent[] = [];

  // JTE tracking page renders timeline items. Common patterns:
  // 1. JSON data embedded in the page (window.__NUXT__ or similar)
  // 2. Server-rendered HTML timeline elements
  //
  // Try extracting from embedded JSON first (more reliable)
  const jsonMatch = /trajectoryList['"]\s*:\s*(\[[\s\S]*?\])\s*[,}]/i.exec(html) ||
    /logisticsList['"]\s*:\s*(\[[\s\S]*?\])\s*[,}]/i.exec(html) ||
    /trackingList['"]\s*:\s*(\[[\s\S]*?\])\s*[,}]/i.exec(html);

  if (jsonMatch) {
    try {
      const items = JSON.parse(jsonMatch[1]) as Array<{
        scanTime?: string;
        operateTime?: string;
        time?: string;
        desc?: string;
        scanDesc?: string;
        remark?: string;
        scanCity?: string;
        city?: string;
      }>;

      for (const item of items) {
        const dateStr = item.scanTime || item.operateTime || item.time;
        const description = item.desc || item.scanDesc || item.remark;
        if (!dateStr || !description) continue;

        const occurredAt = new Date(dateStr);
        if (isNaN(occurredAt.getTime())) continue;

        events.push({
          status: description,
          description,
          location: item.scanCity || item.city || undefined,
          occurredAt,
        });
      }
    } catch {
      // JSON parse failed, try HTML parsing below
    }
  }

  // Fallback: parse HTML timeline entries
  if (events.length === 0) {
    // Look for timeline-style entries in the HTML
    const itemRegex =
      /<(?:li|div)[^>]*class=["'][^"']*(?:timeline|track|logistics)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div)>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(html)) !== null) {
      const inner = match[1];
      const dateMatch =
        /(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/.exec(inner);
      if (!dateMatch) continue;
      const description = stripTags(inner)
        .replace(dateMatch[1], "")
        .trim()
        .replace(/\s+/g, " ");
      if (!description) continue;

      events.push({
        status: description,
        description: description.slice(0, 500),
        occurredAt: new Date(dateMatch[1].replace(/\//g, "-")),
      });
    }
  }

  // Sort newest first
  events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  if (events.length === 0) {
    return { events: [], rawStatus: null, error: "not_found_on_jte" };
  }

  const rawStatus = events[0].description;
  return { events, rawStatus };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}
