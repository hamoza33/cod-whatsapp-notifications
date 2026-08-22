"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { api } from "@/lib/api-client";
import {
  RefreshCw,
  Search,
  Tag,
  Package as PackageIcon,
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
  aiAgentEnabled: boolean;
  aiSystemPrompt: string | null;
  lastSyncedAt: string;
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

  // Sort so that products with the AI agent enabled bubble to the top of
  // each list (My Products / COD Drop). Array.prototype.sort is stable in
  // modern engines, so the existing API order is preserved within each
  // group.
  const sortByAiAgent = (a: Product, b: Product): number => {
    if (a.aiAgentEnabled === b.aiAgentEnabled) return 0;
    return a.aiAgentEnabled ? -1 : 1;
  };
  const myProducts = products.filter((p) => !p.isDropProduct).slice().sort(sortByAiAgent);
  const dropProducts = products.filter((p) => p.isDropProduct).slice().sort(sortByAiAgent);
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

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isArabic(text: string): boolean {
  const arabicPattern = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return arabicPattern.test(text);
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
  const plainDesc = stripHtml(product.description || "");
  const [desc, setDesc] = useState(plainDesc);
  const [saving, setSaving] = useState(false);
  const descIsArabic = isArabic(plainDesc);

  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptEditing, setPromptEditing] = useState(false);
  const [prompt, setPrompt] = useState(product.aiSystemPrompt || "");
  const [promptSaving, setPromptSaving] = useState(false);
  const promptIsArabic = isArabic(prompt);

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

  const savePrompt = async () => {
    setPromptSaving(true);
    try {
      const value = prompt.trim() ? prompt : null;
      await api.patch(`/products/${product.id}`, { aiSystemPrompt: value });
      onUpdate({ ...product, aiSystemPrompt: value });
      setPromptEditing(false);
    } catch {
      // keep editing open on error
    } finally {
      setPromptSaving(false);
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
        <div className="flex items-center justify-between mt-2 py-2 border-t border-gray-100">
          <span className="text-xs font-medium text-gray-600">AI Agent</span>
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
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              product.aiAgentEnabled ? "bg-blue-600" : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                product.aiAgentEnabled ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>

        {/* Per-product AI system prompt */}
        <div className="border-t border-gray-100 pt-2">
          <button
            onClick={() => setPromptExpanded(!promptExpanded)}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
          >
            {promptExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            AI Prompt
            {product.aiSystemPrompt ? (
              <span className="ml-1 inline-block px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-green-100 text-green-700">
                custom
              </span>
            ) : (
              <span className="ml-1 inline-block px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-gray-100 text-gray-500">
                global
              </span>
            )}
          </button>
          {promptExpanded && (
            <div className="mt-2">
              {promptEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={5}
                    dir={promptIsArabic ? "rtl" : "ltr"}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Dedicated system prompt for this product. Leave empty to use the global AI prompt."
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={savePrompt}
                      disabled={promptSaving}
                      className="flex items-center gap-1 px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Save size={10} />
                      {promptSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => {
                        setPromptEditing(false);
                        setPrompt(product.aiSystemPrompt || "");
                      }}
                      className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p
                    className="text-xs text-gray-600 whitespace-pre-wrap"
                    dir={promptIsArabic ? "rtl" : "ltr"}
                  >
                    {product.aiSystemPrompt ||
                      "No product prompt — using the global AI system prompt."}
                  </p>
                  <button
                    onClick={() => setPromptEditing(true)}
                    className="mt-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    {product.aiSystemPrompt ? "Edit prompt" : "Set product prompt"}
                  </button>
                </div>
              )}
            </div>
          )}
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
                    dir={descIsArabic ? "rtl" : "ltr"}
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
                        setDesc(plainDesc);
                      }}
                      className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p
                    className="text-xs text-gray-600 whitespace-pre-wrap"
                    dir={descIsArabic ? "rtl" : "ltr"}
                  >
                    {plainDesc || "No description available."}
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
