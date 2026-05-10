"use client";

import { useState, FormEvent } from "react";
import { api } from "@/lib/api-client";
import { Send, RefreshCw } from "lucide-react";

interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  bodyParameterCount: number;
  bodyText: string | null;
  header: { format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION" } | null;
}

export default function TestMessagePage() {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("");
  const [templateVariables, setTemplateVariables] = useState("");
  const [templateHeaderImage, setTemplateHeaderImage] = useState("");
  const [templateHeaderText, setTemplateHeaderText] = useState("");
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [templateInfo, setTemplateInfo] = useState<TemplateInfo | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const handleDetectTemplate = async () => {
    setDetecting(true);
    setTemplateError(null);
    setTemplateInfo(null);
    try {
      const params = new URLSearchParams();
      if (templateName.trim()) params.set("name", templateName.trim());
      if (templateLanguage.trim()) params.set("language", templateLanguage.trim());
      if (!params.get("name")) {
        setTemplateError(
          "Enter a Template Name (or save one in Settings → WhatsApp Cloud API and use it as the override) before detecting."
        );
        return;
      }
      const data = await api.get<{ template: TemplateInfo }>(
        `/whatsapp/templates?${params.toString()}`
      );
      setTemplateInfo(data.template);
    } catch (err) {
      setTemplateError(
        err instanceof Error ? err.message : "Failed to fetch template metadata"
      );
    } finally {
      setDetecting(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const payload: {
        phoneNumber: string;
        templateName?: string;
        templateLanguage?: string;
        templateVariables?: string[];
        templateHeaderImage?: string;
        templateHeaderText?: string;
      } = { phoneNumber };
      if (templateName.trim()) payload.templateName = templateName.trim();
      if (templateLanguage.trim()) payload.templateLanguage = templateLanguage.trim();
      if (templateVariables.trim()) {
        // Comma-separated list, preserving any value the user typed (including
        // blanks for templates that explicitly want an empty positional arg).
        payload.templateVariables = templateVariables
          .split(",")
          .map((v) => v.trim());
      }
      if (templateHeaderImage.trim()) payload.templateHeaderImage = templateHeaderImage.trim();
      else if (templateHeaderText.trim()) payload.templateHeaderText = templateHeaderText.trim();
      const data = await api.post<{
        success: boolean;
        templateName: string;
        language: string;
      }>("/whatsapp/test", payload);
      setResult({
        type: "success",
        message: `Test message sent using template "${data.templateName}" (${data.language}). Check the recipient's WhatsApp.`,
      });
    } catch (err) {
      setResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to send test message",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        Send Test Message
      </h1>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <p className="text-sm text-gray-500 mb-4">
          Send a test WhatsApp message to verify your Cloud API configuration. By
          default this uses the template configured under{" "}
          <strong>Settings → WhatsApp Cloud API</strong>; you can override it
          below for ad-hoc verification.
        </p>

        {result && (
          <div
            className={`mb-4 p-3 rounded-md text-sm border ${
              result.type === "success"
                ? "bg-green-50 text-green-700 border-green-200"
                : "bg-red-50 text-red-700 border-red-200"
            }`}
          >
            {result.message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="phone"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Recipient Phone Number
            </label>
            <input
              id="phone"
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              required
              placeholder="e.g. +212612345678 or 0612345678"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">
              International format preferred. Morocco numbers (+212) are auto-detected.
            </p>
          </div>

          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-900">
              Advanced: override template (optional)
            </summary>
            <div className="mt-3 space-y-3 pl-1">
              <div>
                <label
                  htmlFor="template-name"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Template Name
                </label>
                <input
                  id="template-name"
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Leave empty to use Settings value"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label
                  htmlFor="template-language"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Template Language
                </label>
                <input
                  id="template-language"
                  type="text"
                  value={templateLanguage}
                  onChange={(e) => setTemplateLanguage(e.target.value)}
                  placeholder="e.g. en or en_US"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleDetectTemplate}
                  disabled={detecting}
                  className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw size={12} className={detecting ? "animate-spin" : ""} />
                  {detecting ? "Detecting…" : "Detect Template"}
                </button>
                {templateError && (
                  <p className="text-xs text-red-600 mt-2">{templateError}</p>
                )}
                {templateInfo && (
                  <div className="mt-3 p-3 rounded-md bg-blue-50 border border-blue-200 text-xs text-blue-900 space-y-1">
                    <p>
                      <strong>{templateInfo.name}</strong> ({templateInfo.language})
                      — status <code>{templateInfo.status}</code>, category{" "}
                      <code>{templateInfo.category}</code>
                    </p>
                    <p>
                      Body needs <strong>{templateInfo.bodyParameterCount}</strong>{" "}
                      variable{templateInfo.bodyParameterCount === 1 ? "" : "s"}.
                    </p>
                    {templateInfo.header ? (
                      <p>
                        Header format: <strong>{templateInfo.header.format}</strong>{" "}
                        {templateInfo.header.format === "IMAGE" &&
                          "— provide a Header Image URL below."}
                        {templateInfo.header.format === "TEXT" &&
                          "— provide Header Text below."}
                      </p>
                    ) : (
                      <p>No header — leave Header Image / Header Text empty.</p>
                    )}
                    {templateInfo.bodyText && (
                      <p className="font-mono whitespace-pre-wrap text-blue-900/80">
                        {templateInfo.bodyText}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label
                  htmlFor="template-variables"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Template Body Variables (comma-separated)
                </label>
                <input
                  id="template-variables"
                  type="text"
                  value={templateVariables}
                  onChange={(e) => setTemplateVariables(e.target.value)}
                  placeholder="e.g. Customer, ORDER-12345"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Pass one value per body parameter the template expects. Leave
                  empty if the template has no variables.
                </p>
              </div>
              <div>
                <label
                  htmlFor="template-header-image"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Header Image URL (if template has an IMAGE header)
                </label>
                <input
                  id="template-header-image"
                  type="url"
                  value={templateHeaderImage}
                  onChange={(e) => setTemplateHeaderImage(e.target.value)}
                  placeholder="https://example.com/image.jpg"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label
                  htmlFor="template-header-text"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Header Text (if template has a TEXT header)
                </label>
                <input
                  id="template-header-text"
                  type="text"
                  value={templateHeaderText}
                  onChange={(e) => setTemplateHeaderText(e.target.value)}
                  placeholder="Header text value"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Use Header Image OR Header Text — not both. Leave both empty if the
                  template has no header parameter.
                </p>
              </div>
              <p className="text-xs text-gray-400">
                The template must be APPROVED on your WhatsApp Business Account.
              </p>
            </div>
          </details>

          <button
            type="submit"
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            <Send size={16} />
            {loading ? "Sending..." : "Send Test Message"}
          </button>
        </form>
      </div>
    </div>
  );
}
