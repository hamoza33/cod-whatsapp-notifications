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
//
// FIELD NAME (CRITICAL): Injaz's form input is `name="order"`, not
// `order_id`. The previous implementation sent `order_id=` which Injaz
// silently ignored, returning ~72KB of homepage HTML containing 156
// decorative `<li>` items all reading "Send to Laibaih" / "2022-06-06".
// The orchestrator was happily persisting those as real events. We now:
//   1. Send `order=<num>` with a Referer header (some Injaz deployments
//      reject form posts without it).
//   2. Detect the "No Result Found" page (response < 10KB and contains
//      that literal string) and surface `error: 'not_found_on_injaz'`
//      instead of trying to parse it.
//   3. Filter out the homepage decorative-filler events (status
//      "Send to Laibaih" + date 2022-06-06) so a misroute can't pollute
//      the DB with garbage. If after filtering the events list is empty
//      we also report `error: 'not_found_on_injaz'`.

const INJAZ_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function fetchInjazTracking(
  trackingNumber: string
): Promise<ProviderResult> {
  const resp = await fetch(
    "https://injaz-express.com/track_order.php",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://injaz-express.com/",
        "User-Agent": INJAZ_USER_AGENT,
      },
      body: `order=${encodeURIComponent(trackingNumber)}`,
    }
  );

  const html = await resp.text();
  return parseInjazHtml(html);
}

function parseInjazHtml(html: string): ProviderResult {
  // Short-circuit: Injaz serves a small (~5KB) "No Result Found" page when
  // the tracking number isn't in their system. Detect it before trying to
  // parse so we don't fall through to the homepage filler path.
  if (html.length < 10000 && html.includes("No Result Found")) {
    return { events: [], rawStatus: null, error: "not_found_on_injaz" };
  }

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

    // Drop the well-documented homepage decorative-filler items: every
    // entry has status "Send to Laibaih" with date "2022-06-06". This is
    // what the operator was seeing as "terminated"-style garbage when the
    // wrong-field-name bug was active, and a defense-in-depth filter so
    // any future server misroute can't pollute the DB.
    if (
      status.toLowerCase() === "send to laibaih" &&
      dateStr === "2022-06-06"
    ) {
      continue;
    }

    events.push({
      status,
      description: status,
      occurredAt: new Date(dateStr),
    });
  }

  // Reverse to chronological (newest first)
  events.reverse();

  if (events.length === 0) {
    return { events: [], rawStatus: null, error: "not_found_on_injaz" };
  }

  const rawStatus = events[0].status;
  return { events, rawStatus };
}
