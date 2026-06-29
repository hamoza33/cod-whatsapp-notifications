import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH: Update a support source.
 * DELETE: Delete a support source.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const body = (await request.json()) as {
    slug?: string;
    name?: string;
    systemPrompt?: string;
    enabled?: boolean;
  };

  const existing = await prisma.supportSource.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (body.slug !== undefined) {
    const slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!slug) {
      return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    }
    if (slug !== existing.slug) {
      const conflict = await prisma.supportSource.findUnique({ where: { slug } });
      if (conflict) {
        return NextResponse.json({ error: `Slug "${slug}" already exists` }, { status: 409 });
      }
    }
    data.slug = slug;
  }
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.systemPrompt !== undefined) data.systemPrompt = body.systemPrompt;
  if (body.enabled !== undefined) data.enabled = body.enabled;

  const source = await prisma.supportSource.update({
    where: { id },
    data,
  });

  return NextResponse.json({ source });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const existing = await prisma.supportSource.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  await prisma.supportSource.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
