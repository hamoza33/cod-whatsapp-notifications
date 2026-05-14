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
  error?: string;
}
