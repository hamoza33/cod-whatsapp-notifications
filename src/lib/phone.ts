/**
 * Normalize a phone number to international format (E.164-like).
 * Removes spaces, dashes, parentheses, and leading zeros.
 * Prepends country code if missing (defaults to +212 for Morocco).
 */
export function normalizePhoneNumber(
  phone: string,
  defaultCountryCode = "212"
): string {
  let cleaned = phone.replace(/[\s\-\(\)\+\.]/g, "");

  if (cleaned.startsWith("00")) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith("0")) {
    cleaned = defaultCountryCode + cleaned.slice(1);
  }

  if (!cleaned.match(/^\d{10,15}$/)) {
    throw new Error(`Invalid phone number: ${phone}`);
  }

  return cleaned;
}

export function isValidPhoneNumber(phone: string): boolean {
  try {
    normalizePhoneNumber(phone);
    return true;
  } catch {
    return false;
  }
}

export function formatPhoneForDisplay(phone: string): string {
  if (phone.length >= 10) {
    return `+${phone}`;
  }
  return phone;
}
