import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus, Prisma } from "@prisma/client";
import { matchesAutomation, runAutomationsForOrder } from "@/lib/automations";

function asStatus(value: unknown): OrderStatus | null {
  if (!value || typeof value !== "string") return null;
  if (Object.values(OrderStatus).includes(value as OrderStatus)) {
    return value as OrderStatus;
  }
  return null;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const automation = await prisma.automation.findUnique({
    where: { id },
    include: {
      runs: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          order: {
            select: {
              id: true,
              codNetworkOrderId: true,
              customerName: true,
              productName: true,
            },
          },
        },
      },
    },
  });
  if (!automation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ automation });
}

interface UpdateAutomationBody {
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

export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;

  let body: UpdateAutomationBody;
  try {
    body = (await request.json()) as UpdateAutomationBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Prisma.AutomationUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;
  if (body.autoRun !== undefined) data.autoRun = body.autoRun;
  if (body.whenStatusEquals !== undefined)
    data.whenStatusEquals = asStatus(body.whenStatusEquals);
  if (body.andProductContains !== undefined)
    data.andProductContains = body.andProductContains?.trim() || null;
  if (body.andProductDoesNotContain !== undefined)
    data.andProductDoesNotContain = body.andProductDoesNotContain?.trim() || null;
  if (body.thenMoveToStatus !== undefined)
    data.thenMoveToStatus = asStatus(body.thenMoveToStatus);
  if (body.thenSendTemplateName !== undefined)
    data.thenSendTemplateName = body.thenSendTemplateName?.trim() || null;
  if (body.thenSendTemplateLanguage !== undefined)
    data.thenSendTemplateLanguage = body.thenSendTemplateLanguage?.trim() || null;
  if (body.thenSendTemplateVariables !== undefined) {
    data.thenSendTemplateVariables =
      Array.isArray(body.thenSendTemplateVariables) &&
      body.thenSendTemplateVariables.length > 0
        ? body.thenSendTemplateVariables
        : Prisma.JsonNull;
  }
  if (body.thenSendHeaderImageUrl !== undefined)
    data.thenSendHeaderImageUrl = body.thenSendHeaderImageUrl?.trim() || null;
  if (body.thenSendOnce !== undefined) data.thenSendOnce = body.thenSendOnce;
  if (body.andPhoneStartsWith !== undefined)
    data.andPhoneStartsWith = body.andPhoneStartsWith?.trim() || null;
  if (body.andTrackingCondition !== undefined)
    data.andTrackingCondition = body.andTrackingCondition?.trim() || null;
  if (body.andCityContains !== undefined)
    data.andCityContains = body.andCityContains?.trim() || null;
  if (body.andCustomerNameContains !== undefined)
    data.andCustomerNameContains = body.andCustomerNameContains?.trim() || null;
  if (body.andMinPrice !== undefined)
    data.andMinPrice = body.andMinPrice?.trim() || null;
  if (body.andMaxPrice !== undefined)
    data.andMaxPrice = body.andMaxPrice?.trim() || null;
  if (body.andTrackingStatusContains !== undefined)
    data.andTrackingStatusContains = body.andTrackingStatusContains?.trim() || null;

  try {
    const automation = await prisma.automation.update({
      where: { id },
      data,
    });
    return NextResponse.json({ automation });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  try {
    await prisma.automation.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}

/**
 * Dry-run preview: returns the number of orders this automation WOULD match
 * right now (and a sample of the top 10). Used by the Automations UI to give
 * operators confidence before flipping `isEnabled = true`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  const automation = await prisma.automation.findUnique({ where: { id } });
  if (!automation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (action === "preview") {
    // Pretend the automation is enabled regardless of the actual flag so
    // operators can preview the impact before enabling.
    const checkAutomation = { ...automation, isEnabled: true };
    // We scope candidates by `whenStatusEquals` if set, otherwise check the
    // full order list (capped for safety).
    const where: Prisma.OrderWhereInput = {};
    if (checkAutomation.whenStatusEquals) {
      where.status = checkAutomation.whenStatusEquals;
    }
    const orders = await prisma.order.findMany({
      where,
      take: 1000,
      orderBy: { codCreatedAt: "desc" },
      select: {
        id: true,
        codNetworkOrderId: true,
        customerName: true,
        productName: true,
        customerPhone: true,
        trackingNumber: true,
        customerCity: true,
        productPrice: true,
        status: true,
        trackingOrders: { select: { latestEvent: true }, take: 1 },
      },
    });
    const matching = orders.filter((o) =>
      matchesAutomation(checkAutomation, o, {
        latestTrackingEvent: o.trackingOrders?.[0]?.latestEvent ?? null,
      })
    );
    return NextResponse.json({
      candidateOrdersScanned: orders.length,
      matchingCount: matching.length,
      sampleMatches: matching.slice(0, 10),
    });
  }

  if (action === "run-now") {
    // Apply the automation to *currently matching* orders. Useful when the
    // operator wants to back-fill an automation onto historical orders.
    const checkAutomation = { ...automation, isEnabled: true };
    const where: Prisma.OrderWhereInput = {};
    if (checkAutomation.whenStatusEquals) {
      where.status = checkAutomation.whenStatusEquals;
    }
    const orders = await prisma.order.findMany({
      where,
      take: 1000,
      orderBy: { codCreatedAt: "desc" },
      include: { trackingOrders: { select: { latestEvent: true }, take: 1 } },
    });
    const matching = orders.filter((o) =>
      matchesAutomation(checkAutomation, o, {
        latestTrackingEvent: o.trackingOrders?.[0]?.latestEvent ?? null,
      })
    );
    let applied = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const order of matching) {
      try {
        const summaries = await runAutomationsForOrder(order.id, {
          automationIds: [automation.id],
        });
        if (summaries.some((s) => s.status === "applied")) {
          applied++;
        } else if (summaries.some((s) => s.status === "failed")) {
          failed++;
          const failedSummary = summaries.find((s) => s.status === "failed");
          if (failedSummary?.reason) {
            errors.push(`#${order.codNetworkOrderId}: ${failedSummary.reason}`);
          }
        }
      } catch (err) {
        failed++;
        errors.push(
          `#${order.codNetworkOrderId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return NextResponse.json({
      candidateOrdersScanned: orders.length,
      matchingCount: matching.length,
      applied,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  return NextResponse.json(
    { error: "Unknown action; use ?action=preview or ?action=run-now" },
    { status: 400 }
  );
}
