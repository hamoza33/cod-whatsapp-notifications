import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const numbers = await prisma.whatsappNumber.findMany({
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ numbers });
}

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { label?: string; phoneNumberId?: string; displayPhone?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const label = (body.label ?? "").trim();
  const phoneNumberId = (body.phoneNumberId ?? "").trim();
  if (!label || !phoneNumberId) {
    return NextResponse.json(
      { error: "label and phoneNumberId are required" },
      { status: 400 }
    );
  }

  const existingCount = await prisma.whatsappNumber.count();
  const number = await prisma.whatsappNumber.create({
    data: {
      label,
      phoneNumberId,
      displayPhone: body.displayPhone?.trim() || null,
      isDefault: existingCount === 0,
    },
  });

  return NextResponse.json({ number }, { status: 201 });
}
