import { getSetting, SETTING_KEYS } from "./settings";

/** Warn this far ahead of the token's expiry (~1 day, as requested). */
export const COD_TOKEN_WARN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CodTokenStatus {
  /** True when a static API token is configured (vs email/password auth). */
  hasStaticToken: boolean;
  /** Token expiry as an ISO string, or null when it can't be determined. */
  expiresAt: string | null;
  /** Milliseconds until expiry (negative when already expired), or null. */
  expiresInMs: number | null;
  /** True when the token's `exp` is in the past. */
  expired: boolean;
  /** True when the token expires within the warning window (but not yet expired). */
  expiringSoon: boolean;
}

/**
 * Decode the `exp` (seconds since epoch) claim from a JWT without verifying
 * its signature. Returns null when the value isn't a well-formed JWT or has
 * no numeric `exp` — e.g. an opaque (non-JWT) API token.
 */
export function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(payload, "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      return null;
    }
    return claims.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Report the COD Network API token's expiry state so the dashboard can warn
 * the operator ~1 day before it lapses. Only meaningful for the static-token
 * flow: with email/password auth the app mints short-lived access tokens and
 * refreshes them automatically, so there is nothing for the user to replace.
 */
export async function getCodTokenStatus(): Promise<CodTokenStatus> {
  const token = (await getSetting(SETTING_KEYS.COD_API_TOKEN))?.trim();
  const base: CodTokenStatus = {
    hasStaticToken: !!token,
    expiresAt: null,
    expiresInMs: null,
    expired: false,
    expiringSoon: false,
  };
  if (!token) return base;

  const expiresAtMs = decodeJwtExpiryMs(token);
  if (expiresAtMs === null) return base;

  const expiresInMs = expiresAtMs - Date.now();
  return {
    hasStaticToken: true,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInMs,
    expired: expiresInMs <= 0,
    expiringSoon: expiresInMs > 0 && expiresInMs <= COD_TOKEN_WARN_WINDOW_MS,
  };
}
