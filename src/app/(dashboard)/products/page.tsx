"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { api } from "@/lib/api-client";
import { RefreshCw, Search, Tag, Package as PackageIcon } from "lucide-react";

interface Product {
  id: string;
  codNetworkProductId: string;
  sku: string | null;
  name: string;
  nameArabic: string | null;
  imageUrl: string | null;
  price: string | null;
  currency: string | null;
  productType: string | null;
  productStatus: string | null;
  storeUrl: string | null;
  lastSyncedAt: string;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params: Record<string, string> = { pageSize: "500" };
        if (search) params.search = search;
        const data = await api.get<{ products: Product[] }>("/products", params);
        if (!cancelled) setProducts(data.products);
      } catch (err) {
        if (!cancelled) {
          setNotification({
            type: "error",
            message: err instanceof Error ? err.message : "Failed to load products",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [search, refreshKey]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setNotification(null);
    try {
      const result = await api.post<{
        success: boolean;
        fetched: number;
        created: number;
        updated: number;
      }>("/products/sync");
      setNotification({
        type: "success",
        message: `Imported ${result.fetched} products from COD Network — ${result.created} new, ${result.updated} updated.`,
      });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Products</h1>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing…" : "Import from COD Network"}
        </button>
      </div>

      {notification && (
        <div
          className={`mb-4 p-3 rounded-md text-sm border ${
            notification.type === "success"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {notification.message}
        </div>
      )}

      {/* Search */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Search products by name or SKU…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setSearch(searchInput);
          }}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm w-80"
        />
        <button
          onClick={() => setSearch(searchInput)}
          className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
        >
          <Search size={16} />
        </button>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="text-center py-12">
          <RefreshCw className="animate-spin text-gray-400 mx-auto" size={20} />
        </div>
      ) : products.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center">
          <PackageIcon className="mx-auto text-gray-400 mb-3" size={32} />
          <p className="text-gray-700 font-medium">No products imported yet.</p>
          <p className="text-gray-500 text-sm mt-1">
            Click <strong>Import from COD Network</strong> above to pull your
            seller catalog. Products refresh automatically every 5 minutes once
            imported.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {products.map((p) => (
            <div
              key={p.id}
              className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm flex flex-col"
            >
              {p.imageUrl ? (
                <div className="relative w-full h-40 bg-gray-50">
                  <Image
                    src={p.imageUrl}
                    alt={p.name}
                    fill
                    sizes="(max-width: 640px) 100vw, 33vw"
                    className="object-contain"
                    unoptimized
                  />
                </div>
              ) : (
                <div className="w-full h-40 bg-gray-50 flex items-center justify-center text-gray-300">
                  <PackageIcon size={36} />
                </div>
              )}
              <div className="p-3 flex flex-col gap-1 flex-1">
                <div className="font-medium text-gray-900 line-clamp-2">
                  {p.name}
                </div>
                {p.nameArabic && (
                  <div
                    className="text-xs text-gray-500 line-clamp-1"
                    dir="rtl"
                  >
                    {p.nameArabic}
                  </div>
                )}
                <div className="flex items-center justify-between mt-2 text-xs">
                  <span className="flex items-center gap-1 text-gray-500 font-mono">
                    <Tag size={12} />
                    {p.sku || p.codNetworkProductId}
                  </span>
                  {p.price && (
                    <span className="font-semibold text-gray-900">
                      {p.price}
                      {p.currency ? ` ${p.currency}` : ""}
                    </span>
                  )}
                </div>
                {p.productStatus && (
                  <div className="mt-1">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        p.productStatus === "Enabled"
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {p.productStatus}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
