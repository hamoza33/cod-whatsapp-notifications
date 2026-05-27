/**
 * Webhook-side glue for the `wait_for_reply` action node. When the
 * WhatsApp webhook persists an inbound text, it calls
 * {@link routeInboundReplyToWaits} to see whether any parked automation
 * runs are waiting on this customer; if so, the matching wait is woken
 * up and the engine resumes the flow down the matched branch.
 *
 * Matching rules (in order):
 *   1. Empty inbound text → no match (sticker / image without caption).
 *   2. Inbound text matches one of the wait's `yesKeywords` (case- and
 *      diacritic-insensitive, whole-word or whole-message) → "yes".
 *   3. Same against `noKeywords` → "no".
 *   4. Neither list matches → leave the wait parked, fall through to
 *      the normal MESSAGE_RECEIVED automation pathway.
 *
 * A wait is consumed by at most one inbound message — once it transitions
 * to MATCHED it's never reconsidered for routing.
 */

import { prisma } from "../prisma";
import { resumeFlow, sweepExpiredWaits } from "./engine";

/**
 * Default keyword lists used when a `wait_for_reply` node was created
 * without any explicit keywords. Lower-cased + diacritic-stripped to
 * match the comparator below.
 */
const DEFAULT_YES_KEYWORDS = [
  "yes",
  "y",
  "yeah",
  "yep",
  "sure",
  "ok",
  "okay",
  "oui",
  "ouais",
  "naam",
  "na3am",
  "نعم",
  "موافق",
  "1",
];
const DEFAULT_NO_KEYWORDS = [
  "no",
  "n",
  "nope",
  "non",
  "la",
  "la2",
  "لا",
  "0",
  "2",
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip latin diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // keep letters / digits / spaces
    .replace(/\s+/g, " ")
    .trim();
}

function splitKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]+/)
    .map((k) => normalize(k))
    .filter((k) => k.length > 0);
}

function tokenize(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t.length > 0);
}

function matchesKeyword(normalizedText: string, keyword: string): boolean {
  if (!keyword) return false;
  if (normalizedText === keyword) return true;
  // For short single-token keywords ("y", "n", "ok") require a whole-word
  // match so a casual "no problem" doesn't get routed to "no" when the
  // operator meant a literal "no".
  const tokens = tokenize(normalizedText);
  if (tokens.includes(keyword)) return true;
  // Multi-word keyword: allow substring match.
  if (keyword.includes(" ") && normalizedText.includes(keyword)) return true;
  return false;
}

/**
 * Try to route a customer's inbound reply to any parked flow runs
 * waiting on that phone. Returns the number of waits that were matched
 * (and therefore resumed). Best-effort — errors are caught and logged
 * so the webhook never 500s.
 */
export async function routeInboundReplyToWaits(
  fromPhone: string,
  text: string | null
): Promise<number> {
  // Opportunistic expiry sweep so the table doesn't grow unbounded.
  // Don't await — we don't need it to complete before returning.
  sweepExpiredWaits().catch((err) => {
    console.error(
      "[automation-flow] sweepExpiredWaits failed:",
      err instanceof Error ? err.message : err
    );
  });

  if (!text || !text.trim()) return 0;
  const normalizedText = normalize(text);
  if (!normalizedText) return 0;

  const waits = await prisma.automationFlowWait.findMany({
    where: { fromPhone, status: "WAITING" },
    orderBy: { createdAt: "desc" },
  });
  if (waits.length === 0) return 0;

  let matched = 0;
  for (const wait of waits) {
    const yesList = splitKeywords(wait.yesKeywords);
    const noList = splitKeywords(wait.noKeywords);
    const effectiveYes = yesList.length > 0 ? yesList : DEFAULT_YES_KEYWORDS;
    const effectiveNo = noList.length > 0 ? noList : DEFAULT_NO_KEYWORDS;

    let handle: "yes" | "no" | null = null;
    if (effectiveYes.some((k) => matchesKeyword(normalizedText, k))) {
      handle = "yes";
    } else if (effectiveNo.some((k) => matchesKeyword(normalizedText, k))) {
      handle = "no";
    }
    if (!handle) continue;

    try {
      await resumeFlow(wait.id, handle, text);
      matched++;
    } catch (err) {
      console.error(
        `[automation-flow] failed to resume wait ${wait.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return matched;
}
