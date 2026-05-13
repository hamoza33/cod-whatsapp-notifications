import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    name?: string;
    language?: string;
    category?: string;
    bodyText?: string;
    bodyParamCount?: number;
    headerType?: string | null;
    components?: unknown;
  };

  if (!body.name?.trim()) {
    return NextResponse.json(
      { error: "Template name is required" },
      { status: 400 }
    );
  }

  const template = await prisma.whatsappTemplate.upsert({
    where: {
      name_language: {
        name: body.name.trim(),
        language: body.language || "en",
      },
    },
    update: {
      category: body.category || "UTILITY",
      bodyParamCount: body.bodyParamCount ?? 0,
      bodyText: body.bodyText || null,
      headerType: body.headerType || null,
      components: (body.components as object) ?? {},
      status: "DRAFT",
    },
    create: {
      name: body.name.trim(),
      language: body.language || "en",
      status: "DRAFT",
      category: body.category || "UTILITY",
      bodyParamCount: body.bodyParamCount ?? 0,
      bodyText: body.bodyText || null,
      headerType: body.headerType || null,
      components: (body.components as object) ?? {},
    },
  });

  return NextResponse.json({ template });
}
