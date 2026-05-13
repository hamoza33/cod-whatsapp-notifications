import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: { aiAgentEnabled?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.aiAgentEnabled !== "boolean") {
    return NextResponse.json(
      { error: "aiAgentEnabled must be a boolean" },
      { status: 400 }
    );
  }

  const product = await prisma.product
    .update({
      where: { id },
      data: { aiAgentEnabled: body.aiAgentEnabled },
    })
    .catch(() => null);

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  return NextResponse.json({ product });
}
