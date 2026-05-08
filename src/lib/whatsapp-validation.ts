/**
 * Pure (browser-safe) helpers for WhatsApp Cloud API value validation.
 * Kept in a separate module so client components can import them without
 * pulling in the full WhatsApp client (which depends on Prisma / pg).
 */

/**
 * The visible Meta phone number (e.g. `+966 57 253 4141`) is NOT the same as
 * the Meta-issued Phone Number ID — the Phone Number ID is a separate 15–16
 * digit identifier exposed in WhatsApp Manager → API Setup. This helper
 * detects values that look like a phone number so the UI can warn the user
 * before they hit Meta's confusing "(#100) Could not find phone number" error.
 */
export function looksLikePhoneNumber(value: string): boolean {
  if (!value) return false;
  const stripped = value.replace(/[\s\-+()]/g, "");
  if (/^[+0]/.test(value.trim())) return true;
  if (/[\s\-()]/.test(value)) return true;
  if (!/^\d+$/.test(stripped)) return false;
  if (stripped.length < 8 || stripped.length > 12) return false;
  return true;
}
