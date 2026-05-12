import { prisma } from "./prisma";

export async function getSetting(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  return setting?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function getSettings(
  keys: string[]
): Promise<Record<string, string | null>> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    result[key] = settings.find((s) => s.key === key)?.value ?? null;
  }
  return result;
}

export const SETTING_KEYS = {
  COD_API_TOKEN: "cod_network_api_token",
  COD_API_BASE_URL: "cod_network_api_base_url",
  COD_API_EMAIL: "cod_network_api_email",
  COD_API_PASSWORD: "cod_network_api_password",
  COD_API_TOKEN_CACHED: "cod_network_api_token_cached",
  COD_API_TOKEN_EXPIRES_AT: "cod_network_api_token_expires_at",
  // The COD Network "Webhook secret key" used to verify HMAC signatures on
  // inbound lead/order webhook payloads. See seller.cod.network → My Account
  // → API Developer → Webhook secret key.
  COD_WEBHOOK_SECRET: "cod_network_webhook_secret",
  WHATSAPP_PHONE_NUMBER_ID: "whatsapp_phone_number_id",
  WHATSAPP_ACCESS_TOKEN: "whatsapp_access_token",
  WHATSAPP_API_VERSION: "whatsapp_api_version",
  WHATSAPP_TEMPLATE_NAME: "whatsapp_template_name",
  WHATSAPP_TEMPLATE_LANGUAGE: "whatsapp_template_language",
  AUTOMATION_ENABLED: "automation_enabled",
  AUTOMATION_TRIGGER_STATUS: "automation_trigger_status",
  AUTOMATION_DELAY_SECONDS: "automation_delay_seconds",
  AUTOMATION_SEND_ONCE: "automation_send_once",
  DEFAULT_COUNTRY_CODE: "default_country_code",
  AUTO_SYNC_ENABLED: "auto_sync_enabled",
  AUTO_SYNC_INTERVAL_MINUTES: "auto_sync_interval_minutes",
  SYNC_DAYS_BACK: "sync_days_back",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "whatsapp_business_account_id",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "whatsapp_webhook_verify_token",
  // App Secret from the Meta App's "Basic" settings — used to verify the
  // X-Hub-Signature-256 header on inbound webhook payloads. If unset the
  // webhook accepts any payload (intended only for local testing).
  WHATSAPP_APP_SECRET: "whatsapp_app_secret",
  WHATSAPP_DEFAULT_TEMPLATE_HEADER_IMAGE_URL: "whatsapp_default_template_header_image_url",
  // ISO timestamp recording when `whatsapp_templates` was last refreshed
  // from Meta. Used by the auto-import refresh window logic.
  WHATSAPP_TEMPLATES_LAST_IMPORT_AT: "whatsapp_templates_last_import_at",
  AI_AGENT_ENABLED: "ai_agent_enabled",
  OPENAI_API_KEY: "openai_api_key",
  AI_AGENT_MODEL: "ai_agent_model",
  AI_AGENT_SYSTEM_PROMPT: "ai_agent_system_prompt",
  AI_AGENT_MAX_TOKENS: "ai_agent_max_tokens",
  AI_AGENT_PRODUCT_TYPES: "ai_agent_product_types",
} as const;

export const SENSITIVE_SETTING_KEYS: readonly string[] = [
  SETTING_KEYS.COD_API_TOKEN,
  SETTING_KEYS.COD_API_PASSWORD,
  SETTING_KEYS.COD_WEBHOOK_SECRET,
  SETTING_KEYS.WHATSAPP_ACCESS_TOKEN,
  SETTING_KEYS.WHATSAPP_APP_SECRET,
  SETTING_KEYS.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  SETTING_KEYS.OPENAI_API_KEY,
];

/**
 * "Maskable" keys aren't strictly secret (Phone Number ID, Business Account
 * ID, template name) but the operator asked for the same first-4 / last-2
 * mask treatment so they can verify which value is saved at a glance without
 * having to keep it in their head. We null out the input on GET and show the
 * preview as a chip beside the label — same UX as secrets but conceptually
 * just "identifiers".
 */
export const MASKABLE_SETTING_KEYS: readonly string[] = [
  SETTING_KEYS.COD_API_EMAIL,
  SETTING_KEYS.WHATSAPP_PHONE_NUMBER_ID,
  SETTING_KEYS.WHATSAPP_BUSINESS_ACCOUNT_ID,
  SETTING_KEYS.WHATSAPP_TEMPLATE_NAME,
];

export const INTERNAL_SETTING_KEYS: readonly string[] = [
  SETTING_KEYS.COD_API_TOKEN_CACHED,
  SETTING_KEYS.COD_API_TOKEN_EXPIRES_AT,
];

/**
 * Generates a "preview mask" for a sensitive setting value: the first 4 chars
 * verbatim, then 8 dots, then the last 2 chars. So `kuwait_ezihear_no_reply`
 * becomes `kuwa••••••••ly`. Lets the operator confirm "yes, the right value is
 * saved" without exposing the full secret in the response payload.
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "••••••";
  const head = value.slice(0, 4);
  const tail = value.slice(-2);
  return `${head}••••••••${tail}`;
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}
