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

  let body: {
    aiAgentEnabled?: boolean;
    description?: string;
    aiSystemPrompt?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: {
    aiAgentEnabled?: boolean;
    description?: string | null;
    aiSystemPrompt?: string | null;
  } = {};

  if (body.aiAgentEnabled !== undefined) {
    if (typeof body.aiAgentEnabled !== "boolean") {
      return NextResponse.json(
        { error: "aiAgentEnabled must be a boolean" },
        { status: 400 }
      );
    }
    data.aiAgentEnabled = body.aiAgentEnabled;
  }

  if (body.description !== undefined) {
    data.description = body.description ?? null;
  }

  if (body.aiSystemPrompt !== undefined) {
    if (body.aiSystemPrompt !== null && typeof body.aiSystemPrompt !== "string") {
      return NextResponse.json(
        { error: "aiSystemPrompt must be a string or null" },
        { status: 400 }
      );
    }
    const trimmed =
      typeof body.aiSystemPrompt === "string"
        ? body.aiSystemPrompt.trim()
        : "";
    data.aiSystemPrompt = trimmed ? trimmed : null;
  }

  const product = await prisma.product
    .update({
      where: { id },
      data,
    })
    .catch(() => null);

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  return NextResponse.json({ product });
}
