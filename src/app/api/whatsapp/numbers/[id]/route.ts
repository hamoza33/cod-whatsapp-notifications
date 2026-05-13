import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const deleted = await prisma.whatsappNumber
    .delete({ where: { id } })
    .catch(() => null);

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (deleted.isDefault) {
    const first = await prisma.whatsappNumber.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (first) {
      await prisma.whatsappNumber.update({
        where: { id: first.id },
        data: { isDefault: true },
      });
    }
  }

  return NextResponse.json({ success: true });
}
