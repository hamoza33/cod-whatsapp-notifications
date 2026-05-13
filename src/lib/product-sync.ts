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
}> {
  const client = await CodNetworkClient.fromSettings();

  let created = 0;
  let updated = 0;

  const sellerProducts = await client.getAllProducts();
  for (const p of sellerProducts) {
    const result = await upsertProduct(p, false);
    if (result === "created") created++;
    else if (result === "updated") updated++;
  }

  let dropProducts: typeof sellerProducts = [];
  try {
    dropProducts = await client.getAllDropProducts();
    for (const p of dropProducts) {
      const result = await upsertProduct(p, true);
      if (result === "created") created++;
      else if (result === "updated") updated++;
    }
  } catch {
    // drop-products endpoint may not be available for all accounts
  }

  const fetched = sellerProducts.length + dropProducts.length;
  return { fetched, created, updated };
}

async function upsertProduct(
  p: CodNetworkProduct,
  forceDropProduct?: boolean
): Promise<"created" | "updated" | "skipped"> {
  const codId = String(p.id ?? "").trim();
  if (!codId) return "skipped";

  const name = (p.name ?? "").trim();
  if (!name) return "skipped";

  const productType = extractLabel(p.type);
  const isDropProduct = forceDropProduct ?? detectDropProduct(p, productType);

  const data = {
    sku: p.sku ?? null,
    name,
    nameArabic: p.name_arabic ?? null,
    imageUrl: p.image_url ?? p.path_image ?? null,
    description: typeof p.description === "string" ? p.description : null,
    price: p.price !== undefined && p.price !== null ? String(p.price) : null,
    currency: p.currency ?? null,
    productType,
    productStatus: extractLabel(p.status),
    isDropProduct,
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

function detectDropProduct(
  p: CodNetworkProduct,
  productType: string | null
): boolean {
  // Heuristic: COD Drop products often have "drop" in type, source, or
  // specific flags from the raw payload. Adjust if COD provides a clear flag.
  const raw = p as Record<string, unknown>;
  if (typeof raw.is_drop === "boolean") return raw.is_drop;
  if (typeof raw.source === "string" && raw.source.toLowerCase().includes("drop"))
    return true;
  if (productType?.toLowerCase().includes("drop")) return true;
  return false;
}

function extractLabel(
  v: { label?: string; code?: number } | string | null | undefined
): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.label ?? (typeof v.code === "number" ? String(v.code) : null);
}
