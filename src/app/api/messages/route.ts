import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MessageStatus } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = Math.max(1, Math.min(100, parseInt(searchParams.get("pageSize") || "20", 10)));
  const status = searchParams.get("status");

  const where: Record<string, unknown> = {};
  if (status && status !== "ALL") {
    where.status = status as MessageStatus;
  }

  const [messages, total] = await Promise.all([
    prisma.whatsappMessage.findMany({
      where,
      include: {
        order: {
          select: {
            codNetworkOrderId: true,
            customerName: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.whatsappMessage.count({ where }),
  ]);

  const templateNames = [...new Set(messages.map((m) => m.templateName).filter((n) => n !== "<text>"))];
  const templateBodies = new Map<string, string>();
  if (templateNames.length > 0) {
    const templates = await prisma.whatsappTemplate.findMany({
      where: { name: { in: templateNames } },
      select: { name: true, bodyText: true },
    });
    for (const t of templates) {
      if (t.bodyText) templateBodies.set(t.name, t.bodyText);
    }
  }

  const enrichedMessages = messages.map((m) => {
    let renderedText: string | null = null;
    if (m.templateName === "<text>") {
      const vars = m.templateVariablesJson;
      if (vars && typeof vars === "object" && "text" in vars) {
        renderedText = (vars as { text: string }).text;
      }
    } else {
      const body = templateBodies.get(m.templateName);
      if (body) {
        const vars = Array.isArray(m.templateVariablesJson)
          ? (m.templateVariablesJson as string[])
          : [];
        renderedText = body.replace(/\{\{(\d+)\}\}/g, (_, idx) => {
          const i = parseInt(idx, 10) - 1;
          return vars[i] ?? `{{${idx}}}`;
        });
      }
    }
    return { ...m, renderedText };
  });

  return NextResponse.json({
    messages: enrichedMessages,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}
