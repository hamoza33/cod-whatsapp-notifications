/**
 * Tracking provider using 4tracking.net for iMile and J&T Express.
 *
 * 4tracking.net supports bulk tracking queries via their web interface.
 * We use HTTP requests to query tracking status.
 */

import type { TrackingProvider, TrackingResult, TrackingDeliveryStatus } from "./types";

const FOURTRACKING_BASE_URL = "https://4tracking.net";

function parseDeliveryStatus(rawStatus: string): TrackingDeliveryStatus {
  const s = rawStatus.toLowerCase().trim();
  if (s.includes("delivered") || s.includes("completed")) return "delivered";
  if (s.includes("return")) return "returned";
  if (s.includes("out for delivery") || s.includes("out_for_delivery")) return "out_for_delivery";
  if (s.includes("in transit") || s.includes("in_transit") || s.includes("transit") || s.includes("shipping")) return "in_transit";
  if (s.includes("fail")) return "failed";
  return "unknown";
}

export class FourTrackingProvider implements TrackingProvider {
  name = "4tracking.net";

  async trackBatch(trackingNumbers: string[]): Promise<TrackingResult[]> {
    const results = await Promise.allSettled(
      trackingNumbers.map((tn) => this.trackSingle(tn))
    );

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        trackingNumber: trackingNumbers[i],
        status: "unknown" as TrackingDeliveryStatus,
        events: [],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });
  }

  async trackSingle(trackingNumber: string): Promise<TrackingResult> {
    try {
      const url = `${FOURTRACKING_BASE_URL}/track/${encodeURIComponent(trackingNumber)}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        return {
          trackingNumber,
          status: "unknown",
          events: [],
          error: `HTTP ${response.status} from 4tracking.net`,
        };
      }

      const html = await response.text();
      return this.parseTrackingPage(trackingNumber, html);
    } catch (err) {
      return {
        trackingNumber,
        status: "unknown",
        events: [],
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  private parseTrackingPage(trackingNumber: string, html: string): TrackingResult {
    const events: { date: string; description: string; location?: string }[] = [];

    // Extract tracking events from the HTML.
    // 4tracking.net renders events in a structured format.
    const eventRegex = /<div[^>]*class="[^"]*tracking[_-]?event[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let match: RegExpExecArray | null;
    while ((match = eventRegex.exec(html)) !== null) {
      const block = match[1];
      const dateMatch = block.match(/(\d{4}[-/]\d{2}[-/]\d{2}[\s\d:]*)/);
      const descMatch = block.match(/<[^>]*class="[^"]*desc[^"]*"[^>]*>(.*?)<\/[^>]*>/i);
      if (dateMatch || descMatch) {
        events.push({
          date: dateMatch?.[1]?.trim() ?? "",
          description: descMatch?.[1]?.replace(/<[^>]*>/g, "").trim() ?? block.replace(/<[^>]*>/g, "").trim(),
        });
      }
    }

    // Try to extract the overall status
    let status: TrackingDeliveryStatus = "unknown";
    const statusMatch = html.match(
      /<[^>]*class="[^"]*(?:status|state|result)[^"]*"[^>]*>([^<]+)<\/[^>]*>/i
    );
    if (statusMatch) {
      status = parseDeliveryStatus(statusMatch[1]);
    } else if (events.length > 0) {
      // Infer from the latest event
      status = parseDeliveryStatus(events[0].description);
    }

    // Also try the meta/title-based status detection
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (status === "unknown" && titleMatch) {
      const title = titleMatch[1].toLowerCase();
      if (title.includes("delivered")) status = "delivered";
      else if (title.includes("transit")) status = "in_transit";
      else if (title.includes("return")) status = "returned";
    }

    return { trackingNumber, status, events };
  }
}
