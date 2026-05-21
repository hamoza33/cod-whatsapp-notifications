import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requestCancel } from "@/lib/bulk-messaging/runner";

/** POST — request the in-process worker to stop after its current send.
 *  If the worker isn't running anymore (e.g. process restarted between the
 *  campaign start and this call), this still flips PENDING rows to
 *  CANCELLED so the campaign closes out cleanly.
 */
export async function POST(
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
  if (campaign.status === "COMPLETED" || campaign.status === "CANCELLED") {
    return NextResponse.json({ ok: true, status: campaign.status });
  }

  requestCancel(id);

  // Be eager: cancel any PENDING rows up-front so the UI reflects the
  // operator's intent immediately. The worker may still finish one
  // in-flight send before noticing the cancel flag.
  await prisma.bulkRecipient.updateMany({
    where: { campaignId: id, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  await prisma.bulkCampaign.update({
    where: { id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
