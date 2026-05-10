import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@prisma/client";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  // Cap: 100 by default for the table view; the Pipeline (Kanban) view needs
  // to fetch many cards at once and explicitly opts into the higher cap.
  const pageSize = Math.max(
    1,
    Math.min(1000, parseInt(searchParams.get("pageSize") || "20", 10))
  );
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const sentFilter = searchParams.get("sent"); // "true" | "false" | null

  const where: Record<string, unknown> = {};

  if (status && status !== "ALL") {
    if (status === "ELIGIBLE") {
      where.status = { in: [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY] };
    } else {
      where.status = status as OrderStatus;
    }
  }

  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: "insensitive" } },
      { customerPhone: { contains: search } },
      { codNetworkOrderId: { contains: search } },
      { trackingNumber: { contains: search } },
    ];
  }

  if (sentFilter === "true") {
    where.whatsappSentAt = { not: null };
  } else if (sentFilter === "false") {
    where.whatsappSentAt = null;
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        whatsappMessages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      // Newest *placed* order first (codCreatedAt). Falls back to our row's
      // createdAt for orders that pre-date this column. updatedAt is the final
      // tiebreaker so re-syncs of older orders surface together.
      orderBy: [
        { codCreatedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { updatedAt: "desc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return NextResponse.json({
    orders,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}
