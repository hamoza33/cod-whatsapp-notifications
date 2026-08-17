/**
 * Product-catalog matching for orders and leads.
 *
 * COD Network stores an order's products as a single comma-joined string
 * ("Hearing aid Kuwait-Right, Portable hair straightener, …"), while leads use
 * "Name/SKU" strings and `original_payload.sku_N` / `product_name_N`. An exact
 * `product.name === order.productName` lookup therefore misses most rows, so
 * every catalog lookup goes through these helpers instead.
 */

export interface ProductKeys {
  names: string[];
  skus: string[];
}

/**
 * Collect every candidate product name and SKU referenced by an order/lead.
 * Handles:
 *  - multi-product names comma-joined ("Hearing aid D, Fast car charger")
 *  - lead "Name/SKU" strings ("Energy Coffee Drink for Men/MP-X1TGXPHPN3QZ")
 *  - lead `original_payload.sku_1…` / `product_name_1…`
 *  - order item SKUs (items.data[].product.data.sku)
 */
export function collectProductKeys(
  productName: string | null,
  rawOrderJson: unknown
): ProductKeys {
  const names = new Set<string>();
  const skus = new Set<string>();

  const addSegment = (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    // "Name/SKU" → the last "/"-part is the SKU, the rest is the name.
    const slash = trimmed.lastIndexOf("/");
    if (slash > 0 && slash < trimmed.length - 1) {
      const namePart = trimmed.slice(0, slash).trim();
      const skuPart = trimmed.slice(slash + 1).trim();
      if (namePart) names.add(namePart);
      if (skuPart) skus.add(skuPart);
    } else {
      names.add(trimmed);
    }
  };

  if (productName) {
    for (const part of productName.split(",")) addSegment(part);
  }

  if (rawOrderJson && typeof rawOrderJson === "object") {
    const raw = rawOrderJson as Record<string, unknown>;
    if (typeof raw.products === "string") {
      for (const part of raw.products.split(",")) addSegment(part);
    }

    // Lead payload: original_payload is a JSON string with sku_N / product_name_N.
    const original =
      typeof raw.original_payload === "string"
        ? safeParseObject(raw.original_payload)
        : raw.original_payload && typeof raw.original_payload === "object"
          ? (raw.original_payload as Record<string, unknown>)
          : null;
    if (original) {
      for (let i = 1; i <= 10; i++) {
        const sku = original[`sku_${i}`];
        const name = original[`product_name_${i}`];
        if (typeof sku === "string" && sku.trim()) skus.add(sku.trim());
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      }
    }

    // Order payload: items.data[].product.data.sku
    const items = raw.items;
    const itemList = Array.isArray(items)
      ? items
      : items && typeof items === "object" && "data" in items
        ? (items as { data?: unknown[] }).data ?? []
        : [];
    for (const item of itemList) {
      if (item && typeof item === "object") {
        const product = (item as Record<string, unknown>).product;
        const data =
          product && typeof product === "object"
            ? (product as Record<string, unknown>).data
            : null;
        const sku =
          data && typeof data === "object"
            ? (data as Record<string, unknown>).sku
            : null;
        if (typeof sku === "string" && sku.trim()) skus.add(sku.trim());
      }
    }
  }

  return { names: [...names], skus: [...skus] };
}

export function normalizeProductKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CatalogProduct {
  name: string;
  nameArabic?: string | null;
  sku?: string | null;
}

/**
 * Pick the catalog entries an order refers to. Matches on SKU first (most
 * reliable), then on exact normalized name, then on a normalized-substring
 * check against the raw product string so a multi-product order like
 * "Hearing aid Kuwait-Right, Portable hair straightener" still resolves.
 */
export function matchCatalogProducts<T extends CatalogProduct>(
  candidates: T[],
  productName: string | null,
  rawOrderJson: unknown
): T[] {
  const { names, skus } = collectProductKeys(productName, rawOrderJson);
  const nameSet = new Set(names.map(normalizeProductKey));
  const skuSet = new Set(skus.map(normalizeProductKey));
  const haystack = normalizeProductKey(productName ?? "");

  return candidates.filter((product) => {
    if (product.sku && skuSet.has(normalizeProductKey(product.sku))) return true;
    const productNames = [product.name, product.nameArabic].filter(
      (n): n is string => Boolean(n && n.trim())
    );
    for (const n of productNames) {
      const key = normalizeProductKey(n);
      if (nameSet.has(key)) return true;
      if (key.length >= 4 && haystack.includes(key)) return true;
    }
    return false;
  });
}

function safeParseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
