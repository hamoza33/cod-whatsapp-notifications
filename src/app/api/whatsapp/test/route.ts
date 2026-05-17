import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WhatsAppClient } from "@/lib/whatsapp";
import { normalizePhoneNumber } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = rateLimit(`whatsapp-test:${user.id}`, 5, 60_000);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded for test messages." },
      { status: 429 }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      phoneNumber?: string;
      templateName?: string;
      templateLanguage?: string;
      templateVariables?: unknown;
      templateHeaderImage?: unknown;
      templateHeaderText?: unknown;
    };
    const {
      phoneNumber,
      templateName: overrideTemplate,
      templateLanguage: overrideLanguage,
      templateVariables: rawVariables,
      templateHeaderImage: rawHeaderImage,
      templateHeaderText: rawHeaderText,
    } = body;

    let header: { type: "image" | "text"; value: string } | undefined;
    if (typeof rawHeaderImage === "string" && rawHeaderImage.trim()) {
      header = { type: "image", value: rawHeaderImage.trim() };
    } else if (typeof rawHeaderText === "string" && rawHeaderText.trim()) {
      header = { type: "text", value: rawHeaderText.trim() };
    } else if (
      (rawHeaderImage !== undefined && rawHeaderImage !== null) ||
      (rawHeaderText !== undefined && rawHeaderText !== null)
    ) {
      return NextResponse.json(
        { error: "templateHeaderImage / templateHeaderText must be a string" },
        { status: 400 }
      );
    }

    // Coerce variables from any reasonable shape (string[] or comma-separated
    // string) and reject anything else so the user gets a clear error rather
    // than a confusing Meta response.
    let variables: string[] | undefined;
    if (Array.isArray(rawVariables)) {
      if (!rawVariables.every((v) => typeof v === "string")) {
        return NextResponse.json(
          { error: "templateVariables must be an array of strings" },
          { status: 400 }
        );
      }
      variables = rawVariables;
    } else if (typeof rawVariables === "string") {
      variables = rawVariables.split(",").map((v) => v.trim());
    } else if (rawVariables !== undefined && rawVariables !== null) {
      return NextResponse.json(
        { error: "templateVariables must be an array of strings" },
        { status: 400 }
      );
    }

    if (!phoneNumber) {
      return NextResponse.json(
        { error: "phoneNumber is required" },
        { status: 400 }
      );
    }

    const defaultCountryCode =
      (await getSetting(SETTING_KEYS.DEFAULT_COUNTRY_CODE)) || "212";

    let phone: string;
    try {
      phone = normalizePhoneNumber(phoneNumber, defaultCountryCode);
    } catch {
      return NextResponse.json(
        { error: `Invalid phone number: ${phoneNumber}` },
        { status: 400 }
      );
    }

    // Use the configured template by default (avoids hard-coded
    // `hello_world`, which only works if it happens to be approved on the
    // user's WABA). Callers can still override per-request from the UI.
    const configuredTemplate = await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_NAME);
    const configuredLanguage = await getSetting(SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE);

    const templateName = overrideTemplate || configuredTemplate || "hello_world";
    const language = overrideLanguage || configuredLanguage || "en_US";

    const whatsappClient = await WhatsAppClient.fromSettings();
    const result = await whatsappClient.sendTestMessage(phone, {
      templateName,
      language,
      variables: variables ?? [],
      header,
    });

    // Record the test message so it appears in the Inbox / chat history
    try {
      const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;
      await prisma.whatsappMessage.create({
        data: {
          orderId: null,
          phoneNumber: formattedPhone,
          templateName,
          templateLanguage: language,
          templateVariablesJson: variables ?? [],
          providerMessageId: result.messages?.[0]?.id ?? null,
          status: "SENT",
          sentBy: user.email,
          sentAt: new Date(),
        },
      });
    } catch (logErr) {
      console.error("[test] failed to record test message", logErr);
    }

    return NextResponse.json({
      success: true,
      result,
      templateName,
      language,
      variables: variables ?? [],
      header,
    });
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to send test message";
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
