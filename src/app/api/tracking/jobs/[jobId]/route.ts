import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TrackingItemStatus } from "@prisma/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const user = getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;

  const job = await prisma.trackingJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Get recent errors for the progress view
  const recentErrors = await prisma.trackingJobItem.findMany({
    where: {
      jobId,
      status: TrackingItemStatus.FAILED,
    },
    orderBy: { finishedAt: "desc" },
    take: 10,
    select: {
      trackingNumber: true,
      carrier: true,
      lastError: true,
      finishedAt: true,
    },
  });

  const percentage =
    job.totalOrders > 0
      ? Math.round((job.processedOrders / job.totalOrders) * 100)
      : 0;

  return NextResponse.json({
    id: job.id,
    status: job.status,
    totalOrders: job.totalOrders,
    processedOrders: job.processedOrders,
    successCount: job.successCount,
    failedCount: job.failedCount,
    skippedCount: job.skippedCount,
    currentCarrier: job.currentCarrier,
    percentage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorMessage: job.errorMessage,
    recentErrors,
    createdAt: job.createdAt,
  });
}
