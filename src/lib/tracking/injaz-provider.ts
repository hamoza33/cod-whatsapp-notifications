/**
 * Tracking provider for Injaz Express.
 *
 * Uses the official Injaz website to track shipments one-by-one.
 * Concurrency is intentionally limited (3–5 parallel sessions).
 */

import type { TrackingProvider, TrackingResult, TrackingDeliveryStatus } from "./types";

const INJAZ_TRACKING_URL = "https://injaz-express.com/tracking";

function parseInjazStatus(rawStatus: string): TrackingDeliveryStatus {
  const s = rawStatus.toLowerCase().trim();
  if (s.includes("delivered") || s.includes("تم التسليم") || s.includes("livré")) return "delivered";
  if (s.includes("return") || s.includes("retour") || s.includes("مرتجع")) return "returned";
  if (s.includes("out for delivery") || s.includes("en cours de livraison") || s.includes("قيد التوصيل")) return "out_for_delivery";
  if (s.includes("transit") || s.includes("en transit") || s.includes("في الطريق") || s.includes("shipping")) return "in_transit";
  if (s.includes("fail") || s.includes("échec") || s.includes("فشل")) return "failed";
  return "unknown";
}

export class InjazProvider implements TrackingProvider {
  name = "Injaz Express";

  async trackBatch(trackingNumbers: string[]): Promise<TrackingResult[]> {
    // Injaz tracks one-by-one; use allSettled so one failure doesn't block others
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
      // Try the Injaz API endpoint
      const response = await fetch(
        `https://injaz-express.com/api/tracking/${encodeURIComponent(trackingNumber)}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/html, */*",
            "Referer": INJAZ_TRACKING_URL,
          },
          signal: AbortSignal.timeout(30_000),
        }
      );

      if (!response.ok) {
        // Fallback: try the HTML tracking page
        return this.trackViaHtml(trackingNumber);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = await response.json() as {
          status?: string;
          tracking_status?: string;
          events?: Array<{
            date?: string;
            description?: string;
            location?: string;
          }>;
        };

        const events = (data.events ?? []).map((e) => ({
          date: e.date ?? "",
          description: e.description ?? "",
          location: e.location,
        }));

        const rawStatus = data.tracking_status ?? data.status ?? "";
        const status = parseInjazStatus(rawStatus);

        return { trackingNumber, status, events };
      }

      // If HTML response, parse it
      const html = await response.text();
      return this.parseTrackingHtml(trackingNumber, html);
    } catch (err) {
      return {
        trackingNumber,
        status: "unknown",
        events: [],
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  private async trackViaHtml(trackingNumber: string): Promise<TrackingResult> {
    try {
      const response = await fetch(
        `${INJAZ_TRACKING_URL}?tracking=${encodeURIComponent(trackingNumber)}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(30_000),
        }
      );

      if (!response.ok) {
        return {
          trackingNumber,
          status: "unknown",
          events: [],
          error: `HTTP ${response.status} from Injaz`,
        };
      }

      const html = await response.text();
      return this.parseTrackingHtml(trackingNumber, html);
    } catch (err) {
      return {
        trackingNumber,
        status: "unknown",
        events: [],
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  private parseTrackingHtml(trackingNumber: string, html: string): TrackingResult {
    const events: { date: string; description: string; location?: string }[] = [];

    // Try to extract status from common patterns
    const statusPatterns = [
      /<[^>]*class="[^"]*(?:status|state|tracking-status)[^"]*"[^>]*>([^<]+)<\/[^>]*>/i,
      /<span[^>]*>(?:Status|Statut|الحالة)\s*:?\s*<\/span>\s*<[^>]*>([^<]+)<\/[^>]*>/i,
    ];

    let status: TrackingDeliveryStatus = "unknown";
    for (const pattern of statusPatterns) {
      const match = html.match(pattern);
      if (match) {
        status = parseInjazStatus(match[1]);
        break;
      }
    }

    // Extract events from timeline-style markup
    const eventRegex = /<(?:tr|li|div)[^>]*class="[^"]*(?:event|step|timeline)[^"]*"[^>]*>([\s\S]*?)<\/(?:tr|li|div)>/gi;
    let match: RegExpExecArray | null;
    while ((match = eventRegex.exec(html)) !== null) {
      const block = match[1];
      const dateMatch = block.match(/(\d{4}[-/]\d{2}[-/]\d{2}[\s\d:]*|\d{2}[-/]\d{2}[-/]\d{4}[\s\d:]*)/);
      const text = block.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        events.push({
          date: dateMatch?.[1]?.trim() ?? "",
          description: text,
        });
      }
    }

    if (status === "unknown" && events.length > 0) {
      status = parseInjazStatus(events[0].description);
    }

    return { trackingNumber, status, events };
  }
}
