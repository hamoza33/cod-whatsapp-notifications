import type { ParsedEvent, ProviderResult } from "./types";

// ---------------------------------------------------------------------------
// Injaz Express HTML scraper
// ---------------------------------------------------------------------------
//
// Injaz's public results page renders the full timeline server-side as a
// classic Ant Design `<ul class='ant-timeline'>` list. We POST the form,
// regex out the status + date pairs, and return them oldest-first reversed
// so events[0] is the most recent. Kept as a named export so callers and
// a potential rollback don't break.

export async function fetchInjazTracking(
  trackingNumber: string
): Promise<ProviderResult> {
  const resp = await fetch(
    "https://injaz-express.com/track_order.php",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `order_id=${encodeURIComponent(trackingNumber)}`,
    }
  );

  const html = await resp.text();
  return parseInjazHtml(html);
}

function parseInjazHtml(html: string): ProviderResult {
  const events: ParsedEvent[] = [];

  // Extract timeline items:
  // <div class='orderTravel_status'>Status text</div>
  // <div class='orderTravel_time'...>2022-06-06</div>
  const itemRegex =
    /<li\s+class='ant-timeline-item[^']*'[^>]*>[\s\S]*?<div\s+class='orderTravel_status'\s*>(.*?)<\/div>[\s\S]*?<div\s+class='orderTravel_time'[^>]*>(.*?)<\/div>/g;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) !== null) {
    const status = match[1].trim();
    const dateStr = match[2].trim();
    if (!status || !dateStr) continue;

    events.push({
      status,
      description: status,
      occurredAt: new Date(dateStr),
    });
  }

  // Reverse to chronological (newest first)
  events.reverse();

  const rawStatus = events.length > 0 ? events[0].status : null;
  return { events, rawStatus };
}
