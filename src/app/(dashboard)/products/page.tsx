"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Search,
  Tag,
  Package as PackageIcon,
  Bot,
  ChevronDown,
  ChevronUp,
  Save,
  ShoppingBag,
  Store,
} from "lucide-react";

interface Product {
  id: string;
  codNetworkProductId: string;
  sku: string | null;
  name: string;
  nameArabic: string | null;
  imageUrl: string | null;
  description: string | null;
  price: string | null;
  currency: string | null;
  productType: string | null;
  productStatus: string | null;
  storeUrl: string | null;
  isDropProduct: boolean;
  lastSyncedAt: string;
  aiAgentEnabled: boolean;
}

type ProductTab = "my" | "drop";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [activeTab, setActiveTab] = useState<ProductTab>("my");
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

  const myProducts = products.filter((p) => !p.isDropProduct);
  const dropProducts = products.filter((p) => p.isDropProduct);
  const displayProducts = activeTab === "my" ? myProducts : dropProducts;

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

      {/* Tab bar */}
      <div className="border-b border-gray-200 mb-4">
        <nav className="flex gap-0 -mb-px">
          <button
            onClick={() => setActiveTab("my")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "my"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            <Store size={16} />
            My Products ({myProducts.length})
          </button>
          <button
            onClick={() => setActiveTab("drop")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "drop"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            <ShoppingBag size={16} />
            COD Drop Products ({dropProducts.length})
          </button>
        </nav>
      </div>

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
      ) : displayProducts.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center">
          <PackageIcon className="mx-auto text-gray-400 mb-3" size={32} />
          <p className="text-gray-700 font-medium">
            {products.length === 0
              ? "No products imported yet."
              : `No ${activeTab === "drop" ? "COD Drop" : "My"} products found.`}
          </p>
          {products.length === 0 && (
            <p className="text-gray-500 text-sm mt-1">
              Click <strong>Import from COD Network</strong> above to pull your
              seller catalog.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayProducts.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              onUpdate={(updated) =>
                setProducts((prev) =>
                  prev.map((x) => (x.id === updated.id ? updated : x))
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductCard({
  product,
  onUpdate,
}: {
  product: Product;
  onUpdate: (p: Product) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(product.description || "");
  const [saving, setSaving] = useState(false);

  const saveDescription = async () => {
    setSaving(true);
    try {
      await api.patch(`/products/${product.id}`, { description: desc });
      onUpdate({ ...product, description: desc });
      setEditing(false);
    } catch {
      // keep editing open on error
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm flex flex-col">
      {product.imageUrl ? (
        <div className="relative w-full h-40 bg-gray-50">
          <Image
            src={product.imageUrl}
            alt={product.name}
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
          {product.name}
        </div>
        {product.nameArabic && (
          <div className="text-xs text-gray-500 line-clamp-1" dir="rtl">
            {product.nameArabic}
          </div>
        )}
        <div className="flex items-center justify-between mt-2 text-xs">
          <span className="flex items-center gap-1 text-gray-500 font-mono">
            <Tag size={12} />
            {product.sku || product.codNetworkProductId}
          </span>
          {product.price && (
            <span className="font-semibold text-gray-900">
              {product.price}
              {product.currency ? ` ${product.currency}` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1">
          {product.productStatus && (
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                product.productStatus === "Enabled"
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {product.productStatus}
            </span>
          )}
          {product.isDropProduct && (
            <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700">
              COD Drop
            </span>
          )}
        </div>

        {/* AI Agent toggle */}
        <div className="mt-2 border-t border-gray-100 pt-2">
          <button
            onClick={async () => {
              const newVal = !product.aiAgentEnabled;
              onUpdate({ ...product, aiAgentEnabled: newVal });
              try {
                await api.patch(`/products/${product.id}`, { aiAgentEnabled: newVal });
              } catch {
                onUpdate({ ...product, aiAgentEnabled: !newVal });
              }
            }}
            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md transition-colors w-full justify-center ${
              product.aiAgentEnabled
                ? "bg-purple-100 text-purple-700 hover:bg-purple-200"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            <Bot size={12} />
            {product.aiAgentEnabled ? "AI Agent Active" : "Activate AI Agent"}
          </button>
        </div>

        {/* Description expand/collapse */}
        <div className="mt-2 border-t border-gray-100 pt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? "Hide" : "Show"} Description
          </button>
          {expanded && (
            <div className="mt-2">
              {editing ? (
                <div className="space-y-2">
                  <textarea
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    rows={4}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Enter product description..."
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={saveDescription}
                      disabled={saving}
                      className="flex items-center gap-1 px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Save size={10} />
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => {
                        setEditing(false);
                        setDesc(product.description || "");
                      }}
                      className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-xs text-gray-600 whitespace-pre-wrap">
                    {product.description || "No description available."}
                  </p>
                  <button
                    onClick={() => setEditing(true)}
                    className="mt-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    Edit description
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
