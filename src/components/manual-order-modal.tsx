"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { X } from "lucide-react";

interface ProductInfo {
  id: string;
  name: string;
  sku: string | null;
  price: string | null;
  currency: string | null;
}

const STATUS_OPTIONS = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "SCHEDULED",
] as const;

/**
 * Modal form for creating a manual order — used by /orders and /pipeline.
 *
 * Manual orders are never overwritten by the COD Network sync (the sync
 * filter on the unique `codNetworkOrderId` only touches rows it just
 * fetched). They get a generated `MANUAL-<random>` id server-side so the
 * unique index is preserved and operators can spot them in the UI.
 */
export default function ManualOrderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (orderId?: string) => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerCity, setCustomerCity] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [productName, setProductName] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [productQuantity, setProductQuantity] = useState("1");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [deliveryCompany, setDeliveryCompany] = useState("");
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("PENDING");
  const [pipelineNote, setPipelineNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [showProductPicker, setShowProductPicker] = useState(false);

  // Fetch products once when the modal opens so the operator can autocomplete
  // from their imported COD Network catalog. If they have no products yet,
  // they can still type a freeform product name.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ products: ProductInfo[] }>("/products?pageSize=500")
      .then((data) => {
        if (!cancelled) setProducts(data.products);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const productMatches = useMemo(() => {
    const q = productName.trim().toLowerCase();
    if (!q) return products.slice(0, 8);
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku && p.sku.toLowerCase().includes(q))
      )
      .slice(0, 8);
  }, [products, productName]);

  const submit = async () => {
    setError(null);
    if (!customerName.trim()) {
      setError("Customer name is required");
      return;
    }
    if (!customerPhone.trim()) {
      setError("Customer phone is required");
      return;
    }
    if (!productName.trim()) {
      setError("Product name is required");
      return;
    }
    setSubmitting(true);
    try {
      const data = await api.post<{ order: { id: string } }>("/orders", {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerCity: customerCity.trim() || null,
        customerAddress: customerAddress.trim() || null,
        productName: productName.trim(),
        productPrice: productPrice.trim() || null,
        productQuantity: productQuantity.trim() || null,
        trackingNumber: trackingNumber.trim() || null,
        deliveryCompany: deliveryCompany.trim() || null,
        status,
        pipelineNote: pipelineNote.trim() || null,
      });
      onCreated(data.order.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <h2 className="text-lg font-bold text-gray-900">New manual order</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          <p className="text-xs text-gray-500">
            Manual orders are stored separately from COD Network — they get a
            generated <code className="px-1 bg-gray-100 rounded">MANUAL-…</code>{" "}
            ID and won&apos;t be overwritten by the next sync. Add a tracking
            number to trigger automation rules that fire on shipping.
          </p>

          {error && (
            <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-xs">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Customer name *">
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. Hamza B."
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>
            <Field
              label="Customer phone *"
              help="International format works best (e.g. +212690…). The app will normalize it."
            >
              <input
                type="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="+212690415194"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>
            <Field label="City">
              <input
                type="text"
                value={customerCity}
                onChange={(e) => setCustomerCity(e.target.value)}
                placeholder="e.g. Casablanca"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>
            <Field label="Status">
              <select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as (typeof STATUS_OPTIONS)[number])
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
            <div className="md:col-span-2">
              <Field label="Address">
                <input
                  type="text"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  placeholder="optional"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </Field>
            </div>

            <div className="md:col-span-2 relative">
              <Field
                label="Product *"
                help={
                  products.length > 0
                    ? `Type a substring or pick from your ${products.length} imported products`
                    : "Type the product name. Import products from COD Network to enable autocomplete."
                }
              >
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  onFocus={() => setShowProductPicker(true)}
                  onBlur={() =>
                    setTimeout(() => setShowProductPicker(false), 150)
                  }
                  placeholder="e.g. Eczema and psoriasis-cream - Version 2"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </Field>
              {showProductPicker && productMatches.length > 0 && (
                <ul className="absolute z-20 left-0 right-0 top-[68px] bg-white border border-gray-200 rounded-md shadow-lg max-h-64 overflow-y-auto">
                  {productMatches.map((p) => (
                    <li
                      key={p.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setProductName(p.name);
                        if (p.price && !productPrice) {
                          setProductPrice(p.price);
                        }
                        setShowProductPicker(false);
                      }}
                      className="px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 flex items-center justify-between gap-2"
                    >
                      <div>
                        <div className="font-medium text-gray-900 line-clamp-1">
                          {p.name}
                        </div>
                        {p.sku && (
                          <div className="text-xs text-gray-500 font-mono">
                            {p.sku}
                          </div>
                        )}
                      </div>
                      {p.price && (
                        <div className="text-xs text-gray-500">
                          {p.price} {p.currency ?? ""}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Field label="Price">
              <input
                type="text"
                value={productPrice}
                onChange={(e) => setProductPrice(e.target.value)}
                placeholder="e.g. 199.00"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>
            <Field label="Quantity">
              <input
                type="text"
                value={productQuantity}
                onChange={(e) => setProductQuantity(e.target.value)}
                placeholder="1"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>

            <Field
              label="Tracking #"
              help="Adding a tracking number can trigger your shipping automation when paired with a SHIPPED/OUT_FOR_DELIVERY status."
            >
              <input
                type="text"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                placeholder="optional"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>
            <Field label="Delivery company">
              <input
                type="text"
                value={deliveryCompany}
                onChange={(e) => setDeliveryCompany(e.target.value)}
                placeholder="optional"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </Field>

            <div className="md:col-span-2">
              <Field label="Internal note">
                <textarea
                  value={pipelineNote}
                  onChange={(e) => setPipelineNote(e.target.value)}
                  rows={2}
                  placeholder="optional — visible only inside this app"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create order"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        {label}
      </label>
      {children}
      {help && <p className="mt-1 text-[11px] text-gray-500">{help}</p>}
    </div>
  );
}
