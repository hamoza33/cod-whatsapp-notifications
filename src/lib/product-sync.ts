import { prisma } from "./prisma";
import { CodNetworkClient, type CodNetworkProduct } from "./cod-network";
import type { Prisma } from "@prisma/client";

/**
 * Pull the full product catalog from COD Network and upsert into the
 * `products` table. Returns counts so the caller (cron + manual sync UI) can
 * surface "imported N new / updated M" without re-querying.
 *
 * Idempotent: identifies products by `codNetworkProductId`, so re-running
 * just refreshes prices/names/images. Products that disappear from COD are
 * left in our cache untouched (we never delete here — operators may still
 * be referencing them in automation rules).
 */
export async function syncProductsFromCodNetwork(): Promise<{
  fetched: number;
  created: number;
  updated: number;
  errors: number;
}> {
  const client = await CodNetworkClient.fromSettings();

  // Fetch "My Products" (seller products)
  let myProducts: CodNetworkProduct[] = [];
  try {
    myProducts = await client.getAllProducts();
  } catch (err) {
    console.error("[product-sync] Failed to fetch My Products:", err);
  }

  // Fetch "COD Drop Products" (drop-shipping products)
  let dropProducts: CodNetworkProduct[] = [];
  try {
    dropProducts = await client.getAllDropProducts();
  } catch (err) {
    // Drop products endpoint may not exist for all accounts
    console.warn("[product-sync] Drop products endpoint not available:", err instanceof Error ? err.message : err);
  }

  const allProducts = [...myProducts, ...dropProducts];

  let created = 0;
  let updated = 0;
  let errors = 0;
  for (const p of allProducts) {
    try {
      const result = await upsertProduct(p);
      if (result === "created") created++;
      else if (result === "updated") updated++;
    } catch (err) {
      errors++;
      console.error("[product-sync] Failed to upsert product:", p.id, err);
    }
  }

  return { fetched: allProducts.length, created, updated, errors };
}

async function upsertProduct(
  p: CodNetworkProduct
): Promise<"created" | "updated" | "skipped"> {
  const codId = String(p.id ?? "").trim();
  if (!codId) return "skipped";

  // Try multiple name fields — COD Drop Products may use different keys
  const name = (p.name ?? p.name_arabic ?? (p as Record<string, unknown>).title as string ?? "").trim();
  if (!name) return "skipped";

  const data = {
    sku: p.sku ?? null,
    name,
    nameArabic: p.name_arabic ?? null,
    imageUrl: p.image_url ?? p.path_image ?? null,
    price: p.price !== undefined && p.price !== null ? String(p.price) : null,
    currency: p.currency ?? null,
    productType: extractLabel(p.type),
    productStatus: extractLabel(p.status),
    storeUrl: p.url ?? null,
    rawProductJson: p as unknown as Prisma.InputJsonValue,
    lastSyncedAt: new Date(),
  };

  const existing = await prisma.product.findUnique({
    where: { codNetworkProductId: codId },
    select: { id: true },
  });

  if (existing) {
    await prisma.product.update({
      where: { codNetworkProductId: codId },
      data,
    });
    return "updated";
  }
  await prisma.product.create({
    data: {
      codNetworkProductId: codId,
      ...data,
    },
  });
  return "created";
}

function extractLabel(
  v: { label?: string; code?: number } | string | null | undefined
): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.label ?? (typeof v.code === "number" ? String(v.code) : null);
}
