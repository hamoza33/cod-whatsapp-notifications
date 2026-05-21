/**
 * Duplicate an existing flow. Convenience action used by the flow-list
 * row menu — useful for branching off a known-working flow before
 * tweaking conditions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const original = await prisma.automationFlow.findUnique({ where: { id } });
  if (!original) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const flow = await prisma.automationFlow.create({
    data: {
      name: `${original.name} (copy)`,
      description: original.description,
      triggerType: original.triggerType,
      // Always start disabled so the copy doesn't fire until the operator
      // re-enables it explicitly.
      isEnabled: false,
      graphJson: original.graphJson as unknown as Prisma.InputJsonValue,
    },
  });
  return NextResponse.json({ flow }, { status: 201 });
}
