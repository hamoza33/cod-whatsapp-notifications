/**
 * Returns the full set of data points the flow editor can use as
 * condition fields and template tokens. The UI calls this once on
 * mount to populate the inspector's "field" dropdown — keeps the
 * client schema in sync with the server-side registry.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  DATA_POINTS,
  groupDataPoints,
} from "@/lib/automation-flows/data-points";
import {
  ACTION_KINDS,
  CONDITION_OPERATORS,
  FLOW_TRIGGER_TYPES,
} from "@/lib/automation-flows/types";

export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    dataPoints: DATA_POINTS,
    groups: groupDataPoints(),
    operators: CONDITION_OPERATORS,
    triggers: FLOW_TRIGGER_TYPES,
    actions: ACTION_KINDS,
  });
}
