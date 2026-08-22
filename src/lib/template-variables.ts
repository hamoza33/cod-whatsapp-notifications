/**
 * Helpers for WhatsApp template body variables (`{{1}}`, `{{2}}`, …).
 *
 * Meta rejects a template send when a body parameter is present but blank
 * (error `#131008 Parameter of type text is missing text value`), so an
 * automation whose variable slots were left empty fails at send time. These
 * helpers let both the builder UI and the automation engine fill blank slots
 * with the data point the template body itself is asking for.
 */

const NAME_TOKEN = "{{order.customerName}}";
const TRACKING_TOKEN = "{{order.trackingNumber}}";
const ORDER_ID_TOKEN = "{{order.codNetworkOrderId}}";
const PRODUCT_TOKEN = "{{order.productName}}";
const AMOUNT_TOKEN = "{{order.productPrice}}";
const CITY_TOKEN = "{{order.customerCity}}";

/** Highest `{{n}}` index used in a template body — i.e. how many params Meta expects. */
export function countTemplateVariables(bodyText: string): number {
  if (!bodyText) return 0;
  const matches = bodyText.match(/{{\s*\d+\s*}}/g);
  if (!matches) return 0;
  const nums = matches.map((m) => parseInt(m.replace(/[{}]/g, "").trim(), 10));
  return Math.max(...nums);
}

/**
 * Guess the data point each `{{n}}` slot wants, from the wording around it.
 * Recognises Arabic and English cues (e.g. "رقم التتبع: {{2}}" → tracking
 * number). Slots with no recognisable cue fall back to the customer name for
 * the first slot and an empty string elsewhere.
 */
export function inferTemplateVariableDefaults(
  bodyText: string,
  count: number
): string[] {
  const total = count > 0 ? count : countTemplateVariables(bodyText);
  const defaults: string[] = [];
  for (let i = 1; i <= total; i++) {
    defaults.push(inferSlot(bodyText, i));
  }
  return defaults;
}

function inferSlot(bodyText: string, index: number): string {
  const placeholder = new RegExp(`{{\\s*${index}\\s*}}`);
  const match = placeholder.exec(bodyText ?? "");
  const before = match
    ? (bodyText ?? "").slice(Math.max(0, match.index - 60), match.index).toLowerCase()
    : "";

  const has = (...needles: string[]) => needles.some((n) => before.includes(n));

  if (has("tracking", "waybill", "shipment number", "تتبع", "التتبع", "الشحنة")) {
    return TRACKING_TOKEN;
  }
  if (has("order number", "order id", "order #", "رقم الطلب", "رقم طلبك")) {
    return ORDER_ID_TOKEN;
  }
  if (has("product", "item", "المنتج", "منتج")) return PRODUCT_TOKEN;
  if (has("total", "amount", "price", "المبلغ", "السعر", "الإجمالي")) {
    return AMOUNT_TOKEN;
  }
  if (has("city", "المدينة", "مدينة")) return CITY_TOKEN;
  if (
    has(
      "hello",
      "hi ",
      "dear",
      "name",
      "السلام عليكم",
      "مرحبا",
      "مرحباً",
      "هلا",
      "عزيزي",
      "الاسم"
    )
  ) {
    return NAME_TOKEN;
  }
  // A leading slot is almost always the customer's name in practice.
  return index === 1 ? NAME_TOKEN : "";
}

/**
 * Build the final body parameter list for a send: each configured slot wins,
 * blank slots fall back to the inferred data point. Returns the raw token
 * strings — the caller still renders `{{token}}` against its own context.
 */
export function resolveTemplateVariableSlots(
  configured: string[],
  bodyText: string
): string[] {
  const expected = countTemplateVariables(bodyText);
  const total = Math.max(expected, configured.length);
  if (total === 0) return [];
  const inferred = inferTemplateVariableDefaults(bodyText, total);
  return Array.from({ length: total }, (_, i) => {
    const slot = (configured[i] ?? "").trim();
    return slot || inferred[i] || "";
  });
}
