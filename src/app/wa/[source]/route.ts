import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";

/**
 * GET /wa/:source
 * Landing page redirect for source-based WhatsApp chat.
 * 1. Logs the visit (source + timestamp) in the DB
 * 2. Redirects to wa.me/<phone> (no text= parameter)
 * 3. When a new message arrives, the webhook checks recent visits to
 *    auto-assign the source via time-window matching.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ source: string }> }
) {
  const { source } = await params;

  // Get the support phone number to redirect to
  const supportPhone = await getSetting("wa_support_phone_number_id");

  // We need the actual phone number, not the phone number ID.
  // Try to get the display phone number from settings or use a fallback.
  // The user's WhatsApp number for support is configured separately.
  let phoneNumber = "";

  // Check if there's a display phone stored
  const displayPhone = await getSetting("wa_support_display_phone");
  if (displayPhone) {
    phoneNumber = displayPhone.replace(/[^0-9+]/g, "");
  }

  // If no display phone, try to look up from WhatsApp numbers table
  if (!phoneNumber && supportPhone) {
    const waNumber = await prisma.whatsappNumber.findFirst({
      where: { phoneNumberId: supportPhone },
      select: { displayPhone: true },
    });
    if (waNumber?.displayPhone) {
      phoneNumber = waNumber.displayPhone.replace(/[^0-9+]/g, "");
    }
  }

  if (!phoneNumber) {
    return new NextResponse(
      `<html>
        <body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h2>WhatsApp Support</h2>
          <p>Phone number not configured yet. Please contact the administrator.</p>
        </body>
      </html>`,
      { status: 404, headers: { "Content-Type": "text/html" } }
    );
  }

  // Log the source visit for time-window matching
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || null;
  const userAgent = request.headers.get("user-agent") || null;

  try {
    await prisma.sourceVisit.create({
      data: {
        source: source.toLowerCase(),
        ip,
        userAgent,
      },
    });
  } catch (err) {
    console.error("[wa-redirect] failed to log source visit:", err);
  }

  // Clean phone number for wa.me link
  const cleanPhone = phoneNumber.replace(/^\+/, "");
  const waUrl = `https://wa.me/${cleanPhone}`;

  // Redirect to WhatsApp
  return NextResponse.redirect(waUrl, 302);
}
