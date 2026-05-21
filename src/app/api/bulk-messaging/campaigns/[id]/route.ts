import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRunning } from "@/lib/bulk-messaging/runner";

/** GET single campaign with status counts (used by the live status view poll). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const campaign = await prisma.bulkCampaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const counts = await prisma.bulkRecipient.groupBy({
    by: ["status"],
    where: { campaignId: id },
    _count: { _all: true },
  });
  const countsByStatus: Record<string, number> = {};
  for (const c of counts) {
    countsByStatus[c.status] = c._count._all;
  }

  return NextResponse.json({
    campaign,
    counts: countsByStatus,
    running: isRunning(id),
  });
}

/** DELETE a campaign and all its recipients. Refuses to delete a SENDING
 *  campaign so the operator doesn't accidentally drop rows mid-send.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const campaign = await prisma.bulkCampaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.status === "SENDING") {
    return NextResponse.json(
      { error: "Cancel the campaign before deleting it." },
      { status: 400 }
    );
  }

  await prisma.bulkCampaign.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
