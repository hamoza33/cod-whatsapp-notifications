import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Paginated list of recipients for one campaign — backs the status table. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(
    500,
    Math.max(1, parseInt(searchParams.get("pageSize") ?? "100", 10))
  );
  const statusFilter = searchParams.get("status");

  const where = {
    campaignId: id,
    ...(statusFilter ? { status: statusFilter as never } : {}),
  };

  const [recipients, total] = await Promise.all([
    prisma.bulkRecipient.findMany({
      where,
      orderBy: { rowIndex: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.bulkRecipient.count({ where }),
  ]);

  return NextResponse.json({ recipients, page, pageSize, total });
}
