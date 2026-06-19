import { getSetting, setSetting, deleteSetting, SETTING_KEYS } from "./settings";

export interface CodNetworkOrderItem {
  name?: string;
  sku?: string;
  price?: string | number;
  quantity?: string | number;
  // The seller orders endpoint returns nested products at
  // items[].product.data.{name, sku, ...} when ?include=items[product] is used,
  // or even by default for some accounts. Other endpoints flatten the product
  // straight onto the item, hence both shapes are accepted here.
  product?: {
    data?: {
      name?: string;
      sku?: string;
      [key: string]: unknown;
    };
    name?: string;
    sku?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CodNetworkOrderStatus {
  label?: string;
  code?: number;
}

export interface CodNetworkOrder {
  id: string | number;
  reference?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_city?: string;
  customer_area?: string;
  customer_address?: string;
  customer_country_name?: string;
  product_name?: string;
  product_price?: string | number;
  product_quantity?: string | number;
  total_price?: string | number;
  total?: string | number;
  amount?: string | number;
  quantity?: string | number;
  tracking_number?: string | null;
  tracking_status?: string | null;
  delivery_company?: string;
  status?: string | CodNetworkOrderStatus;
  // The Seller API v2 wraps the items list in a `data` envelope
  // (`items: { data: [...] }`) when ?include=items is set; some other
  // endpoints / older responses return a plain array. Both shapes are accepted.
  items?: CodNetworkOrderItem[] | { data?: CodNetworkOrderItem[] };
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface CodNetworkListResponse {
  status?: string;
  data: CodNetworkOrder[];
  meta?: {
    pagination?: {
      total?: number;
      count?: number;
      per_page?: number;
      current_page?: number;
      total_pages?: number;
    };
    current_page?: number;
    last_page?: number;
    per_page?: number;
    total?: number;
  };
}

interface CodNetworkLoginResponse {
  status: string;
  access_token?: string;
  expires_in?: number;
  message?: string;
  code?: string | number;
}

/**
 * Public, structured error thrown when the COD Network API rejects a request.
 * Surfaces the HTTP status, a short human-readable message, the raw response
 * body, and (when available) the parsed error envelope `{status, code, message}`.
 */
export class CodNetworkApiError extends Error {
  status: number;
  body: string;
  code?: string | number;
  apiMessage?: string;

  constructor(status: number, body: string, message?: string) {
    let apiMessage: string | undefined;
    let apiCode: string | number | undefined;
    try {
      const parsed = JSON.parse(body) as { message?: string; code?: string | number };
      apiMessage = parsed.message;
      apiCode = parsed.code;
    } catch {
      // body is not JSON
    }
    const friendly =
      message ??
      `COD Network API error (${status})${
        apiMessage ? `: ${apiMessage}` : `: ${body.slice(0, 200)}`
      }`;
    super(friendly);
    this.name = "CodNetworkApiError";
    this.status = status;
    this.body = body;
    this.apiMessage = apiMessage;
    this.code = apiCode;
  }
}

/**
 * Module-level mutex so concurrent requests don't trigger parallel logins or
 * thrash the cached access_token. Only one auth refresh runs at a time per
 * Node process.
 */
let authMutex: Promise<void> = Promise.resolve();

async function withAuthMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = authMutex;
  let release!: () => void;
  authMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

const TOKEN_REFRESH_BUFFER_MS = 60_000;

export class CodNetworkClient {
  private baseUrl: string;
  private email?: string;
  private password?: string;
  private staticToken?: string;
  private accessToken?: string;
  private accessTokenExpiresAt?: number;

  constructor(opts: {
    baseUrl: string;
    email?: string;
    password?: string;
    staticToken?: string;
    cachedToken?: string;
    cachedTokenExpiresAt?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.email = opts.email;
    this.password = opts.password;
    this.staticToken = opts.staticToken;
    this.accessToken = opts.cachedToken;
    this.accessTokenExpiresAt = opts.cachedTokenExpiresAt;
  }

  static async fromSettings(): Promise<CodNetworkClient> {
    const baseUrl =
      (await getSetting(SETTING_KEYS.COD_API_BASE_URL)) ||
      process.env.COD_NETWORK_API_BASE_URL ||
      "https://api.cod.network/v2";

    const email =
      (await getSetting(SETTING_KEYS.COD_API_EMAIL)) ||
      process.env.COD_NETWORK_API_EMAIL ||
      undefined;
    const password =
      (await getSetting(SETTING_KEYS.COD_API_PASSWORD)) ||
      process.env.COD_NETWORK_API_PASSWORD ||
      undefined;
    const staticToken =
      (await getSetting(SETTING_KEYS.COD_API_TOKEN)) ||
      process.env.COD_NETWORK_API_TOKEN ||
      undefined;

    const cachedToken =
      (await getSetting(SETTING_KEYS.COD_API_TOKEN_CACHED)) || undefined;
    const cachedExp = await getSetting(SETTING_KEYS.COD_API_TOKEN_EXPIRES_AT);
    const cachedTokenExpiresAt = cachedExp ? Number(cachedExp) : undefined;

    if (!email && !password && !staticToken) {
      throw new Error(
        "COD Network credentials not configured. Add your seller email + password (recommended, per https://developer.cod.network/v2/api-introduction-getting-started) or a static API token in Settings → COD Network."
      );
    }
    if (email && !password) {
      throw new Error(
        "COD Network email is set but password is missing. Add your password in Settings → COD Network."
      );
    }
    if (!email && password) {
      throw new Error(
        "COD Network password is set but email is missing. Add your email in Settings → COD Network."
      );
    }

    return new CodNetworkClient({
      baseUrl,
      email,
      password,
      staticToken,
      cachedToken,
      cachedTokenExpiresAt,
    });
  }

  private hasFreshCachedToken(): boolean {
    if (!this.accessToken || !this.accessTokenExpiresAt) return false;
    return this.accessTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now();
  }

  private async login(): Promise<string> {
    if (!this.email || !this.password) {
      throw new Error(
        "Cannot login to COD Network: email and password are not configured."
      );
    }

    const url = `${this.baseUrl}/seller/login`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: this.email, password: this.password }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`COD Network login network error: ${msg}`);
    }

    const bodyText = await response.text();
    let parsed: CodNetworkLoginResponse | null = null;
    try {
      parsed = JSON.parse(bodyText) as CodNetworkLoginResponse;
    } catch {
      // bodyText left as-is
    }

    if (!response.ok || !parsed?.access_token) {
      const friendly = parsed?.message
        ? `COD Network login failed (${response.status}): ${parsed.message}`
        : `COD Network login failed (${response.status}): ${bodyText.slice(0, 300)}`;
      throw new CodNetworkApiError(response.status, bodyText, friendly);
    }

    const token = parsed.access_token;
    const expiresInSec = Number(parsed.expires_in ?? 3600);
    const expiresAt = Date.now() + expiresInSec * 1000;
    this.accessToken = token;
    this.accessTokenExpiresAt = expiresAt;
    try {
      await setSetting(SETTING_KEYS.COD_API_TOKEN_CACHED, token);
      await setSetting(SETTING_KEYS.COD_API_TOKEN_EXPIRES_AT, String(expiresAt));
    } catch {
      // best-effort cache; in-memory copy still works
    }
    return token;
  }

  private async invalidateCachedToken(): Promise<void> {
    this.accessToken = undefined;
    this.accessTokenExpiresAt = undefined;
    try {
      await deleteSetting(SETTING_KEYS.COD_API_TOKEN_CACHED);
      await deleteSetting(SETTING_KEYS.COD_API_TOKEN_EXPIRES_AT);
    } catch {
      // ignore
    }
  }

  private async getAuthToken(forceRefresh = false): Promise<string> {
    // Email + password flow takes precedence (per COD Network docs).
    if (this.email && this.password) {
      return withAuthMutex(async () => {
        if (!forceRefresh && this.hasFreshCachedToken()) {
          return this.accessToken!;
        }
        return await this.login();
      });
    }
    // Fallback: legacy static API token.
    if (this.staticToken) return this.staticToken;
    throw new Error("COD Network: no auth credentials available.");
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    isRetry = false
  ): Promise<T> {
    const token = await this.getAuthToken(false);
    const url = `${this.baseUrl}${endpoint}`;

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`COD Network network error calling ${endpoint}: ${msg}`);
    }

    if (response.status === 401 && !isRetry && this.email && this.password) {
      // Token expired/revoked — invalidate cache and retry once with a fresh token.
      await this.invalidateCachedToken();
      return this.request<T>(endpoint, options, true);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new CodNetworkApiError(response.status, body);
    }

    return (await response.json()) as T;
  }

  async getOrders(
    page = 1,
    perPage = 50,
    params: Record<string, string> = {}
  ): Promise<CodNetworkListResponse> {
    const searchParams = new URLSearchParams({
      page: String(page),
      // Docs use `limit` for page size; some endpoints accept `per_page`.
      // Send both to maximize compatibility.
      limit: String(perPage),
      per_page: String(perPage),
      include: "items",
      ...params,
    });
    return this.request<CodNetworkListResponse>(
      `/seller/orders?${searchParams.toString()}`
    );
  }

  async getAllOrders(
    params: Record<string, string> = {},
    opts: { sinceDate?: Date; maxPages?: number } = {}
  ): Promise<CodNetworkOrder[]> {
    const { sinceDate, maxPages = 100 } = opts;
    const allOrders: CodNetworkOrder[] = [];
    let page = 1;
    let hasMore = true;

    // If `sinceDate` is provided, ask the API for only newer orders. Different
    // installs of the Seller API have inconsistent filter param names, so we
    // send a few common variants and additionally enforce the cutoff client
    // side. Stops paginating once a full page falls before the cutoff.
    const dateParams: Record<string, string> = {};
    if (sinceDate) {
      const iso = sinceDate.toISOString();
      const isoDate = iso.slice(0, 10);
      dateParams["created_at[gte]"] = iso;
      dateParams.from = isoDate;
      dateParams.since = iso;
    }
    const mergedParams = { ...dateParams, ...params };

    while (hasMore) {
      const response = await this.getOrders(page, 50, mergedParams);

      const pageOrders = sinceDate
        ? response.data.filter((o) => {
            if (!o.created_at) return true;
            const t = Date.parse(o.created_at);
            return Number.isNaN(t) ? true : t >= sinceDate.getTime();
          })
        : response.data;
      allOrders.push(...pageOrders);

      // If filtering on date and the entire page was older than the cutoff,
      // stop paginating — the API isn't honoring the date filter so we exit
      // early instead of paging through years of history.
      if (
        sinceDate &&
        response.data.length > 0 &&
        pageOrders.length === 0
      ) {
        break;
      }

      const pagination = response.meta?.pagination;
      if (
        pagination?.current_page !== undefined &&
        pagination?.total_pages !== undefined
      ) {
        hasMore = pagination.current_page < pagination.total_pages;
      } else if (
        response.meta?.current_page !== undefined &&
        response.meta?.last_page !== undefined
      ) {
        hasMore = response.meta.current_page < response.meta.last_page;
      } else {
        hasMore = response.data.length === 50;
      }

      page++;

      if (page > maxPages) break;
    }

    return allOrders;
  }

  async getOrder(orderId: string): Promise<CodNetworkOrder> {
    const response = await this.request<{ data: CodNetworkOrder }>(
      `/seller/orders/${orderId}?include=items`
    );
    return response.data;
  }

  async getProducts(
    page = 1,
    perPage = 50
  ): Promise<CodNetworkListResponse> {
    const search = new URLSearchParams({
      page: String(page),
      limit: String(perPage),
      per_page: String(perPage),
    });
    return this.request<CodNetworkListResponse>(
      `/seller/products?${search.toString()}`
    );
  }

  /**
   * Pull every product across all pages. The seller catalog rarely exceeds a
   * few hundred entries, so we don't bother with a `sinceDate` filter — a full
   * snapshot is cheap and avoids stale rows when products are edited in COD.
   */
  async getAllProducts(opts: { maxPages?: number } = {}): Promise<
    CodNetworkProduct[]
  > {
    const { maxPages = 50 } = opts;
    const all: CodNetworkProduct[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const response = await this.getProducts(page, 50);
      const items = (response.data as unknown as CodNetworkProduct[]) ?? [];
      all.push(...items);
      const pagination = response.meta?.pagination;
      if (
        pagination?.current_page !== undefined &&
        pagination?.total_pages !== undefined
      ) {
        hasMore = pagination.current_page < pagination.total_pages;
      } else {
        hasMore = items.length === 50;
      }
      page++;
      if (page > maxPages) break;
    }
    return all;
  }

  async getDropProducts(
    page = 1,
    perPage = 50
  ): Promise<CodNetworkListResponse> {
    const search = new URLSearchParams({
      page: String(page),
      limit: String(perPage),
      per_page: String(perPage),
    });
    return this.request<CodNetworkListResponse>(
      `/seller/drop-products?${search.toString()}`
    );
  }

  async getAllDropProducts(opts: { maxPages?: number } = {}): Promise<
    CodNetworkProduct[]
  > {
    const { maxPages = 50 } = opts;
    const all: CodNetworkProduct[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      try {
        const response = await this.getDropProducts(page, 50);
        const items = (response.data as unknown as CodNetworkProduct[]) ?? [];
        all.push(...items);
        const pagination = response.meta?.pagination;
        if (
          pagination?.current_page !== undefined &&
          pagination?.total_pages !== undefined
        ) {
          hasMore = pagination.current_page < pagination.total_pages;
        } else {
          hasMore = items.length === 50;
        }
      } catch {
        break;
      }
      page++;
      if (page > maxPages) break;
    }
    return all;
  }
}

export interface CodNetworkProduct {
  id: number | string;
  sku?: string | null;
  name?: string | null;
  name_arabic?: string | null;
  description?: string | null;
  image_url?: string | null;
  path_image?: string | null;
  price?: string | number | null;
  currency?: string | null;
  url?: string | null;
  type?: { label?: string; code?: number } | string | null;
  status?: { label?: string; code?: number } | string | null;
  [key: string]: unknown;
}

/**
 * COD Network seller order status codes
 * (https://developer.cod.network/v2/api-seller-orders).
 *  1=New, 2=Assigned, 3=Shipped, 4=Delivered, 5=Return, 6=Cancel,
 *  7=Out of stock, 8=Pending, 9=Return on process, 10=Processing
 */
const ORDER_STATUS_CODE_MAP: Record<number, string> = {
  1: "NEW",
  2: "ASSIGNED",
  3: "SHIPPED",
  4: "DELIVERED",
  5: "RETURNED",
  6: "CANCELLED",
  7: "OUT_OF_STOCK",
  8: "PENDING",
  9: "RETURN_ON_PROCESS",
  10: "PROCESSING",
};

/**
 * COD Network seller lead status codes
 * (https://developer.cod.network/v2/api-seller-leads).
 *  1=New, 2=Confirmed, 3=Call later, 4=Call later scheduled,
 *  5=No reply, 6=Cancelled, 7=Wrong, 8=Expired,
 *  9=Processing, 10=Delayed, 11=Cancelled price, 12=Black listed
 */
const LEAD_STATUS_CODE_MAP: Record<number, string> = {
  1: "NEW",
  2: "CONFIRMED",
  3: "CALL_LATER",
  4: "CALL_LATER_SCHEDULED",
  5: "NO_REPLY",
  6: "CANCELLED",
  7: "WRONG",
  8: "EXPIRED",
  9: "PROCESSING",
  10: "DELAYED",
  11: "CANCELLED_PRICE",
  12: "BLACK_LISTED",
};

/** Combined code map — order codes take priority, lead codes fill gaps. */
const STATUS_CODE_MAP: Record<number, string> = {
  ...LEAD_STATUS_CODE_MAP,
  ...ORDER_STATUS_CODE_MAP,
};

export { LEAD_STATUS_CODE_MAP, ORDER_STATUS_CODE_MAP };

const STATUS_STRING_MAP: Record<string, string> = {
  new: "NEW",
  "new lead": "NEW",
  pending: "PENDING",
  assigned: "ASSIGNED",
  confirmed: "CONFIRMED",
  processing: "PROCESSING",
  shipped: "SHIPPED",
  "out for delivery": "OUT_FOR_DELIVERY",
  out_for_delivery: "OUT_FOR_DELIVERY",
  "out-for-delivery": "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
  returned: "RETURNED",
  return: "RETURNED",
  "return on process": "RETURN_ON_PROCESS",
  return_on_process: "RETURN_ON_PROCESS",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  cancel: "CANCELLED",
  "out of stock": "OUT_OF_STOCK",
  out_of_stock: "OUT_OF_STOCK",
  "no reply": "NO_REPLY",
  no_reply: "NO_REPLY",
  noreply: "NO_REPLY",
  unanswered: "NO_REPLY",
  wrong: "WRONG",
  "wrong lead": "WRONG",
  "wrong number": "WRONG",
  expired: "EXPIRED",
  "call later": "CALL_LATER",
  call_later: "CALL_LATER",
  callback: "CALL_LATER",
  "call later scheduled": "CALL_LATER_SCHEDULED",
  call_later_scheduled: "CALL_LATER_SCHEDULED",
  scheduled: "CALL_LATER_SCHEDULED",
  delayed: "DELAYED",
  "cancelled price": "CANCELLED_PRICE",
  cancelled_price: "CANCELLED_PRICE",
  "canceled price": "CANCELLED_PRICE",
  "black listed": "BLACK_LISTED",
  black_listed: "BLACK_LISTED",
  blacklisted: "BLACK_LISTED",
};

export function mapCodStatus(
  status: string | CodNetworkOrderStatus | undefined,
  trackingStatus?: string | null
): string {
  // tracking_status promotes a SHIPPED order to OUT_FOR_DELIVERY once a courier
  // picks it up, which is one of the user-configurable trigger statuses.
  if (trackingStatus) {
    const t = String(trackingStatus).toLowerCase();
    if (t.includes("out") && t.includes("delivery")) return "OUT_FOR_DELIVERY";
    if (t === "delivered") return "DELIVERED";
    if (t === "returned" || t.includes("return")) return "RETURNED";
  }

  if (status === undefined || status === null) return "UNKNOWN";

  if (typeof status === "object") {
    if (typeof status.code === "number" && STATUS_CODE_MAP[status.code]) {
      return STATUS_CODE_MAP[status.code];
    }
    if (status.label) {
      const mapped = STATUS_STRING_MAP[status.label.toLowerCase()];
      if (mapped) return mapped;
    }
    return "UNKNOWN";
  }

  return STATUS_STRING_MAP[status.toLowerCase()] || "UNKNOWN";
}

/** Normalize the various item-list shapes into a flat `CodNetworkOrderItem[]`. */
function normalizeItemsList(
  items: CodNetworkOrder["items"]
): CodNetworkOrderItem[] {
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (Array.isArray(items.data)) return items.data;
  return [];
}

/**
 * Extract a human-friendly product name from the order. The Seller API wraps
 * both the items list and each product in `data` envelopes when ?include=items
 * is set, so this looks at all of:
 *   1. order.product_name                       (top-level convenience field)
 *   2. items[].name                             (flat shape, some endpoints)
 *   3. items[].product.data.name                (default include=items shape)
 *   4. items[].product.name                     (unwrapped variant)
 *
 * `order.items` itself can be `[...]` or `{data: [...]}` — both are handled.
 */
export function extractProductName(order: CodNetworkOrder): string | null {
  if (typeof order.product_name === "string" && order.product_name.length > 0) {
    return order.product_name;
  }
  const list = normalizeItemsList(order.items);
  if (list.length === 0) return null;
  const names = list
    .map((it) => {
      if (typeof it.name === "string" && it.name.length > 0) return it.name;
      const productData = it.product?.data;
      if (
        productData &&
        typeof productData.name === "string" &&
        productData.name.length > 0
      ) {
        return productData.name;
      }
      if (
        it.product &&
        typeof it.product.name === "string" &&
        it.product.name.length > 0
      ) {
        return it.product.name;
      }
      return null;
    })
    .filter((n): n is string => !!n);
  return names.length > 0 ? names.join(", ") : null;
}
