"use client";

import { useState, FormEvent } from "react";
import { api } from "@/lib/api-client";
import { Send } from "lucide-react";

export default function TestMessagePage() {
  const [phoneNumber, setPhoneNumber] = useState("");
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
      await api.post("/whatsapp/test", { phoneNumber });
      setResult({
        type: "success",
        message: "Test message sent successfully! Check the recipient's WhatsApp.",
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
          Send a test WhatsApp message using the{" "}
          <code className="bg-gray-100 px-1 rounded">hello_world</code>{" "}
          template to verify your WhatsApp Cloud API configuration.
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
