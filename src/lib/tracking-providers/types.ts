/**
 * Per-carrier tracking provider contract.
 *
 * Every carrier scraper / API client returns a `ProviderResult` for each
 * tracking number — either a fulfilled list of normalized `ParsedEvent`s
 * with the carrier-side raw status string, or an `error` code that the
 * orchestrator (`refreshAllTracking`) can branch on (e.g. fall back from
 * 4tracking to the iMile direct API when the number isn't recognized).
 *
 * Bulk providers MUST return one entry per requested tracking number —
 * never silently drop. If a number isn't recognized, surface a per-number
 * `error` like `not_found_on_4tracking` / `not_found_on_jdw` so the
 * orchestrator can route the retry path.
 *
 * The orchestrator (`applyTrackingResult` in src/lib/tracking.ts) also
 * persists the `error` string into `TrackingOrder.latestError` so the
 * user-visible row in the /tracking UI can surface a per-row diagnostic
 * (e.g. "not_found_on_injaz", "jte_manual_only", "captcha_required") in
 * addition to the generic status enum.
 */

export interface ParsedEvent {
  status: string;
  description: string;
  location?: string;
  occurredAt: Date;
  rawData?: unknown;
}

export interface ProviderResult {
  events: ParsedEvent[];
  rawStatus: string | null;
  /**
   * Canonical category computed server-side by the courier-tracking-api —
   * one of "In Transit" | "Out for Delivery" | "Delivered" | "Returned"
   * (or null when the API couldn't classify / is an older deployment). The
   * orchestrator prefers this over the local heuristic mapper so order
   * grouping follows the aggregator's per-carrier return rules.
   */
  normalizedStatus?: string | null;
  error?: string;
}
