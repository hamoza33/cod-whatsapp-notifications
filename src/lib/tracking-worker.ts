/**
 * Background tracking worker.
 *
 * Picks queued TrackingJob rows and processes every TrackingJobItem to
 * completion. Each item is looked up via the appropriate carrier provider
 * and the order status is updated accordingly.
 *
 * Design constraints:
 *   - One failed order must NOT abort the entire job.
 *   - One failed carrier must NOT abort other carriers.
 *   - Progress is persisted after every batch so a restart picks up where
 *     it left off.
 *   - Uses cursor-based iteration (by item id) — never offset pagination.
 *   - Uses Promise.allSettled so rejected promises don't kill the batch.
 */

import { prisma } from "./prisma";
import { TrackingItemStatus, TrackingJobStatus, OrderStatus } from "@prisma/client";
import type { CarrierCode } from "./carrier-normalization";
import { CARRIER_DISPLAY_NAMES } from "./carrier-normalization";
import { getSetting, SETTING_KEYS } from "./settings";
import type { TrackingProvider, TrackingResult, TrackingDeliveryStatus } from "./tracking/types";
import { FourTrackingProvider } from "./tracking/fourtracking-provider";
import { JdLogisticsProvider } from "./tracking/jd-logistics-provider";
import { InjazProvider } from "./tracking/injaz-provider";

// Carrier-specific concurrency and batch-size configuration
interface CarrierConfig {
  batchSize: number;
  concurrency: number;
  provider: (captchaKey: string | null) => TrackingProvider;
}

const CARRIER_CONFIG: Record<CarrierCode, CarrierConfig> = {
  JTE: {
    batchSize: 10,
    concurrency: 5,
    provider: () => new FourTrackingProvider(),
  },
  IMILE: {
    batchSize: 10,
    concurrency: 5,
    provider: () => new FourTrackingProvider(),
  },
  JDW: {
    batchSize: 10,
    concurrency: 5,
    provider: (captchaKey) => new JdLogisticsProvider(captchaKey),
  },
  INJAZ: {
    batchSize: 1,
    concurrency: 4,
    provider: () => new InjazProvider(),
  },
};

const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2_000;

function mapTrackingStatusToOrderStatus(
  trackingStatus: TrackingDeliveryStatus,
  currentOrderStatus: OrderStatus
): OrderStatus | null {
  switch (trackingStatus) {
    case "delivered":
      return OrderStatus.DELIVERED;
    case "returned":
      return OrderStatus.RETURNED;
    case "out_for_delivery":
      if (
        currentOrderStatus !== OrderStatus.DELIVERED &&
        currentOrderStatus !== OrderStatus.RETURNED
      ) {
        return OrderStatus.OUT_FOR_DELIVERY;
      }
      return null;
    case "in_transit":
      if (
        currentOrderStatus === OrderStatus.PENDING ||
        currentOrderStatus === OrderStatus.CONFIRMED ||
        currentOrderStatus === OrderStatus.PROCESSING ||
        currentOrderStatus === OrderStatus.UNKNOWN
      ) {
        return OrderStatus.SHIPPED;
      }
      return null;
    default:
      return null;
  }
}

export async function processTrackingJob(jobId: string): Promise<void> {
  const startTime = Date.now();
  console.log(`[tracking-worker] Starting job ${jobId}`);

  // Mark job as running
  await prisma.trackingJob.update({
    where: { id: jobId },
    data: { status: TrackingJobStatus.RUNNING, startedAt: new Date() },
  });

  const captchaApiKey = await getSetting(SETTING_KEYS.CAPTCHA_API_KEY ?? "captcha_api_key");

  // Process each carrier independently
  const carriers = Object.keys(CARRIER_CONFIG) as CarrierCode[];

  for (const carrier of carriers) {
    try {
      await processCarrier(jobId, carrier, captchaApiKey);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[tracking-worker] Carrier ${carrier} failed for job ${jobId}: ${errorMsg}`);
      // Mark remaining items for this carrier as failed, but continue with others
      await prisma.trackingJobItem.updateMany({
        where: { jobId, carrier, status: TrackingItemStatus.PENDING },
        data: {
          status: TrackingItemStatus.FAILED,
          lastError: `Carrier-level failure: ${errorMsg}`,
          finishedAt: new Date(),
        },
      });
      await refreshJobCounters(jobId);
    }
  }

  // Handle any items with carrier = "UNKNOWN"
  await prisma.trackingJobItem.updateMany({
    where: { jobId, carrier: "UNKNOWN", status: TrackingItemStatus.PENDING },
    data: {
      status: TrackingItemStatus.SKIPPED,
      lastError: "No tracking provider for unknown carrier",
      finishedAt: new Date(),
    },
  });
  await refreshJobCounters(jobId);

  // Mark job as completed
  const finalJob = await prisma.trackingJob.findUnique({ where: { id: jobId } });
  const finalStatus =
    (finalJob?.failedCount ?? 0) > 0 && (finalJob?.successCount ?? 0) === 0
      ? TrackingJobStatus.FAILED
      : TrackingJobStatus.COMPLETED;

  await prisma.trackingJob.update({
    where: { id: jobId },
    data: {
      status: finalStatus,
      currentCarrier: null,
      finishedAt: new Date(),
    },
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[tracking-worker] Job ${jobId} finished in ${duration}s — ` +
    `status=${finalStatus}, success=${finalJob?.successCount}, ` +
    `failed=${finalJob?.failedCount}, skipped=${finalJob?.skippedCount}`
  );
}

async function processCarrier(
  jobId: string,
  carrier: CarrierCode,
  captchaKey: string | null
): Promise<void> {
  const config = CARRIER_CONFIG[carrier];
  const provider = config.provider(captchaKey);
  const displayName = CARRIER_DISPLAY_NAMES[carrier];

  // Update job's current carrier
  await prisma.trackingJob.update({
    where: { id: jobId },
    data: { currentCarrier: displayName },
  });

  let batchNumber = 0;
  let hasMore = true;

  while (hasMore) {
    // Fetch pending items for this carrier using cursor-based pagination
    const items = await prisma.trackingJobItem.findMany({
      where: {
        jobId,
        carrier,
        status: TrackingItemStatus.PENDING,
      },
      orderBy: { id: "asc" },
      take: config.batchSize * config.concurrency,
    });

    if (items.length === 0) {
      hasMore = false;
      break;
    }

    batchNumber++;
    const batchStart = Date.now();
    console.log(
      `[tracking-worker] Job ${jobId} | ${carrier} | batch ${batchNumber} | ` +
      `${items.length} items`
    );

    // Split items into batches
    const batches: typeof items[] = [];
    for (let i = 0; i < items.length; i += config.batchSize) {
      batches.push(items.slice(i, i + config.batchSize));
    }

    // Process batches with controlled concurrency using allSettled
    const concurrentBatches: Promise<void>[] = [];
    for (let i = 0; i < batches.length; i += config.concurrency) {
      const chunk = batches.slice(i, i + config.concurrency);
      const batchPromises = chunk.map((batch) =>
        processBatch(jobId, carrier, batch, provider)
      );
      concurrentBatches.push(
        Promise.allSettled(batchPromises).then((results) => {
          for (const r of results) {
            if (r.status === "rejected") {
              console.error(
                `[tracking-worker] Batch promise rejected for ${carrier}:`,
                r.reason
              );
            }
          }
        })
      );
    }

    await Promise.allSettled(concurrentBatches);

    const batchDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log(
      `[tracking-worker] Job ${jobId} | ${carrier} | batch ${batchNumber} | ` +
      `completed in ${batchDuration}s`
    );

    await refreshJobCounters(jobId);
  }
}

async function processBatch(
  jobId: string,
  carrier: string,
  items: Array<{ id: string; trackingNumber: string; orderId: string; attempts: number }>,
  provider: TrackingProvider
): Promise<void> {
  // Mark items as running
  await prisma.trackingJobItem.updateMany({
    where: { id: { in: items.map((i) => i.id) } },
    data: { status: TrackingItemStatus.RUNNING, startedAt: new Date() },
  });

  const trackingNumbers = items.map((i) => i.trackingNumber);
  let results: TrackingResult[];

  try {
    results = await provider.trackBatch(trackingNumbers);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Entire batch failed — mark all as failed
    for (const item of items) {
      const newAttempts = item.attempts + 1;
      if (newAttempts < MAX_RETRY_ATTEMPTS) {
        // Retry with exponential backoff
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, newAttempts - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        await prisma.trackingJobItem.update({
          where: { id: item.id },
          data: {
            status: TrackingItemStatus.PENDING,
            attempts: newAttempts,
            lastError: `Batch error: ${errorMsg}`,
          },
        });
      } else {
        await prisma.trackingJobItem.update({
          where: { id: item.id },
          data: {
            status: TrackingItemStatus.FAILED,
            attempts: newAttempts,
            lastError: `Batch error after ${MAX_RETRY_ATTEMPTS} attempts: ${errorMsg}`,
            finishedAt: new Date(),
          },
        });
      }
    }
    return;
  }

  // Map results back to items
  const resultMap = new Map<string, TrackingResult>();
  for (const r of results) {
    resultMap.set(r.trackingNumber, r);
  }

  for (const item of items) {
    const result = resultMap.get(item.trackingNumber);
    if (!result) {
      await prisma.trackingJobItem.update({
        where: { id: item.id },
        data: {
          status: TrackingItemStatus.FAILED,
          lastError: "No result returned from provider",
          finishedAt: new Date(),
          attempts: item.attempts + 1,
        },
      });
      continue;
    }

    if (result.error && result.status === "unknown") {
      const newAttempts = item.attempts + 1;
      if (newAttempts < MAX_RETRY_ATTEMPTS) {
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, newAttempts - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        await prisma.trackingJobItem.update({
          where: { id: item.id },
          data: {
            status: TrackingItemStatus.PENDING,
            attempts: newAttempts,
            lastError: result.error,
          },
        });
      } else {
        await prisma.trackingJobItem.update({
          where: { id: item.id },
          data: {
            status: TrackingItemStatus.FAILED,
            attempts: newAttempts,
            lastError: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${result.error}`,
            finishedAt: new Date(),
          },
        });
      }
      continue;
    }

    // Handle captcha_blocked for JD Logistics
    if (result.status === "captcha_blocked") {
      await prisma.trackingJobItem.update({
        where: { id: item.id },
        data: {
          status: TrackingItemStatus.SKIPPED,
          lastError: result.error ?? "Captcha blocked",
          trackingResult: "captcha_blocked",
          finishedAt: new Date(),
          attempts: item.attempts + 1,
        },
      });
      continue;
    }

    // Update the tracking item
    await prisma.trackingJobItem.update({
      where: { id: item.id },
      data: {
        status: TrackingItemStatus.SUCCESS,
        trackingResult: result.status,
        lastError: result.error ?? null,
        finishedAt: new Date(),
        attempts: item.attempts + 1,
      },
    });

    // Update the order status if the tracking result warrants it
    try {
      const order = await prisma.order.findUnique({
        where: { id: item.orderId },
        select: { status: true },
      });
      if (order) {
        const newStatus = mapTrackingStatusToOrderStatus(result.status, order.status);
        if (newStatus && newStatus !== order.status) {
          await prisma.order.update({
            where: { id: item.orderId },
            data: { status: newStatus, statusChangedAt: new Date() },
          });
          console.log(
            `[tracking-worker] Order ${item.orderId} status: ${order.status} → ${newStatus} ` +
            `(tracking: ${result.status})`
          );
        }
      }
    } catch (err) {
      console.error(
        `[tracking-worker] Failed to update order ${item.orderId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

async function refreshJobCounters(jobId: string): Promise<void> {
  const counts = await prisma.trackingJobItem.groupBy({
    by: ["status"],
    where: { jobId },
    _count: true,
  });

  let processed = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of counts) {
    if (c.status === TrackingItemStatus.SUCCESS) {
      success = c._count;
      processed += c._count;
    } else if (c.status === TrackingItemStatus.FAILED) {
      failed = c._count;
      processed += c._count;
    } else if (c.status === TrackingItemStatus.SKIPPED) {
      skipped = c._count;
      processed += c._count;
    }
  }

  await prisma.trackingJob.update({
    where: { id: jobId },
    data: {
      processedOrders: processed,
      successCount: success,
      failedCount: failed,
      skippedCount: skipped,
    },
  });
}

/**
 * Poll for queued jobs and process them. This is the main loop for the
 * standalone worker process.
 */
export async function startTrackingWorkerLoop(): Promise<void> {
  console.log("[tracking-worker] Worker loop started");

  for (;;) {
    try {
      // Find the oldest queued job
      const job = await prisma.trackingJob.findFirst({
        where: { status: TrackingJobStatus.QUEUED },
        orderBy: { createdAt: "asc" },
      });

      if (job) {
        await processTrackingJob(job.id);
      } else {
        // No jobs — wait before polling again
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } catch (err) {
      console.error(
        "[tracking-worker] Unexpected error in worker loop:",
        err instanceof Error ? err.message : err
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}
