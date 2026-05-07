import { getSetting, SETTING_KEYS } from "./settings";

export interface CodNetworkOrder {
  id: string | number;
  reference?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_city?: string;
  customer_address?: string;
  product_name?: string;
  tracking_number?: string;
  delivery_company?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface CodNetworkListResponse {
  data: CodNetworkOrder[];
  meta?: {
    current_page?: number;
    last_page?: number;
    per_page?: number;
    total?: number;
  };
}

export class CodNetworkClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  static async fromSettings(): Promise<CodNetworkClient> {
    const baseUrl =
      (await getSetting(SETTING_KEYS.COD_API_BASE_URL)) ||
      process.env.COD_NETWORK_API_BASE_URL ||
      "https://api.cod.network/v2";
    const token =
      (await getSetting(SETTING_KEYS.COD_API_TOKEN)) ||
      process.env.COD_NETWORK_API_TOKEN ||
      "";

    if (!token) {
      throw new Error(
        "COD Network API token not configured. Please set it in Settings."
      );
    }

    return new CodNetworkClient(baseUrl, token);
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `COD Network API error (${response.status}): ${body}`
      );
    }

    return response.json();
  }

  async getOrders(
    page = 1,
    perPage = 50,
    params: Record<string, string> = {}
  ): Promise<CodNetworkListResponse> {
    const searchParams = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      ...params,
    });
    return this.request<CodNetworkListResponse>(
      `/seller/orders?${searchParams.toString()}`
    );
  }

  async getAllOrders(
    params: Record<string, string> = {}
  ): Promise<CodNetworkOrder[]> {
    const allOrders: CodNetworkOrder[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getOrders(page, 50, params);
      allOrders.push(...response.data);

      if (
        response.meta &&
        response.meta.current_page !== undefined &&
        response.meta.last_page !== undefined
      ) {
        hasMore = response.meta.current_page < response.meta.last_page;
      } else {
        hasMore = response.data.length === 50;
      }

      page++;

      if (page > 100) break;
    }

    return allOrders;
  }

  async getOrder(orderId: string): Promise<CodNetworkOrder> {
    const response = await this.request<{ data: CodNetworkOrder }>(
      `/seller/orders/${orderId}`
    );
    return response.data;
  }
}

export function mapCodStatus(status: string | undefined): string {
  if (!status) return "UNKNOWN";

  const statusMap: Record<string, string> = {
    pending: "PENDING",
    confirmed: "CONFIRMED",
    processing: "PROCESSING",
    shipped: "SHIPPED",
    "out for delivery": "OUT_FOR_DELIVERY",
    out_for_delivery: "OUT_FOR_DELIVERY",
    delivered: "DELIVERED",
    returned: "RETURNED",
    cancelled: "CANCELLED",
    canceled: "CANCELLED",
  };

  return statusMap[status.toLowerCase()] || "UNKNOWN";
}
