-- CreateEnum
CREATE TYPE "TrackingJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrackingItemStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- AlterTable: Add normalized_carrier to orders
ALTER TABLE "orders" ADD COLUMN "normalized_carrier" TEXT;

-- CreateIndex
CREATE INDEX "orders_normalized_carrier_idx" ON "orders"("normalized_carrier");

-- CreateTable
CREATE TABLE "tracking_jobs" (
    "id" TEXT NOT NULL,
    "status" "TrackingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "processed_orders" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "current_carrier" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_job_items" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "tracking_number" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "status" "TrackingItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "tracking_result" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "tracking_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_jobs_status_idx" ON "tracking_jobs"("status");

-- CreateIndex
CREATE INDEX "tracking_job_items_job_id_status_idx" ON "tracking_job_items"("job_id", "status");

-- CreateIndex
CREATE INDEX "tracking_job_items_order_id_idx" ON "tracking_job_items"("order_id");

-- CreateIndex
CREATE INDEX "tracking_job_items_carrier_idx" ON "tracking_job_items"("carrier");

-- AddForeignKey
ALTER TABLE "tracking_job_items" ADD CONSTRAINT "tracking_job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "tracking_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_job_items" ADD CONSTRAINT "tracking_job_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
