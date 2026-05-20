import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    return NextResponse.json({ error: "phoneNumber is required" }, { status: 400 });
  }

  await prisma.pinnedConversation.upsert({
    where: { phoneNumber },
    create: { phoneNumber },
    update: { pinnedAt: new Date() },
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const phoneNumber = searchParams.get("phoneNumber");
  if (!phoneNumber) {
    return NextResponse.json({ error: "phoneNumber is required" }, { status: 400 });
  }

  await prisma.pinnedConversation.deleteMany({
    where: { phoneNumber },
  });

  return NextResponse.json({ success: true });
}
