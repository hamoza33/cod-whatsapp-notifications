import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const target = await prisma.whatsappNumber.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.whatsappNumber.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    }),
    prisma.whatsappNumber.update({
      where: { id },
      data: { isDefault: true },
    }),
  ]);

  return NextResponse.json({ success: true });
}
