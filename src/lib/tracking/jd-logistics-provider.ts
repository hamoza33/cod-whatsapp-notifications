/**
 * Tracking provider for JD Logistics (JDW).
 *
 * Uses the JD Logistics official tracking page. If a captcha is encountered
 * and no captcha API key is configured, the batch is marked as captcha_blocked
 * and processing continues with other carriers.
 */

import type { TrackingProvider, TrackingResult, TrackingDeliveryStatus } from "./types";

const JD_TRACKING_URL = "https://www.jdl.com/orderTracking";

function parseJdStatus(rawStatus: string): TrackingDeliveryStatus {
  const s = rawStatus.toLowerCase().trim();
  if (s.includes("signed") || s.includes("delivered") || s.includes("completed") || s.includes("签收")) return "delivered";
  if (s.includes("return") || s.includes("退")) return "returned";
  if (s.includes("out for delivery") || s.includes("派送") || s.includes("配送中")) return "out_for_delivery";
  if (s.includes("transit") || s.includes("运输") || s.includes("在途")) return "in_transit";
  if (s.includes("fail") || s.includes("异常")) return "failed";
  return "unknown";
}

export class JdLogisticsProvider implements TrackingProvider {
  name = "JD Logistics";
  private captchaApiKey: string | null;

  constructor(captchaApiKey: string | null = null) {
    this.captchaApiKey = captchaApiKey;
  }

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
      // Try the JD Logistics API endpoint first
      const response = await fetch(
        `https://www.jdl.com/api/tracking/query?waybillCode=${encodeURIComponent(trackingNumber)}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Referer": JD_TRACKING_URL,
          },
          signal: AbortSignal.timeout(30_000),
        }
      );

      if (!response.ok) {
        // Check if it's a captcha challenge
        const text = await response.text();
        if (text.includes("captcha") || text.includes("verify") || response.status === 403) {
          if (!this.captchaApiKey) {
            return {
              trackingNumber,
              status: "captcha_blocked",
              events: [],
              error: "Captcha required but no captcha API key configured",
            };
          }
          // With captcha key, we'd solve it here — for now mark as blocked
          return {
            trackingNumber,
            status: "captcha_blocked",
            events: [],
            error: "Captcha solving not yet implemented",
          };
        }

        return {
          trackingNumber,
          status: "unknown",
          events: [],
          error: `HTTP ${response.status} from JD Logistics`,
        };
      }

      const data = await response.json() as {
        code?: number;
        data?: {
          waybillStatus?: string;
          trackEvents?: Array<{
            time?: string;
            desc?: string;
            location?: string;
          }>;
        };
        message?: string;
      };

      if (data.code !== 0 && data.code !== 200) {
        // Check for captcha
        if (data.message?.includes("captcha") || data.message?.includes("verify")) {
          return {
            trackingNumber,
            status: "captcha_blocked",
            events: [],
            error: this.captchaApiKey
              ? "Captcha solving not yet implemented"
              : "Captcha required but no captcha API key configured",
          };
        }

        return {
          trackingNumber,
          status: "unknown",
          events: [],
          error: data.message ?? `JD API error code ${data.code}`,
        };
      }

      const events = (data.data?.trackEvents ?? []).map((e) => ({
        date: e.time ?? "",
        description: e.desc ?? "",
        location: e.location,
      }));

      const status = data.data?.waybillStatus
        ? parseJdStatus(data.data.waybillStatus)
        : events.length > 0
          ? parseJdStatus(events[0].description)
          : "unknown";

      return { trackingNumber, status, events };
    } catch (err) {
      return {
        trackingNumber,
        status: "unknown",
        events: [],
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }
}
