import type { ParsedEvent, ProviderResult } from "./types";
import { solveCaptcha } from "@/lib/captcha";

/**
 * JD Logistics bulk tracking via the consumer Nuxt SPA's JSON backend.
 *
 * REQUEST SHAPE
 *   POST https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1
 *   Content-Type: application/json
 *   Required headers (from the public Nuxt SPA):
 *     Origin:     https://www.jingdonglogistics.com
 *     Referer:    https://www.jingdonglogistics.com/Tracking
 *     LOP-DN:     pro-intl-cms-interface.jdl.com
 *     ClientInfo: {"appName":"intl_cms","client":"m"}
 *     AppParams:  {"appid":"intl-cms-interface-web","ticket_type":"pc"}
 *   Body (NOTE the array wrapper):
 *     [{
 *       "magicNoList":["JDW...", ...up to 10],
 *       "clientIp":"$cooMrdGatewayIp$",
 *       "lang":"en",
 *       "timeZone":"+03:00"
 *     }]
 *
 * RESPONSE SHAPE
 *   { code: 1, data: [
 *       { waybillNo: "...",
 *         wayBillTrackItemDtoList: [...],
 *         trackNodeList: [
 *            { msgContent, opeTitle, operateTime, operateNode, ... },
 *            ...
 *         ],
 *         ... }
 *   ]}
 *   Empty data (number not in their system) -> { code:1, data:[] } (200 OK).
 *
 * KNOWN FAILURE MODES
 *   1. Captcha challenge — the consumer site has a frontend rate-limiting
 *      flow that *can* surface as a captcha. We have NOT observed it in
 *      our probes; the captcha-retry path here is defensive. If the API
 *      ever returns a body with a `captcha` / `verify` / `geetest` field
 *      OR an HTTP 403/429, we treat it as a captcha challenge.
 *   2. Number not in their database. We surface
 *      `error: 'not_found_on_jdw'` for that single number; other numbers
 *      in the same batch may still resolve normally.
 *   3. Captcha required but no key configured. We surface
 *      `error: 'captcha_required'` for every number in the batch.
 *
 * PER-NUMBER ERROR CODES
 *   not_found_on_jdw   — JDW has no record of the number.
 *   captcha_required   — captcha challenge fired and we couldn't solve it.
 *   jdw_error:<code>   — JDW returned an unexpected `code` value.
 */

const JDW_URL =
  "https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1";
const JDW_MAX_PER_CALL = 10;

interface JdwTrackNode {
  msgContent?: string;
  opeTitle?: string;
  operateTime?: string;
  operateNode?: string;
  operateAddress?: string;
  city?: string;
}

interface JdwDataEntry {
  waybillNo?: string;
  trackNodeList?: JdwTrackNode[];
  wayBillTrackItemDtoList?: JdwTrackNode[];
  status?: string;
  statusName?: string;
}

interface JdwResponse {
  code?: number;
  msg?: string;
  data?: JdwDataEntry[];
  // Defensive: the API might include any of these on a captcha challenge.
  captcha?: unknown;
  verify?: unknown;
  geetest?: unknown;
}

export interface FetchJdwOpts {
  captchaApiKey?: string | null;
  captchaProvider?: string | null;
}

export async function fetchJdwBulk(
  numbers: string[],
  opts?: FetchJdwOpts
): Promise<Map<string, ProviderResult>> {
  if (numbers.length === 0) return new Map();
  if (numbers.length > JDW_MAX_PER_CALL) {
    throw new Error(
      `fetchJdwBulk: max ${JDW_MAX_PER_CALL} numbers per call, got ${numbers.length}`
    );
  }

  const out = new Map<string, ProviderResult>();
  for (const n of numbers) {
    out.set(n, { events: [], rawStatus: null, error: "not_found_on_jdw" });
  }

  let resp = await callJdw(numbers);

  // CAPTCHA RETRY FLOW
  // If the response indicates a captcha challenge AND we have a key, try
  // to solve it once and replay. If we don't have a key, surface a clear
  // captcha_required error per number — never crash.
  if (isCaptchaChallenge(resp.status, resp.body)) {
    const captchaKey = opts?.captchaApiKey?.trim();
    const captchaProvider = opts?.captchaProvider?.trim() || "2captcha";
    if (!captchaKey) {
      console.warn(
        "[jdw] captcha challenge detected but no captcha API key configured"
      );
      for (const n of numbers) {
        out.set(n, {
          events: [],
          rawStatus: null,
          error: "captcha_required",
        });
      }
      return out;
    }
    try {
      const challenge = inferCaptchaChallenge(resp.body);
      const token = await solveCaptcha({
        provider: captchaProvider,
        apiKey: captchaKey,
        challenge,
      });
      resp = await callJdw(numbers, token);
      if (isCaptchaChallenge(resp.status, resp.body)) {
        for (const n of numbers) {
          out.set(n, {
            events: [],
            rawStatus: null,
            error: "captcha_required",
          });
        }
        return out;
      }
    } catch (err) {
      console.warn(
        "[jdw] captcha solve failed",
        err instanceof Error ? err.message : err
      );
      for (const n of numbers) {
        out.set(n, {
          events: [],
          rawStatus: null,
          error: "captcha_required",
        });
      }
      return out;
    }
  }

  if (!resp.body || resp.body.code !== 1) {
    const code = resp.body?.code ?? "no_body";
    for (const n of numbers) {
      out.set(n, {
        events: [],
        rawStatus: null,
        error: `jdw_error:${code}`,
      });
    }
    return out;
  }

  // Index by upper-cased waybillNo so we can match case-insensitively.
  const byWaybill = new Map<string, JdwDataEntry>();
  for (const entry of resp.body.data ?? []) {
    if (entry.waybillNo) {
      byWaybill.set(entry.waybillNo.toUpperCase(), entry);
    }
  }

  for (const num of numbers) {
    const entry = byWaybill.get(num.toUpperCase());
    if (!entry) continue;
    const nodes = entry.trackNodeList ?? entry.wayBillTrackItemDtoList ?? [];
    if (nodes.length === 0) continue;
    const events: ParsedEvent[] = [];
    for (const node of nodes) {
      const description =
        node.msgContent?.trim() ||
        node.opeTitle?.trim() ||
        "Update";
      const occurredAtRaw = node.operateTime?.trim();
      if (!occurredAtRaw) continue;
      const occurredAt = parseJdwDate(occurredAtRaw);
      if (Number.isNaN(occurredAt.getTime())) continue;
      events.push({
        status: node.opeTitle?.trim() || "Update",
        description: description.slice(0, 500),
        location:
          node.operateAddress?.trim() ||
          node.operateNode?.trim() ||
          node.city?.trim() ||
          undefined,
        occurredAt,
        rawData: node,
      });
    }
    // Newest first for consistency with the other providers.
    events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    const rawStatus =
      entry.statusName?.trim() ||
      entry.status?.trim() ||
      events[0]?.status ||
      null;
    out.set(num, { events, rawStatus });
  }

  return out;
}

async function callJdw(
  numbers: string[],
  captchaToken?: string
): Promise<{ status: number; body: JdwResponse | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: "https://www.jingdonglogistics.com",
    Referer: "https://www.jingdonglogistics.com/Tracking",
    "LOP-DN": "pro-intl-cms-interface.jdl.com",
    ClientInfo: '{"appName":"intl_cms","client":"m"}',
    AppParams: '{"appid":"intl-cms-interface-web","ticket_type":"pc"}',
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  if (captchaToken) {
    headers["X-Captcha-Token"] = captchaToken;
  }
  const body = JSON.stringify([
    {
      magicNoList: numbers,
      clientIp: "$cooMrdGatewayIp$",
      lang: "en",
      timeZone: "+03:00",
      ...(captchaToken ? { captchaToken } : {}),
    },
  ]);
  try {
    const resp = await fetch(JDW_URL, { method: "POST", headers, body });
    const json = (await resp.json().catch(() => null)) as JdwResponse | null;
    return { status: resp.status, body: json };
  } catch (err) {
    console.warn(
      "[jdw] fetch failed",
      err instanceof Error ? err.message : err
    );
    return { status: 0, body: null };
  }
}

function isCaptchaChallenge(status: number, body: JdwResponse | null): boolean {
  if (status === 403 || status === 429) return true;
  if (!body) return false;
  const text = JSON.stringify(body).toLowerCase();
  return (
    body.captcha != null ||
    body.verify != null ||
    body.geetest != null ||
    text.includes("captcha") ||
    text.includes("geetest") ||
    text.includes("verify code")
  );
}

function inferCaptchaChallenge(
  body: JdwResponse | null
): {
  type: "image" | "recaptcha" | "hcaptcha" | "turnstile";
  data: string;
  siteUrl?: string;
  sitekey?: string;
} {
  // We don't have a confirmed captcha shape from JDW yet — default to a
  // turnstile-style challenge against the consumer tracking page so the
  // 2Captcha submit succeeds against the same site URL the JS uses. If a
  // future drift surfaces a different shape we'll handle it here.
  let sitekey = "";
  if (body && typeof body.captcha === "object" && body.captcha) {
    const cap = body.captcha as Record<string, unknown>;
    if (typeof cap.sitekey === "string") sitekey = cap.sitekey;
    if (typeof cap.siteKey === "string") sitekey = cap.siteKey as string;
  }
  return {
    type: "turnstile",
    data: sitekey,
    sitekey: sitekey || undefined,
    siteUrl: "https://www.jingdonglogistics.com/Tracking",
  };
}

function parseJdwDate(input: string): Date {
  // JDW commonly uses "YYYY-MM-DD HH:MM:SS"; pass through ISO-ish too.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(input)) {
    return new Date(input.replace(" ", "T") + "+08:00");
  }
  return new Date(input);
}
