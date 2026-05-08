"use client";

import { useState, FormEvent } from "react";
import { api } from "@/lib/api-client";
import { Send } from "lucide-react";

export default function TestMessagePage() {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("");
  const [templateVariables, setTemplateVariables] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

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
