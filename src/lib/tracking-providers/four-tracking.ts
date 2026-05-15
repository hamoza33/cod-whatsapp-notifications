// NOT IN USE — server-side scraping of 4tracking.net is not viable
// (Cloudflare-protected SPA). Kept here as documentation of the
// previously-attempted approach.

import type { ParsedEvent, ProviderResult } from "./types";

/**
 * 4tracking.net bulk tracking via the public results page.
 *
 * REQUEST SHAPE
 *   POST https://www.4tracking.net/en/
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: trackids=<num1>%0A<num2>%0A...   (newline-separated, max 10)
 *   User-Agent: a desktop Chrome string (the page is more forgiving with one)
 *
 * RESPONSE SHAPE
 *   Plain HTML. The results timeline is rendered into a `<div id="rcpt">`
 *   container. Per tracking number there is a section with:
 *     - the input id (e.g. `data-tn="..."` or a `<h2>...</h2>` heading)
 *     - a status badge with one of the `t-*` classes:
 *         t-delivered, t-out-for-delivery, t-in-transit, t-info-recieved,
 *         t-exception, t-failed-attempt, t-expired, t-pending
 *     - a `<ul>`/`<ol>` of `<li>` timeline rows: each has a date + a
 *       description + an optional location
 *
 * KNOWN FAILURE MODES
 *   1. Cloudflare blocks the request (rare in our probes — happens when the
 *      result HTML is rendered async by JS calling https://api.4tracking.net,
 *      which is Cloudflare-protected and returns 403 from server-to-server
 *      callers without a browser-issued JWT-style `__et`). In that case the
 *      page returns the shell HTML with `FT_OBJ.csrf_token` set but no
 *      timeline data inline; we surface `error: 'fourtracking_blocked'` for
 *      every requested tracking number so the orchestrator can fall back.
 *   2. The number is not in 4tracking's database. We surface
 *      `error: 'not_found_on_4tracking'` for that single number; other numbers
 *      in the same batch may still resolve normally.
 *   3. The HTML structure changes. We throw a descriptive error so the
 *      caller can branch into per-carrier direct paths.
 *
 * PER-NUMBER ERROR CODES
 *   not_found_on_4tracking — 4tracking returned the page but the requested
 *                            tracking number had no timeline section.
 *   fourtracking_blocked   — the entire batch came back without timeline
 *                            data (CSRF/captcha/Cloudflare).
 */

const FOUR_TRACKING_URL = "https://www.4tracking.net/en/";
const FOUR_TRACKING_MAX_PER_CALL = 10;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function fetch4TrackingBatch(
  numbers: string[]
): Promise<Map<string, ProviderResult>> {
  if (numbers.length === 0) return new Map();
  if (numbers.length > FOUR_TRACKING_MAX_PER_CALL) {
    throw new Error(
      `fetch4TrackingBatch: max ${FOUR_TRACKING_MAX_PER_CALL} numbers per call, got ${numbers.length}`
    );
  }

  // Always return one entry per requested number — start with a default
  // "not found" map and overwrite as we parse hits.
  const out = new Map<string, ProviderResult>();
  for (const n of numbers) {
    out.set(n, { events: [], rawStatus: null, error: "not_found_on_4tracking" });
  }

  const body = `trackids=${numbers.map((n) => encodeURIComponent(n)).join("%0A")}`;

  let html: string;
  try {
    const resp = await fetch(FOUR_TRACKING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT,
      },
      body,
    });
    html = await resp.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "fetch_failed";
    for (const n of numbers) {
      out.set(n, {
        events: [],
        rawStatus: null,
        error: `fourtracking_fetch_failed:${detail}`,
      });
    }
    return out;
  }

  // Slice the rcpt container if it exists; otherwise scan the whole document.
  const rcptStart = html.indexOf('id="rcpt"');
  const rcpt =
    rcptStart >= 0 ? html.slice(rcptStart) : html;

  // Parse per-tracking-number sections. We look for any block in the rcpt
  // area that mentions one of our tracking numbers and try to associate the
  // following timeline items with it. This is intentionally defensive — the
  // upstream HTML can drift and we'd rather gracefully fall back than crash.
  let anyParsed = false;
  for (const num of numbers) {
    const parsed = parseFourTrackingForNumber(rcpt, num);
    if (parsed) {
      anyParsed = true;
      out.set(num, parsed);
    }
  }

  // FALLBACK SIGNAL: if we got nothing for any number AND the page contains
  // the `FT_OBJ` payload with a CSRF token (i.e. the JS hasn't run, the data
  // is rendered client-side from the api.4tracking.net call we can't reach),
  // surface fourtracking_blocked so the orchestrator can fall through to
  // per-carrier direct APIs.
  if (!anyParsed && /FT_OBJ\s*=|csrf_token/i.test(html)) {
    for (const n of numbers) {
      out.set(n, {
        events: [],
        rawStatus: null,
        error: "fourtracking_blocked",
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Defensive HTML parser. Kept regex-based to avoid pulling in a DOM library;
// matches the same style as the existing Injaz scraper. Each fragile block
// is commented so a future reader can understand what to look at when the
// upstream page drifts.
// ---------------------------------------------------------------------------

function parseFourTrackingForNumber(
  html: string,
  num: string
): ProviderResult | null {
  // Find the section that mentions this tracking number. 4tracking commonly
  // uses either `data-tn="<num>"` on a wrapper div, or an `<h2>` / `<h3>`
  // with the tracking number as its text. We accept any of those.
  const numEsc = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(
    `(?:data-tn=["']${numEsc}["']|<(?:h2|h3|div|section)[^>]*>\\s*${numEsc}\\s*<)([\\s\\S]{0,8000})`,
    "i"
  );
  const sectionMatch = sectionRegex.exec(html);
  if (!sectionMatch) return null;
  const section = sectionMatch[1];

  // Status badge. 4tracking marks the overall status with a class like
  // `t-delivered`, `t-out-for-delivery`, etc. on a span/div near the top.
  const statusBadge = /class=["'][^"']*\bt-([a-z-]+)\b[^"']*["']/i.exec(section);
  const rawStatus = statusBadge ? humanizeStatusSlug(statusBadge[1]) : null;

  // Timeline items. Each `<li>` (or row div) contains a date string and a
  // description; sometimes a location follows as a separate node. We grab
  // each `<li>` and pull out the first date-looking token + the surrounding
  // text. This is fragile; if it returns nothing we treat the section as
  // not-found which lets the iMile fallback in the orchestrator kick in.
  const events: ParsedEvent[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch: RegExpExecArray | null;
  while ((liMatch = liRegex.exec(section)) !== null) {
    const inner = liMatch[1];
    const date = extractDate(inner);
    if (!date) continue;
    const description = stripTags(inner)
      .replace(date.matched, "")
      .trim()
      .replace(/\s+/g, " ");
    if (!description) continue;
    const location = extractLocation(inner);
    events.push({
      status: rawStatus ?? "Update",
      description: description.slice(0, 500),
      location: location ?? undefined,
      occurredAt: date.parsed,
    });
  }

  if (events.length === 0 && !rawStatus) {
    return null;
  }

  // Newest first. Most carrier feeds give us oldest-first; sort defensively.
  events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return { events, rawStatus };
}

function humanizeStatusSlug(slug: string): string {
  // e.g. "out-for-delivery" -> "Out For Delivery"
  return slug
    .split("-")
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function extractDate(
  html: string
): { matched: string; parsed: Date } | null {
  const text = stripTags(html);
  // Match "YYYY-MM-DD HH:MM(:SS)?" or "YYYY-MM-DD" or "DD/MM/YYYY HH:MM"
  const m =
    /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/.exec(text) ||
    /(\d{4}-\d{2}-\d{2})/.exec(text) ||
    /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/.exec(text);
  if (!m) return null;
  const matched = m[1];
  let parsed: Date;
  if (matched.includes("/")) {
    // dd/mm/yyyy HH:MM
    const [date, time] = matched.split(/\s+/);
    const [dd, mm, yyyy] = date.split("/");
    parsed = new Date(`${yyyy}-${mm}-${dd}T${time ?? "00:00"}:00+03:00`);
  } else if (matched.length <= 10) {
    parsed = new Date(`${matched}T00:00:00+03:00`);
  } else {
    parsed = new Date(matched.replace(" ", "T") + "+03:00");
  }
  if (Number.isNaN(parsed.getTime())) return null;
  return { matched, parsed };
}

function extractLocation(html: string): string | null {
  // Look for a child node that looks like a location — typically wrapped in
  // a span/div with class containing "loc" or "city".
  const m = /<(?:span|div|small)[^>]*class=["'][^"']*(?:loc|city|station)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div|small)>/i.exec(
    html
  );
  if (!m) return null;
  const text = stripTags(m[1]).trim();
  return text || null;
}
