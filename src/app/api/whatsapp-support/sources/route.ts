import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET: List all support sources.
 * POST: Create a new support source.
 */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sources = await prisma.supportSource.findMany({
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ sources });
}

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    slug?: string;
    name?: string;
    systemPrompt?: string;
    enabled?: boolean;
  };

  if (!body.slug || !body.name || !body.systemPrompt) {
    return NextResponse.json(
      { error: "slug, name, and systemPrompt are required" },
      { status: 400 }
    );
  }

  const slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const existing = await prisma.supportSource.findUnique({ where: { slug } });
  if (existing) {
    return NextResponse.json(
      { error: `Source with slug "${slug}" already exists` },
      { status: 409 }
    );
  }

  const source = await prisma.supportSource.create({
    data: {
      slug,
      name: body.name.trim(),
      systemPrompt: body.systemPrompt,
      enabled: body.enabled ?? true,
    },
  });

  return NextResponse.json({ source }, { status: 201 });
}
