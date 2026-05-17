/**
 * Captcha solver client.
 *
 * Currently supports 2Captcha (https://2captcha.com). Anti-Captcha and other
 * providers can be added by extending the `provider` switch below.
 *
 * 2Captcha flow (per https://2captcha.com/2captcha-api):
 *
 *   1. Submit the challenge:
 *        POST https://2captcha.com/in.php
 *        form fields:
 *          - method=base64       + body=<base64>             (image captcha)
 *          - method=userrecaptcha + googlekey=<sitekey> + pageurl=<url>  (reCAPTCHA v2/v3)
 *          - method=hcaptcha     + sitekey=<sitekey>  + pageurl=<url>    (hCaptcha)
 *          - method=turnstile    + sitekey=<sitekey>  + pageurl=<url>    (Cloudflare Turnstile)
 *        plus key=<apiKey> + json=1
 *      Returns `{ status: 1, request: <captchaId> }` on success.
 *
 *   2. Poll for the solution every 5 seconds, up to the timeout:
 *        GET https://2captcha.com/res.php?key=<apiKey>&action=get&id=<captchaId>&json=1
 *      Returns:
 *        - `{ status: 1, request: <solution> }` when ready
 *        - `{ status: 0, request: 'CAPCHA_NOT_READY' }` while solving
 *        - `{ status: 0, request: <ERROR_CODE> }` on permanent failure
 *
 * Permanent failure codes we treat as fatal: ERROR_KEY_DOES_NOT_EXIST,
 * ERROR_ZERO_BALANCE, ERROR_NO_SLOT_AVAILABLE, etc. Any non
 * `CAPCHA_NOT_READY` error from `res.php` short-circuits the poll loop and
 * is rethrown so the caller can record the failure clearly in logs.
 */

export type CaptchaChallengeType =
  | "image"
  | "recaptcha"
  | "hcaptcha"
  | "turnstile";

export interface CaptchaChallenge {
  type: CaptchaChallengeType;
  /**
   * For `image`, this is the base64 of the image. For
   * recaptcha/hcaptcha/turnstile, this is the data-sitekey. (We accept the
   * generic `data` field instead of two separate fields to keep the
   * function signature small.)
   */
  data: string;
  siteUrl?: string;
  sitekey?: string;
}

export interface SolveCaptchaOpts {
  provider: string;
  apiKey: string;
  challenge: CaptchaChallenge;
}

const TWOCAPTCHA_IN_URL = "https://2captcha.com/in.php";
const TWOCAPTCHA_RES_URL = "https://2captcha.com/res.php";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

export async function solveCaptcha(opts: SolveCaptchaOpts): Promise<string> {
  if (opts.provider !== "2captcha") {
    throw new Error(`Unsupported captcha provider: ${opts.provider}`);
  }
  if (!opts.apiKey) {
    throw new Error("Captcha API key is required");
  }

  const captchaId = await submit2Captcha(opts.apiKey, opts.challenge);
  return await poll2Captcha(opts.apiKey, captchaId);
}

async function submit2Captcha(
  apiKey: string,
  challenge: CaptchaChallenge
): Promise<string> {
  const params = new URLSearchParams();
  params.set("key", apiKey);
  params.set("json", "1");

  switch (challenge.type) {
    case "image":
      params.set("method", "base64");
      params.set("body", challenge.data);
      break;
    case "recaptcha": {
      const sitekey = challenge.sitekey ?? challenge.data;
      if (!sitekey || !challenge.siteUrl) {
        throw new Error("reCAPTCHA requires sitekey and siteUrl");
      }
      params.set("method", "userrecaptcha");
      params.set("googlekey", sitekey);
      params.set("pageurl", challenge.siteUrl);
      break;
    }
    case "hcaptcha": {
      const sitekey = challenge.sitekey ?? challenge.data;
      if (!sitekey || !challenge.siteUrl) {
        throw new Error("hCaptcha requires sitekey and siteUrl");
      }
      params.set("method", "hcaptcha");
      params.set("sitekey", sitekey);
      params.set("pageurl", challenge.siteUrl);
      break;
    }
    case "turnstile": {
      const sitekey = challenge.sitekey ?? challenge.data;
      if (!sitekey || !challenge.siteUrl) {
        throw new Error("Turnstile requires sitekey and siteUrl");
      }
      params.set("method", "turnstile");
      params.set("sitekey", sitekey);
      params.set("pageurl", challenge.siteUrl);
      break;
    }
    default: {
      const _exhaustive: never = challenge.type;
      throw new Error(`Unknown captcha challenge type: ${_exhaustive}`);
    }
  }

  const resp = await fetch(TWOCAPTCHA_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = (await resp.json().catch(() => null)) as
    | { status?: number; request?: string }
    | null;
  if (!data || data.status !== 1 || !data.request) {
    throw new Error(
      `2Captcha submit failed: ${data?.request ?? "unknown_error"}`
    );
  }
  return data.request;
}

async function poll2Captcha(
  apiKey: string,
  captchaId: string
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const url = `${TWOCAPTCHA_RES_URL}?key=${encodeURIComponent(
      apiKey
    )}&action=get&id=${encodeURIComponent(captchaId)}&json=1`;
    const resp = await fetch(url);
    const data = (await resp.json().catch(() => null)) as
      | { status?: number; request?: string }
      | null;
    if (!data) continue;
    if (data.status === 1 && data.request) {
      return data.request;
    }
    // status 0 with CAPCHA_NOT_READY -> keep polling. Any other error is
    // permanent (bad key, zero balance, etc.) and should fail fast.
    if (data.status === 0 && data.request && data.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha permanent error: ${data.request}`);
    }
  }
  throw new Error("2Captcha solve timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
