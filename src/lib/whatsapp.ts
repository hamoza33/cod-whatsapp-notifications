import { getSetting, SETTING_KEYS } from "./settings";

interface WhatsAppTextParameter {
  type: "text";
  text: string;
}

interface WhatsAppImageParameter {
  type: "image";
  // Meta accepts either a public `link` or a previously-uploaded `id`. We
  // prefer `id` whenever possible because it avoids the "expected IMAGE,
  // received UNKNOWN" failure when Meta can't fetch the URL.
  image: { link: string } | { id: string };
}

type WhatsAppTemplateParameter = WhatsAppTextParameter | WhatsAppImageParameter;

interface WhatsAppTemplateComponent {
  type: "body" | "header" | "button";
  parameters: WhatsAppTemplateParameter[];
}

export interface WhatsAppTemplateHeader {
  type: "text" | "image";
  /**
   * For text headers: the literal text. For image headers: either an https
   * URL (passed via `image.link`) or a Meta media ID (passed via `image.id`).
   * Use `imageKind` to disambiguate; defaults to URL.
   */
  value: string;
  /** "url" => image.link; "id" => image.id. Defaults to "url". */
  imageKind?: "url" | "id";
}

interface WhatsAppSendResult {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

/**
 * Public, structured error thrown when Meta's Graph API rejects a request.
 * Surfaces the HTTP status, raw body, and parsed Meta error envelope so the UI
 * and logs can display the actual reason (template not approved, invalid
 * Phone Number ID, expired access token, etc.).
 */
export class WhatsAppApiError extends Error {
  status: number;
  body: string;
  metaCode?: number;
  metaSubcode?: number;
  metaMessage?: string;
  metaDetails?: string;
  /** For #132000 errors only: number of body params the template expects. */
  expectedParamCount?: number;
  /** For #132000 errors only: number of body params we actually sent. */
  receivedParamCount?: number;

  constructor(status: number, body: string, message?: string) {
    let metaMessage: string | undefined;
    let metaDetails: string | undefined;
    let metaCode: number | undefined;
    let metaSubcode: number | undefined;
    try {
      const parsed = JSON.parse(body) as {
        error?: {
          message?: string;
          code?: number;
          error_subcode?: number;
          error_data?: { details?: string };
        };
      };
      metaMessage = parsed.error?.message;
      metaCode = parsed.error?.code;
      metaSubcode = parsed.error?.error_subcode;
      metaDetails = parsed.error?.error_data?.details;
    } catch {
      // body is not JSON
    }

    // #132000 = "Number of parameters does not match". Pull the explicit
    // counts out of the details string so callers (UI/log) can show the user
    // exactly how many params their template needs.
    let expectedParamCount: number | undefined;
    let receivedParamCount: number | undefined;
    if (metaCode === 132000 && metaDetails) {
      // Example details:
      //   "body: number of localizable_params (1) does not match the
      //    expected number of params (2)"
      const m = metaDetails.match(
        /\((\d+)\)\s*does not match.*expected number of params\s*\((\d+)\)/i
      );
      if (m) {
        receivedParamCount = parseInt(m[1], 10);
        expectedParamCount = parseInt(m[2], 10);
      }
    }

    let friendly: string;
    if (message) {
      friendly = message;
    } else if (
      metaCode === 132000 &&
      typeof expectedParamCount === "number" &&
      typeof receivedParamCount === "number"
    ) {
      friendly = `WhatsApp template needs ${expectedParamCount} body variable${
        expectedParamCount === 1 ? "" : "s"
      } but you sent ${receivedParamCount}. Add ${
        expectedParamCount - receivedParamCount > 0
          ? `${expectedParamCount - receivedParamCount} more`
          : `${receivedParamCount - expectedParamCount} fewer`
      } and try again.`;
    } else if (metaCode === 132012 && metaDetails) {
      friendly = `WhatsApp template header format mismatch — ${metaDetails}. Provide a header image URL (or upload an image) in the Test Message → Advanced section.`;
    } else if (metaMessage) {
      friendly = `WhatsApp API error (${status}): ${metaMessage}${
        metaDetails ? ` — ${metaDetails}` : ""
      }`;
    } else {
      friendly = `WhatsApp API error (${status}): ${body.slice(0, 300)}`;
    }
    super(friendly);
    this.name = "WhatsAppApiError";
    this.status = status;
    this.body = body;
    this.metaCode = metaCode;
    this.metaSubcode = metaSubcode;
    this.metaMessage = metaMessage;
    this.metaDetails = metaDetails;
    this.expectedParamCount = expectedParamCount;
    this.receivedParamCount = receivedParamCount;
  }
}

/**
 * The visible Meta phone number (e.g. `+966 57 253 4141`) is NOT the same as
 * the Meta-issued Phone Number ID — the Phone Number ID is a separate 15–16
 * digit identifier exposed in WhatsApp Manager → API Setup. This helper
 * detects values that look like a phone number so the UI / API layer can
 * warn the user before they hit Meta's confusing "(#100) Could not find
 * phone number" error.
 */
export function looksLikePhoneNumber(value: string): boolean {
  if (!value) return false;
  const stripped = value.replace(/[\s\-+()]/g, "");
  // Plain phone numbers typically have 7–15 digits and start with 0 or a
  // common country prefix; Meta Phone Number IDs are 15–16 digit opaque IDs
  // but never start with a leading "+" or "0".
  if (/^[+0]/.test(value.trim())) return true;
  if (/[\s\-()]/.test(value)) return true;
  if (!/^\d+$/.test(stripped)) return false;
  if (stripped.length < 8 || stripped.length > 12) return false;
  return true;
}

export class WhatsAppClient {
  private phoneNumberId: string;
  private accessToken: string;
  private apiVersion: string;

  constructor(
    phoneNumberId: string,
    accessToken: string,
    apiVersion = "v17.0"
  ) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
  }

  /**
   * Build a client from settings. Pass `phoneNumberIdOverride` to send from
   * a specific WABA (used by the multi-account inbox — the operator picks
   * a number from the dropdown and we route their send through that PNI
   * instead of the global default).
   */
  static async fromSettings(
    opts?: { phoneNumberIdOverride?: string | null }
  ): Promise<WhatsAppClient> {
    const overrideRaw = opts?.phoneNumberIdOverride;
    const override = overrideRaw && overrideRaw.trim() ? overrideRaw.trim() : null;
    const phoneNumberId =
      override ||
      (await getSetting(SETTING_KEYS.WHATSAPP_PHONE_NUMBER_ID)) ||
      process.env.WHATSAPP_PHONE_NUMBER_ID ||
      "";
    const accessToken =
      (await getSetting(SETTING_KEYS.WHATSAPP_ACCESS_TOKEN)) ||
      process.env.WHATSAPP_ACCESS_TOKEN ||
      "";
    const apiVersion =
      (await getSetting(SETTING_KEYS.WHATSAPP_API_VERSION)) ||
      process.env.WHATSAPP_API_VERSION ||
      "v17.0";

    if (!phoneNumberId || !accessToken) {
      throw new Error(
        "WhatsApp Cloud API credentials not configured. Please set them in Settings."
      );
    }

    if (looksLikePhoneNumber(phoneNumberId)) {
      throw new Error(
        `WhatsApp "Phone Number ID" looks like a phone number (${phoneNumberId}). The Phone Number ID is a 15–16 digit Meta-issued identifier (NOT the visible phone number). Find it in WhatsApp Manager → API Setup → Phone numbers, then update Settings → WhatsApp Cloud API.`
      );
    }

    return new WhatsAppClient(phoneNumberId, accessToken, apiVersion);
  }

  /** Expose the WABA Phone Number ID this client is sending from. */
  getPhoneNumberId(): string {
    return this.phoneNumberId;
  }

  async sendTemplate(
    to: string,
    templateName: string,
    language: string,
    variables: string[],
    header?: WhatsAppTemplateHeader
  ): Promise<WhatsAppSendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

    const components: WhatsAppTemplateComponent[] = [];
    if (header) {
      let parameter: WhatsAppTemplateParameter;
      if (header.type === "image") {
        parameter = {
          type: "image",
          image:
            header.imageKind === "id"
              ? { id: header.value }
              : { link: header.value },
        };
      } else {
        parameter = { type: "text", text: header.value };
      }
      components.push({ type: "header", parameters: [parameter] });
    }
    if (variables.length > 0) {
      components.push({
        type: "body",
        parameters: variables.map((v) => ({ type: "text" as const, text: v })),
      });
    }

    const body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new WhatsAppApiError(response.status, errorBody);
    }

    return response.json();
  }

  /**
   * Send a free-form text message. Only valid inside Meta's 24-hour customer
   * service window — i.e. the recipient must have messaged us in the last
   * 24 hours. Outside the window Meta returns #131047 / #470 and the caller
   * should fall back to a template send.
   */
  async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new WhatsAppApiError(response.status, errorBody);
    }
    return response.json();
  }

  /**
   * Send a media message (image, video, audio, document, or sticker) using
   * a media_id previously uploaded via /media. Only valid inside Meta's
   * 24-hour customer service window — the recipient must have messaged us
   * in the last 24 hours.
   *
   * `mediaType` must be one of: "image", "video", "audio", "document",
   * "sticker". `caption` is supported on image/video/document only (Meta
   * silently drops it for audio/sticker). `filename` is required by Meta
   * for documents.
   */
  async sendMedia(
    to: string,
    mediaType: "image" | "video" | "audio" | "document" | "sticker",
    mediaId: string,
    opts?: { caption?: string; filename?: string }
  ): Promise<WhatsAppSendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const mediaPayload: Record<string, unknown> = { id: mediaId };
    if (opts?.caption && (mediaType === "image" || mediaType === "video" || mediaType === "document")) {
      mediaPayload.caption = opts.caption;
    }
    if (opts?.filename && mediaType === "document") {
      mediaPayload.filename = opts.filename;
    }
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: mediaType,
      [mediaType]: mediaPayload,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new WhatsAppApiError(response.status, errorBody);
    }
    return response.json();
  }

  /**
   * Send a one-off test message. Defaults to the user-configured template
   * (so they don't have to maintain a `hello_world` template just for tests),
   * but accepts overrides for ad-hoc verification.
   */
  async sendTestMessage(
    to: string,
    opts?: {
      templateName?: string;
      language?: string;
      variables?: string[];
      header?: WhatsAppTemplateHeader;
    }
  ): Promise<WhatsAppSendResult> {
    const templateName = opts?.templateName || "hello_world";
    const language = opts?.language || "en_US";
    const variables = opts?.variables ?? [];
    return this.sendTemplate(to, templateName, language, variables, opts?.header);
  }
}

export function buildTemplateVariables(
  customerName: string,
  orderId: string
): string[] {
  return [customerName || "Customer", orderId];
}
