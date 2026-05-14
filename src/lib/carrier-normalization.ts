/**
 * Carrier normalization layer.
 *
 * Maps the free-text `deliveryCompany` field from COD Network into a
 * canonical carrier code used for routing to the correct tracking provider.
 *
 * Canonical codes:
 *   JTE   – J&T Express       → tracked via 4tracking.net
 *   IMILE – iMile              → tracked via 4tracking.net
 *   JDW   – JD Logistics       → tracked via JD Logistics official site
 *   INJAZ – Injaz Express      → tracked via Injaz official website
 */

export type CarrierCode = "JTE" | "JDW" | "INJAZ" | "IMILE";

interface NormalizationResult {
  carrier: CarrierCode | null;
  reason: string | null;
}

const CARRIER_ALIASES: Array<{ patterns: RegExp[]; code: CarrierCode }> = [
  {
    code: "JTE",
    patterns: [
      /^jte$/i,
      /^j\s*&\s*t/i,
      /^jt\s*express/i,
      /^jnt$/i,
      /^j\s*n\s*t/i,
      /j&t\s*express/i,
      /j\s*and\s*t/i,
    ],
  },
  {
    code: "JDW",
    patterns: [
      /^jdw$/i,
      /^jd$/i,
      /^jd\s*logistics/i,
      /^jingdong/i,
      /^京东物流$/,
      /^京东/,
      /jd\s*log/i,
      /jingdong\s*logistics/i,
    ],
  },
  {
    code: "INJAZ",
    patterns: [
      /^injaz$/i,
      /^injaz[\s-]*express/i,
      /^injaz[\s-]*delivery/i,
    ],
  },
  {
    code: "IMILE",
    patterns: [
      /^imile$/i,
      /^i\s*mile/i,
      /^imile\s*delivery/i,
    ],
  },
];

export function normalizeCarrier(
  deliveryCompany: string | null | undefined,
  trackingNumber: string | null | undefined
): NormalizationResult {
  const raw = (deliveryCompany ?? "").trim();

  if (!raw && !trackingNumber) {
    return { carrier: null, reason: "no delivery company or tracking number" };
  }

  // 1. Try matching by carrier name
  if (raw) {
    for (const entry of CARRIER_ALIASES) {
      for (const pattern of entry.patterns) {
        if (pattern.test(raw)) {
          return { carrier: entry.code, reason: null };
        }
      }
    }
  }

  // 2. Try matching by tracking number pattern
  if (trackingNumber) {
    const tn = trackingNumber.trim();
    const inferred = inferCarrierFromTrackingNumber(tn);
    if (inferred) {
      return {
        carrier: inferred,
        reason: null,
      };
    }
  }

  return {
    carrier: null,
    reason: `unrecognized carrier name "${raw}" and tracking number pattern did not match any known carrier`,
  };
}

function inferCarrierFromTrackingNumber(tn: string): CarrierCode | null {
  // J&T Express tracking numbers typically start with J or JT
  if (/^J[A-Z]?\d/i.test(tn)) return "JTE";
  // JD Logistics: starts with JD or JDKW
  if (/^JD/i.test(tn)) return "JDW";
  // iMile: starts with IM
  if (/^IM/i.test(tn)) return "IMILE";
  // Injaz: various patterns; match common ones
  if (/^INJ/i.test(tn)) return "INJAZ";
  return null;
}

export function getAllCarrierCodes(): CarrierCode[] {
  return ["JTE", "IMILE", "JDW", "INJAZ"];
}

export const CARRIER_DISPLAY_NAMES: Record<CarrierCode, string> = {
  JTE: "J&T Express",
  IMILE: "iMile",
  JDW: "JD Logistics",
  INJAZ: "Injaz Express",
};
