import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus, Prisma } from "@prisma/client";

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
  autoRun?: boolean;
  whenStatusEquals?: string | null;
  andProductContains?: string | null;
  andProductDoesNotContain?: string | null;
  andPhoneStartsWith?: string | null;
  andTrackingCondition?: string | null;
  andCityContains?: string | null;
  andCustomerNameContains?: string | null;
  andMinPrice?: string | null;
  andMaxPrice?: string | null;
  andTrackingStatusContains?: string | null;
  thenMoveToStatus?: string | null;
  thenSendTemplateName?: string | null;
  thenSendTemplateLanguage?: string | null;
  thenSendTemplateVariables?: string[] | null;
  thenSendHeaderImageUrl?: string | null;
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

  // Validate at least one trigger condition is present.
  const hasTrigger =
    body.whenStatusEquals ||
    body.andProductContains ||
    body.andPhoneStartsWith ||
    body.andTrackingCondition ||
    body.andCityContains ||
    body.andCustomerNameContains ||
    body.andMinPrice ||
    body.andMaxPrice ||
    body.andTrackingStatusContains;
  if (!hasTrigger) {
    return NextResponse.json(
      {
        error:
          "Set at least one trigger condition",
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
      autoRun: body.autoRun ?? false,
      whenStatusEquals: asStatus(body.whenStatusEquals),
      andProductContains: body.andProductContains?.trim() || null,
      andProductDoesNotContain: body.andProductDoesNotContain?.trim() || null,
      thenMoveToStatus: asStatus(body.thenMoveToStatus),
      thenSendTemplateName: body.thenSendTemplateName?.trim() || null,
      thenSendTemplateLanguage: body.thenSendTemplateLanguage?.trim() || null,
      thenSendTemplateVariables:
        Array.isArray(body.thenSendTemplateVariables) &&
        body.thenSendTemplateVariables.length > 0
          ? body.thenSendTemplateVariables
          : Prisma.JsonNull,
      thenSendHeaderImageUrl: body.thenSendHeaderImageUrl?.trim() || null,
      thenSendOnce: body.thenSendOnce ?? true,
      andPhoneStartsWith: body.andPhoneStartsWith?.trim() || null,
      andTrackingCondition: body.andTrackingCondition?.trim() || null,
      andCityContains: body.andCityContains?.trim() || null,
      andCustomerNameContains: body.andCustomerNameContains?.trim() || null,
      andMinPrice: body.andMinPrice?.trim() || null,
      andMaxPrice: body.andMaxPrice?.trim() || null,
      andTrackingStatusContains: body.andTrackingStatusContains?.trim() || null,
    },
  });

  return NextResponse.json({ automation }, { status: 201 });
}
