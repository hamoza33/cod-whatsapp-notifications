"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Save, RefreshCw, AlertTriangle } from "lucide-react";
import { looksLikePhoneNumber } from "@/lib/whatsapp-validation";

interface SettingsData {
  [key: string]: string | null;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [configuredSecrets, setConfiguredSecrets] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchSettings() {
      try {
        const data = await api.get<{ settings: SettingsData; sensitiveKeysSet: string[] }>("/settings");
        if (!cancelled) {
          setSettings(data.settings);
          setConfiguredSecrets(new Set(data.sensitiveKeysSet || []));
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchSettings();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async (section: string, keys: string[]) => {
    setSaving(true);
    setNotification(null);
    try {
      const updates: Record<string, string> = {};
      for (const key of keys) {
        if (dirtyKeys.has(key) && settings[key] !== null && settings[key] !== undefined) {
          updates[key] = settings[key] as string;
        }
      }
      if (Object.keys(updates).length === 0) {
        setNotification({ type: "success", message: "No changes to save." });
        setSaving(false);
        return;
      }
      await api.put("/settings", { settings: updates });
      setNotification({
        type: "success",
        message: `${section} settings saved!`,
      });
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirtyKeys((prev) => new Set(prev).add(key));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

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

      {/* COD Network Settings */}
      <SettingsSection
        title="COD Network API"
        description="Connect to api.cod.network. Email + password is the recommended flow per the COD Network docs and yields a 1-hour access_token that the app refreshes automatically."
        onSave={() =>
          handleSave("COD Network", [
            "cod_network_api_base_url",
            "cod_network_api_email",
            "cod_network_api_password",
            "cod_network_api_token",
          ])
        }
        saving={saving}
      >
        <SettingsField
          label="API Base URL"
          value={settings.cod_network_api_base_url || ""}
          onChange={(v) => updateSetting("cod_network_api_base_url", v)}
          placeholder="https://api.cod.network/v2"
        />
        <SettingsField
          label="Seller Email (recommended)"
          value={settings.cod_network_api_email || ""}
          onChange={(v) => updateSetting("cod_network_api_email", v)}
          type="email"
          placeholder="you@example.com"
          help="Your COD Network seller portal email. Used with the password below to obtain a fresh access_token from POST /v2/seller/login."
        />
        <SettingsField
          label="Seller Password (recommended)"
          value={settings.cod_network_api_password || ""}
          onChange={(v) => updateSetting("cod_network_api_password", v)}
          type="password"
          placeholder={
            configuredSecrets.has("cod_network_api_password")
              ? "Currently configured — enter a new value to replace"
              : "Your COD Network seller portal password"
          }
        />
        <SettingsField
          label="API Token (legacy fallback)"
          value={settings.cod_network_api_token || ""}
          onChange={(v) => updateSetting("cod_network_api_token", v)}
          type="password"
          placeholder={
            configuredSecrets.has("cod_network_api_token")
              ? "Currently configured — enter a new value to replace"
              : "Optional — used only if email/password are not set"
          }
          help="Tokens generated from the seller portal's API Developer page may be rejected by api.cod.network. Prefer email + password."
        />
      </SettingsSection>

      {/* WhatsApp Settings */}
      <SettingsSection
        title="WhatsApp Cloud API"
        description="Configure your Meta WhatsApp Cloud API credentials. The Phone Number ID is NOT your visible phone number — it's a 15–16 digit Meta-issued ID from WhatsApp Manager → API Setup → Phone numbers."
        onSave={() =>
          handleSave("WhatsApp", [
            "whatsapp_phone_number_id",
            "whatsapp_access_token",
            "whatsapp_api_version",
            "whatsapp_template_name",
            "whatsapp_template_language",
          ])
        }
        saving={saving}
      >
        <SettingsField
          label="Phone Number ID"
          value={settings.whatsapp_phone_number_id || ""}
          onChange={(v) => updateSetting("whatsapp_phone_number_id", v)}
          placeholder="e.g. 906139205908177"
          warning={
            looksLikePhoneNumber(settings.whatsapp_phone_number_id || "")
              ? 'This looks like a phone number, not a Phone Number ID. The Phone Number ID is a 15–16 digit Meta-issued identifier (find it in WhatsApp Manager → API Setup → Phone numbers).'
              : undefined
          }
        />
        <SettingsField
          label="Access Token"
          value={settings.whatsapp_access_token || ""}
          onChange={(v) => updateSetting("whatsapp_access_token", v)}
          type="password"
          placeholder={configuredSecrets.has("whatsapp_access_token") ? "Currently configured — enter new value to replace" : "Your WhatsApp Access Token"}
        />
        <SettingsField
          label="API Version"
          value={settings.whatsapp_api_version || "v17.0"}
          onChange={(v) => updateSetting("whatsapp_api_version", v)}
          placeholder="v17.0"
        />
        <SettingsField
          label="Template Name"
          value={settings.whatsapp_template_name || "order_out_for_delivery"}
          onChange={(v) => updateSetting("whatsapp_template_name", v)}
          placeholder="order_out_for_delivery"
          help="Must be an APPROVED template on your WhatsApp Business Account. The Test Message button uses this template by default."
        />
        <SettingsField
          label="Template Language"
          value={settings.whatsapp_template_language || "en"}
          onChange={(v) => updateSetting("whatsapp_template_language", v)}
          placeholder="en"
        />
        <SettingsField
          label="WhatsApp Business Account ID"
          value={settings.whatsapp_business_account_id || ""}
          onChange={(v) => updateSetting("whatsapp_business_account_id", v)}
          placeholder="e.g. 1234567890123456"
          help="Used to fetch your approved templates so the app can show variable counts. Find it in WhatsApp Manager → API Setup → Business Account."
        />
        <SettingsField
          label="Default Header Image URL"
          value={settings.whatsapp_default_template_header_image_url || ""}
          onChange={(v) =>
            updateSetting("whatsapp_default_template_header_image_url", v)
          }
          placeholder="https://example.com/header.jpg"
          help="Fallback image used when a template requires an IMAGE header but none is provided per-message."
        />
        <SettingsField
          label="Webhook Verify Token"
          value={settings.whatsapp_webhook_verify_token || ""}
          onChange={(v) => updateSetting("whatsapp_webhook_verify_token", v)}
          placeholder="any random string, e.g. cod-wa-verify-2026"
          help="Pasted into Meta App → WhatsApp → Configuration → Verify Token. Must match exactly. Used by /api/whatsapp/webhook for the GET handshake."
        />
        <SettingsField
          label="App Secret"
          value={settings.whatsapp_app_secret || ""}
          onChange={(v) => updateSetting("whatsapp_app_secret", v)}
          placeholder="From Meta App → Settings → Basic → App Secret"
          type="password"
          help="Used to verify the X-Hub-Signature-256 header on inbound webhook payloads. If left blank the webhook accepts any payload — only safe for local testing."
        />
      </SettingsSection>

      {/* Sync Settings */}
      <SettingsSection
        title="Order Sync"
        description="Pull orders from COD Network on a schedule. Auto-sync runs in the same Node process as the web app — for serverless deployments, set up an external cron calling /api/cron/sync."
        onSave={() =>
          handleSave("Order Sync", [
            "auto_sync_enabled",
            "auto_sync_interval_minutes",
            "sync_days_back",
          ])
        }
        saving={saving}
      >
        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm font-medium text-gray-700">
            Enable Auto-Sync
          </label>
          <button
            onClick={() =>
              updateSetting(
                "auto_sync_enabled",
                settings.auto_sync_enabled === "false" ? "true" : "false"
              )
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              settings.auto_sync_enabled !== "false"
                ? "bg-blue-600"
                : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.auto_sync_enabled !== "false"
                  ? "translate-x-6"
                  : "translate-x-1"
              }`}
            />
          </button>
        </div>
        <SettingsField
          label="Auto-Sync Interval (minutes)"
          value={settings.auto_sync_interval_minutes || "5"}
          onChange={(v) => updateSetting("auto_sync_interval_minutes", v)}
          type="number"
          placeholder="5"
          help="How often to pull new orders. Minimum 1 minute. Default 5 minutes. Restart the app for interval changes to take effect."
        />
        <SettingsField
          label="Sync Window (days back)"
          value={settings.sync_days_back || "30"}
          onChange={(v) => updateSetting("sync_days_back", v)}
          type="number"
          placeholder="30"
          help="Only orders placed within this many days are pulled, keeping each sync fast. Default 30."
        />
      </SettingsSection>

      {/* Automation Settings */}
      <SettingsSection
        title="Automation"
        description="Configure automatic WhatsApp message sending."
        onSave={() =>
          handleSave("Automation", [
            "automation_enabled",
            "automation_trigger_status",
            "automation_delay_seconds",
            "automation_send_once",
            "default_country_code",
          ])
        }
        saving={saving}
      >
        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm font-medium text-gray-700">
            Enable Automation
          </label>
          <button
            onClick={() =>
              updateSetting(
                "automation_enabled",
                settings.automation_enabled === "true" ? "false" : "true"
              )
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              settings.automation_enabled === "true"
                ? "bg-blue-600"
                : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.automation_enabled === "true"
                  ? "translate-x-6"
                  : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <SettingsField
          label="Trigger Status (comma-separated)"
          value={
            settings.automation_trigger_status || "SHIPPED,OUT_FOR_DELIVERY"
          }
          onChange={(v) => updateSetting("automation_trigger_status", v)}
          placeholder="SHIPPED,OUT_FOR_DELIVERY"
        />
        <SettingsField
          label="Delay Before Sending (seconds)"
          value={settings.automation_delay_seconds || "0"}
          onChange={(v) => updateSetting("automation_delay_seconds", v)}
          type="number"
          placeholder="0"
        />
        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm font-medium text-gray-700">
            Send Only Once Per Order
          </label>
          <button
            onClick={() =>
              updateSetting(
                "automation_send_once",
                settings.automation_send_once === "false" ? "true" : "false"
              )
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              settings.automation_send_once !== "false"
                ? "bg-blue-600"
                : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.automation_send_once !== "false"
                  ? "translate-x-6"
                  : "translate-x-1"
              }`}
            />
          </button>
        </div>
        <SettingsField
          label="Default Country Code"
          value={settings.default_country_code || "212"}
          onChange={(v) => updateSetting("default_country_code", v)}
          placeholder="212"
        />
      </SettingsSection>
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
  onSave,
  saving,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">{title}</h2>
      <p className="text-sm text-gray-500 mb-4">{description}</p>
      {children}
      <button
        onClick={onSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors mt-2"
      >
        <Save size={16} />
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

function SettingsField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  help,
  warning,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  help?: string;
  warning?: string;
}) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
          warning ? "border-amber-400 bg-amber-50" : "border-gray-300"
        }`}
      />
      {warning && (
        <p className="mt-1 flex items-start gap-1 text-xs text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </p>
      )}
      {help && !warning && (
        <p className="mt-1 text-xs text-gray-500">{help}</p>
      )}
    </div>
  );
}
