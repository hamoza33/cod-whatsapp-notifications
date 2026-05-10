import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const automations = await prisma.automation.findMany({
    orderBy: [{ isEnabled: "desc" }, { createdAt: "desc" }],
    include: {
      _count: {
        select: { runs: true },
      },
    },
  });

  return NextResponse.json({ automations });
}

interface CreateAutomationBody {
  name?: string;
  isEnabled?: boolean;
  whenStatusEquals?: string | null;
  andProductContains?: string | null;
  andProductDoesNotContain?: string | null;
  thenMoveToStatus?: string | null;
  thenSendTemplateName?: string | null;
  thenSendTemplateLanguage?: string | null;
  thenSendOnce?: boolean;
}

function asStatus(value: unknown): OrderStatus | null {
  if (!value || typeof value !== "string") return null;
  if (Object.values(OrderStatus).includes(value as OrderStatus)) {
    return value as OrderStatus;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateAutomationBody;
  try {
    body = (await request.json()) as CreateAutomationBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Validate at least one trigger and one action are present — otherwise the
  // rule does nothing.
  if (!body.whenStatusEquals && !body.andProductContains) {
    return NextResponse.json(
      {
        error:
          "Set at least one trigger (whenStatusEquals or andProductContains)",
      },
      { status: 400 }
    );
  }
  if (!body.thenMoveToStatus && !body.thenSendTemplateName) {
    return NextResponse.json(
      {
        error: "Set at least one action (thenMoveToStatus or thenSendTemplateName)",
      },
      { status: 400 }
    );
  }

  const automation = await prisma.automation.create({
    data: {
      name: body.name.trim(),
      isEnabled: body.isEnabled ?? false,
      whenStatusEquals: asStatus(body.whenStatusEquals),
      andProductContains: body.andProductContains?.trim() || null,
      andProductDoesNotContain: body.andProductDoesNotContain?.trim() || null,
      thenMoveToStatus: asStatus(body.thenMoveToStatus),
      thenSendTemplateName: body.thenSendTemplateName?.trim() || null,
      thenSendTemplateLanguage: body.thenSendTemplateLanguage?.trim() || null,
      thenSendOnce: body.thenSendOnce ?? true,
    },
  });

  return NextResponse.json({ automation }, { status: 201 });
}
