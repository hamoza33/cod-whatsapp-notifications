export interface TrackingEvent {
  date: string;
  description: string;
  location?: string;
}

export type TrackingDeliveryStatus =
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "returned"
  | "failed"
  | "unknown"
  | "captcha_blocked";

export interface TrackingResult {
  trackingNumber: string;
  status: TrackingDeliveryStatus;
  events: TrackingEvent[];
  rawResponse?: string;
  error?: string;
}

export interface TrackingProvider {
  name: string;
  trackBatch(trackingNumbers: string[]): Promise<TrackingResult[]>;
  trackSingle(trackingNumber: string): Promise<TrackingResult>;
}
