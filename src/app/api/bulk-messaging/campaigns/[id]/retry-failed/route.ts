import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startCampaign } from "@/lib/bulk-messaging/runner";

/** POST — flip every FAILED row back to PENDING and re-kick the worker.
 *  Skips rows that failed due to an invalid phone number (those are
 *  permanent — re-trying without fixing the phone won't help). The UI's
 *  caller can include `includeInvalidPhones=true` to override.
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

  const body = (await request.json().catch(() => ({}))) as {
    includeInvalidPhones?: boolean;
  };

  // Skip recipients whose phone normalization failed at upload time —
  // identified by the absence of a "+" or all-digits in the normalized
  // phone column. Optionally include them via the flag.
  const where = {
    campaignId: id,
    status: "FAILED" as const,
    ...(body.includeInvalidPhones
      ? {}
      : { NOT: { errorMessage: { contains: "phone", mode: "insensitive" as const } } }),
  };
  const updated = await prisma.bulkRecipient.updateMany({
    where,
    data: { status: "PENDING", errorMessage: null, errorCode: null, failedAt: null },
  });

  // Move the campaign back to SENDING if we just queued anything.
  if (updated.count > 0) {
    await prisma.bulkCampaign.update({
      where: { id },
      data: {
        status: "SENDING",
        completedAt: null,
        startedAt: campaign.startedAt ?? new Date(),
      },
    });
    startCampaign(id).catch((err) =>
      console.error("[bulk-messaging] retry-failed startCampaign failed", id, err)
    );
  }

  return NextResponse.json({ retried: updated.count });
}
