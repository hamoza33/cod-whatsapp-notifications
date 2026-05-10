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
} as const;
