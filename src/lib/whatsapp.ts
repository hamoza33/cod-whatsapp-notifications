import { getSetting, SETTING_KEYS } from "./settings";

interface WhatsAppTemplateComponent {
  type: "body" | "header" | "button";
  parameters: Array<{
    type: "text";
    text: string;
  }>;
}

interface WhatsAppSendResult {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
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

  static async fromSettings(): Promise<WhatsAppClient> {
    const phoneNumberId =
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

    return new WhatsAppClient(phoneNumberId, accessToken, apiVersion);
  }

  async sendTemplate(
    to: string,
    templateName: string,
    language: string,
    variables: string[]
  ): Promise<WhatsAppSendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

    const components: WhatsAppTemplateComponent[] = [];
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
      throw new Error(
        `WhatsApp API error (${response.status}): ${errorBody}`
      );
    }

    return response.json();
  }

  async sendTestMessage(to: string): Promise<WhatsAppSendResult> {
    return this.sendTemplate(to, "hello_world", "en_US", []);
  }
}

export function buildTemplateVariables(
  customerName: string,
  orderId: string
): string[] {
  return [customerName || "Customer", orderId];
}
