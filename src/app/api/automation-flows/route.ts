/**
 * List + create automation flows. Mirrors the shape of
 * `/api/automations` (the classic CRUD) so the UI stays consistent.
 *
 * Body for POST:
 *   { name: string; description?: string; triggerType: FlowTriggerType; graphJson?: FlowGraph }
 *
 * `graphJson` is optional on create — the UI seeds it with a minimal
 * "trigger only" graph and lets the operator fill it in via the canvas.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { FLOW_TRIGGER_TYPES, type FlowGraph, type FlowTriggerType } from "@/lib/automation-flows/types";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const flows = await prisma.automationFlow.findMany({
    orderBy: [{ isEnabled: "desc" }, { updatedAt: "desc" }],
  });

  return NextResponse.json({ flows });
}

interface CreateFlowBody {
  name?: string;
  description?: string;
  triggerType?: string;
  graphJson?: FlowGraph;
  isEnabled?: boolean;
}

function isValidTriggerType(value: unknown): value is FlowTriggerType {
  return typeof value === "string" && (FLOW_TRIGGER_TYPES as readonly string[]).includes(value);
}

function defaultGraph(triggerType: FlowTriggerType): FlowGraph {
  return {
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 200, y: 120 },
        data: {
          kind: "trigger",
          triggerType,
          label: triggerType.replace(/_/g, " "),
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateFlowBody;
  try {
    body = (await request.json()) as CreateFlowBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!isValidTriggerType(body.triggerType)) {
    return NextResponse.json(
      { error: `triggerType must be one of ${FLOW_TRIGGER_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  const graphJson: FlowGraph = body.graphJson ?? defaultGraph(body.triggerType);

  const flow = await prisma.automationFlow.create({
    data: {
      name,
      description: body.description ?? null,
      triggerType: body.triggerType,
      isEnabled: !!body.isEnabled,
      graphJson: graphJson as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ flow }, { status: 201 });
}
