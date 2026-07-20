"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Save, RefreshCw, AlertTriangle, Trash2, Star, Plus, Eye, EyeOff } from "lucide-react";
import { looksLikePhoneNumber } from "@/lib/whatsapp-validation";

interface SettingsData {
  [key: string]: string | null;
}

const TABS = [
  { id: "cod", label: "COD Network" },
  { id: "webhooks", label: "Webhooks" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "wa_numbers", label: "WA Numbers" },
  { id: "wa_support", label: "WA Support" },
  { id: "wa_sources", label: "Sources" },
  { id: "sync", label: "Order Sync" },
  { id: "tracking", label: "Tracking" },
  { id: "automation", label: "Automation" },
  { id: "ai", label: "AI Agent" },
  { id: "voice", label: "Voice Agent" },
] as const;

const TRACKING_REFRESH_OPTIONS = [
  { label: "Every 30 min", value: "30" },
  { label: "Every 1 hour", value: "60" },
  { label: "Every 6 hours", value: "360" },
  { label: "Every 12 hours", value: "720" },
  { label: "Once a day", value: "1440" },
];

interface WhatsappNumberRecord {
  id: string;
  label: string;
  phoneNumberId: string;
  displayPhone: string;
  isDefault: boolean;
}

type TabId = (typeof TABS)[number]["id"];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [configuredSecrets, setConfiguredSecrets] = useState<Set<string>>(new Set());
  const [sensitivePreviews, setSensitivePreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("cod");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchSettings() {
      try {
        const data = await api.get<{
          settings: SettingsData;
          sensitiveKeysSet: string[];
          maskableKeysSet?: string[];
          sensitivePreviews?: Record<string, string>;
        }>("/settings");
        if (!cancelled) {
          setSettings(data.settings);
          setConfiguredSecrets(
            new Set([
              ...(data.sensitiveKeysSet || []),
              ...(data.maskableKeysSet || []),
            ])
          );
          setSensitivePreviews(data.sensitivePreviews || {});
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

  // Honor a `#<tab-id>` hash on the URL so deep links from elsewhere in
  // the app (e.g. the per-row "Captcha key required" pill on /tracking
  // links to /settings#tracking) land the operator on the right tab
  // instead of the default "cod" tab. Listening to `hashchange` lets
  // this work for both initial load and in-page navigation.
  useEffect(() => {
    function applyHash() {
      if (typeof window === "undefined") return;
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const match = TABS.find((t) => t.id === hash);
      if (match) setActiveTab(match.id);
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
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
    <div className="max-w-4xl">
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

      {/* Tab bar */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-0 -mb-px overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* COD Network */}
      {activeTab === "cod" && (
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
            configuredPreview={sensitivePreviews.cod_network_api_email}
            settingKey="cod_network_api_email"
            placeholder={
              configuredSecrets.has("cod_network_api_email")
                ? "Currently configured — enter a new value to replace"
                : "you@example.com"
            }
            help="Your COD Network seller portal email. Used with the password below to obtain a fresh access_token from POST /v2/seller/login."
          />
          <SettingsField
            label="Seller Password (recommended)"
            value={settings.cod_network_api_password || ""}
            onChange={(v) => updateSetting("cod_network_api_password", v)}
            type="password"
            configuredPreview={sensitivePreviews.cod_network_api_password}
            settingKey="cod_network_api_password"
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
            configuredPreview={sensitivePreviews.cod_network_api_token}
            settingKey="cod_network_api_token"
            placeholder={
              configuredSecrets.has("cod_network_api_token")
                ? "Currently configured — enter a new value to replace"
                : "Optional — used only if email/password are not set"
            }
            help="Tokens generated from the seller portal's API Developer page may be rejected by api.cod.network. Prefer email + password."
          />
        </SettingsSection>
      )}

      {/* Webhooks */}
      {activeTab === "webhooks" && (
        <SettingsSection
          title="COD Network Webhooks"
          description="Paste these URLs into seller.cod.network → My Account → API Developer → Webhook Lead Status / Webhook Order Status."
          onSave={() =>
            handleSave("COD Webhooks", ["cod_network_webhook_secret"])
          }
          saving={saving}
        >
          <SettingsField
            label="Webhook Secret Key"
            value={settings.cod_network_webhook_secret || ""}
            onChange={(v) => updateSetting("cod_network_webhook_secret", v)}
            type="password"
            configuredPreview={sensitivePreviews.cod_network_webhook_secret}
            settingKey="cod_network_webhook_secret"
            placeholder={
              configuredSecrets.has("cod_network_webhook_secret")
                ? "Currently configured — enter a new value to replace"
                : "The 'Webhook secret key' from your COD Network account"
            }
            help="From seller.cod.network → My Account → API Developer → Webhook secret key. Used to verify HMAC-SHA256 signatures."
          />
          <WebhookUrlReadout name="Lead Status" path="/api/cod-network/webhook/leads" />
          <WebhookUrlReadout name="Order Status" path="/api/cod-network/webhook/orders" />
        </SettingsSection>
      )}

      {/* WhatsApp */}
      {activeTab === "whatsapp" && (
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
              "whatsapp_business_account_id",
              "whatsapp_default_template_header_image_url",
              "whatsapp_webhook_verify_token",
              "whatsapp_app_secret",
            ])
          }
          saving={saving}
        >
          <SettingsField
            label="Phone Number ID"
            value={settings.whatsapp_phone_number_id || ""}
            onChange={(v) => updateSetting("whatsapp_phone_number_id", v)}
            configuredPreview={sensitivePreviews.whatsapp_phone_number_id}
            settingKey="whatsapp_phone_number_id"
            placeholder={
              configuredSecrets.has("whatsapp_phone_number_id")
                ? "Currently configured — enter a new value to replace"
                : "e.g. 906139205908177"
            }
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
            configuredPreview={sensitivePreviews.whatsapp_access_token}
            settingKey="whatsapp_access_token"
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
            value={settings.whatsapp_template_name || ""}
            onChange={(v) => updateSetting("whatsapp_template_name", v)}
            configuredPreview={sensitivePreviews.whatsapp_template_name}
            settingKey="whatsapp_template_name"
            placeholder={
              configuredSecrets.has("whatsapp_template_name")
                ? "Currently configured — enter a new value to replace"
                : "order_out_for_delivery"
            }
            help="Must be an APPROVED template on your WhatsApp Business Account."
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
            configuredPreview={sensitivePreviews.whatsapp_business_account_id}
            settingKey="whatsapp_business_account_id"
            placeholder={
              configuredSecrets.has("whatsapp_business_account_id")
                ? "Currently configured — enter a new value to replace"
                : "e.g. 1234567890123456"
            }
            help="Used to fetch your approved templates. Find it in WhatsApp Manager → API Setup → Business Account."
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
            type="password"
            configuredPreview={sensitivePreviews.whatsapp_webhook_verify_token}
            settingKey="whatsapp_webhook_verify_token"
            placeholder="any random string, e.g. cod-wa-verify-2026"
            help="Pasted into Meta App → WhatsApp → Configuration → Verify Token."
          />
          <SettingsField
            label="App Secret"
            value={settings.whatsapp_app_secret || ""}
            onChange={(v) => updateSetting("whatsapp_app_secret", v)}
            placeholder="From Meta App → Settings → Basic → App Secret"
            type="password"
            configuredPreview={sensitivePreviews.whatsapp_app_secret}
            settingKey="whatsapp_app_secret"
            help="Used to verify X-Hub-Signature-256 on inbound webhook payloads. If blank, the webhook accepts any payload."
          />
        </SettingsSection>
      )}

      {/* WhatsApp Support */}
      {activeTab === "wa_support" && (
        <SettingsSection
          title="WhatsApp Support"
          description="Configure a separate WhatsApp Business account for customer support. These credentials are entirely independent from the main WhatsApp setup, allowing you to manage support conversations in a dedicated inbox."
          onSave={() =>
            handleSave("WhatsApp Support", [
              "wa_support_business_account_id",
              "wa_support_phone_number_id",
              "wa_support_access_token",
              "wa_support_api_key",
              "wa_support_app_secret",
              "wa_support_webhook_verify_token",
              "wa_support_ai_enabled",
              "wa_support_ai_api_key",
              "wa_support_ai_system_prompt",
              "wa_support_ai_model",
              "wa_support_display_phone",
            ])
          }
          saving={saving}
        >
          <SettingsField
            label="WhatsApp Business Account ID"
            value={settings.wa_support_business_account_id || ""}
            onChange={(v) => updateSetting("wa_support_business_account_id", v)}
            configuredPreview={sensitivePreviews.wa_support_business_account_id}
            settingKey="wa_support_business_account_id"
            placeholder={
              configuredSecrets.has("wa_support_business_account_id")
                ? "Currently configured — enter a new value to replace"
                : "e.g. 123456789012345"
            }
          />
          <SettingsField
            label="Phone Number ID"
            value={settings.wa_support_phone_number_id || ""}
            onChange={(v) => updateSetting("wa_support_phone_number_id", v)}
            configuredPreview={sensitivePreviews.wa_support_phone_number_id}
            settingKey="wa_support_phone_number_id"
            placeholder={
              configuredSecrets.has("wa_support_phone_number_id")
                ? "Currently configured — enter a new value to replace"
                : "e.g. 906139205908177"
            }
          />
          <SettingsField
            label="Access Token"
            value={settings.wa_support_access_token || ""}
            onChange={(v) => updateSetting("wa_support_access_token", v)}
            type="password"
            configuredPreview={sensitivePreviews.wa_support_access_token}
            settingKey="wa_support_access_token"
            placeholder={configuredSecrets.has("wa_support_access_token") ? "Currently configured — enter new value to replace" : "Permanent access token for support line"}
          />
          <SettingsField
            label="API Key"
            value={settings.wa_support_api_key || ""}
            onChange={(v) => updateSetting("wa_support_api_key", v)}
            type="password"
            configuredPreview={sensitivePreviews.wa_support_api_key}
            settingKey="wa_support_api_key"
            placeholder={configuredSecrets.has("wa_support_api_key") ? "Currently configured — enter new value to replace" : "API key for WhatsApp Support line"}
          />
          <SettingsField
            label="App Secret"
            value={settings.wa_support_app_secret || ""}
            onChange={(v) => updateSetting("wa_support_app_secret", v)}
            type="password"
            configuredPreview={sensitivePreviews.wa_support_app_secret}
            settingKey="wa_support_app_secret"
            placeholder={configuredSecrets.has("wa_support_app_secret") ? "Currently configured — enter new value to replace" : "Meta App Secret for webhook signature verification"}
          />
          <SettingsField
            label="Webhook Verify Token"
            value={settings.wa_support_webhook_verify_token || ""}
            onChange={(v) => updateSetting("wa_support_webhook_verify_token", v)}
            configuredPreview={sensitivePreviews.wa_support_webhook_verify_token}
            settingKey="wa_support_webhook_verify_token"
            placeholder={
              configuredSecrets.has("wa_support_webhook_verify_token")
                ? "Currently configured — enter a new value to replace"
                : "Token to verify webhook subscription"
            }
            help="Point your Meta webhook to: /api/whatsapp-support/webhook"
          />
          <SettingsField
            label="Display Phone Number (for /wa/ redirect links)"
            value={settings.wa_support_display_phone || ""}
            onChange={(v) => updateSetting("wa_support_display_phone", v)}
            placeholder="+447830607451"
            help="The actual phone number customers will message (with country code). Used for /wa/<source> redirect links. E.g. +447830607451"
          />
          <div className="border-t border-gray-200 pt-4 mt-4">
            <h4 className="text-sm font-semibold text-gray-800 mb-3">Support AI Agent</h4>
            <p className="text-xs text-gray-500 mb-3">This AI agent is independent of the main WhatsApp AI agent. It uses its own API key and system prompt.</p>
            <div className="flex items-center gap-3 mb-4">
              <label className="text-sm font-medium text-gray-700">
                Enable Auto-Reply
              </label>
              <button
                onClick={() =>
                  updateSetting(
                    "wa_support_ai_enabled",
                    settings.wa_support_ai_enabled === "true" ? "false" : "true"
                  )
                }
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settings.wa_support_ai_enabled === "true"
                    ? "bg-blue-600"
                    : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    settings.wa_support_ai_enabled === "true"
                      ? "translate-x-6"
                      : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <SettingsField
              label="AI API Key"
              value={settings.wa_support_ai_api_key || ""}
              onChange={(v) => updateSetting("wa_support_ai_api_key", v)}
              type="password"
              configuredPreview={sensitivePreviews.wa_support_ai_api_key}
              settingKey="wa_support_ai_api_key"
              placeholder={configuredSecrets.has("wa_support_ai_api_key") ? "Currently configured — enter new value to replace" : "OpenAI API Key for support agent"}
            />
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                AI Model
              </label>
              <select
                value={settings.wa_support_ai_model || "gpt-4o-mini"}
                onChange={(e) => updateSetting("wa_support_ai_model", e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="gpt-4o-mini">GPT-4o Mini</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
                <option value="gpt-4.1">GPT-4.1</option>
                <option value="gpt-4.1-nano">GPT-4.1 Nano</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                <option value="o4-mini">o4-mini</option>
                <option value="o3-mini">o3-mini</option>
                <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                System Prompt
              </label>
              <textarea
                value={settings.wa_support_ai_system_prompt || ""}
                onChange={(e) => updateSetting("wa_support_ai_system_prompt", e.target.value)}
                rows={5}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="You are a helpful customer support agent..."
              />
              <p className="mt-1 text-xs text-gray-500">
                Instructions for the support AI agent. This is independent of the main AI agent.
              </p>
            </div>
          </div>
        </SettingsSection>
      )}

      {/* Support Sources */}
      {activeTab === "wa_sources" && <SupportSourcesManager />}

      {/* Order Sync */}
      {activeTab === "sync" && (
        <SettingsSection
          title="Order Sync"
          description="Pull orders from COD Network on a schedule."
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
            help="How often to pull new orders. Minimum 1 minute."
          />
          <SettingsField
            label="Sync Window (days back)"
            value={settings.sync_days_back || "30"}
            onChange={(v) => updateSetting("sync_days_back", v)}
            type="number"
            placeholder="30"
            help="Only orders placed within this many days are pulled."
          />
        </SettingsSection>
      )}

      {/* Automation */}
      {activeTab === "automation" && (
        <SettingsSection
          title="Automation"
          description="Configure automatic WhatsApp message sending."
          onSave={() =>
            handleSave("Automation", [
              "automation_enabled",
              "automation_trigger_status",
              "automation_delay_seconds",
              "automation_send_once",
              "automation_timezone",
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
            label="Automation Timezone (IANA)"
            value={settings.automation_timezone || "UTC"}
            onChange={(v) => updateSetting("automation_timezone", v)}
            placeholder="UTC"
          />
          <p className="text-xs text-gray-500 -mt-2 mb-4">
            Timezone used to evaluate scheduled-hour automations (e.g. &quot;send
            after 6 AM&quot;). Use an IANA name like{" "}
            <code>Africa/Casablanca</code>, <code>Europe/London</code>, or{" "}
            <code>UTC</code>. A rule scheduled for hour H fires for matching
            orders once the local time reaches H:00.
          </p>
          <SettingsField
            label="Default Country Code"
            value={settings.default_country_code || "212"}
            onChange={(v) => updateSetting("default_country_code", v)}
            placeholder="212"
          />
        </SettingsSection>
      )}

      {/* Tracking */}
      {activeTab === "tracking" && (
        <SettingsSection
          title="Package Tracking"
          description="Configure carrier tracking refresh cadence and the captcha solver used by JD Logistics (JDW) when their site challenges. The /tracking page also has a quick refresh-interval selector that mirrors this tab — both write to the same setting."
          onSave={() =>
            handleSave("Tracking", [
              "captcha_provider",
              "captcha_api_key",
              "tracking_refresh_interval_minutes",
              "courier_jte_provider",
              "courier_jte_batch_size",
            ])
          }
          saving={saving}
        >
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Refresh Interval
            </label>
            <div className="flex gap-2 flex-wrap">
              {TRACKING_REFRESH_OPTIONS.map((opt) => {
                const current =
                  settings.tracking_refresh_interval_minutes || "60";
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      updateSetting("tracking_refresh_interval_minutes", opt.value)
                    }
                    className={`px-3 py-1.5 text-sm rounded-md border ${
                      current === opt.value
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Background cron cadence for refreshing pending and in-transit orders. Click Save below to apply.
            </p>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Captcha Provider
            </label>
            <select
              value={settings.captcha_provider || "2captcha"}
              onChange={(e) => updateSetting("captcha_provider", e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="2captcha">2Captcha</option>
              <option value="anti-captcha" disabled>
                Anti-Captcha (coming soon)
              </option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Service used to solve captcha challenges from carrier APIs. Currently 2Captcha is the only working provider.
            </p>
          </div>
          <SettingsField
            label="Captcha API Key"
            value={settings.captcha_api_key || ""}
            onChange={(v) => updateSetting("captcha_api_key", v)}
            type="password"
            configuredPreview={sensitivePreviews.captcha_api_key}
            settingKey="captcha_api_key"
            placeholder={
              configuredSecrets.has("captcha_api_key")
                ? "Currently configured — enter a new value to replace"
                : "Your 2Captcha API key"
            }
            help="Only used when JD Logistics (JDW) tracking responses challenge with a captcha. Optional — without a key, JDW rows are marked captcha_required when challenged."
          />

          <div className="mt-6 mb-4 border-t border-gray-200 pt-4">
            <h4 className="text-sm font-semibold text-gray-800 mb-1">
              J&amp;T Express (JTE)
            </h4>
            <p className="text-xs text-gray-500 mb-3">
              J&amp;T tracking is handled by the courier tracking service. The
              captcha keys (2Captcha / Capsolver) and worker concurrency live on
              that service. Here you control which provider the dashboard
              requests and how many waybills it sends per request.
            </p>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              J&amp;T Provider
            </label>
            <select
              value={settings.courier_jte_provider || "auto"}
              onChange={(e) =>
                updateSetting("courier_jte_provider", e.target.value)
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="auto">Auto (TrackingMore → Tencent fallback)</option>
              <option value="trackingmore">TrackingMore only</option>
              <option value="tencent">Tencent captcha only</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              &quot;Auto&quot; tries TrackingMore first (fast) and falls back to
              the Tencent captcha solver on failure.
            </p>
          </div>
          <SettingsField
            label="J&T Batch Size"
            value={settings.courier_jte_batch_size || "20"}
            onChange={(v) => updateSetting("courier_jte_batch_size", v)}
            type="number"
            placeholder="20"
            help="Waybills sent per tracking request (1–20). The service groups internally: TrackingMore/auto up to 20, Tencent up to 10."
          />
        </SettingsSection>
      )}

      {/* AI Agent */}
      {activeTab === "ai" && (
        <SettingsSection
          title="AI Auto-Reply Agent"
          description="Configure an AI agent that automatically responds to incoming WhatsApp messages using ChatGPT. The agent will reply based on the product ordered and your custom instructions."
          onSave={() =>
            handleSave("AI Agent", [
              "ai_agent_enabled",
              "openai_api_key",
              "ai_agent_model",
              "ai_agent_system_prompt",
              "ai_agent_max_tokens",
              "ai_agent_product_types",
              "ai_suggestions_enabled",
              "ai_suggestions_count",
              "ai_suggestions_system_prompt",
            ])
          }
          saving={saving}
        >
          <div className="flex items-center gap-3 mb-4">
            <label className="text-sm font-medium text-gray-700">
              Enable AI Auto-Reply
            </label>
            <button
              onClick={() =>
                updateSetting(
                  "ai_agent_enabled",
                  settings.ai_agent_enabled === "true" ? "false" : "true"
                )
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.ai_agent_enabled === "true"
                  ? "bg-blue-600"
                  : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.ai_agent_enabled === "true"
                    ? "translate-x-6"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <SettingsField
            label="OpenAI API Key"
            value={settings.openai_api_key || ""}
            onChange={(v) => updateSetting("openai_api_key", v)}
            type="password"
            configuredPreview={sensitivePreviews.openai_api_key}
            settingKey="openai_api_key"
            placeholder={
              configuredSecrets.has("openai_api_key")
                ? "Currently configured — enter a new value to replace"
                : "sk-..."
            }
            help="Your OpenAI API key from platform.openai.com/api-keys"
          />
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Model
            </label>
            <select
              value={settings.ai_agent_model || "gpt-4o-mini"}
              onChange={(e) => updateSetting("ai_agent_model", e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="gpt-4o-mini">GPT-4o Mini (fast, cost-effective)</option>
              <option value="gpt-4o">GPT-4o (high quality)</option>
              <option value="gpt-4.1-mini">GPT-4.1 Mini (latest mini)</option>
              <option value="gpt-4.1">GPT-4.1 (latest)</option>
              <option value="gpt-4.1-nano">GPT-4.1 Nano (fastest)</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo (legacy, cheapest)</option>
              <option value="o4-mini">o4-mini (reasoning)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Select the OpenAI model for AI auto-replies.
            </p>
          </div>
          <SettingsField
            label="Max Response Tokens"
            value={settings.ai_agent_max_tokens || "300"}
            onChange={(v) => updateSetting("ai_agent_max_tokens", v)}
            type="number"
            placeholder="300"
            help="Maximum tokens in the AI response. Keep short for WhatsApp."
          />
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              System Prompt
            </label>
            <textarea
              value={settings.ai_agent_system_prompt || ""}
              onChange={(e) => updateSetting("ai_agent_system_prompt", e.target.value)}
              rows={6}
              placeholder={`You are a helpful customer service agent for a delivery company. When a customer messages you:\n- Check their order status based on the product they ordered\n- Provide helpful shipping updates\n- Be polite and professional\n- Keep responses short for WhatsApp\n- Reply in the customer's language`}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Instructions for the AI agent. Use {"{customer_name}"}, {"{product}"}, {"{order_status}"}, {"{tracking}"} as placeholders — they will be replaced with real order data.
            </p>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Product Type Filter
            </label>
            <input
              type="text"
              value={settings.ai_agent_product_types || ""}
              onChange={(e) => updateSetting("ai_agent_product_types", e.target.value)}
              placeholder="e.g. Gadget, Beauty (comma-separated, or leave empty for all)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Comma-separated list of product types. AI agent will only auto-respond for orders matching these types. Leave empty to respond to all products.
            </p>
          </div>

          <div className="border-t border-gray-200 pt-4 mt-4">
            <h3 className="text-base font-semibold text-gray-900 mb-3">AI Reply Suggestions</h3>
            <p className="text-sm text-gray-500 mb-4">
              Generate AI-powered reply suggestions in the Inbox chat. Click the sparkle button to get suggested replies based on conversation history and order details.
            </p>
            <div className="flex items-center gap-3 mb-4">
              <label className="text-sm font-medium text-gray-700">
                Enable AI Suggestions
              </label>
              <button
                onClick={() =>
                  updateSetting(
                    "ai_suggestions_enabled",
                    settings.ai_suggestions_enabled === "true" ? "false" : "true"
                  )
                }
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settings.ai_suggestions_enabled === "true"
                    ? "bg-blue-600"
                    : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    settings.ai_suggestions_enabled === "true"
                      ? "translate-x-6"
                      : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <SettingsField
              label="Number of Suggestions"
              value={settings.ai_suggestions_count || "3"}
              onChange={(v) => updateSetting("ai_suggestions_count", v)}
              type="number"
              placeholder="3"
              help="How many reply suggestions to generate (1-5)."
            />
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Suggestions System Prompt
              </label>
              <textarea
                value={settings.ai_suggestions_system_prompt || ""}
                onChange={(e) => updateSetting("ai_suggestions_system_prompt", e.target.value)}
                rows={4}
                placeholder="You are a helpful customer service agent for a COD company. Generate short, professional WhatsApp reply suggestions. Keep each suggestion concise (1-2 sentences max). Reply in the same language as the customer."
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Custom instructions for generating reply suggestions. Leave empty for default behavior.
              </p>
            </div>
          </div>
        </SettingsSection>
      )}

      {activeTab === "voice" && (
        <SettingsSection
          title="Voice Agent — Vapi"
          description="Integrate Vapi for automated voice calls. When a lead or order is moved to the 'Call Agent' pipeline column, the system initiates a call via Vapi with all customer variables. Configure your assistant at dashboard.vapi.ai."
          onSave={() =>
            handleSave("Voice Agent", [
              "voice_agent_enabled",
              "vapi_api_key",
              "vapi_phone_number_id",
              "vapi_assistant_id",
            ])
          }
          saving={saving}
        >
          <div className="flex items-center gap-3 mb-4">
            <label className="text-sm font-medium text-gray-700">
              Enable Voice Agent
            </label>
            <button
              onClick={() =>
                updateSetting(
                  "voice_agent_enabled",
                  settings.voice_agent_enabled === "true" ? "false" : "true"
                )
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.voice_agent_enabled === "true"
                  ? "bg-purple-600"
                  : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.voice_agent_enabled === "true"
                    ? "translate-x-6"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <SettingsField
            label="Vapi API Key (Private Key)"
            value={settings.vapi_api_key || ""}
            onChange={(v) => updateSetting("vapi_api_key", v)}
            type="password"
            configuredPreview={sensitivePreviews.vapi_api_key}
            settingKey="vapi_api_key"
            placeholder={
              configuredSecrets.has("vapi_api_key")
                ? "Currently configured — enter a new value to replace"
                : "Your Vapi private API key from dashboard.vapi.ai"
            }
            help="Private API key from Vapi (dashboard.vapi.ai → Organization Settings → API Keys)."
          />
          <SettingsField
            label="Vapi Phone Number ID"
            value={settings.vapi_phone_number_id || ""}
            onChange={(v) => updateSetting("vapi_phone_number_id", v)}
            configuredPreview={sensitivePreviews.vapi_phone_number_id}
            settingKey="vapi_phone_number_id"
            placeholder={
              configuredSecrets.has("vapi_phone_number_id")
                ? "Currently configured — enter a new value to replace"
                : "Phone Number ID from Vapi dashboard"
            }
            help="The Vapi phone number ID to use for outbound calls. Find it in Vapi dashboard → Phone Numbers."
          />
          <SettingsField
            label="Vapi Assistant ID"
            value={settings.vapi_assistant_id || ""}
            onChange={(v) => updateSetting("vapi_assistant_id", v)}
            configuredPreview={sensitivePreviews.vapi_assistant_id}
            settingKey="vapi_assistant_id"
            placeholder={
              configuredSecrets.has("vapi_assistant_id")
                ? "Currently configured — enter a new value to replace"
                : "Assistant ID from Vapi dashboard"
            }
            help="The Vapi assistant to use for calls. Configure the assistant's prompt and behaviour at dashboard.vapi.ai."
          />
          <div className="border-t border-gray-200 pt-4 mt-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Variables passed to Vapi</h3>
            <p className="text-xs text-gray-500 mb-2">
              When a call is initiated, these variables are sent to Vapi as <code className="bg-gray-100 px-1 rounded">assistantOverrides.variableValues</code>.
              Use them in your Vapi assistant prompt with {"{{variable_name}}"} syntax.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                "customer_name", "customer_phone", "customer_city", "customer_address",
                "product_name", "product_price", "product_quantity", "product_description",
                "order_id", "lead_id", "order_status", "delivery_status",
                "tracking_number", "delivery_company", "call_attempts",
              ].map((v) => (
                <span key={v} className="text-[11px] px-2 py-1 bg-purple-50 text-purple-700 rounded-md font-mono border border-purple-200">
                  {`{{${v}}}`}
                </span>
              ))}
            </div>
          </div>
        </SettingsSection>
      )}

      {activeTab === "wa_numbers" && <WhatsappNumbersManager />}
    </div>
  );
}

function WhatsappNumbersManager() {
  const [numbers, setNumbers] = useState<WhatsappNumberRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newPhoneNumberId, setNewPhoneNumberId] = useState("");
  const [newDisplayPhone, setNewDisplayPhone] = useState("");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const fetchNumbers = async () => {
    try {
      const data = await api.get<{ numbers: WhatsappNumberRecord[] }>("/whatsapp/numbers");
      setNumbers(data.numbers);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNumbers();
  }, []);

  const handleAdd = async () => {
    if (!newLabel.trim() || !newPhoneNumberId.trim() || !newDisplayPhone.trim()) {
      setNotification({ type: "error", message: "All fields are required." });
      return;
    }
    try {
      await api.post("/whatsapp/numbers", {
        label: newLabel.trim(),
        phoneNumberId: newPhoneNumberId.trim(),
        displayPhone: newDisplayPhone.trim(),
      });
      setNewLabel("");
      setNewPhoneNumberId("");
      setNewDisplayPhone("");
      setAdding(false);
      setNotification({ type: "success", message: "WhatsApp number added." });
      fetchNumbers();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to add number",
      });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/whatsapp/numbers/${id}`, { method: "DELETE" });
      setNotification({ type: "success", message: "Number deleted." });
      fetchNumbers();
    } catch {
      setNotification({ type: "error", message: "Delete failed." });
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await fetch(`/api/whatsapp/numbers/${id}/default`, { method: "PUT" });
      setNotification({ type: "success", message: "Default number updated." });
      fetchNumbers();
    } catch {
      setNotification({ type: "error", message: "Failed to set default." });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <RefreshCw className="animate-spin text-gray-400" size={20} />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">WhatsApp Numbers</h2>
          <p className="text-sm text-gray-500">
            Manage your WhatsApp Business numbers. The default number is used for sending messages.
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={14} />
          Add Number
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

      {adding && (
        <div className="mb-4 p-4 border border-blue-200 rounded-lg bg-blue-50/50 space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Main Business, Support"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number ID (from Meta)</label>
            <input
              type="text"
              value={newPhoneNumberId}
              onChange={(e) => setNewPhoneNumberId(e.target.value)}
              placeholder="e.g. 123456789012345"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Phone Number</label>
            <input
              type="text"
              value={newDisplayPhone}
              onChange={(e) => setNewDisplayPhone(e.target.value)}
              placeholder="e.g. +212600000000"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
            >
              Save
            </button>
            <button
              onClick={() => setAdding(false)}
              className="px-4 py-2 text-gray-600 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {numbers.length === 0 ? (
        <p className="text-gray-500 text-sm py-4">
          No WhatsApp numbers configured. Add one to start sending messages.
        </p>
      ) : (
        <div className="space-y-2">
          {numbers.map((n) => (
            <div
              key={n.id}
              className={`flex items-center justify-between p-3 rounded-lg border ${
                n.isDefault ? "border-blue-300 bg-blue-50/50" : "border-gray-200"
              }`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">{n.label}</span>
                  {n.isDefault && (
                    <span className="px-2 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 rounded-full">
                      Default
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 font-mono mt-0.5">
                  {n.displayPhone} · ID: {n.phoneNumberId}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!n.isDefault && (
                  <button
                    onClick={() => handleSetDefault(n.id)}
                    className="p-1.5 text-gray-400 hover:text-yellow-600 transition-colors"
                    title="Set as default"
                  >
                    <Star size={16} />
                  </button>
                )}
                <button
                  onClick={() => handleDelete(n.id)}
                  className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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
  configuredPreview,
  settingKey,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  help?: string;
  warning?: string;
  configuredPreview?: string;
  settingKey?: string;
}) {
  const isSecret = type === "password";
  const [revealed, setRevealed] = useState(false);
  // Full saved value, fetched on demand from /settings/reveal when the eye is
  // clicked on an already-configured (masked) field. Null until requested.
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  // The eye is available for secret fields, and for any masked field with a
  // saved value the operator may want to read back in full.
  const canReveal = isSecret || !!configuredPreview;
  const inputType = isSecret && !revealed ? "password" : "text";

  const toggleReveal = async () => {
    const next = !revealed;
    setRevealed(next);
    // When revealing a saved-but-empty field, pull the full value once so the
    // chip can show the real credential instead of the mask.
    if (
      next &&
      configuredPreview &&
      settingKey &&
      revealedValue === null &&
      !revealing
    ) {
      setRevealing(true);
      try {
        const data = await api.get<{ value: string | null }>(
          `/settings/reveal?key=${encodeURIComponent(settingKey)}`
        );
        setRevealedValue(data.value ?? "");
      } catch {
        setRevealedValue("");
      } finally {
        setRevealing(false);
      }
    }
  };

  const chipText =
    revealed && revealedValue !== null ? revealedValue : configuredPreview;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1 gap-3">
        <label className="block text-sm font-medium text-gray-700">
          {label}
        </label>
        {chipText && (
          <span
            className={`font-mono text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200 ${
              revealed ? "break-all" : ""
            }`}
            title={revealed ? "Currently saved value" : "Currently saved value, masked"}
          >
            {revealing ? "Revealing…" : chipText}
          </span>
        )}
      </div>
      <div className="relative">
        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full px-3 py-2 ${canReveal ? "pr-10" : ""} border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
            warning ? "border-amber-400 bg-amber-50" : "border-gray-300"
          }`}
        />
        {canReveal && (
          <button
            type="button"
            onClick={toggleReveal}
            aria-label={revealed ? "Hide value" : "Reveal value"}
            title={revealed ? "Hide value" : "Reveal value"}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
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

function WebhookUrlReadout({ name, path }: { name: string; path: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);
  const url = origin ? `${origin}${path}` : path;
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {name} webhook URL
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 px-3 py-2 border border-gray-200 rounded-md text-xs font-mono bg-gray-50 text-gray-700 focus:outline-none"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button
          type="button"
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

interface SupportSourceRecord {
  id: string;
  slug: string;
  name: string;
  systemPrompt: string;
  enabled: boolean;
}

function SupportSourcesManager() {
  const [sources, setSources] = useState<SupportSourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ slug: "", name: "", systemPrompt: "", enabled: true });
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const fetchSources = async () => {
    try {
      const data = await api.get<{ sources: SupportSourceRecord[] }>("/whatsapp-support/sources");
      setSources(data.sources);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSources(); }, []);

  const handleSave = async () => {
    if (!form.slug.trim() || !form.name.trim() || !form.systemPrompt.trim()) {
      setNotification({ type: "error", message: "Slug, name, and system prompt are required." });
      return;
    }
    try {
      if (editingId) {
        await api.patch(`/whatsapp-support/sources/${editingId}`, form);
        setNotification({ type: "success", message: "Source updated." });
      } else {
        await api.post("/whatsapp-support/sources", form);
        setNotification({ type: "success", message: "Source created." });
      }
      setAdding(false);
      setEditingId(null);
      setForm({ slug: "", name: "", systemPrompt: "", enabled: true });
      await fetchSources();
    } catch (err) {
      setNotification({ type: "error", message: err instanceof Error ? err.message : "Save failed" });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this source?")) return;
    try {
      await api.del(`/whatsapp-support/sources/${id}`);
      setNotification({ type: "success", message: "Source deleted." });
      await fetchSources();
    } catch {
      setNotification({ type: "error", message: "Delete failed." });
    }
  };

  const startEdit = (s: SupportSourceRecord) => {
    setEditingId(s.id);
    setForm({ slug: s.slug, name: s.name, systemPrompt: s.systemPrompt, enabled: s.enabled });
    setAdding(true);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><RefreshCw className="animate-spin h-5 w-5 text-gray-400" /></div>;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Support Sources</h3>
          <p className="text-sm text-gray-500 mt-1">
            Manage website sources for WhatsApp Support auto-reply. Each source has its own AI system prompt.
            Use <code className="bg-gray-100 px-1 rounded text-xs">?source=slug</code> in your WhatsApp link to route customers.
          </p>
        </div>
        {!adding && (
          <button
            onClick={() => { setAdding(true); setEditingId(null); setForm({ slug: "", name: "", systemPrompt: "", enabled: true }); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            <Plus size={14} /> Add Source
          </button>
        )}
      </div>

      {notification && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${notification.type === "success" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {notification.message}
        </div>
      )}

      {adding && (
        <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h4 className="text-sm font-semibold text-gray-800 mb-3">{editingId ? "Edit Source" : "New Source"}</h4>
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Slug</label>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="e.g. site1"
                disabled={!!editingId}
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Used in ?source=slug</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Display Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="e.g. My Store Website"
              />
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">AI System Prompt</label>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              rows={5}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              placeholder="You are a customer support agent for [website name]. Help customers with their orders..."
            />
          </div>
          <div className="flex items-center gap-3 mb-4">
            <label className="text-xs font-medium text-gray-600">Enabled</label>
            <button
              onClick={() => setForm({ ...form, enabled: !form.enabled })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.enabled ? "bg-blue-600" : "bg-gray-300"}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${form.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700">
              <Save size={14} className="inline mr-1" />{editingId ? "Update" : "Create"}
            </button>
            <button onClick={() => { setAdding(false); setEditingId(null); }} className="px-4 py-2 bg-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}

      {sources.length === 0 && !adding && (
        <div className="text-center py-8 text-gray-400 text-sm">
          No sources configured. Add a source to enable per-website AI auto-reply prompts.
        </div>
      )}

      {sources.length > 0 && (
        <div className="space-y-3">
          {sources.map((s) => (
            <div key={s.id} className="flex items-start justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-gray-900">{s.name}</span>
                  <code className="text-[10px] bg-gray-200 px-1.5 py-0.5 rounded text-gray-600">{s.slug}</code>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${s.enabled ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}>
                    {s.enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-1 line-clamp-2">{s.systemPrompt}</p>
                <p className="text-[10px] text-gray-400 mt-1">
                  Link: https://api.whatsapp.com/send?phone=YOUR_NUMBER&text=source:{s.slug}
                </p>
              </div>
              <div className="flex gap-1 ml-3">
                <button onClick={() => startEdit(s)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                  <Eye size={14} />
                </button>
                <button onClick={() => handleDelete(s.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
