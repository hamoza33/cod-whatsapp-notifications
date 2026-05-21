/**
 * GET / PATCH / DELETE a single automation flow. The PATCH endpoint
 * accepts a partial body so the frontend can autosave the canvas after
 * every edit without re-sending the entire object.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { FLOW_TRIGGER_TYPES, type FlowGraph, type FlowTriggerType } from "@/lib/automation-flows/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const flow = await prisma.automationFlow.findUnique({ where: { id } });
  if (!flow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ flow });
}

interface PatchFlowBody {
  name?: string;
  description?: string | null;
  triggerType?: string;
  graphJson?: FlowGraph;
  isEnabled?: boolean;
}

function isValidTriggerType(value: unknown): value is FlowTriggerType {
  return typeof value === "string" && (FLOW_TRIGGER_TYPES as readonly string[]).includes(value);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;

  let body: PatchFlowBody;
  try {
    body = (await request.json()) as PatchFlowBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Prisma.AutomationFlowUpdateInput = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if (body.description !== undefined) data.description = body.description;
  if (body.triggerType !== undefined) {
    if (!isValidTriggerType(body.triggerType)) {
      return NextResponse.json(
        { error: `triggerType must be one of ${FLOW_TRIGGER_TYPES.join(", ")}` },
        { status: 400 }
      );
    }
    data.triggerType = body.triggerType;
  }
  if (body.graphJson !== undefined) {
    data.graphJson = body.graphJson as unknown as Prisma.InputJsonValue;
  }
  if (typeof body.isEnabled === "boolean") data.isEnabled = body.isEnabled;

  try {
    const flow = await prisma.automationFlow.update({ where: { id }, data });
    return NextResponse.json({ flow });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
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
    await prisma.automationFlow.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}
