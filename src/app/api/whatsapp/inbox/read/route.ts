import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Mark a conversation as read by upserting a lastReadAt timestamp.
 * Clears the unread count for that phone number.
 */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { phoneNumber?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phoneNumber = (body.phoneNumber ?? "").trim();
  if (!phoneNumber) {
    return NextResponse.json(
      { error: "phoneNumber is required" },
      { status: 400 }
    );
  }

  await prisma.conversationReadState.upsert({
    where: { phoneNumber },
    create: { phoneNumber, lastReadAt: new Date() },
    update: { lastReadAt: new Date() },
  });

  return NextResponse.json({ success: true });
}
